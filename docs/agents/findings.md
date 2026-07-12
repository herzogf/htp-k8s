# Agent Findings

A shared, version-controlled knowledge base for AI agents working on htp-k8s. When you (as any subagent or the orchestrator) learn something non-obvious that a *future* agent would otherwise have to rediscover the hard way — a build/CI gotcha, a dependency constraint, a resolved trip-hazard — record it here. This is the project's "agent memory": it travels with the repo, is read by every dispatched agent, and is visible to the human maintainer.

**Scope:** durable, cross-ticket operational knowledge. Not a changelog (git history covers that), not domain vocabulary (`CONTEXT.md`), not architectural decisions (`docs/adr/`). If a fact belongs in one of those, put it there and link it.

**Upkeep:** keep entries terse and current. If a finding becomes obsolete (e.g. a constraint is lifted), delete or update it rather than leaving stale advice.

---

## Build & toolchain

- **The app is a single binary.** `task build` builds the frontend (`web/`), copies `web/dist` into `internal/server/dist`, and compiles `bin/htp-k8s` with the frontend embedded via `go:embed`. Running the binary serves the UI plus a `/ws` WebSocket endpoint. There is no separate frontend server to run in production.
- **`go.mod` floors at `go 1.26` (minor version), deliberately not an exact patch.** This avoids forcing local dev machines to fetch a specific toolchain. Do **not** "tighten" it to an exact patch — that decision was made and reversed once already (see PR history on issue #2). CI compensates with `check-latest: true` on `actions/setup-go` so it still scans against the newest patched toolchain.
- **`task test` runs `go test ./cmd/... ./internal/...`, not `./...`** — scoped on purpose. After `npm ci`, `web/node_modules` can contain stray vendored `.go` files (e.g. the `flatted` package) that `./...` would wrongly pull into the module's test graph.

## CI & security scanning

- **`govulncheck ./...` is a blocking PR check** (Backend job). It fails the build on any *reachable* vulnerability. This has bitten PRs twice; treat it as a first-class gate, and run `govulncheck ./...` locally before pushing.
- **Keep `golang.org/x/net` at ≥ v0.57.0.** It arrives transitively via the kind/KWOK/k8s client libraries. v0.38.0 shipped two reachable vulns (GO-2026-5026 idna, GO-2026-4918 http2). When you `go mod tidy`, verify x/net did not get downgraded below v0.57.0 — a botched go.sum merge can silently drop it.
- **`npm audit` is a blocking PR check** (Frontend job). Run it locally before pushing if you touched `web/` dependencies.
- **Branch protection on `main`** (ruleset id 18831212): PRs required (0 approvals), with required status checks `Backend (Go)` and `Frontend (Node)`. Direct pushes to `main` are rejected — always go through a PR.
- **A PR opened *before* a workflow existed on `main` won't have run the checks.** Update the PR branch with `main` (`gh pr update-branch <n>`) to produce the commit event that triggers them.

## Testing

- **Integration tests are gated behind the `//go:build integration` build tag** and are therefore *not* run by the fast PR workflow's `task test` step (that's by design — the fast jobs stay fast). Run them locally with `go test -tags=integration ./internal/...`. Wiring the integration suite into CI as its own job is tracked in issue #8.
- **The kind + KWOK harness lives at `internal/testcluster`** (`testcluster.New(t, ...)`, from issue #5). It programmatically spins up a real single-node kind cluster and attaches a KWOK controller — **Docker is the only prerequisite** (no `kind`/`kwok` CLI, no pre-existing cluster). It ran live in ~45s in the build environment. Teardown is registered via `t.Cleanup` before creation, so clusters are always removed even on panic/failure. Use `AddFakeNodes`/`AddFakePods` for scale without real containers.
- **KWOK manifests are vendored** from pinned upstream v0.8.0 under `internal/testcluster/manifests/` (with attribution). Don't hand-edit them casually; re-vendor from a pinned upstream tag if they need updating.

## Parallel-dispatch hazards

- **Two tickets that both edit `go.mod`/`go.sum` will conflict when the second merges**, even with no source overlap. This happened with PRs #35 (added gorilla/websocket) and #36 (added kind/KWOK deps). Resolution: merge `main` into the lagging branch, take one side's `go.mod`/`go.sum` wholesale, re-run `go mod tidy`, then **re-verify `govulncheck` and the x/net floor survived**. Prefer scoping parallel tickets so only one touches Go dependencies at a time.
- **File-ownership boundaries prevent most conflicts.** When dispatching parallel work, give each agent an explicit disjoint file scope (backend → `cmd/`+`internal/`, frontend → `web/`, CI → `.github/`, etc.) and name the sibling ticket's scope so it stays clear.
- **`.claude/agents/*.md` custom subagent types may not be available in every runtime.** When they aren't, dispatch a `general-purpose` agent and fold the role's persona (from the corresponding `.claude/agents/*.md`) into the prompt instead.
