// Package scene defines the wire contract between the htp-k8s backend and its
// frontend: the types the backend serializes to a client over /ws. It is the
// single source of truth for that contract — the corresponding TypeScript
// types are generated from these Go definitions with tygo (see the root
// Taskfile's `codegen` target) rather than hand-maintained on the frontend, so
// a Go/TS schema mismatch surfaces in the build instead of at runtime.
//
// The package holds no Kubernetes logic and imports no client-go packages: it
// is the pure vocabulary of the scene (see CONTEXT.md), produced by the kube
// package and consumed by the frontend. It carries the View Mode and the set
// of Towers, each Tower carrying its own Panels (one per Pod, #14). Per ADR-0007
// the wire protocol is a full SceneState snapshot on connect followed by
// incremental Scene Deltas; the deltas are a later ticket and are not defined
// here.
package scene

// ViewMode determines what a Tower represents in the scene (see CONTEXT.md).
type ViewMode string

const (
	// ViewModeNode renders one Tower per Node. Selected when the current
	// user is allowed to list Nodes cluster-wide.
	ViewModeNode ViewMode = "node"

	// ViewModeNamespace renders one Tower per Namespace/Project. The
	// graceful-degradation default (ADR-0002): selected whenever the user
	// cannot list Nodes, including on OpenShift where a user may only see
	// their own Projects.
	ViewModeNamespace ViewMode = "namespace"
)

// GridPosition is a Tower's slot on the scene floor: zero-based integer
// column and row indices in the deterministic grid-by-name layout (see Tower).
// The frontend multiplies these by a fixed spacing to place the Tower in 3D;
// keeping them as abstract grid indices (not world coordinates) leaves the
// visual spacing a frontend concern.
type GridPosition struct {
	// Col is the zero-based column index (X axis) of the Tower in the grid.
	Col int `json:"col"`
	// Row is the zero-based row index (Z axis) of the Tower in the grid.
	Row int `json:"row"`
}

// Tower is one 3D structure on the scene floor (see CONTEXT.md). Depending on
// the active View Mode it represents either one Node (Node-mode) or one
// Namespace/Project (Namespace-mode). Towers are arranged in a simple grid,
// ordered by Name, so the same cluster state always yields the same layout —
// a Tower's position is a pure function of the sorted set of names, not of the
// order the backend happened to observe the resources in.
type Tower struct {
	// Name is the Tower's stable identity and label: the Node name in
	// Node-mode, or the Namespace/Project name in Namespace-mode. Unique
	// within a SceneState, and the key the grid layout is ordered by.
	Name string `json:"name"`
	// Grid is the Tower's position in the deterministic grid-by-name layout.
	Grid GridPosition `json:"grid"`
	// Panels are the Tower's Panels — one per Pod belonging to this Tower under
	// the active View Mode (the pods on this Node in Node-mode, or in this
	// Namespace/Project in Namespace-mode) — in a deterministic order (by
	// Namespace, then Pod). A Panel is always part of exactly one Tower (see
	// CONTEXT.md: it sits "on a Tower's face"), so Panels are nested here rather
	// than in a flat scene-level list. Sent non-nil over the wire: a Tower with
	// no pods carries an empty array, not null.
	Panels []Panel `json:"panels"`
}

// PodPhase is the phase-like status a Panel's color encodes (see CONTEXT.md's
// Panel definition). It is the Kubernetes pod phase enriched with the
// CrashLoopBackOff container-waiting state, which is not a real pod phase but
// is the single most important "something is wrong" signal to surface — so the
// backend derives it from the pod's container statuses and treats it as a
// first-class phase for coloring (see kube.BuildPanels). The zero value is not
// used on the wire; every Panel carries an explicit phase.
type PodPhase string

const (
	// PodPhaseRunning is a pod whose containers are all running (or a
	// Completed-but-restarting init). Rendered in the "healthy" color.
	PodPhaseRunning PodPhase = "Running"
	// PodPhasePending is a pod accepted by the cluster but not yet running —
	// unscheduled, pulling images, or waiting on init containers.
	PodPhasePending PodPhase = "Pending"
	// PodPhaseSucceeded is a pod whose containers all terminated with success
	// and will not be restarted (e.g. a completed Job pod).
	PodPhaseSucceeded PodPhase = "Succeeded"
	// PodPhaseFailed is a pod whose containers all terminated and at least one
	// failed (non-zero exit, not being restarted).
	PodPhaseFailed PodPhase = "Failed"
	// PodPhaseCrashLoopBackOff is a pod with a container stuck restarting in a
	// crash loop. Derived from container statuses, not a Kubernetes pod phase,
	// but surfaced as its own phase because it is the key failure signal.
	PodPhaseCrashLoopBackOff PodPhase = "CrashLoopBackOff"
	// PodPhaseUnknown is a pod whose state could not be determined (e.g. its
	// node is unreachable), and the fallback for any unrecognized phase.
	PodPhaseUnknown PodPhase = "Unknown"
)

