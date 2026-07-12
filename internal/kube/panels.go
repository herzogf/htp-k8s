package kube

import (
	"context"
	"fmt"
	"sort"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// crashLoopBackOff is the container-status waiting reason that marks a pod as
// crash-looping. It is not a Kubernetes pod phase, but is derived into the
// scene.PodPhaseCrashLoopBackOff phase because it is the key failure signal a
// Panel's color should surface (see CONTEXT.md's Panel definition).
const crashLoopBackOff = "CrashLoopBackOff"

// BuildPanels builds the scene's Panel list from live cluster state for the
// given View Mode — one Panel per Pod (see CONTEXT.md). This is the k8s-input →
// Panel seam, the analogue of BuildTowers, exercised by the same fake-clientset
// unit tests and against a real cluster.
//
// Each Panel is scoped to the Tower the pod belongs to under mode: the pod's
// Node in Node-mode, or its Namespace/Project in Namespace-mode (see
// towerForPod). The scoping is derived from mode rather than stored on the pod,
// so the same pods re-home onto different Towers when the View Mode changes.
// A pod with no owning Tower under the active mode — an unscheduled pod in
// Node-mode, which has no Node yet — is omitted: there is no Tower to place its
// Panel on.
//
// Panels are returned in a deterministic order (by Tower, then Namespace, then
// Pod) so the same cluster state always yields the same Panel list. The slice
// is always non-nil (empty when there are no pods, or when the pod listing
// failed) so the wire always carries a Panel array rather than null.
//
// Listing pods is cluster-wide. If it fails — e.g. a restricted user who cannot
// list pods at the cluster scope — BuildPanels degrades to an empty Panel set
// with an informational error rather than hard-failing the scene (ADR-0002),
// mirroring BuildTowers: the caller still gets a valid SceneState.
func BuildPanels(ctx context.Context, client kubernetes.Interface, mode scene.ViewMode) ([]scene.Panel, error) {
	list, err := client.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return []scene.Panel{}, fmt.Errorf("list pods for panels: %w", err)
	}

	panels := make([]scene.Panel, 0, len(list.Items))
	for i := range list.Items {
		pod := &list.Items[i]
		tower := towerForPod(pod, mode)
		if tower == "" {
			// No owning Tower under this View Mode (e.g. an unscheduled pod in
			// Node-mode has no spec.nodeName). Nothing to attach a Panel to.
			continue
		}
		phase := derivePhase(pod)
		panels = append(panels, scene.Panel{
			Namespace: pod.Namespace,
			Pod:       pod.Name,
			Tower:     tower,
			Phase:     phase,
			Color:     scene.ColorForPhase(phase),
		})
	}

	sortPanels(panels)
	return panels, nil
}

// towerForPod returns the Name of the Tower a pod belongs to under the given
// View Mode: its Node (spec.nodeName) in Node-mode, or its Namespace/Project in
// Namespace-mode. This is the sole place the Panel→Tower scoping depends on the
// View Mode, so switching modes re-scopes every Panel through one function. An
// empty result means the pod has no owning Tower under mode (an unscheduled pod
// in Node-mode).
func towerForPod(pod *corev1.Pod, mode scene.ViewMode) string {
	switch mode {
	case scene.ViewModeNode:
		return pod.Spec.NodeName
	default:
		// ViewModeNamespace is the safe default for any unrecognized mode,
		// matching BuildTowers: the pod's namespace is always present.
		return pod.Namespace
	}
}

// derivePhase maps a pod to the phase-like status its Panel color encodes (see
// scene.PodPhase). A container stuck in CrashLoopBackOff takes precedence over
// the pod's own phase (a crash-looping pod usually still reports Running),
// because the crash loop is the more important signal to surface; otherwise the
// Kubernetes pod phase is translated one-to-one, with any unrecognized phase
// mapping to Unknown.
func derivePhase(pod *corev1.Pod) scene.PodPhase {
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason == crashLoopBackOff {
			return scene.PodPhaseCrashLoopBackOff
		}
	}

	switch pod.Status.Phase {
	case corev1.PodRunning:
		return scene.PodPhaseRunning
	case corev1.PodPending:
		return scene.PodPhasePending
	case corev1.PodSucceeded:
		return scene.PodPhaseSucceeded
	case corev1.PodFailed:
		return scene.PodPhaseFailed
	default:
		return scene.PodPhaseUnknown
	}
}

// sortPanels orders panels deterministically by Tower, then Namespace, then Pod
// — a total order over the cluster-unique (Namespace, Pod) identity within each
// Tower — so the same cluster state always serializes to the same Panel list.
func sortPanels(panels []scene.Panel) {
	sort.Slice(panels, func(i, j int) bool {
		a, b := panels[i], panels[j]
		if a.Tower != b.Tower {
			return a.Tower < b.Tower
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Pod < b.Pod
	})
}
