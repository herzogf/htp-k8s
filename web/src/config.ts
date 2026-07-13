/** Default WebSocket URL used when `VITE_WS_URL` isn't set at build time. */
export const DEFAULT_WS_URL = 'ws://localhost:8080/ws'

/**
 * Returns the WebSocket URL the scene should connect to, configurable via
 * the `VITE_WS_URL` build-time environment variable so the same build can
 * point at different backends (local dev, CI, a packaged binary's own
 * address) without a code change.
 */
export function getWebSocketUrl(): string {
  return import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL
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
