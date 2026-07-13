package kube_test

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
)

// deltaTimeout bounds each wait for a delta to arrive from the watcher's
// informer→worker→broadcast path. Generous so the async informer sync/dispatch
// never flakes, while a genuinely missing delta still fails within a few seconds.
const deltaTimeout = 3 * time.Second

// startWatcher builds a SceneWatcher over the fake clientset seeded with objs,
// starts it (tearing it down when the test ends), and returns it. The returned
// watcher's caches are synced, so an immediate SnapshotAndSubscribe reflects objs.
func startWatcher(t *testing.T, mode scene.ViewMode, objs ...runtime.Object) (*kube.SceneWatcher, *fake.Clientset) {
	t.Helper()
	client := fake.NewSimpleClientset(objs...)
	w := kube.NewSceneWatcher(client, nil, mode, kube.NamespaceFilter{})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	w.Start(ctx)
	return w, client
}

// recvDelta reads one delta from ch, failing the test on timeout or on the
// channel closing early (a dropped subscriber).
func recvDelta(t *testing.T, ch <-chan scene.SceneDelta) scene.SceneDelta {
	t.Helper()
	select {
	case d, ok := <-ch:
		if !ok {
			t.Fatal("delta channel closed unexpectedly (subscriber dropped)")
		}
		return d
	case <-time.After(deltaTimeout):
		t.Fatal("timed out waiting for a delta")
		return scene.SceneDelta{}
	}
}

// recvStructuralDelta reads deltas from ch until a non-blink (structural) delta
// arrives, skipping any transient DeltaPanelBlink pulses. The lifecycle tests
// assert on structural add/update/remove deltas; a phase transition also emits a
// blink (its own concern, covered by the blink tests), which may interleave with
// the structural delta and is ignored here.
func recvStructuralDelta(t *testing.T, ch <-chan scene.SceneDelta) scene.SceneDelta {
	t.Helper()
	for {
		d := recvDelta(t, ch)
		if d.Type == scene.DeltaPanelBlink {
			continue
		}
		return d
	}
}

// expectNoDelta asserts no delta arrives within a short window — used to prove a
// change that shouldn't affect the scene (e.g. a no-op update) emits nothing.
func expectNoDelta(t *testing.T, ch <-chan scene.SceneDelta) {
	t.Helper()
	select {
	case d, ok := <-ch:
		if ok {
			t.Fatalf("unexpected delta: %+v", d)
		}
	case <-time.After(300 * time.Millisecond):
	}
}

// TestSceneWatcher_NodeMode_PodLifecycle covers the add/update/remove sequence
// for Pods in Node-mode: a Panel appears, changes phase, then disappears, each
// as exactly the expected delta.
func TestSceneWatcher_NodeMode_PodLifecycle(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode, node("node-a"))
	ctx := context.Background()

	snap, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)
	if len(snap.Towers) != 1 || snap.Towers[0].Name != "node-a" {
		t.Fatalf("snapshot = %+v, want single tower node-a", snap.Towers)
	}
	if len(snap.Towers[0].Panels) != 0 {
		t.Fatalf("node-a starts with %d panels, want 0", len(snap.Towers[0].Panels))
	}

	// Add a pod on node-a → PanelAdded.
	p := pod("team", "web-1", "node-a", corev1.PodPending)
	if _, err := client.CoreV1().Pods("team").Create(ctx, p, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	got := recvDelta(t, ch)
	if got.Type != scene.DeltaPanelAdded || got.TowerName != "node-a" ||
		got.Panel == nil || got.Panel.Pod != "web-1" || got.Panel.Phase != scene.PodPhasePending {
		t.Fatalf("add delta = %+v, want PanelAdded node-a web-1 Pending", got)
	}

	// Move the pod to Running → PanelUpdated with the new phase/color.
	p.Status.Phase = corev1.PodRunning
	if _, err := client.CoreV1().Pods("team").Update(ctx, p, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update pod: %v", err)
	}
	got = recvStructuralDelta(t, ch)
	if got.Type != scene.DeltaPanelUpdated || got.Panel == nil ||
		got.Panel.Phase != scene.PodPhaseRunning || got.Panel.Color != scene.ColorRunning {
		t.Fatalf("update delta = %+v, want PanelUpdated Running/%s", got, scene.ColorRunning)
	}

	// Delete the pod → PanelRemoved identified by namespace/pod.
	if err := client.CoreV1().Pods("team").Delete(ctx, "web-1", metav1.DeleteOptions{}); err != nil {
		t.Fatalf("delete pod: %v", err)
	}
	got = recvStructuralDelta(t, ch)
	if got.Type != scene.DeltaPanelRemoved || got.TowerName != "node-a" ||
		got.Namespace != "team" || got.Pod != "web-1" {
		t.Fatalf("remove delta = %+v, want PanelRemoved node-a team/web-1", got)
	}
}

// TestSceneWatcher_NodeMode_NodeLifecycle covers Node add/remove in Node-mode:
// a Tower appears then disappears. node-a is seeded so adding/removing node-b
// (which sorts after it) leaves node-a's grid slot untouched, isolating the
// Tower add/remove delta from any relayout.
func TestSceneWatcher_NodeMode_NodeLifecycle(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode, node("node-a"))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// Add node-b → TowerAdded.
	if _, err := client.CoreV1().Nodes().Create(ctx, node("node-b"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create node: %v", err)
	}
	got := recvDelta(t, ch)
	if got.Type != scene.DeltaTowerAdded || got.Tower == nil || got.Tower.Name != "node-b" {
		t.Fatalf("add delta = %+v, want TowerAdded node-b", got)
	}

	// Remove node-b → TowerRemoved.
	if err := client.CoreV1().Nodes().Delete(ctx, "node-b", metav1.DeleteOptions{}); err != nil {
		t.Fatalf("delete node: %v", err)
	}
	got = recvDelta(t, ch)
	if got.Type != scene.DeltaTowerRemoved || got.TowerName != "node-b" {
		t.Fatalf("remove delta = %+v, want TowerRemoved node-b", got)
	}
}

