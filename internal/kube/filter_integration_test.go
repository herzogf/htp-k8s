//go:build integration

package kube_test

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestNamespaceFilter_RealCluster verifies the Namespace Filter against a real
// API server stood up by the kind+KWOK harness (ADR-0004), rather than a fake
// clientset — proving both filter modes select the right Namespace/Project
// Towers from genuine cluster state (real Namespace objects, real labels, a real
// LIST), not just against the fake's in-process reactor.
//
// Gated behind the "integration" build tag: it spins up real Docker containers
// and takes minutes. Run it explicitly with:
//
//	go test -tags=integration ./internal/kube/...
func TestNamespaceFilter_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	dyn, err := dynamic.NewForConfig(c.RESTConfig)
	if err != nil {
		t.Fatalf("build dynamic client: %v", err)
	}

	// Unique names/labels so the filters select a deterministic set regardless
	// of the cluster's built-in namespaces.
	const teamLabel = "htp-k8s-test-team"
	create := func(name string, labels map[string]string) {
		_, err := c.Clientset.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
		}, metav1.CreateOptions{})
		if err != nil {
			t.Fatalf("create namespace %q: %v", name, err)
		}
	}
	create("htpfilter-alpha", map[string]string{teamLabel: "platform"})
	create("htpfilter-beta", map[string]string{teamLabel: "payments"})
	create("htpfilter-gamma", nil)

	t.Run("name pattern selects matching namespaces", func(t *testing.T) {
		filter, err := kube.NameFilter("htpfilter-*")
		if err != nil {
			t.Fatalf("NameFilter: %v", err)
		}
		towers, err := kube.BuildTowers(ctx, c.Clientset, dyn, scene.ViewModeNamespace, filter)
		if err != nil {
			t.Fatalf("BuildTowers: %v", err)
		}
		assertTowerSet(t, towers, []string{"htpfilter-alpha", "htpfilter-beta", "htpfilter-gamma"})
	})

	t.Run("label selector selects matching namespaces", func(t *testing.T) {
		filter, err := kube.LabelFilter(teamLabel + "=platform")
		if err != nil {
			t.Fatalf("LabelFilter: %v", err)
		}
		towers, err := kube.BuildTowers(ctx, c.Clientset, dyn, scene.ViewModeNamespace, filter)
		if err != nil {
			t.Fatalf("BuildTowers: %v", err)
		}
		assertTowerSet(t, towers, []string{"htpfilter-alpha"})
	})

	t.Run("no filter shows the built-ins too", func(t *testing.T) {
		towers, err := kube.BuildTowers(ctx, c.Clientset, dyn, scene.ViewModeNamespace, kube.NamespaceFilter{})
		if err != nil {
			t.Fatalf("BuildTowers: %v", err)
		}
		names := map[string]bool{}
		for _, tw := range towers {
			names[tw.Name] = true
		}
		// The no-filter default hides nothing: our three plus a built-in.
		for _, want := range []string{"htpfilter-alpha", "htpfilter-beta", "htpfilter-gamma", "default"} {
			if !names[want] {
				t.Errorf("no-filter towers missing %q", want)
			}
		}
	})
}

// assertTowerSet checks the Tower names are exactly want (order-independent).
func assertTowerSet(t *testing.T, towers []scene.Tower, want []string) {
	t.Helper()
	got := map[string]bool{}
	for _, tw := range towers {
		got[tw.Name] = true
	}
	if len(got) != len(want) {
		t.Fatalf("got %d towers %v, want %d %v", len(got), towerNames(towers), len(want), want)
	}
	for _, name := range want {
		if !got[name] {
			t.Errorf("missing tower %q (got %v)", name, towerNames(towers))
		}
	}
}
