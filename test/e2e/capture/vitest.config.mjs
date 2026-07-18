// Vitest config for this tool's permanent pure-math regression suite (issue
// #120 — see lib/*.test.mjs). Deliberately separate from web/'s vitest setup
// (vite.config.ts): these modules have no dependency on the React app or a
// DOM, and this directory is not a descendant of web/ (see run.sh's module-
// resolution comment) — Vite's dev-server file-serving guard also refuses to
// transform test files that live outside a project's root, so pointing
// web/'s vitest at files under here doesn't work without also weakening that
// guard. Running vitest with ITS OWN root here (this directory) sidesteps
// that entirely, at the cost of one extra `task capture:test` wiring step
// (see Taskfile.yml `test`) instead of folding into `web`'s existing `npm
// test`.
//
// No jsdom/setupFiles: everything under test here is plain Node-runnable
// math with no browser API surface, so `environment: 'node'` is both correct
// and much faster than web/'s jsdom-based suite (single-digit ms vs seconds).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.mjs'],
  },
})
