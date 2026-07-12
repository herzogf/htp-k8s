//go:build integration

package kube_test

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestBuildPanels_RealCluster verifies Panel generation against a real cluster
// stood up by the kind+KWOK harness (ADR-0004, issue #5), rather than a fake
// clientset — proving Panels reflect genuine cluster state at a modest scale,
// scope correctly to their owning Tower in both View Modes, and re-scope when
// the View Mode switches, all using KWOK-simulated pods.
//
// Gated behind the "integration" build tag: it spins up real Docker containers
// and takes minutes. Run it explicitly with:
//
//	go test -tags=integration ./internal/kube/...
func TestBuildPanels_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	// A modest, PR-scale fleet: a handful of KWOK nodes carrying several
	// pods each (round-robin bound by AddFakePods), enough to exercise
	// multi-node/multi-pod scoping without real containers.
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
	// cluster, are the source of truth the Panels must reflect.
	podsByNode, podsByNamespace := realPodTowerBindings(ctx, t, c)

	t.Run("node mode panels scope to each pod's node", func(t *testing.T) {
		panels, err := kube.BuildPanels(ctx, c.Clientset, scene.ViewModeNode)
		if err != nil {
			t.Fatalf("BuildPanels node mode: %v", err)
		}
		assertPanelsScopeToTower(t, panels, podsByNode)
		assertFakePodsRunning(t, panels)
	})

	t.Run("namespace mode panels scope to each pod's namespace", func(t *testing.T) {
		panels, err := kube.BuildPanels(ctx, c.Clientset, scene.ViewModeNamespace)
		if err != nil {
			t.Fatalf("BuildPanels namespace mode: %v", err)
		}
		assertPanelsScopeToTower(t, panels, podsByNamespace)
		assertFakePodsRunning(t, panels)

		// All KWOK pods live in the "default" namespace (see testcluster), so
		// in Namespace-mode they all re-home onto the "default" Tower — a
		// different Tower than any of their Nodes carried in Node-mode.
		for _, p := range panels {
			if isFakePod(p.Pod) && p.Tower != "default" {
				t.Errorf("namespace-mode panel for %q on tower %q, want default", p.Pod, p.Tower)
			}
		}
	})
}

// realPodTowerBindings reads every pod from the cluster and returns, keyed by
// pod name, the node it is bound to and the namespace it lives in — the two
// Tower identities a Panel must carry under the two View Modes.
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

// assertPanelsScopeToTower checks every Panel's Tower matches the expected
// Tower for its pod (from wantTower), and that every scheduled pod produced a
// Panel. Pods with no owning Tower (an unscheduled pod in Node-mode, empty
// wantTower) are expected to be absent.
func assertPanelsScopeToTower(t *testing.T, panels []scene.Panel, wantTower map[string]string) {
	t.Helper()

	got := make(map[string]string, len(panels))
	for _, p := range panels {
		if prev, dup := got[p.Pod]; dup {
			t.Errorf("pod %q has two panels (towers %q and %q)", p.Pod, prev, p.Tower)
		}
		got[p.Pod] = p.Tower
		if want, ok := wantTower[p.Pod]; ok && want != "" && p.Tower != want {
			t.Errorf("panel for pod %q on tower %q, want %q", p.Pod, p.Tower, want)
		}
	}

	for pod, want := range wantTower {
		if want == "" {
			continue // no owning Tower under this mode; a Panel is not expected
		}
		if _, ok := got[pod]; !ok {
			t.Errorf("no panel for scheduled pod %q (want tower %q)", pod, want)
		}
	}
}

// assertFakePodsRunning checks the KWOK-simulated pods, which AddFakePods waits
// to reach Running, are colored as Running Panels — the phase→color mapping
// holding against genuine cluster state, not just a fake clientset.
func assertFakePodsRunning(t *testing.T, panels []scene.Panel) {
	t.Helper()
	seen := 0
	for _, p := range panels {
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
	if seen == 0 {
		t.Error("no KWOK-simulated pod panels found")
	}
}

// isFakePod reports whether a pod name is one of the harness's KWOK pods
// (testcluster names them "<cluster>-fake-pod-<n>").
func isFakePod(name string) bool {
	return strings.Contains(name, "-fake-pod-")
}
