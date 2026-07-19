package kube

import (
	"context"
	"fmt"
	"log"
	"sort"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// crashLoopBackOff is the container-status waiting reason that marks a pod as
// crash-looping. It is not a Kubernetes pod phase, but is derived into the
// scene.PodPhaseCrashLoopBackOff phase because it is the key failure signal a
// Panel's color should surface (see CONTEXT.md's Panel definition).
const crashLoopBackOff = "CrashLoopBackOff"

// BuildPanels builds the scene's Panels from live cluster state for the given
// View Mode — one Panel per Pod (see CONTEXT.md) — grouped by the name of the
// Tower each pod belongs to. This is the k8s-input → Panel seam, the analogue
// of BuildTowers, exercised by the same fake-clientset unit tests and against a
// real cluster. Its output is bucketed (not flat) so AttachPanels can nest each
// group under its owning Tower.
//
// A pod's owning Tower under mode is its Node in Node-mode, or its
// Namespace/Project in Namespace-mode (see towerForPod). The scoping is derived
// from mode rather than stored on the pod, so the same pods re-home onto
// different Towers when the View Mode changes. A pod with no owning Tower under
// the active mode — an unscheduled pod in Node-mode, which has no Node yet — is
// omitted: there is no Tower to place its Panel on.
//
// Within each Tower's bucket, Panels are in a deterministic order (by Namespace,
// then Pod) so the same cluster state always yields the same nesting. The
// returned map is always non-nil (empty when there are no pods, or when the pod
// listing failed).
//
// admitNamespace is the Namespace Filter's pod-scoping predicate over a pod's
// namespace name: a pod whose namespace it rejects contributes no Panel. It is
// how the filter reaches pods in Node-mode, where a Tower is a Node (not hidden
// by the filter) so the pods themselves must be scoped to the admitted
// namespaces (see BuildScene). A nil predicate admits every pod — the no-filter
// default and the Namespace-mode path, where filtering the Towers already drops
// hidden namespaces' pods (AttachPanels).
//
// Listing pods is cluster-wide, first. If that fails — e.g. an OpenShift
// project-scoped user who can list their own Projects but not pods at the
// cluster scope — BuildPanels falls back to listing pods per admitted
// Namespace/Project (see podsForPanels), the Panel analogue of BuildTowers'
// Project fallback (issue #55, resolved). Only if neither source is available
// does it degrade to an empty result with an informational error rather than
// hard-failing the scene (ADR-0002), mirroring BuildTowers: the caller still
// gets a valid SceneState.
func BuildPanels(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode, admitNamespace func(string) bool) (map[string][]scene.Panel, error) {
	byTower := map[string][]scene.Panel{}

	items, err := podsForPanels(ctx, client, dyn)
	if err != nil {
		return byTower, err
	}

	for i := range items {
		pod := &items[i]
		if admitNamespace != nil && !admitNamespace(pod.Namespace) {
			// The Namespace Filter excludes this pod's namespace from the scene.
			continue
		}
		tower := towerForPod(pod, mode)
		if tower == "" {
			// No owning Tower under this View Mode (e.g. an unscheduled pod in
			// Node-mode has no spec.nodeName). Nothing to attach a Panel to.
			continue
		}
		phase := derivePhase(pod)
		byTower[tower] = append(byTower[tower], scene.Panel{
			Namespace: pod.Namespace,
			Pod:       pod.Name,
			Phase:     phase,
			Color:     scene.ColorForPhase(phase),
		})
	}

	for tower := range byTower {
		sortPanels(byTower[tower])
	}
	return byTower, nil
}

// podsForPanels returns every Pod BuildPanels should consider, preferring one
// cluster-wide List and falling back to namespaceScopedPods only when that is
// forbidden. It returns an error only when neither source yields pods, so a
// listing failure can still degrade the scene per ADR-0002 rather than
// hard-failing it.
func podsForPanels(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface) ([]corev1.Pod, error) {
	list, err := client.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err == nil {
		return list.Items, nil
	}

	// Cluster-wide listing wasn't permitted — on OpenShift, typically a
	// project-scoped user who can list their own Projects but lacks
	// cluster-scoped `list pods`. Fall back to listing pods per admitted
	// Namespace/Project (the Panel analogue of BuildTowers' Project fallback),
	// preserving the original error for the report if that is unavailable too.
	pods, fbErr := namespaceScopedPods(ctx, client, dyn)
	if fbErr != nil {
		return nil, fmt.Errorf("list pods for panels: cluster-wide: %v; per-namespace fallback: %w", err, fbErr)
	}
	return pods, nil
}

// namespaceScopedPods lists pods once per Namespace/Project the caller can
// enumerate (see admittedNamespaceNames, called here with the zero-value
// NamespaceFilter so it enumerates every admitted name — any Namespace/Project
// filtering happens later, in BuildPanels/AttachPanels, exactly as it would for
// the cluster-wide path). It is the fallback for a cluster-wide Pods list that
// is forbidden but where per-namespace listing is not — the case for an
// OpenShift project-scoped user.
//
// A namespace whose own pod listing fails (e.g. access revoked mid-enumeration)
// is skipped, logged, and does not abort the other admitted namespaces' Panels.
// An error is returned only when the namespace/project names themselves can't
// be enumerated at all — there would be nothing to iterate.
func namespaceScopedPods(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface) ([]corev1.Pod, error) {
	names, err := admittedNamespaceNames(ctx, client, dyn, NamespaceFilter{})
	if err != nil {
		return nil, fmt.Errorf("enumerate namespaces/projects for per-namespace pod fallback: %w", err)
	}

	var pods []corev1.Pod
	for _, ns := range names {
		list, err := client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			log.Printf("list pods in namespace %q for panels: %v", ns, err)
			continue
		}
		pods = append(pods, list.Items...)
	}
	return pods, nil
}

// AttachPanels nests each Tower's Panels into it, returning the same towers with
// Panels populated. byTower is the bucketed output of BuildPanels, keyed by
// Tower name. Every Tower is given a non-nil Panels slice — its bucket, or an
// empty slice when it has no pods — so the wire always carries a Panel array
// rather than null. A bucket whose Tower name matches no Tower in towers is
// dropped (its pods have no Tower to sit on), the nested-shape equivalent of
// BuildPanels' skip of Tower-less pods.
func AttachPanels(towers []scene.Tower, byTower map[string][]scene.Panel) []scene.Tower {
	for i := range towers {
		panels := byTower[towers[i].Name]
		if panels == nil {
			panels = []scene.Panel{}
		}
		towers[i].Panels = panels
	}
	return towers
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

// sortPanels orders a Tower's Panels deterministically by Namespace, then Pod —
// a total order over the cluster-unique (Namespace, Pod) pod identity — so the
// same cluster state always serializes to the same nesting.
func sortPanels(panels []scene.Panel) {
	sort.Slice(panels, func(i, j int) bool {
		a, b := panels[i], panels[j]
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Pod < b.Pod
	})
}
