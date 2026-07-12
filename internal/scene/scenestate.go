// Package scene defines the wire contract between the htp-k8s backend and its
// frontend: the types the backend serializes to a client over /ws. It is the
// single source of truth for that contract — the corresponding TypeScript
// types are generated from these Go definitions with tygo (see the root
// Taskfile's `codegen` target) rather than hand-maintained on the frontend, so
// a Go/TS schema mismatch surfaces in the build instead of at runtime.
//
// The package holds no Kubernetes logic and imports no client-go packages: it
// is the pure vocabulary of the scene (see CONTEXT.md), produced by the kube
// package and consumed by the frontend. It is deliberately minimal today —
// SceneState carries only the View Mode — and grows Towers and Panels in later
// tickets (#12, #14). Per ADR-0007 the wire protocol is a full SceneState
// snapshot on connect followed by incremental Scene Deltas; the deltas are a
// later ticket and are not defined here.
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

// SceneState is the full snapshot of the scene the backend sends to a client
// on connect (and on reconnect), per ADR-0007. It is the root of the wire
// contract; every field is consumed by the frontend to build the 3D scene.
type SceneState struct {
	// ViewMode is the View Mode the scene is rendered in — Towers as Nodes or
	// as Namespaces/Projects — detected at startup by the permission probe.
	ViewMode ViewMode `json:"viewMode"`
}
