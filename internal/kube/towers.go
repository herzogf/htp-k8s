package kube

import (
	"context"
	"fmt"
	"math"
	"sort"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// projectGVR is the OpenShift Project resource (project.openshift.io/v1
// "projects"). A Project maps 1:1 to a Namespace and carries the same name
// (see CONTEXT.md), so a Tower built from a Project is indistinguishable on
// the wire from one built from a Namespace. It is queried through the dynamic
// client rather than a typed OpenShift client so htp-k8s needs no OpenShift
// API dependency: the resource is simply absent on vanilla Kubernetes, which
// is the ADR-0002 "gracefully absent" posture, not an error.
var projectGVR = schema.GroupVersionResource{
	Group:    "project.openshift.io",
	Version:  "v1",
	Resource: "projects",
}

// BuildTowers builds the scene's Tower list from live cluster state for the
// given View Mode. This is the k8s-input → Tower seam: it turns the set of
// Nodes (Node-mode) or Namespaces/Projects (Namespace-mode) into Towers laid
// out in the deterministic grid-by-name layout (see layOutTowers), and is the
// same code path exercised by the fake-clientset unit tests and against a real
// cluster.
//
//   - Node-mode lists Nodes cluster-wide. The permission probe only selects
//     Node-mode when the user may list Nodes (see DetectViewMode), so this is
//     expected to succeed; an error is surfaced to the caller.
//   - Namespace-mode lists Namespaces, and on OpenShift-shaped clusters where
//     that is forbidden falls back to listing the user's Projects (see
//     namespaceTowers). Per ADR-0002 it never hard-fails on the OpenShift
//     fallback path: a user who cannot list Nodes always gets Namespace-mode
//     Towers when any namespace-or-project source is readable.
//
// The NamespaceFilter selects which Namespace/Project Towers are included: in
// Namespace-mode a Tower is a Namespace/Project, so the filter is applied to the
// listed Namespaces/Projects (by name or by label — the object's own labels are
// available here) before layout, so the grid is laid out over exactly the
// admitted set with no gaps. It is deliberately ignored in Node-mode, where a
// Tower is a Node and is never namespace-scoped (the filter instead scopes
// pods' Panels there — see BuildScene). The zero-value filter admits everything.
//
// The dynamic client may be nil, in which case the OpenShift Project fallback
// is skipped (used by Node-mode unit tests that never reach it).
func BuildTowers(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode, filter NamespaceFilter) ([]scene.Tower, error) {
	switch mode {
	case scene.ViewModeNode:
		return nodeTowers(ctx, client)
	default:
		// ViewModeNamespace is the safe default for any unrecognized mode:
		// it is the least-privilege View Mode (ADR-0002).
		return namespaceTowers(ctx, client, dyn, filter)
	}
}

// namesOf extracts the object name from each item of a Kubernetes list. It is
// generic over any list-item type whose pointer is a metav1.Object (Nodes,
// Namespaces, and unstructured Projects all qualify), so the Node/Namespace/
// Project Tower sources share one name-extraction loop.
func namesOf[T any, PT interface {
	*T
	metav1.Object
}](items []T) []string {
	names := make([]string, 0, len(items))
	for i := range items {
		names = append(names, PT(&items[i]).GetName())
	}
	return names
}

// admittedNames is namesOf restricted to the items the NamespaceFilter admits,
// evaluating each item's name and labels through filter.admits. Both Namespaces
// (typed) and Projects (unstructured) satisfy metav1.Object, which exposes both
// GetName and GetLabels, so name-mode and label-mode filtering share this one
// loop across both Tower sources. A zero-value filter admits everything, making
// this equivalent to namesOf for the no-filter default.
func admittedNames[T any, PT interface {
	*T
	metav1.Object
}](items []T, filter NamespaceFilter) []string {
	names := make([]string, 0, len(items))
	for i := range items {
		obj := PT(&items[i])
		if filter.admits(obj.GetName(), obj.GetLabels()) {
			names = append(names, obj.GetName())
		}
	}
	return names
}

// nodeTowers lists Nodes and lays them out as Towers, one per Node.
func nodeTowers(ctx context.Context, client kubernetes.Interface) ([]scene.Tower, error) {
	list, err := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list nodes for towers: %w", err)
	}
	return layOutTowers(namesOf(list.Items)), nil
}

