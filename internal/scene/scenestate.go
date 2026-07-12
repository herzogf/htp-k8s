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
// of Towers today, and grows Panels in a later ticket (#14). Per ADR-0007 the
// wire protocol is a full SceneState snapshot on connect followed by
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
	// grid-by-name layout (ordered by Tower.Name). Sent non-nil over the wire:
	// an empty scene is an empty array, not null.
	Towers []Tower `json:"towers"`
}
