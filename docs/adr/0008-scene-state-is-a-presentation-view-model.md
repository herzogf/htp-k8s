# SceneState is a presentation view model, named in domain vocabulary — not a Kubernetes-native DTO

The backend↔frontend wire contract (`SceneState`, per [[0007-scene-updates-are-snapshot-plus-delta]]) could have been shaped and named after Kubernetes concepts — `Node`, `Namespace`, `Pod` — even as a reduced/projected DTO carrying only the fields the frontend needs. We instead model and name it in the project's own domain/presentation vocabulary: `Tower`, `Panel` (see `CONTEXT.md`), with a `Panel` nested under the `Tower` it belongs to.

## Why

- **It is a view model, so its names should match its content.** The DTO does not carry cluster facts; it carries *scene* facts — grid `position`, phase-*derived* `color`, and view-mode-*resolved* grouping. A type named `Node` that holds an x/z grid position and a hex color would misdescribe its own contents. Presentation names fit presentation state honestly.
- **`Tower` is polymorphic and has no clean Kubernetes name.** A Tower is a `Node` in Node-mode but a `Namespace`/OpenShift `Project` in Namespace-mode. You cannot call the type `Node` (half the time it is a Namespace); a Kubernetes-native design would have to invent a neutral unifying abstraction (`Group` + a `kind` discriminator) anyway. `Tower` *is* that neutral abstraction. (`Panel` = `Pod` is 1:1, so that name is a wash; consistency with `Tower` carries it.)
- **The backend is the smart, RBAC-aware layer ([[0001-go-backend-over-browser-only]]).** Which View Modes are even available is a permission fact (the `SelfSubjectAccessReview` probe; the OpenShift Project fallback), decidable only server-side. So the frontend cannot autonomously derive the scene or switch modes without the backend regardless of the wire's shape.
- **Scale, wire size, and the delta model ([[0007-scene-updates-are-snapshot-plus-delta]]) favor a compact projection.** At thousands of pods, a projected scene DTO is far lighter than relaying cluster objects, and scene-shaped deltas ("this Panel changed color") are simpler than re-deriving the scene from raw watch events on the client.
- **Least exposure, especially for the deferred hosted version.** A presentation projection is a natural allowlist (name, phase, color, position) rather than leaking full object metadata to browsers.
- **It decouples the frontend from Kubernetes.** The WebGL/React layer knows only Towers/Panels/colors, not pod phases, container statuses, or `nodeName` semantics.

## Rejected alternative, and when to revisit

A genuinely Kubernetes-*named* wire would be the right call only if paired with moving presentation logic (layout, color mapping) out of the backend and into the frontend — i.e. the wire becomes plain reduced cluster data (`Pod{name, phase, nodeName}`, no positions/colors) and the frontend derives the scene. That is coherent and would buy "retheme/relayout without backend changes," but it pushes presentation logic into the WebGL layer (against [[0001-go-backend-over-browser-only]] and the clean `SceneState → render tree` seam) and still does not dissolve the `Tower` polymorphism naming problem. Revisit only if minimizing backend round-trips for purely visual changes becomes a priority — the real fork there is *where presentation logic lives*, not merely what the types are called.

This choice is also low-regret: starting with a narrow presentation projection and *widening* it when the frontend genuinely needs more is far easier than starting Kubernetes-native and trying to slim it down later (which breaks consumers and re-introduces the scale/exposure costs).