// Panel palette: the hex color each PodPhase maps to (see ColorForPhase). The
// values are the wire contract's phase→color mapping — deliberately distinct,
// saturated neon tones matching the film's data-center look (see CONTEXT.md) —
// exported so the mapping is documented in the generated TypeScript alongside
// the phases it colors.
const (
	// ColorRunning is the healthy neon green of a running pod.
	ColorRunning = "#39ff14"
	// ColorPending is the amber of a pod still coming up.
	ColorPending = "#ffb000"
	// ColorSucceeded is the cool blue of a pod that completed successfully.
	ColorSucceeded = "#00b3ff"
	// ColorFailed is the red of a pod that terminated in failure.
	ColorFailed = "#ff2b2b"
	// ColorCrashLoopBackOff is the alarming magenta of a crash-looping pod,
	// kept distinct from the plain-Failed red so a crash loop reads at a glance.
	ColorCrashLoopBackOff = "#ff00d4"
	// ColorUnknown is the muted grey of a pod in an unknown/indeterminate state.
	ColorUnknown = "#8a8a8a"
)

// ColorForPhase returns the Panel color (hex string) for a PodPhase. It is the
// single source of truth for the phase→color mapping this ticket introduces;
// any phase it does not recognize (including the empty string) maps to
// ColorUnknown so an unexpected value never yields an empty color on the wire.
func ColorForPhase(phase PodPhase) string {
	switch phase {
	case PodPhaseRunning:
		return ColorRunning
	case PodPhasePending:
		return ColorPending
	case PodPhaseSucceeded:
		return ColorSucceeded
	case PodPhaseFailed:
		return ColorFailed
	case PodPhaseCrashLoopBackOff:
		return ColorCrashLoopBackOff
	default:
		return ColorUnknown
	}
}

// Panel is one glowing rectangle on a Tower's face, representing a single Pod
// (see CONTEXT.md). Its color encodes the pod's phase. A Panel belongs to
// exactly one Tower — the one it is nested under (Tower.Panels) — chosen by the
// active View Mode: the pod's Node in Node-mode, or its Namespace/Project in
// Namespace-mode. That scoping is derived from the View Mode, so the same pod
// re-homes to a different Tower when the View Mode changes; the Panel itself
// carries no Tower reference (its owning Tower is its container).
type Panel struct {
	// Namespace is the pod's Namespace/Project. Together with Pod it forms the
	// pod's cluster-unique identity (a pod name is only unique within its
	// namespace). It remains useful even nested under a Tower — e.g. in
	// Node-mode, where the Tower is the Node, it names the pod's namespace.
	Namespace string `json:"namespace"`
	// Pod is the pod's name.
	Pod string `json:"pod"`
	// Phase is the pod's phase-like status (see PodPhase), the value Color is
	// derived from.
	Phase PodPhase `json:"phase"`
	// Color is the hex color for Phase (see ColorForPhase), carried on the wire
	// so the frontend renders the palette without re-deriving it.
	Color string `json:"color"`
}

// SceneState is the full snapshot of the scene the backend sends to a client
// on connect (and on reconnect), per ADR-0007. It is the root of the wire
// contract; every field is consumed by the frontend to build the 3D scene.
type SceneState struct {
	// ViewMode is the View Mode the scene is rendered in — Towers as Nodes or
	// as Namespaces/Projects — detected at startup by the permission probe.
	ViewMode ViewMode `json:"viewMode"`
	// Towers is the set of Towers in the scene — one per Node in Node-mode or
	// one per Namespace/Project in Namespace-mode — in the deterministic
	// grid-by-name layout (ordered by Tower.Name). Each Tower carries its own
	// Panels (one per Pod on it). Sent non-nil over the wire: an empty scene is
	// an empty array, not null.
	Towers []Tower `json:"towers"`
}
