//go:build integration

package kube_test

import (
	"context"
	"math"
	"sort"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestBuildTowers_RealCluster verifies Tower generation against a real cluster
// stood up by the kind+KWOK harness (ADR-0004, issue #5), rather than a fake
// clientset — proving the Towers reflect genuine cluster state for both View
// Modes, including KWOK-simulated Nodes.
//
// Gated behind the "integration" build tag: it spins up real Docker containers
// and takes minutes. Run it explicitly with:
//
//	go test -tags=integration ./internal/kube/...
func TestBuildTowers_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	dyn, err := dynamic.NewForConfig(c.RESTConfig)
	if err != nil {
		t.Fatalf("build dynamic client: %v", err)
	}

	// Add KWOK-simulated nodes on top of the one real kind node, so Node-mode
	// Towers are validated at a scale a single-node cluster can't show.
	const fakeNodeCount = 5
	if _, err := c.AddFakeNodes(ctx, fakeNodeCount); err != nil {
		t.Fatalf("add fake nodes: %v", err)
	}

	t.Run("node mode towers reflect all nodes", func(t *testing.T) {
		wantNames := realNodeNames(ctx, t, c)
		if len(wantNames) < fakeNodeCount+1 {
			t.Fatalf("cluster has %d nodes, want at least %d (1 real + %d KWOK)",
				len(wantNames), fakeNodeCount+1, fakeNodeCount)
		}

		towers, err := kube.BuildTowers(ctx, c.Clientset, dyn, scene.ViewModeNode)
		if err != nil {
			t.Fatalf("BuildTowers node mode: %v", err)
		}
		assertTowersMatchNames(t, towers, wantNames)
	})

	t.Run("namespace mode towers reflect all namespaces", func(t *testing.T) {
		wantNames := realNamespaceNames(ctx, t, c)
		// Every cluster has at least the built-in namespaces (default,
		// kube-system, ...), so this list is never empty.
		if len(wantNames) == 0 {
			t.Fatal("cluster reported no namespaces")
		}

		towers, err := kube.BuildTowers(ctx, c.Clientset, dyn, scene.ViewModeNamespace)
		if err != nil {
			t.Fatalf("BuildTowers namespace mode: %v", err)
		}
		assertTowersMatchNames(t, towers, wantNames)
	})

	t.Run("restricted user degrades to empty towers, no hard fail", func(t *testing.T) {
		// Impersonate a user with no RBAC against the real authorizer: they
		// can list neither Namespaces nor Projects (kind has no OpenShift
		// Projects API at all). Per ADR-0002 BuildTowers must degrade to an
		// empty Tower set with an informational error, not hard-fail — the
		// same graceful path the fake-clientset unit tests pin, verified here
		// against a genuine deny rather than a canned reactor.
		restricted := rest.CopyConfig(c.RESTConfig)
		restricted.Impersonate = rest.ImpersonationConfig{UserName: "htp-k8s-towers-noperms"}

		client, err := kubernetes.NewForConfig(restricted)
		if err != nil {
			t.Fatalf("build impersonating clientset: %v", err)
		}
		restrictedDyn, err := dynamic.NewForConfig(restricted)
		if err != nil {
			t.Fatalf("build impersonating dynamic client: %v", err)
		}

		towers, err := kube.BuildTowers(ctx, client, restrictedDyn, scene.ViewModeNamespace)
		if err == nil {
			t.Error("BuildTowers = nil error for a user who can list neither namespaces nor projects, want an informational error")
		}
		if towers == nil {
			t.Error("towers slice is nil, want non-nil empty so the wire carries [] not null")
		}
		if len(towers) != 0 {
			t.Errorf("towers = %+v, want empty on degradation", towers)
		}
	})
}

func realNodeNames(ctx context.Context, t *testing.T, c *testcluster.Cluster) []string {
	t.Helper()
	list, err := c.Clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list nodes: %v", err)
	}
	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		names = append(names, list.Items[i].Name)
	}
	return names
}

func realNamespaceNames(ctx context.Context, t *testing.T, c *testcluster.Cluster) []string {
	t.Helper()
	list, err := c.Clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list namespaces: %v", err)
	}
	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		names = append(names, list.Items[i].Name)
	}
	return names
}

// assertTowersMatchNames checks that towers cover exactly wantNames, are sorted
// by name, and carry the deterministic grid-by-name positions — the same layout
// contract the fake-clientset unit tests pin, verified here against real state.
func assertTowersMatchNames(t *testing.T, towers []scene.Tower, wantNames []string) {
	t.Helper()

	if len(towers) != len(wantNames) {
		t.Fatalf("got %d towers, want %d (%v)", len(towers), len(wantNames), wantNames)
	}

	sorted := make([]string, len(wantNames))
	copy(sorted, wantNames)
	sort.Strings(sorted)

	width := int(math.Ceil(math.Sqrt(float64(len(sorted)))))
	if width < 1 {
		width = 1
	}

	for i, tw := range towers {
		if tw.Name != sorted[i] {
			t.Errorf("tower[%d] name = %q, want %q", i, tw.Name, sorted[i])
		}
		wantCol, wantRow := i%width, i/width
		if tw.Grid.Col != wantCol || tw.Grid.Row != wantRow {
			t.Errorf("tower[%d] %q grid = (%d,%d), want (%d,%d)",
				i, tw.Name, tw.Grid.Col, tw.Grid.Row, wantCol, wantRow)
		}
	}
}
