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
