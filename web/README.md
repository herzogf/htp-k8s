# htp-k8s frontend

Vite + React + TypeScript + React Three Fiber frontend for htp-k8s, a cinematic
3D Kubernetes cluster visualizer. See `CONTEXT.md` and `docs/adr/` at the repo
root for domain vocabulary and architectural decisions.

This is currently a placeholder scaffold (issue #3): an empty R3F `Canvas`
that opens a WebSocket connection and displays the raw text of whatever
message it last received. Towers, Panels, and Floor Lanes land in later
tickets.

## Scripts

Run from this directory (`web/`), or via the Taskfile (`task <name>` from
here, or `task --taskfile web/Taskfile.yml <name>` from the repo root):

- `npm run dev` — start the Vite dev server
- `npm run build` — typecheck (`tsc -b`) and build the production bundle
- `npm run lint` — ESLint + Prettier formatting check
- `npm run format` — apply Prettier formatting
- `npm test` — run the Vitest suite
- `npm run e2e` — run the Playwright end-to-end suite (see below)

## End-to-end tests (Playwright)

`e2e/` holds the Playwright suite (`*.spec.ts`), configured in
`playwright.config.ts`. Unlike the Vitest unit tests, these drive the **real
built app**: Playwright's `webServer` runs the root `task build` to produce the
single embedded binary (ADR-0001), launches it, and loads the served page in a
real headless Chromium. This is the genuine full-system check (ADR-0004), and
its screenshots and video are the project's visual proof of behavior.

Run it with `task e2e` (from here) or `npm run e2e`. The browser binary must be
present first — `npx playwright install chromium` (the `task e2e` target does
this for you). The suite builds and launches on port 8080 by default; set
`HTP_K8S_E2E_PORT` to use another port (the frontend's `/ws` target is rebuilt
to match).

Artifacts land in `e2e-results/` (per-test screenshot, video, trace) and an
HTML report in `playwright-report/` — both git-ignored, and the predictable
location a future CI job (issue #8) uploads.

## Configuration

The WebSocket URL the scene connects to is set at build time via the
`VITE_WS_URL` environment variable (see `src/config.ts`), defaulting to
`ws://localhost:8080/ws` when unset.
