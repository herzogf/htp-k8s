/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Escape hatch: overrides the WebSocket URL the scene connects to for
   * Scene State / Scene Delta messages. Unset by default — the URL is
   * derived from `window.location` instead (see `getWebSocketUrl` in
   * `src/config.ts`), so this is only needed for a genuinely cross-origin
   * setup. Not needed for local development either: `vite.config.ts`
   * proxies `/ws` to the backend.
   */
  readonly VITE_WS_URL?: string
  /**
   * Escape hatch: overrides the read-only Detail HTTP + SSE base URL
   * (ADR-0009). Unset by default — the base is derived from
   * {@link VITE_WS_URL} (or, absent that, `window.location`) so the two
   * can't drift (see `getApiBaseUrl`).
   */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
