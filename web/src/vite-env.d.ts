/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL the scene connects to for Scene State / Scene Delta messages. */
  readonly VITE_WS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
