//go:build integration

package testcluster_test

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestSmoke exercises the harness end-to-end against a real kind cluster
// with a real KWOK controller attached: it creates the cluster, asserts
// the real node reports Ready, then asks KWOK to simulate a modest number
// of extra nodes and pods and asserts those come up too.
//
// It is gated behind the "integration" build tag rather than running as
// part of a plain `go test ./...`: it spins up real Docker containers and
// pulls the kind node image plus the KWOK controller image, taking minutes
// rather than milliseconds — unsuitable for the fast default test loop
// other tickets rely on. Run it explicitly with:
//
//	go test -tags=integration ./internal/testcluster/...
//
// Docker is the only prerequisite: no pre-installed kind or kwok binaries.
// CI wiring for this suite is a separate ticket (#6).
func TestSmoke(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	t.Run("real node is ready", func(t *testing.T) {
		nodes, err := c.Clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		if err != nil {
			t.Fatalf("list nodes: %v", err)
		}
		if len(nodes.Items) == 0 {
			t.Fatal("expected at least one node, got none")
		}

		ready := false
		for _, n := range nodes.Items {
			for _, cond := range n.Status.Conditions {
				if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
					ready = true
				}
			}
		}
		if !ready {
			t.Fatal("expected at least one Ready node, got none")
		}
	})

	t.Run("kwok simulates fake nodes and pods", func(t *testing.T) {
		fakeNodes, err := c.AddFakeNodes(ctx, 3)
		if err != nil {
			t.Fatalf("AddFakeNodes: %v", err)
		}
		if len(fakeNodes) != 3 {
			t.Fatalf("len(fakeNodes) = %d, want 3", len(fakeNodes))
		}

		fakePods, err := c.AddFakePods(ctx, fakeNodes, 5)
		if err != nil {
			t.Fatalf("AddFakePods: %v", err)
		}
		if len(fakePods) != 5 {
			t.Fatalf("len(fakePods) = %d, want 5", len(fakePods))
		}
	})
}
