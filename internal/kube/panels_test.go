package kube_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
)

// pod builds a minimal scheduled Pod for the fake clientset: named, in a
// namespace, bound to a node, with the given phase.
func pod(namespace, name, nodeName string, phase corev1.PodPhase) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec:       corev1.PodSpec{NodeName: nodeName},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

// crashLoopPod builds a Pod whose (Running) phase is overridden by a container
// stuck in CrashLoopBackOff — the state BuildPanels must surface as its own
// phase rather than reporting the underlying Running.
func crashLoopPod(namespace, name, nodeName string) *corev1.Pod {
	p := pod(namespace, name, nodeName, corev1.PodRunning)
	p.Status.ContainerStatuses = []corev1.ContainerStatus{{
		Name: "app",
		State: corev1.ContainerState{
			Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"},
		},
	}}
	return p
}

// forbiddenPodList makes the fake clientset deny listing Pods, mimicking a
// restricted user who cannot list pods at the cluster scope.
func forbiddenPodList() k8stesting.ReactionFunc {
	return func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods at the cluster scope"))
	}
}

// buildScene composes the full nested scene the way the server does: build the
// Towers, build the bucketed Panels, then nest each Tower's Panels into it. It
// returns the finished Towers so a test can assert on the nested shape end to
// end.
func buildScene(t *testing.T, objs []runtime.Object, mode scene.ViewMode) []scene.Tower {
	t.Helper()
	client := fake.NewSimpleClientset(objs...)
	ctx := context.Background()

	towers, err := kube.BuildTowers(ctx, client, nil, mode, kube.NamespaceFilter{})
	if err != nil {
		t.Fatalf("BuildTowers %s: %v", mode, err)
	}
	byTower, err := kube.BuildPanels(ctx, client, nil, mode, nil)
	if err != nil {
		t.Fatalf("BuildPanels %s: %v", mode, err)
	}
	return kube.AttachPanels(towers, byTower)
}

// panelsOf returns the Panels nested under the named Tower, failing if there is
// no such Tower.
func panelsOf(t *testing.T, towers []scene.Tower, name string) []scene.Panel {
	t.Helper()
	for _, tw := range towers {
		if tw.Name == name {
			return tw.Panels
		}
	}
	t.Fatalf("no tower named %q in %+v", name, towers)
	return nil
}

// TestBuildPanels_PhaseToColor covers the phase→color mapping for every phase,
// including the derived CrashLoopBackOff (a container waiting reason, not a pod
// phase) and the Unknown fallback for an unrecognized phase. All pods share one
// node, so they nest under that single Tower.
func TestBuildPanels_PhaseToColor(t *testing.T) {
	objs := []runtime.Object{
		node("node-a"),
		pod("default", "runner", "node-a", corev1.PodRunning),
		pod("default", "pender", "node-a", corev1.PodPending),
		pod("default", "winner", "node-a", corev1.PodSucceeded),
		pod("default", "loser", "node-a", corev1.PodFailed),
		pod("default", "mystery", "node-a", corev1.PodUnknown),
		crashLoopPod("default", "crasher", "node-a"),
	}

	panels := panelsOf(t, buildScene(t, objs, scene.ViewModeNode), "node-a")

	want := map[string]struct {
		phase scene.PodPhase
		color string
	}{
		"crasher": {scene.PodPhaseCrashLoopBackOff, scene.ColorCrashLoopBackOff},
		"loser":   {scene.PodPhaseFailed, scene.ColorFailed},
		"mystery": {scene.PodPhaseUnknown, scene.ColorUnknown},
		"pender":  {scene.PodPhasePending, scene.ColorPending},
		"runner":  {scene.PodPhaseRunning, scene.ColorRunning},
		"winner":  {scene.PodPhaseSucceeded, scene.ColorSucceeded},
	}

	if len(panels) != len(want) {
		t.Fatalf("got %d panels, want %d", len(panels), len(want))
	}
	for _, p := range panels {
		w, ok := want[p.Pod]
		if !ok {
			t.Errorf("unexpected panel for pod %q", p.Pod)
			continue
		}
		if p.Phase != w.phase {
			t.Errorf("pod %q phase = %q, want %q", p.Pod, p.Phase, w.phase)
		}
		if p.Color != w.color {
			t.Errorf("pod %q color = %q, want %q", p.Pod, p.Color, w.color)
		}
	}
}

