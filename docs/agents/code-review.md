# Code review — axes & baseline

The methodology htp-k8s's **`code-reviewer`** subagent applies (and the reference for any manual review). **Repo-owned** so it survives updates to the external `/code-review` skill — do not depend on that skill for this content. See `AGENTS.md` → _Review gate, fixes & merge_ for how the reviewer is dispatched.

## The three axes

Review along three deliberately separate axes; don't let one mask another. A change can pass one axis and fail another — so report them separately, never merged or reranked across axes.

### 1. Standards
Does the code follow this repo's documented standards, and is it free of code smells? Apply any repo standards docs (e.g. a `CODING_STANDARDS.md` / `CONTRIBUTING.md` if present), **plus the smell baseline below**. Documented repo standards override the baseline; baseline smells are always judgement calls; skip anything tooling already enforces.

### 2. Spec
Does the diff faithfully implement the originating issue? Report (a) requirements missing or partial, (b) behaviour not asked for (scope creep), (c) requirements that look implemented but wrong. Quote the spec line for each finding.

### 3. Integration / Coherence
Does the change fit the *whole*, not just itself? This is the big-picture axis:
- **Sibling consistency** — follows existing patterns/conventions in the surrounding code, not just internally consistent.
- **ADR & CONTEXT alignment** — doesn't silently violate or drift from a recorded decision (`docs/adr/*`, `CONTEXT.md`).
- **Cross-cutting ripple** — implied edits elsewhere it didn't touch (the WebSocket message contract, the other component, config, the e2e suite).
- **Test-coverage adequacy — PRIORITY.** Flag prominently any **integration/e2e-relevant feature that is under-tested**: logic not sufficiently unit-testable (real-cluster pod lifecycle, watch/event pipeline — see ADR-0004) or **new end-user behaviour the Playwright e2e should exercise and visually prove** but doesn't. This is the demand signal that a tester subagent (`backend-tester` / `frontend-tester`) should be dispatched — call it out explicitly.
- **Docs sync** — a behaviour-changing PR must update the relevant docs (README, `docs/running-locally.md`) in the same PR.
- **Overall coherence** — does the whole still hang together; any architectural drift the two inward axes would miss?

## Security triage
As part of the Integration axis, judge whether the diff is **security-relevant** and warrants a dedicated pass, and return a final line: `security_review_recommended: yes|no — <reason>`. Flag **`yes`** when the diff touches: the permission-probe / view-mode / RBAC-scope logic; the WebSocket/HTTP server surface or input parsing; cluster-access scope or credential/kubeconfig handling; dependencies / supply-chain (`go.mod`, `package.json`, the release/attestation pipeline); file/exec/network operations; or secrets/config. The reviewer does **not** run the security review itself — the orchestrator runs the `/security-review` skill when the flag is `yes`.

## Smell baseline (Fowler, _Refactoring_, ch.3)
A fixed set of code smells that applies even when a repo documents nothing. Two rules bind it: the **repo overrides** (a documented standard always wins; suppress a smell the repo endorses), and it's **always a judgement call** (each is a labelled heuristic — "possible Feature Envy" — never a hard violation; skip anything tooling enforces). Each reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

## Severity & report shape
- **blocking** = correctness, spec-miss, security, coherence/ADR violation, or a missing integration/e2e-relevant test. **nit** = everything else.
- Group findings under `## Standards`, `## Spec`, `## Integration/Coherence`; for each give severity, the file/hunk, and a one-line why, quoting the standard/spec/ADR line where relevant. Don't merge or rerank across axes.
- End with the `security_review_recommended` line and a one-line summary: blocking-count per axis, and whether the PR is mergeable (no blocking findings) or needs another round.
