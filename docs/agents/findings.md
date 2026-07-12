# Agent Findings

A shared, version-controlled knowledge base for AI agents working on htp-k8s. When you (as any subagent or the orchestrator) learn something non-obvious that a *future* agent would otherwise have to rediscover the hard way — a build/CI gotcha, a dependency constraint, a resolved trip-hazard — record it here. This is the project's "agent memory": it travels with the repo, is read by every dispatched agent, and is visible to the human maintainer.

**Scope:** durable, cross-ticket operational knowledge. Not a changelog (git history covers that), not domain vocabulary (`CONTEXT.md`), not architectural decisions (`docs/adr/`). If a fact belongs in one of those, put it there and link it.

**Upkeep:** keep entries terse and current. If a finding becomes obsolete (e.g. a constraint is lifted), delete or update it rather than leaving stale advice.

---

## Build & toolchain

- **The app is a single binary.** `task build` builds the frontend (`web/`), copies `web/dist` into `internal/server/dist`, and compiles `bin/htp-k8s` with the frontend embedded via `go:embed`. Running the binary serves the UI plus a `/ws` WebSocket endpoint. There is no separate frontend server to run in production.
- **`go.mod` floors at `go 1.26` (minor version), deliberately not an exact patch.** This avoids forcing local dev machines to fetch a specific toolchain. Do **not** "tighten" it to an exact patch — that decision was made and reversed once already (see PR history on issue #2). CI compensates with `check-latest: true` on `actions/setup-go` so it still scans against the newest patched toolchain.
- **`task test` runs `go test ./cmd/... ./internal/...`, not `./...`** — scoped on purpose. After `npm ci`, `web/node_modules` can contain stray vendored `.go` files (e.g. the `flatted` package) that `./...` would wrongly pull into the module's test graph.

## Wire contract codegen (SceneState → TypeScript, issue #10)

- **The frontend/backend wire contract is Go-first.** `SceneState` (and the `ViewMode` type/values) are defined once in **`internal/scene`** — the single source of truth. The frontend's TypeScript types are **generated** from it into **`web/src/generated/scenestate.ts`** (checked in); never hand-edit that file.
- **Regenerate with `task codegen`** (runs `go tool tygo generate`, config in root `tygo.yaml`). Root `task build` runs `codegen` before `web:build` so the frontend always typechecks against fresh types.
- **Drift gate: `task codegen:verify`** regenerates then `git diff --exit-code -- web/src/generated`, so a Go struct change without a matching regenerate-and-commit fails. It runs in the **Backend (Go)** CI job (a step before `Build`), **not** the Frontend job — tygo needs the Go toolchain, which the Node job lacks.
- **tygo (`github.com/gzuidhof/tygo`) is a pinned Go *tool* dependency** (`go get -tool`, invoked via `go tool tygo`). It correctly stays `// indirect` in `go.mod` after `go mod tidy` (nothing imports it in code) — that's tidy-stable, don't "fix" it.
- **tygo emits `any` for a field whose type lives in another Go package** (e.g. it can't resolve `kube.ViewMode` from a `scene` struct). Keep every type reachable from `SceneState` **co-located in `internal/scene`** so the generated TS is fully typed. This is why `ViewMode` was moved out of `internal/kube` into `internal/scene`.
- **`web/src/generated` is ESLint- and Prettier-ignored** (generated, not hand-styled) — `web/eslint.config.js` `globalIgnores` + `web/.prettierignore`. It is still typechecked by `tsc -b` (tsconfig `include: ["src"]`), so malformed generated TS still fails the frontend build.
- **`/ws` sends a `scene.SceneState` JSON snapshot on connect** (replaced the ad-hoc `{"type":"viewMode",...}` message from #9). Per ADR-0007, incremental Scene Deltas follow the snapshot — a later ticket.

## CI & security scanning

- **`govulncheck ./...` is a blocking PR check** (Backend job). It fails the build on any *reachable* vulnerability. This has bitten PRs twice; treat it as a first-class gate, and run `govulncheck ./...` locally before pushing.
- **Keep `golang.org/x/net` at ≥ v0.57.0.** It arrives transitively via the kind/KWOK/k8s client libraries. v0.38.0 shipped two reachable vulns (GO-2026-5026 idna, GO-2026-4918 http2). When you `go mod tidy`, verify x/net did not get downgraded below v0.57.0 — a botched go.sum merge can silently drop it.
- **`npm audit` is a blocking PR check** (Frontend job). Run it locally before pushing if you touched `web/` dependencies.
- **Branch protection on `main`** (ruleset id 18831212): PRs required (0 approvals), with required status checks `Backend (Go)` and `Frontend (Node)`. Direct pushes to `main` are rejected — always go through a PR.
- **A PR opened *before* a workflow existed on `main` won't have run the checks.** Update the PR branch with `main` (`gh pr update-branch <n>`) to produce the commit event that triggers them.
- **Two-tier PR jobs (issue #8).** On top of the fast `Backend (Go)` / `Frontend (Node)` jobs, `pr.yml` has three heavier jobs, each separate so the fast tier stays fast: `Backend integration (kind + KWOK)`, `E2E (Playwright)`, `Container scan (Trivy)`. **They are NOT (yet) required status checks** — making them required is a branch-protection-ruleset change left to the repo owner.
- **The Trivy container scan is report-only, never blocking** (ADR-0005). It builds a throwaway local image with `ko build --local` (no registry push; `KO_DOCKER_REPO=ko.local`), then Trivy emits SARIF that is uploaded to the Security tab. The job needs a job-level `permissions: security-events: write` (the workflow default is only `contents: read`) or the SARIF upload 403s. Keep `exit-code: "0"` + `continue-on-error` on the scan/upload steps so a scanner hiccup or finding never fails the PR.
- **`ko build --local ./cmd/htp-k8s` works with only the committed placeholder `internal/server/dist/index.html`** — `go:embed all:dist` matches it, so ko can compile the binary into an image for CVE scanning without first running the frontend build. (The real ko/GoReleaser release build is issue #30.)

## Testing

- **Integration tests are gated behind the `//go:build integration` build tag** and are therefore *not* run by the fast PR workflow's `task test` step (that's by design — the fast jobs stay fast). Run them locally with `go test -tags=integration ./internal/...`. As of issue #8 they run in CI as their own `Backend integration (kind + KWOK)` job (`go test -tags=integration ./cmd/... ./internal/...` — same `./cmd/... ./internal/...` scoping as `task test`, to dodge the `web/node_modules` stray-`.go` hazard). Do **not** add `-tags=integration` to the fast Backend `Test` step — that would force every PR's fast job to spin up kind+KWOK.
- **The Playwright e2e CI job must install the browser with `npx playwright install --with-deps chromium`** — the `--with-deps` apt step supplies system libraries a fresh Ubuntu runner lacks. The `web:e2e` task itself only runs `playwright install chromium` (download, no system deps), so the CI job runs the `--with-deps` install before `task web:e2e`. That job also needs Node + Go + go-task all on PATH, because Playwright's `webServer` runs `task build` to produce and launch the real binary. Screenshots/video/traces land in `web/e2e-results/` (uploaded as the `playwright-e2e-results` artifact; HTML report in `web/playwright-report/`).
- **The kind + KWOK harness lives at `internal/testcluster`** (`testcluster.New(t, ...)`, from issue #5). It programmatically spins up a real single-node kind cluster and attaches a KWOK controller — **Docker is the only prerequisite** (no `kind`/`kwok` CLI, no pre-existing cluster). It ran live in ~45s in the build environment. Teardown is registered via `t.Cleanup` before creation, so clusters are always removed even on panic/failure. Use `AddFakeNodes`/`AddFakePods` for scale without real containers.
- **KWOK manifests are vendored** from pinned upstream v0.8.0 under `internal/testcluster/manifests/` (with attribution). Don't hand-edit them casually; re-vendor from a pinned upstream tag if they need updating.

## Parallel-dispatch hazards

- **Two tickets that both edit `go.mod`/`go.sum` will conflict when the second merges**, even with no source overlap. This happened with PRs #35 (added gorilla/websocket) and #36 (added kind/KWOK deps). Resolution: merge `main` into the lagging branch, take one side's `go.mod`/`go.sum` wholesale, re-run `go mod tidy`, then **re-verify `govulncheck` and the x/net floor survived**. Prefer scoping parallel tickets so only one touches Go dependencies at a time.
- **File-ownership boundaries prevent most conflicts.** When dispatching parallel work, give each agent an explicit disjoint file scope (backend → `cmd/`+`internal/`, frontend → `web/`, CI → `.github/`, etc.) and name the sibling ticket's scope so it stays clear.
- **`.claude/agents/*.md` custom subagent types may not be available in every runtime.** When they aren't, dispatch a `general-purpose` agent and fold the role's persona (from the corresponding `.claude/agents/*.md`) into the prompt instead.