// TestBuildPanels_DistinctColorsPerPhase pins that each phase maps to a
// distinct color, so a regression that collapsed two phases onto one color
// (making them visually indistinguishable) is caught.
func TestBuildPanels_DistinctColorsPerPhase(t *testing.T) {
	phases := []scene.PodPhase{
		scene.PodPhaseRunning,
		scene.PodPhasePending,
		scene.PodPhaseSucceeded,
		scene.PodPhaseFailed,
		scene.PodPhaseCrashLoopBackOff,
		scene.PodPhaseUnknown,
	}
	seen := make(map[string]scene.PodPhase, len(phases))
	for _, ph := range phases {
		c := scene.ColorForPhase(ph)
		if c == "" {
			t.Errorf("phase %q maps to an empty color", ph)
		}
		if prev, dup := seen[c]; dup {
			t.Errorf("phases %q and %q share color %q, want distinct", prev, ph, c)
		}
		seen[c] = ph
	}
}

// TestBuildPanels_NodeModeNesting covers Panel nesting in Node-mode: each Panel
// nests under the Tower for its pod's node, regardless of namespace, ordered by
// namespace then pod.
func TestBuildPanels_NodeModeNesting(t *testing.T) {
	objs := []runtime.Object{
		node("node-1"), node("node-2"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
		pod("team-a", "cache", "node-2", corev1.PodRunning),
	}
	towers := buildScene(t, objs, scene.ViewModeNode)

	if got := panelsOf(t, towers, "node-1"); !reflect.DeepEqual(got, []scene.Panel{
		{Namespace: "team-a", Pod: "web", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}) {
		t.Errorf("node-1 panels = %+v", got)
	}
	// node-2 holds two pods, ordered by (namespace, pod): team-a/cache then team-b/api.
	if got := panelsOf(t, towers, "node-2"); !reflect.DeepEqual(got, []scene.Panel{
		{Namespace: "team-a", Pod: "cache", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
		{Namespace: "team-b", Pod: "api", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}) {
		t.Errorf("node-2 panels = %+v", got)
	}
}

// TestBuildPanels_NamespaceModeNesting covers Panel nesting in Namespace-mode:
// each Panel nests under the Tower for its pod's namespace, regardless of node.
func TestBuildPanels_NamespaceModeNesting(t *testing.T) {
	objs := []runtime.Object{
		namespace("team-a"), namespace("team-b"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
		pod("team-a", "cache", "node-2", corev1.PodRunning),
	}
	towers := buildScene(t, objs, scene.ViewModeNamespace)

	if got := panelsOf(t, towers, "team-a"); !reflect.DeepEqual(got, []scene.Panel{
		{Namespace: "team-a", Pod: "cache", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
		{Namespace: "team-a", Pod: "web", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}) {
		t.Errorf("team-a panels = %+v", got)
	}
	if got := panelsOf(t, towers, "team-b"); !reflect.DeepEqual(got, []scene.Panel{
		{Namespace: "team-b", Pod: "api", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}) {
		t.Errorf("team-b panels = %+v", got)
	}
}

// TestBuildPanels_ReNestsOnViewModeSwitch is the re-scoping acceptance
// criterion: the very same pods nest under different Towers under the two View
// Modes, proving the owning-Tower context is derived from the View Mode and not
// hard-coded onto the pod.
func TestBuildPanels_ReNestsOnViewModeSwitch(t *testing.T) {
	objs := []runtime.Object{
		node("node-1"), node("node-2"),
		namespace("team-a"), namespace("team-b"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
	}

	// Node-mode: pods nest under their nodes.
	nodeTowers := buildScene(t, objs, scene.ViewModeNode)
	if got := panelsOf(t, nodeTowers, "node-1"); len(got) != 1 || got[0].Pod != "web" {
		t.Errorf("node-mode node-1 panels = %+v, want [web]", got)
	}
	if got := panelsOf(t, nodeTowers, "node-2"); len(got) != 1 || got[0].Pod != "api" {
		t.Errorf("node-mode node-2 panels = %+v, want [api]", got)
	}

	// Namespace-mode: the same pods nest under their namespaces instead.
	nsTowers := buildScene(t, objs, scene.ViewModeNamespace)
	if got := panelsOf(t, nsTowers, "team-a"); len(got) != 1 || got[0].Pod != "web" {
		t.Errorf("namespace-mode team-a panels = %+v, want [web]", got)
	}
	if got := panelsOf(t, nsTowers, "team-b"); len(got) != 1 || got[0].Pod != "api" {
		t.Errorf("namespace-mode team-b panels = %+v, want [api]", got)
	}
}

// TestBuildPanels_UnscheduledPodSkippedInNodeMode proves a pod with no node
// (unscheduled) contributes no Panel in Node-mode — there is no Tower to nest it
// under — yet still nests under its namespace Tower in Namespace-mode.
func TestBuildPanels_UnscheduledPodSkippedInNodeMode(t *testing.T) {
	objs := []runtime.Object{
		node("node-1"),
		namespace("default"),
		pod("default", "pending-unscheduled", "", corev1.PodPending),
		pod("default", "scheduled", "node-1", corev1.PodRunning),
	}

	nodeTowers := buildScene(t, objs, scene.ViewModeNode)
	if got := panelsOf(t, nodeTowers, "node-1"); len(got) != 1 || got[0].Pod != "scheduled" {
		t.Fatalf("node-1 panels = %+v, want only the scheduled pod", got)
	}

	nsTowers := buildScene(t, objs, scene.ViewModeNamespace)
	if got := panelsOf(t, nsTowers, "default"); len(got) != 2 {
		t.Fatalf("default namespace panels = %+v, want both pods", got)
	}
}

// TestAttachPanels_EveryTowerNonNil proves AttachPanels gives every Tower a
// non-nil Panels slice — its bucket, or an empty array when it has no pods — so
// the wire never carries a null Panels array. It also proves a bucket with no
// matching Tower is dropped.
func TestAttachPanels_EveryTowerNonNil(t *testing.T) {
	towers := []scene.Tower{
		{Name: "busy", Grid: scene.GridPosition{Col: 0, Row: 0}},
		{Name: "idle", Grid: scene.GridPosition{Col: 1, Row: 0}},
	}
	byTower := map[string][]scene.Panel{
		"busy":  {{Namespace: "default", Pod: "p", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning}},
		"ghost": {{Namespace: "default", Pod: "orphan", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning}},
	}

	got := kube.AttachPanels(towers, byTower)

	for _, tw := range got {
		if tw.Panels == nil {
			t.Errorf("tower %q has nil Panels, want non-nil (empty array on the wire, not null)", tw.Name)
		}
		if tw.Name == "ghost" {
			t.Error("AttachPanels invented a tower for a Tower-less bucket")
		}
	}
	if n := len(panelsOf(t, got, "busy")); n != 1 {
		t.Errorf("busy panels = %d, want 1", n)
	}
	if n := len(panelsOf(t, got, "idle")); n != 0 {
		t.Errorf("idle panels = %d, want 0 (empty, not nil)", n)
	}
}

// TestBuildPanels_Empty proves an empty cluster yields a non-nil (empty) map,
// so nesting still gives every Tower an empty (non-nil) Panels slice.
func TestBuildPanels_Empty(t *testing.T) {
	client := fake.NewSimpleClientset()

	got, err := kube.BuildPanels(context.Background(), client, nil, scene.ViewModeNode, nil)
	if err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}
	if got == nil {
		t.Fatal("byTower map is nil, want non-nil empty")
	}
	if len(got) != 0 {
		t.Fatalf("byTower = %+v, want empty", got)
	}
}

// TestBuildPanels_ListForbiddenDegrades proves that when pods can't be listed
// cluster-wide AND no per-namespace fallback source is available (neither
// Namespaces nor, absent a dynamic client, Projects), BuildPanels degrades to a
// non-nil empty map with an informational error rather than hard-failing
// (ADR-0002), mirroring BuildTowers' TestBuildTowers_NamespaceMode_NoSourceDegrades.
func TestBuildPanels_ListForbiddenDegrades(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "pods", forbiddenPodList())
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())

	// nil dynamic client → no OpenShift Project fallback available either.
	got, err := kube.BuildPanels(context.Background(), client, nil, scene.ViewModeNamespace, nil)
	if err == nil {
		t.Fatal("expected an informational error when pods can't be listed, got nil")
	}
	if got == nil {
		t.Fatal("byTower map is nil, want non-nil empty so nesting still yields [] not null")
	}
	if len(got) != 0 {
		t.Fatalf("byTower = %+v, want empty on degradation", got)
	}
}

// TestBuildPanels_PerNamespaceFallback_Namespaces proves that when pods can't
// be listed cluster-wide but Namespaces are listable (and pods are listable
// per-namespace), BuildPanels falls back to one Pods(ns).List per Namespace and
// still produces real Panels, rather than degrading to empty. This is the
// vanilla-Kubernetes shape of the fallback (no dynamic client involved).
func TestBuildPanels_PerNamespaceFallback_Namespaces(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("team-a"), namespace("team-b"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
	)
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		// Only forbid the cluster-wide (all-namespaces) list; a namespace-scoped
		// list still passes through to the fake clientset's normal handling.
		if la, ok := action.(k8stesting.ListAction); ok && la.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods at the cluster scope"))
		}
		return false, nil, nil
	})

	got, err := kube.BuildPanels(context.Background(), client, nil, scene.ViewModeNamespace, nil)
	if err != nil {
		t.Fatalf("BuildPanels per-namespace fallback: %v", err)
	}
	if n := len(got["team-a"]); n != 1 || got["team-a"][0].Pod != "web" {
		t.Errorf("team-a panels = %+v, want [web]", got["team-a"])
	}
	if n := len(got["team-b"]); n != 1 || got["team-b"][0].Pod != "api" {
		t.Errorf("team-b panels = %+v, want [api]", got["team-b"])
	}
}

// TestBuildPanels_OpenShiftProjectFallback covers issue #55's acceptance
// criterion directly: a project-scoped OpenShift user who can list their own
// Projects but not pods (or Namespaces) at the cluster scope still gets real
// Panels on their Towers, built by listing pods once per admitted Project,
// rather than an empty Panel set (ADR-0002 graceful degradation avoided).
func TestBuildPanels_OpenShiftProjectFallback(t *testing.T) {
	client := fake.NewSimpleClientset(
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
		pod("other", "ignored", "node-3", corev1.PodRunning),
	)
	// Only cluster-wide pod listing is forbidden — a namespace-scoped list still
	// passes through, matching a project-scoped OpenShift user who lacks
	// cluster-level `list pods` but has it within their own Projects.
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if la, ok := action.(k8stesting.ListAction); ok && la.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods at the cluster scope"))
		}
		return false, nil, nil
	})
	client.PrependReactor("list", "namespaces", forbiddenNamespaceList())

	// The user's accessible Projects are a subset of the cluster's Namespaces
	// (CONTEXT.md's Project definition) — "other" has pods but is not one of
	// this user's Projects, so it must not contribute a Panel.
	dyn := projectDynamicClient(project("team-a"), project("team-b"))

	towers := []scene.Tower{
		{Name: "team-a", Grid: scene.GridPosition{Col: 0, Row: 0}},
		{Name: "team-b", Grid: scene.GridPosition{Col: 1, Row: 0}},
	}

	byTower, err := kube.BuildPanels(context.Background(), client, dyn, scene.ViewModeNamespace, nil)
	if err != nil {
		t.Fatalf("BuildPanels openshift project fallback: %v", err)
	}
	got := kube.AttachPanels(towers, byTower)

	if got := panelsOf(t, got, "team-a"); len(got) != 1 || got[0].Pod != "web" {
		t.Errorf("team-a panels = %+v, want [web]", got)
	}
	if got := panelsOf(t, got, "team-b"); len(got) != 1 || got[0].Pod != "api" {
		t.Errorf("team-b panels = %+v, want [api]", got)
	}
	if _, ok := byTower["other"]; ok {
		t.Errorf("byTower has an entry for %q, an un-admitted Project's namespace", "other")
	}
}

