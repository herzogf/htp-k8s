//go:build integration

package kube_test

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/herzogf/htp-k8s/internal/kube"
	"github.com/herzogf/htp-k8s/internal/scene"
	"github.com/herzogf/htp-k8s/internal/testcluster"
)

// TestSceneWatcher_RealCluster verifies the Scene Delta stream end to end against
// a real API server's watch (kind, ADR-0004): a real pod create, status update,
// and delete each surface as the expected Scene Deltas, and a real node
// create/delete surfaces as Tower deltas.
//
// The pod lives on a bare Node that has no kubelet or KWOK controller managing
// it, so nothing races the test for its status: the test drives the pod's
// Pending→Running transition itself with UpdateStatus, giving a deterministic
// PanelUpdated rather than depending on a simulator to flip the phase (which, as
// KWOK does, can coalesce with the create into a single PanelAdded). The changes
// still flow through the real API server's watch, which is what this test exists
// to exercise (the fake-clientset unit tests in watch_test.go cover the pure
// event→delta logic).
//
// Rather than pinning exact per-event deltas (a real watch coalesces and races),
// it reconstructs the scene by applying the deltas to the initial snapshot and
// asserts the reconstruction converges to the expected state at each step — the
// exact property ADR-0007 promises (snapshot + deltas reproduce live state) and
// what the frontend reducer (issue #17) will rely on. It additionally asserts at
// least one delta of each create/update/delete kind was actually observed, so a
// silently-empty stream can't pass.
//
// Gated behind the "integration" build tag; run with:
//
//	go test -tags=integration ./internal/kube/...
func TestSceneWatcher_RealCluster(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// A bare, unmanaged Node in the baseline so the pod under test has a Tower to
	// sit on before we start watching, and so nothing (no kubelet, no KWOK) drives
	// the pod's status but this test. Node-mode mirrors the cluster-admin CI user.
	const podNode = "delta-pod-node"
	if _, err := c.Clientset.CoreV1().Nodes().Create(ctx, bareNode(podNode), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod node: %v", err)
	}

	w := kube.NewSceneWatcher(c.Clientset, nil, scene.ViewModeNode, kube.NamespaceFilter{})
	w.Start(ctx)

	snap, ch, unsub := w.SnapshotAndSubscribe()
	defer unsub()

	recon := newReconScene(snap)
	counts := map[scene.SceneDeltaType]int{}

	// --- Pod create → PanelAdded ---
	const podName = "delta-probe"
	if _, err := c.Clientset.CoreV1().Pods("default").Create(ctx, probePod(podName, podNode), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	drainUntil(t, ch, recon, counts, 60*time.Second, func() bool {
		return recon.hasPanel(podNode, "default", podName)
	})
	if counts[scene.DeltaPanelAdded] == 0 {
		t.Error("no PanelAdded delta observed for pod create")
	}

	// --- Pod update → PanelUpdated (we drive Pending→Running ourselves) ---
	setPodRunning(ctx, t, c, podName)
	drainUntil(t, ch, recon, counts, 60*time.Second, func() bool {
		p, ok := recon.panel(podNode, "default", podName)
		return ok && p.Phase == scene.PodPhaseRunning
	})
	if counts[scene.DeltaPanelUpdated] == 0 {
		t.Error("no PanelUpdated delta observed for the pod's Pending→Running transition")
	}
	if p, _ := recon.panel(podNode, "default", podName); p.Color != scene.ColorRunning {
		t.Errorf("running pod panel color = %q, want %q", p.Color, scene.ColorRunning)
	}

	// --- Pod delete → PanelRemoved ---
	// Force-delete (grace period 0): the bare node has no kubelet to complete a
	// graceful deletion, so the pod would otherwise linger in Terminating.
	zero := int64(0)
	if err := c.Clientset.CoreV1().Pods("default").Delete(ctx, podName, metav1.DeleteOptions{GracePeriodSeconds: &zero}); err != nil {
		t.Fatalf("delete pod: %v", err)
	}
	drainUntil(t, ch, recon, counts, 60*time.Second, func() bool {
		return !recon.hasPanel(podNode, "default", podName)
	})
	if counts[scene.DeltaPanelRemoved] == 0 {
		t.Error("no PanelRemoved delta observed for pod delete")
	}

	// --- Node create → TowerAdded, delete → TowerRemoved ---
	const extraNode = "delta-probe-node"
	if _, err := c.Clientset.CoreV1().Nodes().Create(ctx, bareNode(extraNode), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create node: %v", err)
	}
	drainUntil(t, ch, recon, counts, 60*time.Second, func() bool {
		return recon.hasTower(extraNode)
	})
	if counts[scene.DeltaTowerAdded] == 0 {
		t.Error("no TowerAdded delta observed for node create")
	}

	if err := c.Clientset.CoreV1().Nodes().Delete(ctx, extraNode, metav1.DeleteOptions{}); err != nil {
		t.Fatalf("delete node: %v", err)
	}
	drainUntil(t, ch, recon, counts, 60*time.Second, func() bool {
		return !recon.hasTower(extraNode)
	})
	if counts[scene.DeltaTowerRemoved] == 0 {
		t.Error("no TowerRemoved delta observed for node delete")
	}
}

// TestSceneWatcher_RealCluster_Blink verifies blink-trigger detection end to end
// against a real API server's watch (kind, ADR-0004): a real container-restart
// bump and a real Kubernetes Event each surface as a DeltaPanelBlink for the
// correct Panel, through the real pod watch and the real Events watch
// respectively. The fake-clientset unit tests (blink_test.go) cover the pure
// activity→delta logic; this exercises the same detection over a live watch.
//
// Both activities are driven on bare, unmanaged Nodes (no kubelet, no KWOK) so
// nothing but this test writes the pods' status or events — a deterministic
// signal rather than a race with a simulator. The two activities run on
// separate pods so the per-Panel blink debounce never coalesces them.
//
// Gated behind the "integration" build tag; run with:
//
//	go test -tags=integration ./internal/kube/...
func TestSceneWatcher_RealCluster_Blink(t *testing.T) {
	c := testcluster.New(t, testcluster.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const blinkNode = "blink-node"
	if _, err := c.Clientset.CoreV1().Nodes().Create(ctx, bareNode(blinkNode), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create blink node: %v", err)
	}
	const restartPodName = "blink-restart"
	const eventPodName = "blink-event"
	for _, name := range []string{restartPodName, eventPodName} {
		if _, err := c.Clientset.CoreV1().Pods("default").Create(ctx, probePod(name, blinkNode), metav1.CreateOptions{}); err != nil {
			t.Fatalf("create pod %s: %v", name, err)
		}
	}

	w := kube.NewSceneWatcher(c.Clientset, nil, scene.ViewModeNode, kube.NamespaceFilter{})
	w.Start(ctx)

	snap, ch, unsub := w.SnapshotAndSubscribe()
	defer unsub()

	// Wait until both Panels exist in the reconstructed scene, so a blink for
	// either resolves to a Panel (the homing gate) rather than being dropped.
	recon := newReconScene(snap)
	counts := map[scene.SceneDeltaType]int{}
	drainUntil(t, ch, recon, counts, 60*time.Second, func() bool {
		return recon.hasPanel(blinkNode, "default", restartPodName) &&
			recon.hasPanel(blinkNode, "default", eventPodName)
	})

	// --- Real container restart → restart blink ---
	// Bump the pod's total restart count via the status subresource; the real
	// pod watch delivers the old/new pair the detector compares.
	bumpRestartCount(ctx, t, c, restartPodName)
	drainForBlink(t, ch, 60*time.Second, func(d scene.SceneDelta) bool {
		return d.TowerName == blinkNode && d.Namespace == "default" &&
			d.Pod == restartPodName && d.Activity == scene.ActivityRestart
	})

	// --- Real Kubernetes Event → event blink ---
	// A genuine Event object about the pod, created through the API server, flows
	// through the real Events watch to the blink detector.
	if _, err := c.Clientset.CoreV1().Events("default").Create(ctx,
		podEvent("default", "blink-evt", eventPodName, "", "Warning", "BackOff", metav1.Now()),
		metav1.CreateOptions{}); err != nil {
		t.Fatalf("create event: %v", err)
	}
	drainForBlink(t, ch, 60*time.Second, func(d scene.SceneDelta) bool {
		return d.TowerName == blinkNode && d.Namespace == "default" &&
			d.Pod == eventPodName && d.Activity == scene.ActivityEvent
	})
}

// bumpRestartCount increments the pod's single container's restart count by one
// via the status subresource — the deterministic "a container restarted" signal
// this test asserts a restart blink for. It seeds a container status if none
// exists yet.
func bumpRestartCount(ctx context.Context, t *testing.T, c *testcluster.Cluster, name string) {
	t.Helper()
	got, err := c.Clientset.CoreV1().Pods("default").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get pod for restart bump: %v", err)
	}
	if len(got.Status.ContainerStatuses) == 0 {
		got.Status.ContainerStatuses = []corev1.ContainerStatus{{
			Name:  "app",
			State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
		}}
	}
	got.Status.ContainerStatuses[0].RestartCount++
	if _, err := c.Clientset.CoreV1().Pods("default").UpdateStatus(ctx, got, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update pod status for restart bump: %v", err)
	}
}

// drainForBlink reads deltas until one satisfies match or timeout elapses,
// failing the test on timeout. Non-matching deltas (structural changes, blinks
// for other Panels, any incidental Events the API server emits) are ignored, so
// the real watch's nondeterministic extra traffic can't fail the assertion.
func drainForBlink(t *testing.T, ch <-chan scene.SceneDelta, timeout time.Duration, match func(scene.SceneDelta) bool) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case d, ok := <-ch:
			if !ok {
				t.Fatal("delta channel closed before a matching blink (subscriber dropped)")
			}
			if d.Type == scene.DeltaPanelBlink && match(d) {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for the expected blink delta")
		}
	}
}

