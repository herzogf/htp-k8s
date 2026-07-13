# On-demand detail and the log tail use HTTP + SSE, not the `/ws` WebSocket

The scene wire contract is a **one-way** `/ws` broadcast — a `SceneState` snapshot followed by Scene Deltas ([[0007-scene-updates-are-snapshot-plus-delta]]). On-demand **Detail Popup** data (per-Tower / per-Pod summary, and a bounded live **log tail**) needed a transport too. We could have multiplexed request/response onto the same `/ws` socket, or used a separate channel. We chose separate **read-only HTTP** endpoints plus **Server-Sent Events**:

- `GET /api/towers/{name}` → Tower detail (a `kind: node|namespace` discriminator says which summary is populated).
- `GET /api/pods/{namespace}/{name}` → Pod detail.
- `GET /api/pods/{namespace}/{name}/logtail` → **SSE** stream; each event is the current ≤3-line window (replaced whole), backed by the Kubernetes `GetLogs(Follow, TailLines)` API, bounded and cancelled on client disconnect.

`/ws` stays exactly the one-way snapshot+delta broadcast.

## Why

- **Keeps `/ws` simple.** Detail is per-click request/response, a fundamentally different interaction from a broadcast. Putting it on `/ws` would turn the one-way stream into a multiplexed bus needing correlation IDs, message-type routing, detail replies interleaved with deltas, and write-serialization through the single delta-pump goroutine (WebSocket libraries forbid concurrent writes). HTTP is request/response natively.
- **Read-only becomes structural, not a convention** ([[0003-cinematic-viewer-not-admin-tool]]). SSE is one-directional (server→client) and GET is idempotent, so there is *no* client→server channel on the detail/log path through which an exec or mutation could ever be smuggled. For a viewer that deliberately refuses to be an admin tool, that is a verifiable safety property rather than a discipline.
- **Decoupled lifecycles / backpressure.** A slow detail payload or a stuck log stream is its own connection; it cannot backpressure or stall the scene broadcast. On a shared `/ws` it could.
- **Keeps `SceneState` lean** ([[0008-scene-state-is-a-presentation-view-model]]). Detail is heavier, per-click, and not part of the scene — it stays off the broadcast entirely.
- Trivially testable/observable (curl, browser devtools).

## Cost accepted, and rejected alternative

The app now speaks three transports — WebSocket (scene), HTTP (detail), SSE (logs) — so there is more surface to document and secure, and the deferred hosted version will have more than one channel to authenticate per tenant. We accept this: each is a standard, well-understood mechanism, they share one `http.Server`, and for a hosted deployment separate surfaces are arguably an advantage (independent auth / rate-limiting per surface rather than everything inside one WebSocket connection).

Rejected: **everything over `/ws`**. It offers a single transport/auth surface, but at the cost of turning the clean broadcast into a request/response bus, coupling detail handling to the broadcast writer, sharing backpressure with scene updates, and making the read-only guarantee a discipline instead of a structure. If a future hosted version genuinely needs a single channel, consolidating is a contained refactor — easier than clawing back the read-only structure we'd have given up.
