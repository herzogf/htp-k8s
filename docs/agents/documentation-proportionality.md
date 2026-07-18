# Documentation proportionality

The standard for how much to write, and where. Part of the documentation strategy tracked in issue #39. Enforced by review — see `docs/agents/code-review.md` → _Standards_.

**Match the artifact to its audience. Reference detail; don't inline it. One claim, one home.**

## Artifact → audience

| Artifact | Audience & job | What belongs |
| --- | --- | --- |
| `README.md` | Someone deciding whether to run this, in the first two minutes | The 80% path: commands, plus the minimum text needed to choose between them. **What and how, not why.** Cross-link the rest. |
| Detail docs (`docs/running-locally.md` and friends) | Someone who already committed and hit a wall | The why, the caveats, the platform edge cases — everything that would bloat the README. |
| ADRs (`docs/adr/`) | A future maintainer asking "why is it like this?" | Decisions with trade-offs and rejected alternatives. **Not** style rules, not tutorials, not recipes. |
| Release notes / `.goreleaser.yaml` footer | Every reader of every release | Same discipline as the README — it ships as widely. |

This standard is the worked example of that ADR row: a style rule with no rejected alternatives to record, so it is **not** an ADR. ADR-0012 (the loopback default) is the contrast — a real decision with a real trade-off.

## One claim, one home

The corollary that does the real work: **a claim lives in exactly one place and is referenced from the others.** Duplicated prose across README / detail docs / ADRs drifts — the copies are updated at different times and quietly start disagreeing. When a fact is needed in a second place, link to it.

## Who carries the burden

Size is a judgement call, and an unanchored one licenses arbitrary objections. So, advisory rather than a limit: **a README section past ~40 lines, or a single run of rationale past ~3 sentences, earns a line in the PR body saying why it needs the space.** Past the anchor the author justifies the size; below it, a reviewer wanting a cut makes the case. The number decides who argues — it is not a threshold to enforce.

## The failures that earned it

Verified against the repo, not recollection:

1. **README bloat, PR #132.** The Quickstart reached **74 lines** — and the 37-line baseline it grew from already carried detail-doc content, including a six-line paragraph on `--user "$(id -u):$(id -g)"` covering Windows, macOS Docker Desktop and root shells. Every addition was individually correct and reviewer-requested. The five review rounds after the first commit only ever **added** (71 → 74 lines). It was eventually cut to 59, with the detail moved into `docs/running-locally.md` — after the maintainer objected, not because any review criterion asked.
2. **ADR bloat, PR #133.** The ADR-0011 amendment was drafted at **780 words against 473** for the whole pre-existing ADR — 62% of the resulting document. It merged at **404**, cut in review with nothing of substance lost.
3. **Neither catch came from the gate.** Both were caught pre-merge, so neither shipped — but both catches were ad hoc: one a maintainer reading the result, one a reviewer's unprompted judgement. All three axes ask _is this correct_, and both artifacts were correct; nothing asked _is this the right size for its reader_. That is why five correct review rounds on #132 could only make the Quickstart longer. This standard turns that question from a lucky catch into a documented criterion.