// setPodRunning fetches the pod and flips its status phase to Running via the
// status subresource — the deterministic "update" this test asserts a
// PanelUpdated for.
func setPodRunning(ctx context.Context, t *testing.T, c *testcluster.Cluster, name string) {
	t.Helper()
	got, err := c.Clientset.CoreV1().Pods("default").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get pod for status update: %v", err)
	}
	got.Status.Phase = corev1.PodRunning
	if _, err := c.Clientset.CoreV1().Pods("default").UpdateStatus(ctx, got, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update pod status: %v", err)
	}
}

// probePod is a pod directly bound to nodeName (spec.nodeName bypasses the
// scheduler) with one container. On a bare, kubelet-less node it stays exactly
// as this test sets it.
func probePod(name, nodeName string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1.PodSpec{
			NodeName:   nodeName,
			Containers: []corev1.Container{{Name: "app", Image: "registry.k8s.io/pause:3.10"}},
		},
	}
}

// bareNode is a minimal Node with no kubelet and no KWOK annotation, so nothing
// manages it: it exists as a Tower and pods bound to it keep whatever status the
// test gives them.
func bareNode(name string) *corev1.Node {
	return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

// reconScene is a test-only reconstruction of the live scene: the initial
// snapshot with every subsequent SceneDelta applied, indexed for easy assertion.
// Applying deltas here is also a lightweight check that the delta contract is
// coherent and applyable (the job the frontend reducer, issue #17, will do).
type reconScene struct {
	towers map[string]*reconTower
}

type reconTower struct {
	grid   scene.GridPosition
	panels map[[2]string]scene.Panel
}

func newReconScene(snap scene.SceneState) *reconScene {
	r := &reconScene{towers: map[string]*reconTower{}}
	for _, tw := range snap.Towers {
		rt := &reconTower{grid: tw.Grid, panels: map[[2]string]scene.Panel{}}
		for _, p := range tw.Panels {
			rt.panels[[2]string{p.Namespace, p.Pod}] = p
		}
		r.towers[tw.Name] = rt
	}
	return r
}

func (r *reconScene) apply(d scene.SceneDelta) {
	switch d.Type {
	case scene.DeltaTowerAdded:
		rt := &reconTower{grid: d.Tower.Grid, panels: map[[2]string]scene.Panel{}}
		for _, p := range d.Tower.Panels {
			rt.panels[[2]string{p.Namespace, p.Pod}] = p
		}
		r.towers[d.Tower.Name] = rt
	case scene.DeltaTowerRemoved:
		delete(r.towers, d.TowerName)
	case scene.DeltaTowerMoved:
		if rt := r.towers[d.TowerName]; rt != nil {
			rt.grid = *d.Grid
		}
	case scene.DeltaPanelAdded, scene.DeltaPanelUpdated:
		if rt := r.towers[d.TowerName]; rt != nil {
			rt.panels[[2]string{d.Panel.Namespace, d.Panel.Pod}] = *d.Panel
		}
	case scene.DeltaPanelRemoved:
		if rt := r.towers[d.TowerName]; rt != nil {
			delete(rt.panels, [2]string{d.Namespace, d.Pod})
		}
	}
}

func (r *reconScene) hasTower(name string) bool {
	_, ok := r.towers[name]
	return ok
}

func (r *reconScene) panel(tower, namespace, pod string) (scene.Panel, bool) {
	rt, ok := r.towers[tower]
	if !ok {
		return scene.Panel{}, false
	}
	p, ok := rt.panels[[2]string{namespace, pod}]
	return p, ok
}

func (r *reconScene) hasPanel(tower, namespace, pod string) bool {
	_, ok := r.panel(tower, namespace, pod)
	return ok
}

// drainUntil applies deltas from ch to recon (tallying their kinds in counts)
// until until() holds or timeout elapses, failing the test on timeout. It is how
// the integration test waits for the real, asynchronous watch stream to converge
// the reconstruction to an expected state.
func drainUntil(t *testing.T, ch <-chan scene.SceneDelta, recon *reconScene, counts map[scene.SceneDeltaType]int, timeout time.Duration, until func() bool) {
	t.Helper()
	if until() {
		return
	}
	deadline := time.After(timeout)
	for {
		select {
		case d, ok := <-ch:
			if !ok {
				t.Fatal("delta channel closed before condition met (subscriber dropped)")
			}
			recon.apply(d)
			counts[d.Type]++
			if until() {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for the delta stream to converge")
		}
	}
}
