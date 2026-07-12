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

## Configuration

The WebSocket URL the scene connects to is set at build time via the
`VITE_WS_URL` environment variable (see `src/config.ts`), defaulting to
`ws://localhost:8080/ws` when unset.
