package kube

import (
	corev1 "k8s.io/api/core/v1"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// panelKey is a Panel's cluster-unique identity — the pod's (Namespace, Pod)
// pair — used to index Panels for blink homing and debouncing. It mirrors the
// scene package's own panel identity, kept here as a comparable map key inside
// the kube package.
type panelKey struct {
	namespace string
	pod       string
}

// podBlinkActivity decides whether a pod's transition from old to new is
// blink-worthy activity (see CONTEXT.md's Panel: "brightness/blink encodes
// recent activity"), and if so which kind. It compares the two pod objects the
// informer hands to an update — the only place a phase transition or a
// restart-count increase is directly visible, since neither is derivable from a
// rebuild-and-diff of the SceneState (the Panel carries neither the old phase
// nor the restart count).
//
// Restart takes precedence over a phase change: a container restart is the
// sharper "something is wrong" signal, and a crash typically both bumps the
// restart count and flips the phase (e.g. into CrashLoopBackOff), so reporting
// the restart is the more informative single activity. It reports only an
// increase in the total restart count, never a decrease (a decrease only
// happens when a container is replaced, not when it flaps), and only a genuine
// phase change, so a no-op update (a spec edit, a re-list delivering identical
// status) yields no blink.
func podBlinkActivity(before, after *corev1.Pod) (scene.PanelActivity, bool) {
	if totalRestarts(after) > totalRestarts(before) {
		return scene.ActivityRestart, true
	}
	if derivePhase(before) != derivePhase(after) {
		return scene.ActivityPhaseChange, true
	}
	return "", false
}

// indexPanelTowers maps each Panel in a SceneState to the Name of the Tower it
// sits on, keyed by the pod's (Namespace, Pod) identity. It is the blink
// homing index: given a pod that had activity, the watcher looks up whether that
// pod currently has a Panel in the scene and, if so, which Tower it is on — so a
// blink is emitted only for a Panel the frontend actually holds, and with the
// correct Tower, without re-deriving the View-Mode homing or re-applying the
// Namespace Filter (the built scene already reflects both).
func indexPanelTowers(state scene.SceneState) map[panelKey]string {
	index := make(map[panelKey]string)
	for _, tower := range state.Towers {
		for _, panel := range tower.Panels {
			index[panelKey{namespace: panel.Namespace, pod: panel.Pod}] = tower.Name
		}
	}
	return index
}
