package scene

// This file defines the on-demand Detail wire contract: the payloads the
// backend serves when a user clicks a Tower or Panel to open the Detail Popup
// (see CONTEXT.md's "Detail Popup"). Unlike SceneState/SceneDelta — the
// always-on /ws broadcast (ADR-0007) — these are fetched on demand over
// lightweight read-only HTTP endpoints so they never bloat the scene snapshot
// at scale (ADR-0008: SceneState is a lean presentation view-model). They are
// strictly read-only view data (ADR-0003): no field here drives, or is derived
// from, any mutating or exec capability. Like the rest of this package they hold
// no Kubernetes types and are the single source of truth for the generated
// TypeScript (tygo) the frontend Detail Popup (issue #24) consumes.

// TowerKind names what a Tower's detail describes, mirroring the View Mode the
// Tower was built under: a Node in Node-mode, or a Namespace/Project in
// Namespace-mode. It tells the frontend which of TowerDetail's summary payloads
// (Node or Namespace) is populated.
type TowerKind string

const (
	// TowerKindNode marks a TowerDetail describing a Node (Node-mode). Its Node
	// summary is populated and Namespace is nil.
	TowerKindNode TowerKind = "node"
	// TowerKindNamespace marks a TowerDetail describing a Namespace/Project
	// (Namespace-mode). Its Namespace summary is populated and Node is nil.
	TowerKindNamespace TowerKind = "namespace"
)

// TowerDetail is the on-demand summary for a single Tower, shown in the Detail
// Popup when a Tower is clicked. Which summary it carries depends on the View
// Mode the scene is in (see TowerKind): a Node summary in Node-mode, a
// Namespace/Project summary in Namespace-mode. Per ADR-0002 the detail degrades
// gracefully: a Tower the caller cannot read in full (e.g. a Node a
// namespace-scoped user may not Get) still yields a TowerDetail with its Name
// and Kind, just with the summary payload absent, rather than a hard failure.
type TowerDetail struct {
	// Name is the Tower's identity — the Node name or Namespace/Project name —
	// matching the Tower.Name in the SceneState it was opened from.
	Name string `json:"name"`
	// Kind names what this Tower represents and which summary below is populated.
	Kind TowerKind `json:"kind"`
	// Node is the Node summary, populated only for TowerKindNode (and nil when
	// the Node could not be read — the ADR-0002 degraded case).
	Node *NodeSummary `json:"node,omitempty"`
	// Namespace is the Namespace/Project summary, populated only for
	// TowerKindNamespace (and nil when it could not be read).
	Namespace *NamespaceSummary `json:"namespace,omitempty"`
}

// NodeSummary is the read-only summary of a Node shown in a Node-mode Tower's
// Detail Popup: its readiness, key node-info, capacity, and labels.
type NodeSummary struct {
	// Ready is true when the Node's Ready condition is True.
	Ready bool `json:"ready"`
	// Status is a short human-readable readiness label: "Ready", "NotReady", or
	// "Unknown" (the Ready condition absent or Unknown).
	Status string `json:"status"`
	// KubeletVersion is the Node's reported kubelet version (may be empty on a
	// simulated node).
	KubeletVersion string `json:"kubeletVersion"`
	// OS and Architecture are the Node's operating system and CPU architecture.
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	// CPU, Memory, and Pods are the Node's capacity as Kubernetes quantity
	// strings (e.g. "32", "256Gi", "110"), carried as-is for display.
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
	Pods   string `json:"pods"`
	// Labels are the Node's labels.
	Labels map[string]string `json:"labels"`
	// PodCount is the number of pods scheduled on this Node (best-effort: 0 when
	// the caller may not list pods).
	PodCount int `json:"podCount"`
}

// NamespaceSummary is the read-only summary of a Namespace/Project shown in a
// Namespace-mode Tower's Detail Popup.
type NamespaceSummary struct {
	// Phase is the Namespace lifecycle phase — "Active" or "Terminating" — or
	// empty when unknown (e.g. an OpenShift Project read via the fallback path
	// that exposes no phase).
	Phase string `json:"phase"`
	// Labels are the Namespace/Project's labels.
	Labels map[string]string `json:"labels"`
	// PodCount is the number of pods in this Namespace/Project (best-effort: 0
	// when the caller may not list pods).
	PodCount int `json:"podCount"`
}

