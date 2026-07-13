//go:build integration

package kube_test

import (
	"context"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/dynamic"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestDetail_RealCluster exercises the on-demand Detail Popup data paths (issue
// #23) against a real cluster stood up by the kind+KWOK harness (ADR-0004): Tower
// detail in both View Modes, Pod detail, and — on a real kind-scheduled pod that
// actually produces log output, since KWOK pods produce none — the bounded live
// log tail.
//
// Gated behind the "integration" build tag. Run with:
//
//	go test -tags=integration ./internal/kube/...
func TestDetail_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	dyn, err := dynamic.NewForConfig(c.RESTConfig)
	if err != nil {
		t.Fatalf("build dynamic client: %v", err)
	}

	nodeNames, err := c.AddFakeNodes(ctx, 2)
	if err != nil {
		t.Fatalf("add fake nodes: %v", err)
	}
	podNames, err := c.AddFakePods(ctx, nodeNames, 4)
	if err != nil {
		t.Fatalf("add fake pods: %v", err)
	}

	t.Run("tower detail node mode", func(t *testing.T) {
		detail, err := kube.BuildTowerDetail(ctx, c.Clientset, dyn, scene.ViewModeNode, nodeNames[0])
		if err != nil {
			t.Fatalf("BuildTowerDetail node: %v", err)
		}
		if detail.Name != nodeNames[0] || detail.Kind != scene.TowerKindNode {
			t.Fatalf("identity = %q/%q", detail.Name, detail.Kind)
		}
		if detail.Node == nil {
			t.Fatal("Node summary is nil for a real (KWOK) node")
		}
		if !detail.Node.Ready || detail.Node.Status != "Ready" {
			t.Errorf("node readiness = %v/%q, want true/Ready", detail.Node.Ready, detail.Node.Status)
		}
		// AddFakeNodes gives each KWOK node real capacity; the summary must carry it.
		if detail.Node.CPU == "" || detail.Node.Memory == "" || detail.Node.Pods == "" {
			t.Errorf("node capacity incomplete: %+v", detail.Node)
		}
		if detail.Node.PodCount == 0 {
			t.Error("PodCount = 0, want the KWOK pods scheduled on this node")
		}
	})

	t.Run("tower detail namespace mode", func(t *testing.T) {
		detail, err := kube.BuildTowerDetail(ctx, c.Clientset, dyn, scene.ViewModeNamespace, "default")
		if err != nil {
			t.Fatalf("BuildTowerDetail namespace: %v", err)
		}
		if detail.Kind != scene.TowerKindNamespace || detail.Namespace == nil {
			t.Fatalf("kind/namespace = %q/%v", detail.Kind, detail.Namespace)
		}
		if detail.Namespace.Phase != "Active" {
			t.Errorf("phase = %q, want Active", detail.Namespace.Phase)
		}
		if detail.Namespace.PodCount == 0 {
			t.Error("PodCount = 0, want the KWOK pods in the default namespace")
		}
	})

	t.Run("pod detail", func(t *testing.T) {
		detail, err := kube.BuildPodDetail(ctx, c.Clientset, "default", podNames[0])
		if err != nil {
			t.Fatalf("BuildPodDetail: %v", err)
		}
		if detail.Pod != podNames[0] || detail.Namespace != "default" {
			t.Fatalf("identity = %s/%s", detail.Namespace, detail.Pod)
		}
		if detail.Phase != scene.PodPhaseRunning {
			t.Errorf("phase = %q, want Running", detail.Phase)
		}
		if detail.Containers == nil {
			t.Error("Containers is nil, want non-nil")
		}
		if detail.Events == nil {
			t.Error("Events is nil, want non-nil (empty allowed)")
		}
	})

	t.Run("bounded live log tail on a real pod", func(t *testing.T) {
		podName := realLoggingPod(ctx, t, c)

		tctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()

		var (
			mu       sync.Mutex
			windows  [][]string
			maxLines int
		)
		emit := func(tail scene.LogTail) {
			mu.Lock()
			defer mu.Unlock()
			windows = append(windows, append([]string(nil), tail.Lines...))
			if len(tail.Lines) > maxLines {
				maxLines = len(tail.Lines)
			}
			// The pod prints more lines than the cap; once we've confirmed a full,
			// bounded window we can stop following.
			if len(windows) >= 4 {
				cancel()
			}
		}

		err := kube.PodLogTail(tctx, c.Clientset, "default", podName, emit)
		if err != nil && tctx.Err() == nil {
			t.Fatalf("PodLogTail: %v", err)
		}

		mu.Lock()
		defer mu.Unlock()
		if len(windows) == 0 {
			t.Fatal("received no log tail windows from a logging pod")
		}
		if maxLines == 0 {
			t.Error("every window was empty, want real log lines")
		}
		if maxLines > scene.LogTailMaxLines {
			t.Errorf("a window carried %d lines, exceeds the %d cap", maxLines, scene.LogTailMaxLines)
		}
	})
}

// realLoggingPod creates a real (non-KWOK) pod scheduled on the real kind node
// that continuously prints numbered lines, waits for it to run, and returns its
// name. KWOK pods produce no container logs, so the live log tail must be
// exercised against a genuinely-running container.
func realLoggingPod(ctx context.Context, t *testing.T, c *testcluster.Cluster) string {
	t.Helper()

	realNode := realKindNode(ctx, t, c)
	name := "logtail-probe"
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1.PodSpec{
			// Pin to the real node directly (bypassing the scheduler, and thus any
			// control-plane taint) so the container actually runs on a kubelet.
			NodeName:      realNode,
			RestartPolicy: corev1.RestartPolicyNever,
			Tolerations:   []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
			Containers: []corev1.Container{{
				Name:    "logger",
				Image:   "busybox:1.36",
				Command: []string{"sh", "-c", "i=0; while true; do i=$((i+1)); echo log-line-$i; sleep 1; done"},
			}},
		},
	}
	if _, err := c.Clientset.CoreV1().Pods("default").Create(ctx, p, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create logging pod: %v", err)
	}
	t.Cleanup(func() {
		_ = c.Clientset.CoreV1().Pods("default").Delete(context.Background(), name, metav1.DeleteOptions{})
	})

	// Allow generous time for the busybox image pull on a cold node.
	waitErr := wait.PollUntilContextTimeout(ctx, time.Second, 3*time.Minute, true,
		func(ctx context.Context) (bool, error) {
			got, err := c.Clientset.CoreV1().Pods("default").Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				if apierrors.IsNotFound(err) {
					return false, nil
				}
				return false, err
			}
			return got.Status.Phase == corev1.PodRunning, nil
		})
	if waitErr != nil {
		t.Fatalf("logging pod did not reach Running: %v", waitErr)
	}
	return name
}

// realKindNode returns the name of the real kind node (the one KWOK does not
// manage), identified by the absence of the harness's "type=kwok" label.
func realKindNode(ctx context.Context, t *testing.T, c *testcluster.Cluster) string {
	t.Helper()
	list, err := c.Clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list nodes: %v", err)
	}
	for i := range list.Items {
		if list.Items[i].Labels["type"] != "kwok" {
			return list.Items[i].Name
		}
	}
	t.Fatal("no real (non-KWOK) node found in the cluster")
	return ""
}
