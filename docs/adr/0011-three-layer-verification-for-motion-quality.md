# Motion/animation quality is verified with a three-layer strategy: pose-stream math invariants + e2e behavioral checks + one authoritative video per feel-PR

Building Demo Mode's Canyon-tour flight (#91) exposed that our existing e2e (Playwright) suite — which asserts *behavior* ("the toggle flies the camera", "a Panel is visible") — **cannot certify motion *quality***. Green e2e runs shipped a near-vertical "elevator" climb, instant roll snaps, a mid-flight stutter, and ~160 rad/s aim spins; none tripped a behavioral assertion. Conversely, using a full headless **video capture as the iteration loop** cost ~20 min per change and leaked kind clusters / app servers (see [[worktree-and-resource-cleanup]]). We therefore verify motion/animation-quality work in **three layers, each doing what only it can**.

## The three layers

1. **Pose-stream math invariants** (vitest, renderer-free, ~seconds). Sample the pure motion seam (`createDemoTour`/`stepDemoTour`/`sampleDemoTourPose`, `demoPose`) over multiple seeds at a fixed frame rate and assert per-frame **continuity/quality bounds**: bounded roll rate & angular acceleration, roll≈0 on straight flight, ground-speed continuity, aim yaw/pitch-rate caps, void clearance, climb-gradient, determinism. This is the **inner loop and the permanent regression guard** for feel. It caught four motion bugs the green e2e never saw. Runs on every PR (`web/src/scene/demoModeSmoothness.test.ts` is the first instance).
2. **Targeted e2e behavioral checks** (Playwright, minutes). The real toggle drives the real *built binary* against a real test cluster (per [[0004-two-tier-test-cluster-strategy]]): hand-off has no teleport, canyon-low/overview-high/perimeter passes actually render, screenshots are framed. This is the **"the app genuinely works and didn't regress"** confidence. Every PR touching the flight.
3. **One authoritative video capture per feel-changing PR** (frontend-tester). Choreography and aesthetics are irreducibly human judgments (see [[0003-cinematic-viewer-not-admin-tool]]); the capture is a **merge gate and the artifact the maintainer reviews**, not an iteration loop.

## Why, and the anti-patterns it forbids

- **Speed where it matters, confidence where it counts.** Layer 1 gives fast, mechanical, deterministic feedback on the thing hardest to eyeball reliably (frame-to-frame continuity); layer 2 proves the wired-up app behaves; layer 3 is the human's call on *feel*.
- **Do not use layer 3 as layer 1.** A 20-min video loop per tweak stalls iteration and leaks resources. Iterate against layer 1; capture video once, at the end.
- **Do not trust layer 2 to certify feel.** A passing `toBeVisible` proved nothing about an 8-second roll snap. Behavioral green ≠ smooth.

## Scope

Applies to Demo Mode and future camera/animation work (Focus, Demo Mode refinements, any procedural motion). Ordinary non-animated frontend changes need only the usual unit + e2e coverage; the layer-1 pose-stream harness is specifically for *motion-quality* work.