// PodDetail is the on-demand detail for a single Pod, shown in the Detail Popup
// when a Panel is clicked (see CONTEXT.md). It is the static half of the popup;
// the live log tail (LogTail) streams separately. All fields are read-only view
// data — there is deliberately no action, exec, or full-log field (ADR-0003).
type PodDetail struct {
	// Namespace and Pod are the pod's cluster-unique identity, matching the
	// Panel the popup was opened from.
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	// Node is the Node the pod is scheduled on (empty if unscheduled).
	Node string `json:"node"`
	// Phase is the pod's phase-like status (see PodPhase), the same derivation a
	// Panel's color uses (CrashLoopBackOff surfaced as its own phase).
	Phase PodPhase `json:"phase"`
	// Color is the hex color for Phase (see ColorForPhase), so the popup matches
	// the Panel it opened from without re-deriving it.
	Color string `json:"color"`
	// RestartCount is the total container restart count across the pod, the key
	// "is this pod unhealthy" number to surface.
	RestartCount int `json:"restartCount"`
	// Containers is the pod's containers with their per-container status, in the
	// pod spec's order. Always non-nil (empty array, not null).
	Containers []ContainerDetail `json:"containers"`
	// Events are the pod's recent Kubernetes Events, most-recent-first and capped
	// (see kube.BuildPodDetail) — the "what just happened to this pod" context.
	// Always non-nil (empty array, not null). Events are one of several inputs to
	// the scene, surfaced here as plain read-only text, not acted upon.
	Events []PodEvent `json:"events"`
}

// ContainerDetail is one container's read-only status within a PodDetail.
type ContainerDetail struct {
	// Name is the container name.
	Name string `json:"name"`
	// Image is the container image reference.
	Image string `json:"image"`
	// Ready reflects the container's readiness probe / running state.
	Ready bool `json:"ready"`
	// RestartCount is this container's restart count.
	RestartCount int `json:"restartCount"`
	// State is the container's lifecycle state: "Running", "Waiting",
	// "Terminated", or "Unknown" (no status reported yet).
	State string `json:"state"`
	// Reason is the Waiting/Terminated reason (e.g. "CrashLoopBackOff",
	// "Completed"), empty for a Running or status-less container.
	Reason string `json:"reason,omitempty"`
}

// PodEvent is one recent Kubernetes Event about a pod, flattened to the read-only
// fields the Detail Popup shows. It is deliberately NOT treated as a Scene Delta
// input here — just display text (see CONTEXT.md's note distinguishing a k8s
// Event from a Scene Delta).
type PodEvent struct {
	// Type is the event type: "Normal" or "Warning".
	Type string `json:"type"`
	// Reason is the short machine reason (e.g. "Scheduled", "BackOff").
	Reason string `json:"reason"`
	// Message is the human-readable event message.
	Message string `json:"message"`
	// Count is how many times this event has occurred (>=1).
	Count int `json:"count"`
	// LastSeen is the RFC3339 timestamp the event was last observed, or empty if
	// the source carried no timestamp.
	LastSeen string `json:"lastSeen"`
}

// LogTailMaxLines is the height cap of the pod log tail: the Detail Popup shows a
// small (~3 row) live tail, never a full log viewer (ADR-0003). It bounds both
// the initial history the backend requests (TailLines) and the ring window it
// streams, so the tail is always at most this many lines regardless of how
// chatty the pod is.
const LogTailMaxLines = 3

// LogTail is one frame of a Pod's bounded live log tail, streamed to the Detail
// Popup after the pod is clicked (see CONTEXT.md). Lines is the current window —
// at most LogTailMaxLines entries, oldest first — replaced whole on each new
// line, so the frontend renders it directly without maintaining its own ring.
// This is a height-limited tail, not a full log viewer: there is no pagination,
// no "load more", and no way to fetch history beyond the window (ADR-0003).
type LogTail struct {
	// Lines is the current tail window, oldest first, length 0..LogTailMaxLines.
	Lines []string `json:"lines"`
}
