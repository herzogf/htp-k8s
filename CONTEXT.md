# htp-k8s

A visual, 3D "data center" browser for Kubernetes clusters (and OpenShift), styled after the data-center scene from the 1995 film *Hackers*. Renders live cluster state as a scene of glowing towers connected by a floor of light lanes.

## Language

**Tower**:
The physical 3D structure in the scene. Depending on the active View Mode, a Tower represents either one Node or one Namespace/Project. Arranged in a grid on the scene floor.

**Panel**:
A small glowing rectangle on a Tower's face representing one Pod, instanced-rendered for scale up to large clusters (thousands of pods). Panel color encodes the pod's phase (e.g. Running, Pending, CrashLoopBackOff). Panel brightness/blink encodes recent activity on that pod (phase transitions, restarts, Events). At close/mid camera distance, shows hinted/illegible scrolling text detail (matching the film's look); at far distance, falls back to a flat color blob for render cost.
_Avoid_: tile, cell, block

**Floor Lane**:
A glowing line on the scene floor connecting two Towers, carrying traveling light pulses. In v1, decorative only (not driven by real cluster data). Reserved for later wiring to a real traffic or control-plane signal.

**View Mode**:
Determines what a Tower represents: Node-mode (Towers = Nodes, Panels = pods scheduled on that node) or Namespace-mode (Towers = Namespaces/Projects, Panels = pods in that namespace). Auto-selected at startup based on a permission probe (falls back to Namespace-mode when the user can't list Nodes), and user-switchable at any time.

**Project**:
OpenShift's term for a Namespace. Maps 1:1 to a Kubernetes Namespace. On OpenShift, a user's accessible Projects are often a subset of the cluster's Namespaces — listing all cluster Namespaces may not be permitted even when listing owned Projects is.
_Avoid_: using "namespace" and "project" interchangeably in code that must run on both vanilla Kubernetes and OpenShift — prefer "Namespace/Project" in shared code paths, or the platform-specific term only in platform-specific code.

**Detail Popup**:
An in-world (not fixed screen-space) popup shown beside a clicked Tower or Panel, positioned on the tower surface in 3D space. For a Panel, shows static pod details plus a small, height-limited (~3 rows) log tail. May overlap neighboring Panels while open. Read-only — no actions (no exec, no delete, no full log viewer). The app is a cinematic viewer, not an admin tool; see [[0003-cinematic-viewer-not-admin-tool]].

**Focus**:
The camera behavior triggered by clicking a Tower or Panel: smoothly animates the free-fly camera to a good viewing distance/angle (a specific tower side for a Tower, close enough to read the Detail Popup for a Panel), rather than teleporting.

**Demo Mode**:
An optional automated cinematic camera flight through the tower landscape, with a swinging/banking motion (like a small plane navigating between skyscrapers), for unattended/showcase viewing.

**Namespace Filter**:
User-controlled visibility filter over Namespaces/Projects. Simple mode filters by name (with wildcard/pattern support); advanced mode filters by label. Nothing is excluded by default — all namespaces are visible on first launch. Can be preset via a CLI argument at startup.

**Scene Delta**:
An incremental update message sent from backend to frontend describing one change to the scene — a Tower or Panel added, updated, or removed, or a blink triggered — as opposed to a full `SceneState` snapshot. Sent after the initial snapshot on connect (or reconnect); mirrors Kubernetes' own LIST+WATCH pattern. See [[0007-scene-updates-are-snapshot-plus-delta]].
_Avoid_: "event" alone — ambiguous with a Kubernetes Event (a cluster resource that may be one of several inputs causing a Scene Delta to be emitted, but is a different concept).
