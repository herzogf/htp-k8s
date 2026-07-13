package kube_test

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// podWithRestarts builds a scheduled Pod carrying a single container status with
// the given total restart count — the state a restart blink is detected from.
func podWithRestarts(namespace, name, nodeName string, phase corev1.PodPhase, restarts int32) *corev1.Pod {
	p := pod(namespace, name, nodeName, phase)
	p.Status.ContainerStatuses = []corev1.ContainerStatus{{
		Name:         "app",
		RestartCount: restarts,
		State:        corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
	}}
	return p
}

// recvBlink reads deltas from ch until a DeltaPanelBlink arrives, skipping the
// structural deltas (e.g. the PanelUpdated a phase change also emits) that may
// interleave with it. Fails on timeout via recvDelta.
func recvBlink(t *testing.T, ch <-chan scene.SceneDelta) scene.SceneDelta {
	t.Helper()
	for {
		d := recvDelta(t, ch)
		if d.Type == scene.DeltaPanelBlink {
			return d
		}
	}
}

// collectDeltas drains ch for the given window, returning everything that
// arrived. Used to assert on the whole burst a change produced (e.g. that a
// coalesced storm yields exactly one blink).
func collectDeltas(ch <-chan scene.SceneDelta, window time.Duration) []scene.SceneDelta {
	var got []scene.SceneDelta
	deadline := time.After(window)
	for {
		select {
		case d, ok := <-ch:
			if !ok {
				return got
			}
			got = append(got, d)
		case <-deadline:
			return got
		}
	}
}

// TestSceneWatcher_Blink_PhaseTransition proves a pod phase transition emits a
// blink-trigger delta (Activity phaseChange) naming the correct Panel by
// tower + namespace/pod, alongside the structural PanelUpdated its color change
// produces.
func TestSceneWatcher_Blink_PhaseTransition(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode,
		node("node-a"), pod("team", "web-1", "node-a", corev1.PodPending))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// Pending → Running is a phase transition: blink-worthy activity.
	p := pod("team", "web-1", "node-a", corev1.PodRunning)
	if _, err := client.CoreV1().Pods("team").Update(ctx, p, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update pod: %v", err)
	}

	got := recvBlink(t, ch)
	if got.TowerName != "node-a" || got.Namespace != "team" || got.Pod != "web-1" ||
		got.Activity != scene.ActivityPhaseChange {
		t.Fatalf("blink delta = %+v, want panelBlink node-a team/web-1 phaseChange", got)
	}
}

// TestSceneWatcher_Blink_Restart proves a container restart-count increase emits
// a blink (Activity restart) for the pod's Panel. The phase is unchanged
// (Running throughout), so no structural PanelUpdated accompanies it — the blink
// is the sole signal that the restart happened.
func TestSceneWatcher_Blink_Restart(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode,
		node("node-a"), podWithRestarts("team", "web-1", "node-a", corev1.PodRunning, 0))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// Restart count 0 → 1: a container restarted.
	if _, err := client.CoreV1().Pods("team").Update(ctx,
		podWithRestarts("team", "web-1", "node-a", corev1.PodRunning, 1), metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update pod: %v", err)
	}

	got := recvBlink(t, ch)
	if got.TowerName != "node-a" || got.Namespace != "team" || got.Pod != "web-1" ||
		got.Activity != scene.ActivityRestart {
		t.Fatalf("blink delta = %+v, want panelBlink node-a team/web-1 restart", got)
	}
}

// TestSceneWatcher_Blink_Event proves a new Kubernetes Event about a pod emits a
// blink (Activity event) for that pod's Panel. Events are a separate resource
// (the namespaced Events API, readable with default permissions), watched
// alongside pods purely for this signal.
func TestSceneWatcher_Blink_Event(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNamespace,
		namespace("alpha"), pod("alpha", "job-1", "node-x", corev1.PodRunning))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// A fresh Warning Event about the pod, created after the caches synced, is
	// activity on its Panel.
	ev := podEvent("alpha", "evt-1", "job-1", "", "Warning", "BackOff", metav1.Now())
	if _, err := client.CoreV1().Events("alpha").Create(ctx, ev, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create event: %v", err)
	}

	got := recvBlink(t, ch)
	if got.TowerName != "alpha" || got.Namespace != "alpha" || got.Pod != "job-1" ||
		got.Activity != scene.ActivityEvent {
		t.Fatalf("blink delta = %+v, want panelBlink alpha alpha/job-1 event", got)
	}
}