// namespaceTowers lays out one Tower per admitted Namespace/Project (see
// admittedNamespaceNames for the source and OpenShift fallback). Per ADR-0002 a
// listing failure degrades to an empty Tower set rather than hard-failing the
// scene: the client still gets a valid Namespace-mode SceneState, just with no
// Towers, and the caller can log why.
func namespaceTowers(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, filter NamespaceFilter) ([]scene.Tower, error) {
	names, err := admittedNamespaceNames(ctx, client, dyn, filter)
	if err != nil {
		return layOutTowers(nil), fmt.Errorf("build namespace towers: %w", err)
	}
	return layOutTowers(names), nil
}

// admittedNamespaceNames returns the names of the Namespaces — or, on an
// OpenShift-shaped cluster where the user cannot list cluster Namespaces but can
// list their own Projects, the Projects (same names, see projectGVR) — that the
// filter admits. It is the single Namespace/Project name source shared by both
// filtered consumers: Namespace-mode Tower building (namespaceTowers) and the
// Node-mode label-filter pod predicate (NamespaceFilter.podNamespacePredicate).
// Routing both through here means the filter is evaluated exactly one way —
// client-side, against each object's own name and labels via admittedNames — so
// the two consumers can never drift on what a selector admits, and the OpenShift
// fallback lives in one place.
//
// Per ADR-0002 the Project fallback keeps a restricted OpenShift user usable
// instead of hard-failing; an error is returned only when neither source is
// readable, with the original Namespace error preserved for the report.
func admittedNamespaceNames(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, filter NamespaceFilter) ([]string, error) {
	list, err := client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err == nil {
		return admittedNames(list.Items, filter), nil
	}

	// Namespaces weren't listable. On OpenShift a user often may not list
	// cluster Namespaces yet may list their own Projects, so try that before
	// giving up. Any non-permission error (e.g. a transport failure) is still
	// worth retrying via Projects — the two are alternate sources of the same
	// names — but the original namespace error is preserved for the report if
	// the fallback is unavailable.
	nsErr := err
	projectNames, projErr := listProjectNames(ctx, dyn, filter)
	if projErr != nil {
		return nil, fmt.Errorf("list namespaces or projects: namespaces: %v; projects: %w", nsErr, projErr)
	}
	return projectNames, nil
}

// listProjectNames lists the names of the OpenShift Projects admitted by the
// filter via the dynamic client. It returns an error when the dynamic client is
// absent (nil) or the Projects resource can't be listed (including the
// vanilla-Kubernetes case where the project.openshift.io API group simply
// doesn't exist). The filter is applied client-side over the unstructured
// Projects' names and labels, the same admittedNames path the Namespace source
// uses.
func listProjectNames(ctx context.Context, dyn dynamic.Interface, filter NamespaceFilter) ([]string, error) {
	if dyn == nil {
		return nil, fmt.Errorf("no dynamic client for OpenShift Project fallback")
	}

	list, err := dyn.Resource(projectGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
			return nil, fmt.Errorf("openshift projects api not available: %w", err)
		}
		return nil, fmt.Errorf("list openshift projects: %w", err)
	}

	return admittedNames(list.Items, filter), nil
}

// layOutTowers turns a set of Tower names into Towers positioned in the
// deterministic grid-by-name layout: names are sorted, then filled left to
// right, top to bottom into a near-square grid whose width is ceil(sqrt(n)).
// The result is a pure function of the set of names — independent of the order
// they were observed — so the same cluster state always renders the same
// layout. The returned slice is always non-nil (empty for no names) so the
// wire always carries a Tower array rather than null.
func layOutTowers(names []string) []scene.Tower {
	sorted := make([]string, len(names))
	copy(sorted, names)
	sort.Strings(sorted)

	width := gridWidth(len(sorted))
	towers := make([]scene.Tower, len(sorted))
	for i, name := range sorted {
		towers[i] = scene.Tower{
			Name: name,
			Grid: scene.GridPosition{
				Col: i % width,
				Row: i / width,
			},
		}
	}
	return towers
}

// gridWidth is the number of columns in the grid holding n Towers: the
// smallest square that fits them, ceil(sqrt(n)), giving a near-square footprint
// that grows gracefully with cluster size. It never returns less than 1 so
// callers can divide/modulo by it safely.
func gridWidth(n int) int {
	if n <= 1 {
		return 1
	}
	return int(math.Ceil(math.Sqrt(float64(n))))
}
