# Host-header allowlist for /ws and /api: unconditional, independent of Origin

`/ws`'s WebSocket upgrader no longer overrides `CheckOrigin`; it uses gorilla's default (`checkSameOrigin`: allow when no `Origin` header is present, otherwise require `Origin` to equal `Host`). On top of that, the entire HTTP handler (`internal/server/server.go`'s `NewHandler`) is wrapped in a Host-header allowlist (`internal/server/hostallowlist.go`: `AllowedHosts`, `hostAllowlist`, `gatedPath`) that rejects any `/ws` or `/api/*` request whose `Host` isn't trusted — **unconditionally, regardless of whether the request carries an `Origin` header.** Implemented in #166 (issue #163).

## Why unconditional: gating on Origin's presence is a bypass, not a mitigation

The natural instinct is "only check `Host` when a request looks browser-issued (carries an `Origin`)" — non-browser tooling (`curl`, monitoring) rarely sends one. That instinct is wrong for this specific defense. Per the WHATWG Fetch spec ("Append a request Origin header"), a browser only appends `Origin` when response tainting is `cors` or the request method isn't GET/HEAD — **a same-origin `GET` never carries one.** That's exactly what `fetch()`/`EventSource` issue against `/api`, including the SSE log tail. WebSocket is the one request type Fetch calls out as always carrying `Origin`, which is why an Origin-presence gate looked safe when only `/ws` was considered — it wasn't for `/api`: a DNS-rebound page's `fetch('/api/pods/.../logtail')` is a plain same-origin GET with no `Origin` header at all, so gating on Origin's presence lets it straight through to a `Host` check it never triggers. Verified empirically against a real browser and this handler — an earlier draft of this fix made exactly this mistake and shipped it to review.

The fix: `hostAllowlist` checks `Host` on every `gatedPath` request, full stop — `Origin` is irrelevant to the allow/deny decision (it's only read for the rejection log line).

## What's trusted, unconditionally, with no configuration

`AllowedHosts.Permits` (see its doc comment for the exact rules) always allows:

- **An IP-address-literal `Host`** (v4 or v6). DNS rebinding requires resolving a *name*; a `Host` that's already a bare IP was never routed through DNS, so there's no name to rebind. This is also what makes a wildcard `-addr :8080` bind — the only option inside a container, and what all three `docker run` recipes in `README.md` use — reachable by a browser at its IP address with zero extra configuration, matching the "#160 must not reinstate a configuration step" constraint the original grill on issue #163 established.
- **`localhost` and any `*.localhost` subdomain.** RFC 6761 §6.3 reserves the whole `.localhost` TLD to always resolve to loopback; this mirrors Vite's own dev-server Host check (`isHostAllowedInternal`), which trusts the identical two forms unconditionally, with no `Origin` gate either.

Everything else needs an explicit `-allowed-hosts`/`HTP_K8S_ALLOWED_HOSTS` entry — for a reverse proxy or any DNS-name deployment, neither of which can be inferred from `-addr`. Entries are bare hostnames (a scheme or path is rejected at startup, not silently misinterpreted); wildcards are not supported. A rejection logs the offending `Origin`/`Host` and names `-allowed-hosts` explicitly, so a reverse-proxy operator isn't left with an opaque 403.

## Enforced once, over the whole handler

`NewHandler` wraps the entire `http.ServeMux`, not each route individually; `gatedPath` (a path-prefix check for `/ws` and `/api/*`) decides per-request which paths the wrapper actually enforces. A future `/api/*` route is therefore protected automatically — there's no per-route wrapper to remember when adding one.

## Why this bites the loopback default specifically, and isn't covered by ADR-0012

[ADR-0012](0012-secure-by-default-network-binding.md)'s mitigation is about who can reach the *port* — nothing off the machine can open a connection at all under the loopback default. DNS rebinding needs no off-machine reach: it's the *victim's own browser*, on the victim's own machine, that ends up dialing `127.0.0.1` after the rebind, entirely within what ADR-0012 already permits. That's why this is its own ADR rather than folded into ADR-0012 — cross-linked both ways.

## Rejected alternative: gate on Origin presence

Covered above — not a simplification, a bypass, for every `/api` route including the SSE log tail.

## Revisit if

htp-k8s ever grows a reverse-proxy-aware deployment mode with a canonical public hostname sourced some other way (e.g. a config file) — `-allowed-hosts` might become redundant with that source rather than the sole configuration surface for it.
