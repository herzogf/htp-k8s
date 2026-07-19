import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

// The backend the dev-server proxy below forwards /ws and /api to. Override
// with VITE_DEV_BACKEND if the backend isn't on the default 127.0.0.1:8080
// (e.g. `-addr` was changed) — this only affects `npm run dev`, never the
// production build.
const devBackend = process.env.VITE_DEV_BACKEND ?? 'http://127.0.0.1:8080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxies /ws and /api to the backend so `npm run dev` (Vite on :5173)
    // is same-origin with the backend (normally :8080), matching production
    // where the single binary serves everything from one origin (ADR-0001).
    // This removes the need for VITE_WS_URL/VITE_API_URL in development —
    // see getWebSocketUrl/getApiBaseUrl in src/config.ts.
    proxy: {
      // Exact-match, not a prefix: '/ws' as a plain string key would also
      // capture any future '/ws…' route. `target` takes the plain http(s)
      // origin unchanged — `ws: true` alone is what makes http-proxy accept
      // and forward the WebSocket upgrade; verified live (issue #146).
      '^/ws$': {
        target: devBackend,
        ws: true,
      },
      '/api': {
        target: devBackend,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    // Vitest's default `include` also matches the Playwright *.spec.ts files
    // under e2e/; those are driven by `npx playwright test`, not Vitest (they
    // import @playwright/test and launch a real browser), so keep them out.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
