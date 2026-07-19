/**
 * Returns the WebSocket URL the scene should connect to.
 *
 * Defaults to same-origin: the scheme and host are derived from
 * `window.location` (`https:` → `wss:`, else `ws:`), matching how the single
 * binary serves the UI, `/ws`, and `/api` from one origin (ADR-0001). That
 * means a stock build works unmodified no matter which host/port the binary
 * is actually reached on — including remotely, and behind a TLS reverse
 * proxy.
 *
 * `VITE_WS_URL` remains a build-time escape hatch for a genuinely
 * cross-origin setup. It should not be needed for local development either:
 * `vite.config.ts` proxies `/ws` to the backend so the dev server is
 * same-origin too.
 */
export function getWebSocketUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL
  if (explicit) {
    return explicit
  }
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws`
}

/**
 * Returns the base URL for the read-only Detail HTTP + SSE endpoints (ADR-0009:
 * `GET /api/towers/{name}`, `GET /api/pods/{ns}/{name}`, and the
 * `…/logtail` SSE stream), e.g. `http://localhost:8080`.
 *
 * The single binary serves the frontend, the `/ws` broadcast, and these `/api`
 * endpoints from one origin (ADR-0001), so rather than carry a second
 * environment variable that could drift from {@link getWebSocketUrl}, the HTTP
 * origin is derived from the WebSocket URL: swap `ws`→`http` / `wss`→`https` and
 * drop the trailing `/ws` path. An explicit `VITE_API_URL` still overrides it
 * for the rare case the detail endpoints live elsewhere than the socket.
 */
export function getApiBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_URL
  if (explicit) {
    return explicit
  }
  return getWebSocketUrl().replace(/^ws/, 'http').replace(/\/ws$/, '')
}
