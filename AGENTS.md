## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues in `herzogf/htp-k8s`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Agent findings (shared memory)

`docs/agents/findings.md` is the project's cross-ticket "agent memory" — durable build/CI/testing gotchas and constraints that future agents would otherwise rediscover the hard way. **Read it before starting work, and append to it when you learn something non-obvious that a future agent should know.** Keep entries terse; delete stale ones.

### Code review

`docs/agents/code-review.md` is the **repo-owned** source of truth for the review axes (Standards, Spec, Integration/Coherence), the code-smell baseline, and the security-triage criteria that the `code-reviewer` subagent applies. It's deliberately kept in-repo (not in the external `/code-review` skill) so it survives skill updates. The external `/code-review` skill remains available for ad-hoc manual reviews (two axes).

## AI development team

This project is built entirely by AI, directed by the user rather than hand-written — this applies to future features too, not just v1. See ADR-0006 for the full rationale.

### Roles

- **Architect/orchestrator** — not a subagent. Whichever session is driving `/implement` plays this role: read the ticket(s), decide sequential vs. parallel dispatch, choose which subagent handles which ticket, and dispatch the mandatory `code-reviewer` once component work lands. **Delegates implementation by default** — the dev subagents write the code; the orchestrator does only small, conscious, announced fixes when it already holds the full analysis (e.g. acting directly on a review finding), and a re-review must follow any such fix.
- **`backend-developer`** (`.claude/agents/backend-developer.md`) — Go backend (`cmd/`, `internal/`).
- **`frontend-developer`** (`.claude/agents/frontend-developer.md`) — React Three Fiber frontend (`web/`).
- **`backend-tester`** (`.claude/agents/backend-tester.md`) — kind + KWOK integration tests. On-demand only (see _Review gate_).
- **`frontend-tester`** (`.claude/agents/frontend-tester.md`) — Playwright e2e, screenshots/video. On-demand only (see _Review gate_).
- **`code-reviewer`** (`.claude/agents/code-reviewer.md`, `opus`) — independent, mandatory pre-merge review along three axes (Standards, Spec, Integration/Coherence) plus a security-review triage flag. Reads only; **never** fixes its own findings. Applies the methodology in `docs/agents/code-review.md`.
- **`release-manager`** (`.claude/agents/release-manager.md`) — GoReleaser/`ko`/SBOM/attestation pipeline. Can prepare a release autonomously; **never** tags/pushes/triggers the real release without the user's explicit go-ahead in that turn.

### Dispatch conventions

- Tickets from `/to-tickets` should carry a component label (`frontend`, `backend`, `frontend-test`, `backend-test`, `release`) so the orchestrator knows which subagent to dispatch.
- Independent tickets with no blocking edge between them (e.g. one `frontend` ticket and one `backend` ticket) can be dispatched to their respective subagents **in parallel**, each in an isolated git worktree (`Agent` tool's `isolation: "worktree"`) so simultaneous work doesn't collide.
- A ticket that spans both frontend and backend (e.g. a new WebSocket message shape) should still be split into two component-labeled tickets with a blocking edge between them (backend defines the contract first) rather than handed to one subagent that would edit outside its scope.

### Review gate, fixes & merge

Every PR passes an independent review before it can merge — **no exceptions, including PRs the orchestrator authored itself** (that is where an independent gate matters most).

1. **Implement.** The dev subagent implements test-first and writes its own unit tests. If it sees a change that needs integration (kind + KWOK) or e2e (Playwright) coverage — logic not sufficiently unit-testable, or new end-user behaviour — it **flags that to the orchestrator** rather than opening the PR as-is.
2. **Cover (on demand).** On such a flag, the orchestrator dispatches the relevant tester subagent to add the integration/e2e test code **before** the PR opens and before review.
3. **Review (mandatory).** Once work lands on the PR branch, the orchestrator dispatches the **`code-reviewer`** subagent against the PR diff. It reviews along three axes (Standards, Spec, Integration/Coherence) and returns a `security_review_recommended` triage flag. It **never fixes its own findings.**
4. **Security (conditional).** If the reviewer flags `security_review_recommended: yes`, the orchestrator runs the `/security-review` skill and folds in its findings.
5. **Fix.** Blocking findings go back to the **original dev subagent**; the orchestrator may apply only small, conscious, announced fixes when it already holds the full analysis. After any fix the orchestrator **re-dispatches the reviewer** on the updated diff. The loop is capped at **3 rounds**, then **escalate to the human**.
6. **Merge gate.** A PR merges only when **both** hold: CI is green (including the strict up-to-date-branch checks) **and** the `code-reviewer` returns no blocking findings (and `/security-review` is clean, if it ran).

### Testers are empirical & on-demand

The test suites run on **every** PR in CI (unit + the PR-blocking integration tier + Playwright e2e with screenshots/video) — that empirical verification is automatic and needs no agent. The **tester subagents** (`backend-tester`, `frontend-tester`) *author* test code and are dispatched **on demand only** — triggered either by a dev subagent's upfront flag (step 1 above) or by the `code-reviewer`'s test-coverage-adequacy axis, which treats integration/e2e-relevant untested features as a priority finding. This is deliberately complementary: the tester *writes* coverage; the reviewer *decides whether it's needed*. Don't run testers mechanically for changes unit tests already cover.

### Documentation stays in sync

Any PR that changes user-visible behaviour updates the relevant docs (README, `docs/running-locally.md`, etc.) **in the same PR**. This is enforced by review (the `code-reviewer`'s Integration/Coherence axis checks it), not by tooling, with the pre-release media/content check (#108) as a backstop.

### Issue lifecycle

Issues close **on PR merge, not on PR open.** Put `Closes #<n>` in the PR body and let GitHub auto-close the issue when it merges to `main`; leave the issue open until then, and don't `gh issue close` it manually. See `docs/agents/issue-tracker.md`. This keeps the native dependency graph honest — a downstream ticket only becomes unblocked once its blocker's code is actually on `main` (the orchestrator gates the frontier on "blocker PR merged," not "issue closed").
