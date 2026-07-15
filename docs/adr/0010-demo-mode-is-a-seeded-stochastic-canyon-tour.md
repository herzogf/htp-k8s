# Demo Mode's flight path is a seeded stochastic Canyon tour, not a pure closed-loop function of a clock

Demo Mode's flight (#22/#84) was a *pure function of one elapsed-seconds clock* — `demoPose(t)` tracing a fixed, origin-centered Lissajous figure-eight that was closed and seamless every `DEMO_LOOP_SECONDS`. For the canyon-flying redesign (#91) we replace that with a **stateful, seeded random walk over the Tower cluster's Canyon graph** (the air corridors between grid-adjacent Tower columns/rows, plus a one-lane perimeter ring): a `deterministic PRNG` picks the next waypoint, a smooth spline threads them, and the tour runs endlessly without ever returning to a repeat.

## Why

- **The showcase use case forbids a visible loop.** Demo Mode's primary home is an unattended wall display / conference booth running for hours. A 40-second closed loop reads as a stuck screensaver within a few laps — the one thing a "come work with us" showcase must not do. Non-repetition is the core requirement, and a closed-loop-function-of-`t` structurally cannot deliver it.
- **A fixed curve ignores the Towers.** The old path was sized/positioned by hardcoded constants (`RADIUS_X = TOWER_SPACING*6`, `HEIGHT_BASE = TOWER_HEIGHT*1.3`), so it orbited wide and high in empty space regardless of the actual cluster. A Canyon-graph walk is derived from the real Tower placements, so it threads *among* the Towers and scales from 1 Tower to thousands with no magic numbers.

## Consequences / trade-offs

- **We deliberately give up "pure function of one clock" and the seamless-loop property.** They bought trivial testability and a guaranteed-jump-free repeat. We keep jump-freedom via spline C1-continuity instead, and keep **testability via the seed**: the walk is a deterministic function of `(seed, Tower arrangement, entry waypoint)`, so a unit test asserts a tour for a fixed seed without a renderer — the pure, WebGL-free seam this codebase values survives, it just takes a seed as input now.
- **Reproducibility is real but conditional.** A tour reproduces only while the Tower arrangement is unchanged (add/remove a Tower and the Canyon graph changes). We therefore log the seed + Tower count (and Tower-count changes) on the backend. Full reproduction is *guaranteed* only when Demo Mode is enabled at startup (unflown camera ⇒ known default entry pose); interactive mid-session activation enters at the nearest waypoint to the user's current pose and is best-effort (frontend console log). See #91.
- **Occasional Tower clipping is accepted.** This is a read-only cinematic viewer ([[0003-cinematic-viewer-not-admin-tool]]), not a game — the path is not collision-checked against Tower prisms; a rare brief clip during a low pass is tolerated in exchange for keeping the model simple and seamless.

## When to revisit

If Demo Mode ever needs a *guaranteed* collision-free route, or to visit every Tower deterministically, the seeded-walk model is the wrong base — that would call for explicit gap-following with collision avoidance. We rejected that here as far more machinery than a showcase weave needs.