// TestBuildPanels_PerNamespaceFallback_SkipsFailingNamespace proves that a
// namespace whose own pod listing fails during the fallback is skipped (and
// logged) rather than aborting every other admitted namespace's Panels.
func TestBuildPanels_PerNamespaceFallback_SkipsFailingNamespace(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("ok"), namespace("broken"),
		pod("ok", "web", "node-1", corev1.PodRunning),
		pod("broken", "api", "node-2", corev1.PodRunning),
	)
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		la, ok := action.(k8stesting.ListAction)
		if !ok {
			return false, nil, nil
		}
		switch la.GetNamespace() {
		case "":
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods at the cluster scope"))
		case "broken":
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods in this namespace"))
		default:
			return false, nil, nil
		}
	})

	got, err := kube.BuildPanels(context.Background(), client, nil, scene.ViewModeNamespace, nil)
	if err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}
	if n := len(got["ok"]); n != 1 || got["ok"][0].Pod != "web" {
		t.Errorf("ok panels = %+v, want [web]", got["ok"])
	}
	if _, present := got["broken"]; present {
		t.Errorf("byTower has an entry for the namespace whose own list failed: %+v", got["broken"])
	}
}

// TestBuildPanels_ClusterWideListUsedWhenPermitted proves the cluster-wide
// Pods list is still the path taken whenever it's permitted — the fallback
// added for issue #55 must not run when nothing is forbidden. Regressing to
// "always fall back" would still pass every fallback-specific test above (the
// fallback covers the same pods when nothing is actually restricted), so this
// asserts on the client's recorded Actions rather than only the resulting
// Panels: exactly one Pods list call was made, and it was the cluster-wide one
// (empty namespace), not a per-namespace fan-out.
func TestBuildPanels_ClusterWideListUsedWhenPermitted(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("team-a"), namespace("team-b"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
	)

	if _, err := kube.BuildPanels(context.Background(), client, nil, scene.ViewModeNamespace, nil); err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}

	var podListNamespaces []string
	for _, action := range client.Actions() {
		if action.GetVerb() != "list" || action.GetResource().Resource != "pods" {
			continue
		}
		podListNamespaces = append(podListNamespaces, action.GetNamespace())
	}

	if len(podListNamespaces) != 1 {
		t.Fatalf("got %d Pods list calls %v, want exactly 1 (the cluster-wide list) — a per-namespace fallback ran even though nothing was forbidden", len(podListNamespaces), podListNamespaces)
	}
	if podListNamespaces[0] != "" {
		t.Errorf("the one Pods list call was scoped to namespace %q, want the cluster-wide list (empty namespace)", podListNamespaces[0])
	}
}

