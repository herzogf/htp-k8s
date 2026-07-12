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

// TestBuildPanels_PhaseToColor covers the phase→color mapping for every phase,
// including the derived CrashLoopBackOff (a container waiting reason, not a pod
// phase) and the Unknown fallback for an unrecognized phase.
func TestBuildPanels_PhaseToColor(t *testing.T) {
	client := fake.NewSimpleClientset(
		pod("default", "runner", "node-a", corev1.PodRunning),
		pod("default", "pender", "node-a", corev1.PodPending),
		pod("default", "winner", "node-a", corev1.PodSucceeded),
		pod("default", "loser", "node-a", corev1.PodFailed),
		pod("default", "mystery", "node-a", corev1.PodUnknown),
		crashLoopPod("default", "crasher", "node-a"),
	)

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNode)
	if err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}

	// Panels sort by (Tower, Namespace, Pod); all share tower node-a and
	// namespace default, so the order here is pod name alphabetical.
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

	if len(got) != len(want) {
		t.Fatalf("got %d panels, want %d", len(got), len(want))
	}
	for _, p := range got {
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

// TestBuildPanels_NodeModeScoping covers Panel→Tower scoping in Node-mode: a
// Panel's Tower is the pod's node, regardless of namespace.
func TestBuildPanels_NodeModeScoping(t *testing.T) {
	client := fake.NewSimpleClientset(
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
		pod("team-a", "cache", "node-2", corev1.PodRunning),
	)

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNode)
	if err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}

	want := []scene.Panel{
		{Namespace: "team-a", Pod: "web", Tower: "node-1", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
		{Namespace: "team-a", Pod: "cache", Tower: "node-2", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
		{Namespace: "team-b", Pod: "api", Tower: "node-2", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("panels = %+v, want %+v", got, want)
	}
}

// TestBuildPanels_NamespaceModeScoping covers Panel→Tower scoping in
// Namespace-mode: a Panel's Tower is the pod's namespace, regardless of node.
func TestBuildPanels_NamespaceModeScoping(t *testing.T) {
	client := fake.NewSimpleClientset(
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
		pod("team-a", "cache", "node-2", corev1.PodRunning),
	)

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNamespace)
	if err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}

	want := []scene.Panel{
		{Namespace: "team-a", Pod: "cache", Tower: "team-a", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
		{Namespace: "team-a", Pod: "web", Tower: "team-a", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
		{Namespace: "team-b", Pod: "api", Tower: "team-b", Phase: scene.PodPhaseRunning, Color: scene.ColorRunning},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("panels = %+v, want %+v", got, want)
	}
}

// TestBuildPanels_ReScopesOnViewModeSwitch is the re-scoping acceptance
// criterion: the very same pods yield different Panel.Tower values under the
// two View Modes, proving the owning-Tower context is derived from the View
// Mode and not hard-coded onto the pod.
func TestBuildPanels_ReScopesOnViewModeSwitch(t *testing.T) {
	client := fake.NewSimpleClientset(
		pod("team-a", "web", "node-1", corev1.PodRunning),
		pod("team-b", "api", "node-2", corev1.PodRunning),
	)
	ctx := context.Background()

	nodeMode, err := kube.BuildPanels(ctx, client, scene.ViewModeNode)
	if err != nil {
		t.Fatalf("BuildPanels node mode: %v", err)
	}
	nsMode, err := kube.BuildPanels(ctx, client, scene.ViewModeNamespace)
	if err != nil {
		t.Fatalf("BuildPanels namespace mode: %v", err)
	}

	towerByPod := func(panels []scene.Panel) map[string]string {
		m := make(map[string]string, len(panels))
		for _, p := range panels {
			m[p.Pod] = p.Tower
		}
		return m
	}
	nodeTowers, nsTowers := towerByPod(nodeMode), towerByPod(nsMode)

	if nodeTowers["web"] != "node-1" {
		t.Errorf("node-mode tower for web = %q, want node-1", nodeTowers["web"])
	}
	if nsTowers["web"] != "team-a" {
		t.Errorf("namespace-mode tower for web = %q, want team-a", nsTowers["web"])
	}
	if nodeTowers["api"] != "node-2" {
		t.Errorf("node-mode tower for api = %q, want node-2", nodeTowers["api"])
	}
	if nsTowers["api"] != "team-b" {
		t.Errorf("namespace-mode tower for api = %q, want team-b", nsTowers["api"])
	}
}

// TestBuildPanels_UnscheduledPodSkippedInNodeMode proves a pod with no node
// (unscheduled) yields no Panel in Node-mode — there is no Tower to place it on
// — yet still yields one in Namespace-mode, where its namespace is its Tower.
func TestBuildPanels_UnscheduledPodSkippedInNodeMode(t *testing.T) {
	client := fake.NewSimpleClientset(
		pod("default", "pending-unscheduled", "", corev1.PodPending),
		pod("default", "scheduled", "node-1", corev1.PodRunning),
	)
	ctx := context.Background()

	nodeMode, err := kube.BuildPanels(ctx, client, scene.ViewModeNode)
	if err != nil {
		t.Fatalf("BuildPanels node mode: %v", err)
	}
	if len(nodeMode) != 1 || nodeMode[0].Pod != "scheduled" {
		t.Fatalf("node-mode panels = %+v, want only the scheduled pod", nodeMode)
	}

	nsMode, err := kube.BuildPanels(ctx, client, scene.ViewModeNamespace)
	if err != nil {
		t.Fatalf("BuildPanels namespace mode: %v", err)
	}
	if len(nsMode) != 2 {
		t.Fatalf("namespace-mode panels = %+v, want both pods", nsMode)
	}
}

// TestBuildPanels_Empty proves an empty cluster yields a non-nil empty Panel
// slice (so the wire carries [] rather than null).
func TestBuildPanels_Empty(t *testing.T) {
	client := fake.NewSimpleClientset()

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNode)
	if err != nil {
		t.Fatalf("BuildPanels: %v", err)
	}
	if got == nil {
		t.Fatal("panels slice is nil, want non-nil empty")
	}
	if len(got) != 0 {
		t.Fatalf("panels = %+v, want empty", got)
	}
}

// TestBuildPanels_ListForbiddenDegrades proves that when pods can't be listed
// (a restricted user), BuildPanels degrades to a non-nil empty Panel set with
// an informational error rather than hard-failing (ADR-0002), mirroring
// BuildTowers.
func TestBuildPanels_ListForbiddenDegrades(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "pods", forbiddenPodList())

	got, err := kube.BuildPanels(context.Background(), client, scene.ViewModeNamespace)
	if err == nil {
		t.Fatal("expected an informational error when pods can't be listed, got nil")
	}
	if got == nil {
		t.Fatal("panels slice is nil, want non-nil empty so the wire carries [] not null")
	}
	if len(got) != 0 {
		t.Fatalf("panels = %+v, want empty on degradation", got)
	}
}
