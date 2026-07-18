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

## One claim, one home

The corollary that does the real work: **a claim lives in exactly one place and is referenced from the others.** Duplicated prose across README / detail docs / ADRs drifts — the copies are updated at different times and quietly start disagreeing. When a fact is needed in a second place, link to it.

This standard is itself the worked example of the ADR boundary above: it is a style rule with no rejected alternatives to record, so it is **not** an ADR.

## The failures that earned it

Verified against the repo, not recollection:

1. **README bloat, PR #132.** The Quickstart section went from **37 lines on `main` to 74** in one PR — doubled. Every addition was individually correct and reviewer-requested (the `--user` permissions explanation, the loopback default, the three container-networking cases). The review rounds that followed only ever **added** (71 → 74 lines); none asked whether the result was still usable by a newcomer. Only the maintainer caught it.
2. **ADR bloat, PR #133.** The ADR-0011 amendment landed at **780 words against 473 for the whole pre-existing ADR** — 62% of the resulting document was the amendment. Cut to **404** in review with nothing of substance lost.
3. **The gate could not catch either.** All three review axes ask _is this correct_ — and both artifacts were correct. None asked _is this the right size for its reader_. That is why correct review rounds produced an unusable Quickstart. Hence the Standards-axis check.