// TestBuildPanels_NonForbiddenClusterWideErrorNotRetriedPerNamespace proves
// that a cluster-wide Pods list failure NOT caused by a permission denial
// (e.g. a timeout, or any other transient/transport error) fails BuildPanels
// directly rather than triggering the 1+N-call per-namespace fallback: only a
// genuine `apierrors.IsForbidden` — the OpenShift project-scoped-user shape the
// fallback exists for — should fan out per namespace.
func TestBuildPanels_NonForbiddenClusterWideErrorNotRetriedPerNamespace(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("team-a"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
	)
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if la, ok := action.(k8stesting.ListAction); ok && la.GetNamespace() == "" {
			return true, nil, apierrors.NewTimeoutError("cluster-wide pods list timed out", 0)
		}
		return false, nil, nil
	})

	got, err := kube.BuildPanels(context.Background(), client, nil, scene.ViewModeNamespace, nil)
	if err == nil {
		t.Fatal("expected an error from a non-forbidden cluster-wide list failure, got nil")
	}
	if len(got) != 0 {
		t.Fatalf("byTower = %+v, want empty (no per-namespace fallback should have run)", got)
	}

	for _, action := range client.Actions() {
		if action.GetVerb() == "list" && action.GetResource().Resource == "pods" && action.GetNamespace() != "" {
			t.Errorf("unexpected per-namespace Pods list for namespace %q: a non-forbidden cluster-wide error must not trigger the fallback", action.GetNamespace())
		}
	}
}

