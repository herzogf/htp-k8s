/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL the scene connects to for Scene State / Scene Delta messages. */
  readonly VITE_WS_URL?: string
  /**
   * Optional override for the read-only Detail HTTP + SSE base URL (ADR-0009).
   * Unset by default — the base is derived from {@link VITE_WS_URL} so the two
   * can't drift (see `getApiBaseUrl`).
   */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
