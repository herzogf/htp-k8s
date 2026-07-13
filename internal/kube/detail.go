package kube

import (
	"context"
	"fmt"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// maxPodEvents caps how many recent Events a PodDetail carries: the Detail Popup
// shows recent context, not an event log, so only the most-recent few are kept.
const maxPodEvents = 10

// BuildTowerDetail builds the on-demand Detail Popup summary for one Tower named
// name, under the given View Mode: a Node summary in Node-mode, a
// Namespace/Project summary in Namespace-mode. It is the read-only Tower→detail
// seam, the analogue of BuildTowers, exercised by the same fake-clientset unit
// tests and against a real cluster. It performs only Get/List reads — no mutation
// (ADR-0003).
//
// Per ADR-0002 it degrades gracefully rather than hard-failing: a Tower whose
// backing resource the caller may not read (e.g. a Node a namespace-scoped user
// cannot Get, or a Namespace that on OpenShift is only reachable as a Project)
// still yields a TowerDetail carrying at least the Name and Kind, with the
// summary payload left nil and an informational error returned for logging. In
// Namespace-mode it mirrors BuildTowers' OpenShift fallback: if the Namespace
// can't be read it tries the Project of the same name via the dynamic client.
//
// The dynamic client may be nil (skips the Project fallback), matching BuildTowers.
func BuildTowerDetail(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode, name string) (scene.TowerDetail, error) {
	switch mode {
	case scene.ViewModeNode:
		return nodeDetail(ctx, client, name)
	default:
		// ViewModeNamespace is the safe default for any unrecognized mode, matching
		// BuildTowers.
		return namespaceDetail(ctx, client, dyn, name)
	}
}

// nodeDetail summarizes one Node. A read failure degrades to a Name+Kind-only
// TowerDetail with an informational error (ADR-0002), so a namespace-scoped user
// clicking a Node Tower still gets a well-formed popup instead of an error.
func nodeDetail(ctx context.Context, client kubernetes.Interface, name string) (scene.TowerDetail, error) {
	detail := scene.TowerDetail{Name: name, Kind: scene.TowerKindNode}

	node, err := client.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return detail, fmt.Errorf("get node %q for tower detail: %w", name, err)
	}

	summary := &scene.NodeSummary{
		KubeletVersion: node.Status.NodeInfo.KubeletVersion,
		OS:             node.Status.NodeInfo.OperatingSystem,
		Architecture:   node.Status.NodeInfo.Architecture,
		CPU:            quantityString(node.Status.Capacity, corev1.ResourceCPU),
		Memory:         quantityString(node.Status.Capacity, corev1.ResourceMemory),
		Pods:           quantityString(node.Status.Capacity, corev1.ResourcePods),
		Labels:         node.Labels,
		PodCount:       countPodsOnNode(ctx, client, name),
	}
	summary.Ready, summary.Status = nodeReadiness(node)
	detail.Node = summary
	return detail, nil
}

// namespaceDetail summarizes one Namespace/Project. It tries the Namespace first,
// then — mirroring BuildTowers' OpenShift posture (ADR-0002) — the Project of the
// same name via the dynamic client, and finally degrades to a Name+Kind-only
// detail with an informational error if neither is readable.
func namespaceDetail(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, name string) (scene.TowerDetail, error) {
	detail := scene.TowerDetail{Name: name, Kind: scene.TowerKindNamespace}

	ns, err := client.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		detail.Namespace = &scene.NamespaceSummary{
			Phase:    string(ns.Status.Phase),
			Labels:   ns.Labels,
			PodCount: countPodsInNamespace(ctx, client, name),
		}
		return detail, nil
	}

	// Namespace wasn't readable. On OpenShift the user may still read the Project
	// of the same name; the Project carries no lifecycle phase, so the summary is
	// labels + pod count only.
	nsErr := err
	proj, projErr := getProject(ctx, dyn, name)
	if projErr != nil {
		return detail, fmt.Errorf("get namespace or project %q for tower detail: namespace: %v; project: %w", name, nsErr, projErr)
	}
	detail.Namespace = &scene.NamespaceSummary{
		Labels:   proj.GetLabels(),
		PodCount: countPodsInNamespace(ctx, client, name),
	}
	return detail, nil
}