// TestBuildPanels_PerNamespaceFallback_DeadlineCutShortFailsNotPartial proves
// that when the per-namespace fallback is itself cut short by ctx being done
// (e.g. rebuildTimeout expiring mid-enumeration), BuildPanels fails outright
// rather than silently returning the partial pods collected before the
// deadline hit as a success — a partial result would let BuildScene/scene.Diff
// broadcast a scene missing most Panels (a mass panelRemoved) to every client
// over what was really just a transient timeout.
func TestBuildPanels_PerNamespaceFallback_DeadlineCutShortFailsNotPartial(t *testing.T) {
	client := fake.NewSimpleClientset(
		namespace("team-a"), namespace("team-b"), namespace("team-c"),
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
		pod("team-c", "cache", "node-3", corev1.PodRunning),
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var nsCalls int
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		la, ok := action.(k8stesting.ListAction)
		if !ok {
			return false, nil, nil
		}
		if la.GetNamespace() == "" {
			return true, nil, apierrors.NewForbidden(
				schema.GroupResource{Resource: "pods"}, "", errors.New("cannot list pods at the cluster scope"))
		}
		nsCalls++
		if nsCalls == 2 {
			// Simulate rebuildTimeout expiring mid-enumeration: ctx is already
			// done by the time this (second) per-namespace call fails, exactly
			// as a real deadline would leave every remaining namespace's List
			// failing too.
			cancel()
			return true, nil, context.DeadlineExceeded
		}
		return false, nil, nil
	})

	got, err := kube.BuildPanels(ctx, client, nil, scene.ViewModeNamespace, nil)
	if err == nil {
		t.Fatalf("expected an error when the fallback is cut short by a deadline, got byTower = %+v", got)
	}
	if len(got) != 0 {
		t.Fatalf("byTower = %+v, want empty — a deadline cutting the fallback short must not silently publish a partial scene", got)
	}
}