// TestSceneWatcher_NamespaceMode covers the full add/update/remove sequence in
// Namespace-mode — for both Pods (as Panels homed on their namespace Tower) and
// Namespaces (as Towers) — proving the watch set and Panel homing follow the
// View Mode just like BuildScene, the Namespace-mode counterpart to the
// Node-mode lifecycle tests above.
func TestSceneWatcher_NamespaceMode(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNamespace, namespace("alpha"))
	ctx := context.Background()

	snap, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)
	if len(snap.Towers) != 1 || snap.Towers[0].Name != "alpha" {
		t.Fatalf("snapshot = %+v, want single tower alpha", snap.Towers)
	}

	// Pod add → PanelAdded on the alpha Tower (namespace homing).
	p := pod("alpha", "job-1", "node-x", corev1.PodPending)
	if _, err := client.CoreV1().Pods("alpha").Create(ctx, p, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	got := recvDelta(t, ch)
	if got.Type != scene.DeltaPanelAdded || got.TowerName != "alpha" || got.Panel == nil || got.Panel.Pod != "job-1" {
		t.Fatalf("pod add delta = %+v, want PanelAdded alpha job-1", got)
	}

	// Pod update → PanelUpdated (phase change) on the alpha Tower.
	p.Status.Phase = corev1.PodRunning
	if _, err := client.CoreV1().Pods("alpha").Update(ctx, p, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update pod: %v", err)
	}
	got = recvStructuralDelta(t, ch)
	if got.Type != scene.DeltaPanelUpdated || got.TowerName != "alpha" ||
		got.Panel == nil || got.Panel.Phase != scene.PodPhaseRunning {
		t.Fatalf("pod update delta = %+v, want PanelUpdated alpha Running", got)
	}

	// Pod remove → PanelRemoved from the alpha Tower.
	if err := client.CoreV1().Pods("alpha").Delete(ctx, "job-1", metav1.DeleteOptions{}); err != nil {
		t.Fatalf("delete pod: %v", err)
	}
	got = recvStructuralDelta(t, ch)
	if got.Type != scene.DeltaPanelRemoved || got.TowerName != "alpha" ||
		got.Namespace != "alpha" || got.Pod != "job-1" {
		t.Fatalf("pod remove delta = %+v, want PanelRemoved alpha alpha/job-1", got)
	}

	// Namespace add → TowerAdded. "beta" sorts after "alpha", so alpha's slot is
	// unchanged and only the add is emitted.
	if _, err := client.CoreV1().Namespaces().Create(ctx, namespace("beta"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create namespace: %v", err)
	}
	got = recvStructuralDelta(t, ch)
	if got.Type != scene.DeltaTowerAdded || got.Tower == nil || got.Tower.Name != "beta" {
		t.Fatalf("namespace add delta = %+v, want TowerAdded beta", got)
	}

	// Namespace remove → TowerRemoved. Removing "beta" (the trailing slot) leaves
	// alpha's slot unchanged, isolating the remove delta from any relayout.
	if err := client.CoreV1().Namespaces().Delete(ctx, "beta", metav1.DeleteOptions{}); err != nil {
		t.Fatalf("delete namespace: %v", err)
	}
	got = recvDelta(t, ch)
	if got.Type != scene.DeltaTowerRemoved || got.TowerName != "beta" {
		t.Fatalf("namespace remove delta = %+v, want TowerRemoved beta", got)
	}
}

// TestSceneWatcher_UnscheduledPodInNodeMode proves a Pod with no owning Tower
// under the mode (an unscheduled pod in Node-mode) produces no delta — it has no
// Tower to sit on — matching BuildPanels' skip.
func TestSceneWatcher_UnscheduledPodInNodeMode(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode, node("node-a"))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// Unscheduled pod (empty NodeName): no Tower, so no Panel, so no delta.
	if _, err := client.CoreV1().Pods("team").Create(ctx, pod("team", "pending-1", "", corev1.PodPending), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	expectNoDelta(t, ch)
}

// TestSceneWatcher_LateSubscriberGetsCurrentSnapshot proves a subscriber that
// joins after changes have already landed receives them in its snapshot, not as
// deltas — the reconnection contract (a fresh full snapshot on connect).
func TestSceneWatcher_LateSubscriberGetsCurrentSnapshot(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode, node("node-a"))
	ctx := context.Background()

	// First subscriber observes a pod being added.
	_, ch, unsub := w.SnapshotAndSubscribe()
	if _, err := client.CoreV1().Pods("team").Create(ctx, pod("team", "web-1", "node-a", corev1.PodRunning), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	if got := recvDelta(t, ch); got.Type != scene.DeltaPanelAdded {
		t.Fatalf("first subscriber delta = %+v, want PanelAdded", got)
	}
	unsub()

	// A fresh subscriber (a reconnect) sees the pod already in its snapshot.
	snap, ch2, unsub2 := w.SnapshotAndSubscribe()
	t.Cleanup(unsub2)
	var panels []scene.Panel
	for _, tw := range snap.Towers {
		if tw.Name == "node-a" {
			panels = tw.Panels
		}
	}
	if len(panels) != 1 || panels[0].Pod != "web-1" {
		t.Fatalf("late snapshot node-a panels = %+v, want [web-1]", panels)
	}
	expectNoDelta(t, ch2)
}
