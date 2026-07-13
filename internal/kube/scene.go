package kube

import (
	"context"
	"log"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// BuildScene composes a full SceneState for the given View Mode from live
// cluster state: the Towers (BuildTowers), each with its Pods' Panels nested in
// (BuildPanels + AttachPanels). It is the single "cluster state → SceneState"
// path, used both for the snapshot a client receives on connect and for each
// rebuild the SceneWatcher diffs to emit Scene Deltas (ADR-0007), so the two can
// never drift apart.
//
// Per ADR-0002 it never fails: a Tower- or Panel-listing error (e.g. a restricted
// user, or the OpenShift Project-fallback path) is logged and degraded to
// whatever was obtained (possibly none), and the returned SceneState always
// carries a valid View Mode and a non-nil Towers slice. That keeps the /ws
// contract — a well-formed frame with a valid viewMode — intact regardless of
// RBAC.
func BuildScene(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode) scene.SceneState {
	towers, err := BuildTowers(ctx, client, dyn, mode)
	if err != nil {
		log.Printf("build towers: %v", err)
	}
	if towers == nil {
		// Keep the wire's Towers a JSON array ([]), never null, even when the
		// listing failed outright (see scene.SceneState.Towers).
		towers = []scene.Tower{}
	}

	byTower, err := BuildPanels(ctx, client, mode)
	if err != nil {
		log.Printf("build panels: %v", err)
	}
	// Nest each Tower's Panels into it (empty array for a Tower with no pods);
	// pods whose Tower wasn't built are dropped.
	towers = AttachPanels(towers, byTower)

	return scene.SceneState{ViewMode: mode, Towers: towers}
}
