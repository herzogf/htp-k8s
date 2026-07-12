import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    // Vitest's default `include` also matches the Playwright *.spec.ts files
    // under e2e/; those are driven by `npx playwright test`, not Vitest (they
    // import @playwright/test and launch a real browser), so keep them out.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