// TestSceneWatcher_Blink_EventRecurrence proves a *recurrence* of an Event —
// which Kubernetes' EventRecorder records by bumping the existing Event's Count
// rather than creating a new object — also blinks. The Event is seeded before the
// watcher syncs (so its initial Add is suppressed and doesn't debounce), then its
// Count is bumped, which must surface as an event blink via the update path.
func TestSceneWatcher_Blink_EventRecurrence(t *testing.T) {
	seeded := podEvent("alpha", "evt-1", "job-1", "", "Warning", "BackOff", metav1.Now())
	w, client := startWatcher(t, scene.ViewModeNamespace,
		namespace("alpha"), pod("alpha", "job-1", "node-x", corev1.PodRunning), seeded)
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// The same condition recurs: EventRecorder bumps Count on the existing Event.
	recurred := podEvent("alpha", "evt-1", "job-1", "", "Warning", "BackOff", metav1.Now())
	recurred.Count = seeded.Count + 1
	if _, err := client.CoreV1().Events("alpha").Update(ctx, recurred, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update event: %v", err)
	}

	got := recvBlink(t, ch)
	if got.TowerName != "alpha" || got.Namespace != "alpha" || got.Pod != "job-1" ||
		got.Activity != scene.ActivityEvent {
		t.Fatalf("blink delta = %+v, want panelBlink alpha alpha/job-1 event", got)
	}
}

// TestSceneWatcher_Blink_Coalesced proves a burst of activity on one Panel
// collapses to a single blink within the debounce window, so a flapping pod
// can't flood the delta stream. Two Events for the same pod are created
// back-to-back; only one blink should result.
func TestSceneWatcher_Blink_Coalesced(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNamespace,
		namespace("alpha"), pod("alpha", "job-1", "node-x", corev1.PodRunning))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	for _, name := range []string{"evt-1", "evt-2"} {
		ev := podEvent("alpha", name, "job-1", "", "Warning", "BackOff", metav1.Now())
		if _, err := client.CoreV1().Events("alpha").Create(ctx, ev, metav1.CreateOptions{}); err != nil {
			t.Fatalf("create event %s: %v", name, err)
		}
	}

	blinks := 0
	for _, d := range collectDeltas(ch, 300*time.Millisecond) {
		if d.Type == scene.DeltaPanelBlink {
			blinks++
		}
	}
	if blinks != 1 {
		t.Fatalf("blinks in window = %d, want 1 (debounced)", blinks)
	}
}

// TestSceneWatcher_Blink_NoPanelNoBlink proves a blink is emitted only for a pod
// that actually has a Panel in the scene: an Event about an unscheduled pod in
// Node-mode (no Node, so no Tower, so no Panel) produces nothing. This is the
// homing gate — the blink resolves through the built scene, so it never fires
// for a pod the frontend has no Panel for (also how the Namespace Filter is
// honored for free).
func TestSceneWatcher_Blink_NoPanelNoBlink(t *testing.T) {
	w, client := startWatcher(t, scene.ViewModeNode, node("node-a"))
	ctx := context.Background()

	_, ch, unsub := w.SnapshotAndSubscribe()
	t.Cleanup(unsub)

	// An Event about a pod that has no Panel (never created / unscheduled): no
	// Panel to blink.
	ev := podEvent("team", "evt-1", "ghost", "", "Warning", "BackOff", metav1.Now())
	if _, err := client.CoreV1().Events("team").Create(ctx, ev, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create event: %v", err)
	}
	expectNoDelta(t, ch)
}
