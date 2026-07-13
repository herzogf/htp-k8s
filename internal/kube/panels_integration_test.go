//go:build integration

package kube_test

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestBuildPanels_RealCluster verifies Panel generation against a real cluster
// stood up by the kind+KWOK harness (ADR-0004, issue #5), rather than a fake
// clientset — proving Panels nest under the correct Tower in both View Modes,
// re-nest when the View Mode switches, and reflect genuine cluster state at a
// modest scale, all using KWOK-simulated pods.
//
// Gated behind the "integration" build tag: it spins up real Docker containers
// and takes minutes. Run it explicitly with:
//
//	go test -tags=integration ./internal/kube/...
func TestBuildPanels_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	dyn, err := dynamic.NewForConfig(c.RESTConfig)
	if err != nil {
		t.Fatalf("build dynamic client: %v", err)
	}

	// A modest, PR-scale fleet: a handful of KWOK nodes carrying several
	// pods each (round-robin bound by AddFakePods), enough to exercise
	// multi-node/multi-pod nesting without real containers.
	const (
		fakeNodeCount = 5
		fakePodCount  = 15
	)
	nodeNames, err := c.AddFakeNodes(ctx, fakeNodeCount)
	if err != nil {
		t.Fatalf("add fake nodes: %v", err)
	}
	if _, err := c.AddFakePods(ctx, nodeNames, fakePodCount); err != nil {
		t.Fatalf("add fake pods: %v", err)
	}

	// The real node→pod and namespace→pod bindings, read back from the
	// cluster, are the source of truth the nested Panels must reflect.
	podsByNode, podsByNamespace := realPodTowerBindings(ctx, t, c)

	// buildScene composes the full nested scene the way the server does:
	// Towers, then bucketed Panels, then nested together.
	buildScene := func(mode scene.ViewMode) []scene.Tower {
		t.Helper()
		towers, err := kube.BuildTowers(ctx, c.Clientset, dyn, mode, kube.NamespaceFilter{})
		if err != nil {
			t.Fatalf("BuildTowers %s: %v", mode, err)
		}
		byTower, err := kube.BuildPanels(ctx, c.Clientset, mode, nil)
		if err != nil {
			t.Fatalf("BuildPanels %s: %v", mode, err)
		}
		return kube.AttachPanels(towers, byTower)
	}

	t.Run("node mode panels nest under each pod's node", func(t *testing.T) {
		towers := buildScene(scene.ViewModeNode)
		assertPanelsNestUnderTower(t, towers, podsByNode)
		assertFakePodsRunning(t, towers)
	})

	t.Run("namespace mode panels nest under each pod's namespace", func(t *testing.T) {
		towers := buildScene(scene.ViewModeNamespace)
		assertPanelsNestUnderTower(t, towers, podsByNamespace)
		assertFakePodsRunning(t, towers)

		// All KWOK pods live in the "default" namespace (see testcluster), so
		// in Namespace-mode they all re-home onto the "default" Tower — a
		// different Tower than any of their Nodes carried in Node-mode.
		for _, tw := range towers {
			if tw.Name == "default" {
				continue
			}
			for _, p := range tw.Panels {
				if isFakePod(p.Pod) {
					t.Errorf("KWOK pod %q nested under tower %q, want default", p.Pod, tw.Name)
				}
			}
		}
	})
}

// realPodTowerBindings reads every pod from the cluster and returns, keyed by
// pod name, the node it is bound to and the namespace it lives in — the two
// Tower identities a Panel must nest under across the two View Modes.
func realPodTowerBindings(ctx context.Context, t *testing.T, c *testcluster.Cluster) (byNode, byNamespace map[string]string) {
	t.Helper()
	list, err := c.Clientset.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list pods: %v", err)
	}
	byNode = make(map[string]string, len(list.Items))
	byNamespace = make(map[string]string, len(list.Items))
	for i := range list.Items {
		pod := &list.Items[i]
		byNode[pod.Name] = pod.Spec.NodeName
		byNamespace[pod.Name] = pod.Namespace
	}
	return byNode, byNamespace
}

// assertPanelsNestUnderTower checks every Panel is nested under the Tower that
// matches wantTower for its pod, that no pod appears twice, and that every
// scheduled pod produced a Panel. Pods with no owning Tower (an unscheduled pod
// in Node-mode, empty wantTower) are expected to be absent.
func assertPanelsNestUnderTower(t *testing.T, towers []scene.Tower, wantTower map[string]string) {
	t.Helper()

	gotTower := map[string]string{}
	for _, tw := range towers {
		if tw.Panels == nil {
			t.Errorf("tower %q has nil Panels, want non-nil", tw.Name)
		}
		for _, p := range tw.Panels {
			if prev, dup := gotTower[p.Pod]; dup {
				t.Errorf("pod %q nested under two towers (%q and %q)", p.Pod, prev, tw.Name)
			}
			gotTower[p.Pod] = tw.Name
			if want, ok := wantTower[p.Pod]; ok && want != "" && tw.Name != want {
				t.Errorf("pod %q nested under tower %q, want %q", p.Pod, tw.Name, want)
			}
		}
	}

	for pod, want := range wantTower {
		if want == "" {
			continue // no owning Tower under this mode; a Panel is not expected
		}
		if _, ok := gotTower[pod]; !ok {
			t.Errorf("no panel for scheduled pod %q (want tower %q)", pod, want)
		}
	}
}

// assertFakePodsRunning checks the KWOK-simulated pods, which AddFakePods waits
// to reach Running, are colored as Running Panels — the phase→color mapping
// holding against genuine cluster state, not just a fake clientset.
func assertFakePodsRunning(t *testing.T, towers []scene.Tower) {
	t.Helper()
	seen := 0
	for _, tw := range towers {
		for _, p := range tw.Panels {
			if !isFakePod(p.Pod) {
				continue
			}
			seen++
			if p.Phase != scene.PodPhaseRunning {
				t.Errorf("fake pod %q phase = %q, want Running", p.Pod, p.Phase)
			}
			if p.Color != scene.ColorRunning {
				t.Errorf("fake pod %q color = %q, want %q", p.Pod, p.Color, scene.ColorRunning)
			}
		}
	}
	if seen == 0 {
		t.Error("no KWOK-simulated pod panels found")
	}
}

// isFakePod reports whether a pod name is one of the harness's KWOK pods
// (testcluster names them "<cluster>-fake-pod-<n>").
func isFakePod(name string) bool {
	return strings.Contains(name, "-fake-pod-")
}
