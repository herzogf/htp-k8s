package kube

import (
	"context"
	"errors"
	"fmt"
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
// The NamespaceFilter selects which Namespaces/Projects are in the scene (see
// NamespaceFilter). It is applied consistently for both View Modes here: to the
// Namespace/Project Towers in Namespace-mode, and to the pods' Panels in
// Node-mode. The zero-value filter admits everything, the no-filter default.
//
// Per ADR-0002 it never hard-fails: a Tower- or Panel-listing error (e.g. a
// restricted user, or the OpenShift Project-fallback path) is logged and
// degraded to whatever was obtained (possibly none), and the returned
// SceneState always carries a valid View Mode and a non-nil Towers slice. That
// keeps the /ws contract — a well-formed frame with a valid viewMode — intact
// regardless of RBAC.
//
// The returned error is a SEPARATE signal on top of that always-valid state:
// non-nil whenever the Towers or Panels build degraded (the same conditions
// already logged above), so a caller that has something better to fall back on
// than "possibly none" — SceneWatcher.rebuildAndBroadcast, which can keep
// serving its last known-good SceneState instead of publishing this degraded
// one as truth — can tell the two apart. A caller with nothing better (the
// very first snapshot, e.g. SceneWatcher.Start's seed) is free to use the
// returned state regardless, exactly as before this error existed.
func BuildScene(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode, filter NamespaceFilter) (scene.SceneState, error) {
	towers, towersErr := BuildTowers(ctx, client, dyn, mode, filter)
	if towersErr != nil {
		log.Printf("build towers: %v", towersErr)
	}
	if towers == nil {
		// Keep the wire's Towers a JSON array ([]), never null, even when the
		// listing failed outright (see scene.SceneState.Towers).
		towers = []scene.Tower{}
	}

	// The filter reaches Panels differently per View Mode (see NamespaceFilter):
	// in Namespace-mode the Towers were already filtered above, so pods in hidden
	// namespaces lose their Tower and are dropped by AttachPanels; in Node-mode
	// the Node Towers are never filtered, so this predicate is what scopes pods
	// to the admitted namespaces. It is nil (admit all) except in that Node-mode
	// case, so the common paths do no extra work.
	admitNamespace := filter.podNamespacePredicate(ctx, client, dyn, mode)
	byTower, panelsErr := BuildPanels(ctx, client, dyn, mode, admitNamespace)
	if panelsErr != nil {
		log.Printf("build panels: %v", panelsErr)
	}
	// Nest each Tower's Panels into it (empty array for a Tower with no pods);
	// pods whose Tower wasn't built are dropped.
	towers = AttachPanels(towers, byTower)

	state := scene.SceneState{ViewMode: mode, Towers: towers}
	if err := errors.Join(towersErr, panelsErr); err != nil {
		return state, fmt.Errorf("build scene degraded: %w", err)
	}
	return state, nil
}
