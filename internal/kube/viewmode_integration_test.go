//go:build integration

package kube_test

import (
	"context"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestDetectViewMode_RealCluster verifies the permission probe against a real
// cluster stood up by the kind+KWOK harness (ADR-0004, issue #5), rather than
// a fake clientset. It proves the SelfSubjectAccessReview round-trips against a
// genuine API-server authorizer (not just the fake's canned reactor) for both
// outcomes:
//
//   - the default context is cluster-admin → can list Nodes → Node-mode;
//   - an impersonated user with no RBAC → cannot list Nodes → Namespace-mode,
//     exercising the ADR-0002 graceful-degradation branch against a real deny
//     rather than only against the fake.
//
// Gated behind the "integration" build tag: it spins up real Docker
// containers and takes minutes, unsuitable for the fast default test loop.
// Run it explicitly with:
//
//	go test -tags=integration ./internal/kube/...
func TestDetectViewMode_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx := context.Background()

	t.Run("real cluster is reachable", func(t *testing.T) {
		if err := kube.EnsureReachable(ctx, c.Clientset); err != nil {
			t.Fatalf("EnsureReachable against real cluster: %v", err)
		}
	})

	t.Run("bogus endpoint is unreachable", func(t *testing.T) {
		// A syntactically-valid config pointing at an address nothing listens
		// on: the client builds fine, but the transport probe must fail — the
		// real path exercised at startup when the cluster is down or the
		// context is wrong. Uses TEST-NET-1 (RFC 5737), reserved for docs and
		// guaranteed non-routable. A short context deadline makes it fail fast
		// even if the address black-holes rather than refusing.
		badCfg := rest.CopyConfig(c.RESTConfig)
		badCfg.Host = "https://192.0.2.1:6443"
		badClient, err := kubernetes.NewForConfig(badCfg)
		if err != nil {
			t.Fatalf("build client for bogus endpoint: %v", err)
		}

		badCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		if err := kube.EnsureReachable(badCtx, badClient); err == nil {
			t.Fatal("EnsureReachable = nil for an unreachable endpoint, want an error")
		}
	})

	t.Run("cluster-admin can list nodes selects node mode", func(t *testing.T) {
		mode, err := kube.DetectViewMode(ctx, c.Clientset)
		if err != nil {
			t.Fatalf("DetectViewMode: %v", err)
		}
		if mode != kube.ViewModeNode {
			t.Fatalf("view mode = %q, want %q (kind's default context is cluster-admin)", mode, kube.ViewModeNode)
		}
	})

	t.Run("user without rbac falls back to namespace mode", func(t *testing.T) {
		// Impersonate an arbitrary user that has no RoleBindings, so the real
		// authorizer denies the node-list SSAR. cluster-admin (the base
		// context) is permitted to impersonate.
		restricted := rest.CopyConfig(c.RESTConfig)
		restricted.Impersonate = rest.ImpersonationConfig{UserName: "htp-k8s-probe-noperms"}

		client, err := kubernetes.NewForConfig(restricted)
		if err != nil {
			t.Fatalf("build impersonating clientset: %v", err)
		}

		mode, err := kube.DetectViewMode(ctx, client)
		if err != nil {
			t.Fatalf("DetectViewMode: %v", err)
		}
		if mode != kube.ViewModeNamespace {
			t.Fatalf("view mode = %q, want %q (impersonated user has no node-list permission)", mode, kube.ViewModeNamespace)
		}
	})
}
