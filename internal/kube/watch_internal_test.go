package kube

import (
	"bytes"
	"context"
	"errors"
	"log"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// syncTestNamespace, syncTestPod and syncTestProject are minimal object
// builders local to this file (the equivalents in towers_test.go/panels_test.go
// live in the external kube_test package and so aren't reachable from here,
// which needs package kube itself to reach the unexported cacheSyncTimeout
// field).
func syncTestNamespace(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

func syncTestPod(namespace, name, nodeName string, phase corev1.PodPhase) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec:       corev1.PodSpec{NodeName: nodeName},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func syncTestProject(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "project.openshift.io/v1",
		"kind":       "Project",
		"metadata":   map[string]any{"name": name},
	}}
}

func syncTestProjectDynamicClient(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	gvr := schema.GroupVersionResource{Group: "project.openshift.io", Version: "v1", Resource: "projects"}
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		scheme,
		map[schema.GroupVersionResource]string{gvr: "ProjectList"},
		objs...,
	)
}

// TestSceneWatcher_StartDegradesWhenInformerCannotSync is the end-to-end proof
// issue #55's review asked for: for a project-scoped OpenShift user whose
// cluster-scoped Pods and Namespaces informers can never sync (both always
// 403, the same shape BuildPanels' fallback exists for), Start must still
// return — not block forever on WaitForCacheSync — and the SceneState it seeds
// must still carry real Panels via BuildPanels' per-Namespace/Project fallback,
// built before any informer was even started. This is what makes issue #55's
// AC 1 ("a project-scoped OpenShift user sees Panels on their Towers") true in
// a runnable server, not just in BuildPanels' own unit tests.
func TestSceneWatcher_StartDegradesWhenInformerCannotSync(t *testing.T) {
	var logBuf bytes.Buffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	client := fake.NewSimpleClientset(
		syncTestPod("team-a", "web", "node-1", corev1.PodRunning),
	)
	// Namespaces is never namespace-scoped, so this always fires: the
	// Namespaces informer can never sync, and BuildPanels/BuildTowers's own
	// Namespace source falls to the Project dynamic client instead (below) —
	// mirroring an OpenShift user who cannot list cluster Namespaces at all.
	client.PrependReactor("list", "namespaces", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "namespaces"}, "", errors.New("cannot list namespaces at the cluster scope"))
	})
	// Forbid only the cluster-wide (all-namespaces) Pods list — the Pods
	// informer always lists that way, so it can never sync — while a
	// namespace-scoped list (BuildPanels' per-namespace fallback) still passes
	// through, matching a project-scoped user who has pod-list within their
	// own Projects but not at the cluster scope.
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if la, ok := action.(k8stesting.ListAction); ok && la.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods at the cluster scope"))
		}
		return false, nil, nil
	})

	dyn := syncTestProjectDynamicClient(syncTestProject("team-a"))

	watcher := NewSceneWatcher(client, dyn, scene.ViewModeNamespace, NamespaceFilter{})
	// Keep the test fast: this is the one legitimate use of overriding the
	// instance field directly (see its doc comment) rather than waiting out
	// the real, generously-sized cacheSyncTimeout.
	watcher.cacheSyncTimeout = 50 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	done := make(chan struct{})
	go func() {
		watcher.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
		// Start returned — the point of this test: it must not block forever
		// on an informer that can never sync.
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not return — WaitForCacheSync is not bounded, so a forbidden informer would hang the whole server at startup")
	}

	// The server can now be built on top of this watcher (main.go constructs
	// http.Server only after Start returns) — assert the part that matters
	// here: SnapshotAndSubscribe serves a real, correct initial snapshot.
	snap, _, unsubscribe := watcher.SnapshotAndSubscribe()
	t.Cleanup(unsubscribe)

	if snap.ViewMode != scene.ViewModeNamespace {
		t.Fatalf("view mode = %q, want %q", snap.ViewMode, scene.ViewModeNamespace)
	}
	var found bool
	for _, tw := range snap.Towers {
		if tw.Name != "team-a" {
			continue
		}
		for _, p := range tw.Panels {
			if p.Pod == "web" {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("initial snapshot has no Panel for team-a/web despite BuildPanels' per-namespace fallback: towers = %+v", snap.Towers)
	}

	// Requirement: which informer type(s) failed to sync must be logged
	// somewhere a user watching the process's output will see it (log.Printf,
	// this codebase's only logging path — see issue #103) — not silently
	// swallowed.
	logged := logBuf.String()
	if !strings.Contains(logged, "did not sync") {
		t.Errorf("log output does not mention an informer failing to sync: %q", logged)
	}
	if !strings.Contains(logged, "#161") {
		t.Errorf("log output does not point at the tracked follow-up issue: %q", logged)
	}
}

// TestSceneWatcher_StartSyncsFullyOnHealthyCluster is the "don't regress the
// normal path" guard: against a healthy fake clientset (nothing forbidden),
// every informer syncs well within cacheSyncTimeout, no "did not sync" warning
// is logged, and — the part a mere pass/fail on "did Start return at all"
// can't catch — Start returns promptly rather than always waiting out the
// bound. This deliberately does NOT override watcher.cacheSyncTimeout (unlike
// the degrade test above): it uses the real cacheSyncTimeout default (20s) so
// a regression that made Start always block for the full bound, even when
// every informer already synced, would blow the tight elapsed-time assertion
// below — a bare "returned within 5s" upper bound would not have caught that,
// since 5s < 20s either way.
func TestSceneWatcher_StartSyncsFullyOnHealthyCluster(t *testing.T) {
	var logBuf bytes.Buffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	client := fake.NewSimpleClientset(
		syncTestNamespace("team-a"),
		syncTestPod("team-a", "web", "node-1", corev1.PodRunning),
	)

	watcher := NewSceneWatcher(client, nil, scene.ViewModeNamespace, NamespaceFilter{})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	done := make(chan struct{})
	start := time.Now()
	go func() {
		watcher.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not return against a healthy fake clientset")
	}
	elapsed := time.Since(start)

	// Generous for CI slowness, but tight enough to catch a regression to
	// "always wait the full cacheSyncTimeout (20s)" — a fake clientset's
	// informers sync in milliseconds, so a healthy Start should return in
	// well under a second, not seconds.
	const maxHealthyStartLatency = 2 * time.Second
	if elapsed > maxHealthyStartLatency {
		t.Errorf("Start took %s against a healthy fake clientset, want under %s — did it stop returning early once synced?", elapsed, maxHealthyStartLatency)
	}

	if logged := logBuf.String(); strings.Contains(logged, "did not sync") {
		t.Errorf("healthy path logged a sync-failure warning: %q", logged)
	}
}

// TestSceneWatcher_RebuildAndBroadcast_DegradedRebuildNotPublished is the
// direct proof for the review finding that the ctx-cutoff fix made the mass
// panelRemoved wipe worse, not better: BuildScene logs a Tower/Panel build
// error but still returns a usable (possibly empty-where-degraded) SceneState
// — namespaceScopedPods returning an error rather than partial pods (see
// panels.go) only helps if something actually acts on that error, which
// nothing did. rebuildAndBroadcast must refuse to publish a rebuild whose
// error is non-nil: current (and so every subscriber) must stay exactly the
// last known-good SceneState, and no delta may be broadcast for the degraded
// one. This is tested directly against rebuildAndBroadcast (not through a
// real informer/timing setup — rebuildTimeout is a 10s package const, not
// worth actually waiting out here) by hand-building a SceneWatcher whose
// rebuild func is swapped for one that returns a canned degraded result.
func TestSceneWatcher_RebuildAndBroadcast_DegradedRebuildNotPublished(t *testing.T) {
	goodState := scene.SceneState{
		ViewMode: scene.ViewModeNamespace,
		Towers: []scene.Tower{{
			Name: "team-a",
			Panels: []scene.Panel{
				{Namespace: "team-a", Pod: "web", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
			},
		}},
	}
	// What an empty byTower from a cut-short per-namespace fallback would
	// actually produce once AttachPanels nests it: every Tower present, but
	// with its Panels wiped to empty — this is the "mass panelRemoved" shape
	// the review finding traced through BuildScene/AttachPanels.
	degradedState := scene.SceneState{
		ViewMode: scene.ViewModeNamespace,
		Towers:   []scene.Tower{{Name: "team-a", Panels: []scene.Panel{}}},
	}

	w := &SceneWatcher{
		rebuild: func(context.Context) (scene.SceneState, error) {
			return degradedState, errors.New("build scene degraded: build panels: list pods for panels: cluster-wide: pods is forbidden: ...; per-namespace fallback: per-namespace pod fallback cut short after namespace \"b\": context deadline exceeded")
		},
		current:     goodState,
		subscribers: map[int]chan scene.SceneDelta{},
		panelTower:  indexPanelTowers(goodState),
		lastBlink:   map[panelKey]time.Time{},
	}
	sub := make(chan scene.SceneDelta, subscriberBuffer)
	w.subscribers[0] = sub

	w.rebuildAndBroadcast(context.Background())

	if !reflect.DeepEqual(w.current, goodState) {
		t.Fatalf("current = %+v after a degraded rebuild, want it left unchanged at the last known-good state %+v", w.current, goodState)
	}
	select {
	case d := <-sub:
		t.Fatalf("a delta was broadcast for a degraded rebuild (mass wipe): %+v", d)
	default:
		// Correct: nothing broadcast, so no client ever sees the degraded/wiped
		// scene as if it were real.
	}
}