// getProject reads one OpenShift Project by name via the dynamic client, the
// single-object analogue of BuildTowers' Project listing. It errors when the
// dynamic client is absent or the Project resource can't be read (including the
// vanilla-Kubernetes case where the project.openshift.io group doesn't exist).
func getProject(ctx context.Context, dyn dynamic.Interface, name string) (metav1.Object, error) {
	if dyn == nil {
		return nil, fmt.Errorf("no dynamic client for OpenShift Project fallback")
	}
	obj, err := dyn.Resource(projectGVR).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get openshift project %q: %w", name, err)
	}
	return obj, nil
}

// nodeReadiness reads a Node's Ready condition into a (ready, label) pair. A
// missing condition reads as not-ready / "Unknown".
func nodeReadiness(node *corev1.Node) (bool, string) {
	for _, cond := range node.Status.Conditions {
		if cond.Type != corev1.NodeReady {
			continue
		}
		switch cond.Status {
		case corev1.ConditionTrue:
			return true, "Ready"
		case corev1.ConditionFalse:
			return false, "NotReady"
		default:
			return false, "Unknown"
		}
	}
	return false, "Unknown"
}

// quantityString renders one resource quantity from a ResourceList as its string
// form (e.g. "32", "256Gi"), or "" when the resource is absent.
func quantityString(list corev1.ResourceList, name corev1.ResourceName) string {
	if q, ok := list[name]; ok {
		return q.String()
	}
	return ""
}

// countPodsOnNode best-effort counts pods scheduled on a Node. It lists pods
// cluster-wide and filters by spec.nodeName client-side rather than with a
// field selector, so it counts identically on a real cluster and the fake
// clientset (which ignores field selectors) — the same list-all path BuildPanels
// already uses. A listing failure (e.g. the caller may not list pods) yields 0
// rather than an error, keeping the summary graceful (ADR-0002).
func countPodsOnNode(ctx context.Context, client kubernetes.Interface, nodeName string) int {
	list, err := client.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return 0
	}
	count := 0
	for i := range list.Items {
		if list.Items[i].Spec.NodeName == nodeName {
			count++
		}
	}
	return count
}

// countPodsInNamespace best-effort counts pods in a Namespace/Project. A listing
// failure yields 0 (ADR-0002).
func countPodsInNamespace(ctx context.Context, client kubernetes.Interface, namespace string) int {
	list, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return 0
	}
	return len(list.Items)
}

// BuildPodDetail builds the on-demand Detail Popup detail for one Pod: its
// identity, node, phase/color (the same derivation a Panel uses), total restart
// count, per-container status, and recent Events. It is the read-only Pod→detail
// seam, exercised by the same fake-clientset unit tests and against a real
// cluster, and performs only Get/List reads — no exec, no mutation (ADR-0003).
//
// An error getting the pod is returned to the caller (the realistic case is a pod
// deleted between the click and the fetch); Events are best-effort context, so a
// failure listing them degrades to no events rather than failing the whole detail.
func BuildPodDetail(ctx context.Context, client kubernetes.Interface, namespace, name string) (scene.PodDetail, error) {
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return scene.PodDetail{}, fmt.Errorf("get pod %s/%s for detail: %w", namespace, name, err)
	}

	phase := derivePhase(pod)
	detail := scene.PodDetail{
		Namespace:    pod.Namespace,
		Pod:          pod.Name,
		Node:         pod.Spec.NodeName,
		Phase:        phase,
		Color:        scene.ColorForPhase(phase),
		RestartCount: totalRestarts(pod),
		Containers:   containerDetails(pod),
		Events:       recentPodEvents(ctx, client, pod),
	}
	return detail, nil
}

// totalRestarts sums the restart count across a pod's containers — the single
// "is this pod flapping" number the popup surfaces.
func totalRestarts(pod *corev1.Pod) int {
	total := 0
	for _, cs := range pod.Status.ContainerStatuses {
		total += int(cs.RestartCount)
	}
	return total
}

