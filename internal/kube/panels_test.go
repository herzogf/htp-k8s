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
	byTower, err := kube.BuildPanels(ctx, client, mode, nil)
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

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNode, nil)
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
// (a restricted user), BuildPanels degrades to a non-nil empty map with an
// informational error rather than hard-failing (ADR-0002), mirroring
// BuildTowers.
func TestBuildPanels_ListForbiddenDegrades(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "pods", forbiddenPodList())

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNamespace, nil)
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
