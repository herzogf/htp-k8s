## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues in `herzogf/htp-k8s`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Agent findings (shared memory)

`docs/agents/findings.md` is the project's cross-ticket "agent memory" — durable build/CI/testing gotchas and constraints that future agents would otherwise rediscover the hard way. **Read it before starting work, and append to it when you learn something non-obvious that a future agent should know.** Keep entries terse; delete stale ones.

## AI development team

This project is built entirely by AI, directed by the user rather than hand-written — this applies to future features too, not just v1. See ADR-0006 for the full rationale.

### Roles

- **Architect/orchestrator** — not a subagent. Whichever session is driving `/implement` plays this role: read the ticket(s), decide sequential vs. parallel dispatch, choose which subagent handles which ticket, and run the final cross-cutting `/code-review` once component work lands.
- **`backend-developer`** (`.claude/agents/backend-developer.md`) — Go backend (`cmd/`, `internal/`).
- **`frontend-developer`** (`.claude/agents/frontend-developer.md`) — React Three Fiber frontend (`web/`).
- **`backend-tester`** (`.claude/agents/backend-tester.md`) — kind + KWOK integration tests.
- **`frontend-tester`** (`.claude/agents/frontend-tester.md`) — Playwright e2e, screenshots/video.
- **`release-manager`** (`.claude/agents/release-manager.md`) — GoReleaser/`ko`/SBOM/attestation pipeline. Can prepare a release autonomously; **never** tags/pushes/triggers the real release without the user's explicit go-ahead in that turn.

### Dispatch conventions

- Tickets from `/to-tickets` should carry a component label (`frontend`, `backend`, `frontend-test`, `backend-test`, `release`) so the orchestrator knows which subagent to dispatch.
- Independent tickets with no blocking edge between them (e.g. one `frontend` ticket and one `backend` ticket) can be dispatched to their respective subagents **in parallel**, each in an isolated git worktree (`Agent` tool's `isolation: "worktree"`) so simultaneous work doesn't collide.
- A ticket that spans both frontend and backend (e.g. a new WebSocket message shape) should still be split into two component-labeled tickets with a blocking edge between them (backend defines the contract first) rather than handed to one subagent that would edit outside its scope.