// containerDetails builds the per-container status list in the pod spec's order.
// It is driven by the spec (so every declared container appears even before it
// has a status) and enriched from ContainerStatuses by name. Always non-nil.
func containerDetails(pod *corev1.Pod) []scene.ContainerDetail {
	statusByName := make(map[string]corev1.ContainerStatus, len(pod.Status.ContainerStatuses))
	for _, cs := range pod.Status.ContainerStatuses {
		statusByName[cs.Name] = cs
	}

	details := make([]scene.ContainerDetail, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		cd := scene.ContainerDetail{Name: c.Name, Image: c.Image, State: "Unknown"}
		if cs, ok := statusByName[c.Name]; ok {
			cd.Ready = cs.Ready
			cd.RestartCount = int(cs.RestartCount)
			if cs.Image != "" {
				cd.Image = cs.Image
			}
			cd.State, cd.Reason = containerState(cs.State)
		}
		details = append(details, cd)
	}
	return details
}

// containerState maps a container's state union to a (state, reason) pair.
func containerState(state corev1.ContainerState) (string, string) {
	switch {
	case state.Running != nil:
		return "Running", ""
	case state.Waiting != nil:
		return "Waiting", state.Waiting.Reason
	case state.Terminated != nil:
		return "Terminated", state.Terminated.Reason
	default:
		return "Unknown", ""
	}
}

// recentPodEvents lists the Events involving a pod and returns the most-recent
// maxPodEvents, newest first, flattened to the wire's PodEvent. It filters
// client-side by the involved object (Kind=Pod, matching name, and UID when the
// event carries one) rather than a field selector, so it behaves identically on
// the fake clientset and a real cluster. Best-effort: a listing failure yields an
// empty (non-nil) slice, so events never fail the whole detail (ADR-0002).
func recentPodEvents(ctx context.Context, client kubernetes.Interface, pod *corev1.Pod) []scene.PodEvent {
	list, err := client.CoreV1().Events(pod.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return []scene.PodEvent{}
	}

	matched := make([]corev1.Event, 0, len(list.Items))
	for _, e := range list.Items {
		if !eventInvolvesPod(e, pod) {
			continue
		}
		matched = append(matched, e)
	}

	// Newest first by last-observed time.
	sort.SliceStable(matched, func(i, j int) bool {
		return eventTime(matched[i]).After(eventTime(matched[j]))
	})
	if len(matched) > maxPodEvents {
		matched = matched[:maxPodEvents]
	}

	events := make([]scene.PodEvent, 0, len(matched))
	for _, e := range matched {
		count := int(e.Count)
		if count < 1 {
			count = 1
		}
		var lastSeen string
		if t := eventTime(e); !t.IsZero() {
			lastSeen = t.UTC().Format(time.RFC3339)
		}
		events = append(events, scene.PodEvent{
			Type:     e.Type,
			Reason:   e.Reason,
			Message:  e.Message,
			Count:    count,
			LastSeen: lastSeen,
		})
	}
	return events
}

// eventInvolvesPod reports whether an Event is about the given pod: its involved
// object must be a Pod with the pod's name, and — when the event carries a UID —
// the pod's UID, so a same-named successor pod's events don't leak in.
func eventInvolvesPod(e corev1.Event, pod *corev1.Pod) bool {
	ref := e.InvolvedObject
	if ref.Kind != "Pod" || ref.Name != pod.Name {
		return false
	}
	if ref.UID != "" && pod.UID != "" && ref.UID != pod.UID {
		return false
	}
	return true
}

// eventTime is an Event's most representative timestamp for ordering: its
// LastTimestamp, falling back to the newer EventTime, then the creation time.
func eventTime(e corev1.Event) time.Time {
	if !e.LastTimestamp.IsZero() {
		return e.LastTimestamp.Time
	}
	if !e.EventTime.IsZero() {
		return e.EventTime.Time
	}
	return e.CreationTimestamp.Time
}
