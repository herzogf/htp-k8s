import { describe, expect, it } from 'vitest'
import {
  BANK_YAW_RATE_DEADBAND,
  CANYON_TRAVEL_SPEED,
  CORNER_ARC_TARGET_CHORD,
  CORNER_TURN_RADIUS,
  createDemoTour,
  DEMO_BANK_MAX,
  DEMO_ROLL_MAX_ACCEL,
  DEMO_ROLL_MAX_RATE,
  DEMO_TRANSITION_SECONDS,
  demoIntroSpeedFactor,
  type DemoPose,
  type DemoTourState,
  LOOKAT_AIM_FLOOR,
  sampleDemoIntro,
  sampleDemoTourPose,
  stepDemoTour,
  VIEW_PITCH_MAX_ACCEL,
  VIEW_PITCH_MAX_RATE,
  VIEW_YAW_MAX_ACCEL,
  VIEW_YAW_MAX_RATE,
} from './demoMode'
import { focusLookAngles, type Pose } from './focus'
import {
  TOWER_FOOTPRINT,
  TOWER_HEIGHT,
  TOWER_SPACING,
  towerPlacements,
  type TowerPlacement,
} from './towerLayout'
import { type Tower } from '../generated/scenestate'
import { makeTower } from '../test-support/sceneFixtures'

/**
 * Renderer-free smoothness invariants over Demo Mode's full pose stream (#91
 * smoothness pass). These are the mathematical judge of the flight's *feel*:
 * every maintainer complaint from the captured-video review — abrupt roll
 * snaps, off-level cruising on straights, the activation rush, the mid-tour
 * stutter, the jumpy aim — is a measurable discontinuity in the pose stream,
 * so each is pinned here as a bound the whole tour must satisfy on every
 * frame, across several seeds and cluster shapes. This suite runs in seconds
 * (no browser, no cluster) where the authoritative e2e video capture takes
 * ~20 minutes: it is the fast inner-loop check and the permanent regression
 * guard; the e2e video remains the human-facing verdict on choreography and
 * aesthetics (ADR-0004).
 *
 * Two kinds of bounds live here:
 *
 * - **Exact (construction-guard) bounds** re-assert limits the implementation
 *   enforces by construction (roll rate ≤ DEMO_ROLL_MAX_RATE, roll
 *   acceleration ≤ DEMO_ROLL_MAX_ACCEL, |roll| ≤ DEMO_BANK_MAX, view yaw
 *   rate ≤ VIEW_YAW_MAX_RATE, view yaw acceleration ≤ VIEW_YAW_MAX_ACCEL,
 *   and — outside the aim-window-clamp frames, which are mechanically
 *   identified per frame — the view pitch rate/acceleration caps): these
 *   hold with only floating-point slack, and a violation means the
 *   enforcement mechanism itself broke.
 * - **Calibrated (tuning-guard) bounds** (the ground-speed window, 3D
 *   acceleration, the activation speed factor, the roll sign-change rate,
 *   the peak heading rate, the pan-saturation event budget, and the view
 *   pitch slack *on* clamp frames) are set with stated headroom above the
 *   maximum observed across all seeds/grids at the time of writing — and
 *   below what the known-bad prior behaviour produced, which each bound's
 *   comment records — so they catch a regression to the complained-about
 *   behaviour without flaking on benign tuning.
 */

/** A `cols` x `rows` grid of Towers, placed exactly as the real layout would. */
function grid(cols: number, rows: number): TowerPlacement[] {
  const towers: Tower[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      towers.push(makeTower({ name: `t-${col}-${row}`, grid: { col, row } }))
    }
  }
  return towerPlacements(towers)
}

/** The exact 7-Tower KWOK demo scene the maintainer's layer-3 captures fly: a 3-wide grid filled 3+3+1 (backend `gridWidth` = ceil(sqrt(7))). */
function kwok7(): TowerPlacement[] {
  const slots: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [0, 2],
  ]
  return towerPlacements(
    slots.map(([col, row]) => makeTower({ name: `t-${col}-${row}`, grid: { col, row } })),
  )
}

const DT = 1 / 60
const TOUR_SECONDS = 90
const SEEDS = [42424242, 1, 7, 13, 99]
/**
 * The 5x5 reference grid, a small 4x2, and (since #105 iteration 3) the
 * exact 7-Tower KWOK scene the layer-3 video captures fly — the shape the
 * maintainer actually judges, and the one where perimeter behaviour
 * dominates (its lattice is 12 ring nodes to 4 interior ones).
 *
 * `expectStraightCruise` marks grids whose lattice has avenues long enough
 * that the walk reliably flies a full settle-window dead straight within the
 * recorded tours: the 4x2's and kwok7's avenues are short and their
 * edge-pull bias keeps the walk weaving, so the wings-level property is only
 * *guaranteed exercised* on the larger grid (it still holds — vacuously or
 * not — on the small ones).
 *
 * `maxVoidFraction` / `minCanyonFraction` are the framing/dynamism bounds
 * (#105 iteration 3, re-tightened by iteration 4 against its improved
 * observations) — see the "keeps the Towers on screen" and "stays in among
 * the Towers" invariants for the metric definitions and calibration.
 *
 * `minWideFraction` is iteration 4's vantage-variety floor — see the "wide
 * overview vantage" invariant. Only kwok7 carries a nonzero bound: its
 * lattice is ring-dominant (12 ring nodes to 4 interior), so its tours
 * reliably ride perimeter lines during wide overview episodes; on the
 * interior-heavy 5x5 (and the short-ringed 4x2) whole seeds legitimately
 * never place a wide episode on a straight ring stretch, so a nonzero
 * per-seed floor there would be flaky by construction rather than guarding.
 */
const GRIDS: Array<{
  name: string
  placements: TowerPlacement[]
  expectStraightCruise: boolean
  maxVoidFraction: number
  minCanyonFraction: number
  minWideFraction: number
}> = [
  {
    name: '5x5',
    placements: grid(5, 5),
    expectStraightCruise: true,
    maxVoidFraction: 0.22,
    minCanyonFraction: 0.72,
    minWideFraction: 0,
  },
  {
    name: '4x2',
    placements: grid(4, 2),
    expectStraightCruise: false,
    maxVoidFraction: 0.33,
    minCanyonFraction: 0.7,
    minWideFraction: 0,
  },
  {
    name: 'kwok7',
    placements: kwok7(),
    expectStraightCruise: false,
    maxVoidFraction: 0.32,
    minCanyonFraction: 0.68,
    minWideFraction: 0.02,
  },
]

const ENTRY: Pose = { position: [0, 5, 0], target: [0, 5, -1] }

/** Steps a fresh seeded tour at a fixed frame rate and records every frame's pose. */
function recordTour(seed: number, placements: TowerPlacement[]): DemoPose[] {
  let tour: DemoTourState = createDemoTour({ seed, placements, entry: ENTRY })
  const poses: DemoPose[] = [sampleDemoTourPose(tour)]
  const steps = Math.round(TOUR_SECONDS / DT)
  for (let i = 0; i < steps; i++) {
    tour = stepDemoTour(tour, DT, placements)
    poses.push(sampleDemoTourPose(tour))
  }
  return poses
}

/** Memoized {@link recordTour}, so the per-seed `it`s and the per-grid aggregate share one recording. */
const recordings = new Map<string, DemoPose[]>()
function recordedTour(gridName: string, seed: number, placements: TowerPlacement[]): DemoPose[] {
  const key = `${gridName}:${seed}`
  let poses = recordings.get(key)
  if (!poses) {
    poses = recordTour(seed, placements)
    recordings.set(key, poses)
  }
  return poses
}

function wrapAngle(d: number): number {
  let w = d
  while (w > Math.PI) w -= 2 * Math.PI
  while (w < -Math.PI) w += 2 * Math.PI
  return w
}

/** The nearest point of a Tower's bounding prism to `p` (the standard per-axis clamp). */
function nearestTowerBoxPoint(
  p: readonly [number, number, number],
  t: TowerPlacement,
): [number, number, number] {
  const half = TOWER_FOOTPRINT / 2
  return [
    Math.min(Math.max(p[0], t.position[0] - half), t.position[0] + half),
    Math.min(Math.max(p[1], 0), TOWER_HEIGHT),
    Math.min(Math.max(p[2], t.position[2] - half), t.position[2] + half),
  ]
}

/**
 * The framing-metric cone half-angle: a Tower whose nearest point lies
 * within this of the view axis counts as "on screen near frame centre"
 * (the camera's vertical FOV is 50°, horizontal ≈ 79° at 16:9 — 35° is the
 * central meat of the frame). Deliberately Tower-only: Floor-Lane glow is
 * ignored, so absolute values overstate perceived darkness — the metric is
 * for *relative* regression guarding, validated against the two real
 * layer-3 captures where it reproduced the maintainer's differential
 * black-frame report (pr116 capture 0.354 vs judged iter2 capture 0.592).
 */
const FRAMING_CONE_DEG = 35

/** Whether any Tower sits within the framing cone of the pose's view axis, plus the distance to the nearest Tower prism. */
function framing(
  pose: DemoPose,
  placements: readonly TowerPlacement[],
): { framed: boolean; nearest: number } {
  const [px, py, pz] = pose.position
  const fx = pose.target[0] - px
  const fy = pose.target[1] - py
  const fz = pose.target[2] - pz
  const fl = Math.hypot(fx, fy, fz)
  let framed = false
  let nearest = Infinity
  for (const t of placements) {
    const [cx, cy, cz] = nearestTowerBoxPoint(pose.position, t)
    const dx = cx - px
    const dy = cy - py
    const dz = cz - pz
    const d = Math.hypot(dx, dy, dz)
    nearest = Math.min(nearest, d)
    if (d < 1e-6) {
      framed = true
      continue
    }
    const cos = (dx * fx + dy * fy + dz * fz) / (d * fl)
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
    if (deg <= FRAMING_CONE_DEG) {
      framed = true
    }
  }
  return { framed, nearest }
}

/**
 * Whether sampleDemoTourPose's aim-window clamp (the rendered target's
 * altitude pinned to the canyon floor / roofline bound) is engaged on any of
 * the frames a finite-difference at index `i` reaches back over (`span` = 1
 * for a rate, 2 for an acceleration). The clamp is the one mechanism that
 * legitimately adds rendered pitch motion on top of the eased view triplet —
 * identifying its frames mechanically lets the pitch invariants hold the
 * *exact* follower caps everywhere else.
 */
function aimClampEngaged(pose: DemoPose): boolean {
  const y = pose.target[1]
  return y <= LOOKAT_AIM_FLOOR + 1e-6 || y >= TOWER_HEIGHT - 1e-6
}

function aimClampEngagedNear(poses: DemoPose[], i: number, span: number): boolean {
  for (let j = Math.max(0, i - span); j <= i; j++) {
    if (aimClampEngaged(poses[j])) {
      return true
    }
  }
  return false
}

/**
 * Marks each frame of a pose stream as "settled straight flight": the
 * horizontal travel heading's rate has stayed below the bank deadband for the
 * whole trailing settle window — long enough for the bounded roll follower to
 * unwind from a full bank (rate-limited unwind ≤ DEMO_BANK_MAX /
 * DEMO_ROLL_MAX_RATE ≈ 0.75s, plus the acceleration ramps and the
 * exponential tail).
 */
function straightFlightFrames(poses: DemoPose[]): boolean[] {
  const SETTLE_SECONDS = 2.5
  const settleFrames = Math.round(SETTLE_SECONDS / DT)
  const straight = new Array<boolean>(poses.length).fill(false)
  let previousHeading: number | null = null
  let straightRun = 0
  for (let i = 1; i < poses.length; i++) {
    const dx = poses[i].position[0] - poses[i - 1].position[0]
    const dz = poses[i].position[2] - poses[i - 1].position[2]
    const heading = Math.atan2(dx, dz)
    const headingRate =
      previousHeading === null ? 0 : Math.abs(wrapAngle(heading - previousHeading)) / DT
    previousHeading = heading
    straightRun = headingRate < BANK_YAW_RATE_DEADBAND ? straightRun + 1 : 0
    straight[i] = straightRun >= settleFrames
  }
  return straight
}

describe.each(GRIDS)(
  'Demo Mode pose-stream smoothness on a $name grid',
  ({
    name,
    placements,
    expectStraightCruise,
    maxVoidFraction,
    minCanyonFraction,
    minWideFraction,
  }) => {
    describe.each(SEEDS)('seed %i', (seed) => {
      const poses = recordedTour(name, seed, placements)

      it('roll never snaps: per-frame roll rate stays within DEMO_ROLL_MAX_RATE (exact bound)', () => {
        for (let i = 1; i < poses.length; i++) {
          const rate = Math.abs(poses[i].roll - poses[i - 1].roll) / DT
          expect(rate).toBeLessThanOrEqual(DEMO_ROLL_MAX_RATE + 1e-6)
        }
      })

      it('roll eases in and out: per-frame roll angular acceleration stays within DEMO_ROLL_MAX_ACCEL (exact bound)', () => {
        let previousRate = 0
        for (let i = 1; i < poses.length; i++) {
          const rate = (poses[i].roll - poses[i - 1].roll) / DT
          if (i > 1) {
            expect(Math.abs(rate - previousRate) / DT).toBeLessThanOrEqual(
              DEMO_ROLL_MAX_ACCEL + 1e-6,
            )
          }
          previousRate = rate
        }
      })

      it('never banks past DEMO_BANK_MAX (exact bound)', () => {
        for (const pose of poses) {
          expect(Math.abs(pose.roll)).toBeLessThanOrEqual(DEMO_BANK_MAX + 1e-9)
        }
      })

      it('is wings-level whenever it has been flying straight for a while (roll ≈ 0 outside genuine turns)', () => {
        const LEVEL_TOLERANCE = 0.04 // rad — ~2.3°, visually dead level
        const straight = straightFlightFrames(poses)
        for (let i = 0; i < poses.length; i++) {
          if (straight[i]) {
            expect(Math.abs(poses[i].roll)).toBeLessThanOrEqual(LEVEL_TOLERANCE)
          }
        }
      })

      it('travels at an even ground speed on every frame (no stutter, no boundary hitch)', () => {
        // Calibrated bound: the horizontal arc-length parameterization holds
        // ground speed constant up to the inversion table's piecewise-linear
        // ripple. The pre-fix uniform-t scheme produced one-frame excursions
        // up to ~2x at segment boundaries (the "~42s stutter").
        for (let i = 1; i < poses.length; i++) {
          const groundSpeed =
            Math.hypot(
              poses[i].position[0] - poses[i - 1].position[0],
              poses[i].position[2] - poses[i - 1].position[2],
            ) / DT
          expect(groundSpeed).toBeGreaterThanOrEqual(CANYON_TRAVEL_SPEED * 0.85)
          expect(groundSpeed).toBeLessThanOrEqual(CANYON_TRAVEL_SPEED * 1.15)
        }
      })

      it('has no velocity discontinuities: per-frame 3D acceleration stays bounded across waypoint/episode boundaries', () => {
        // Calibrated bound: the worst genuine acceleration is turning the
        // velocity vector through the tightest lattice corner (observed max
        // ~42 across all seeds/grids); the pre-fix code hit ~130 at the
        // takeoff knot (a visible kink) and ~2x-speed hitches at boundaries.
        const MAX_ACCEL = 60 // world units / s²
        let previous: [number, number, number] | null = null
        for (let i = 1; i < poses.length; i++) {
          const velocity: [number, number, number] = [
            (poses[i].position[0] - poses[i - 1].position[0]) / DT,
            (poses[i].position[1] - poses[i - 1].position[1]) / DT,
            (poses[i].position[2] - poses[i - 1].position[2]) / DT,
          ]
          if (previous) {
            const accel =
              Math.hypot(
                velocity[0] - previous[0],
                velocity[1] - previous[1],
                velocity[2] - previous[2],
              ) / DT
            expect(accel).toBeLessThanOrEqual(MAX_ACCEL)
          }
          previous = velocity
        }
      })

      it('sweeps its aim smoothly: per-frame view yaw/pitch rates stay within the view rate caps (no aim snap)', () => {
        // The yaw bound is exact — the view triplet easing enforces it by
        // construction. The pitch bound is exact too *except* on frames where
        // the aim-window clamp is engaged (mechanically identifiable: the
        // rendered target's altitude sits pinned at the clamp boundary —
        // never above the roofline / below the canyon floor): there the clamp
        // pins the target's altitude while the camera itself climbs/descends,
        // re-deriving the rendered pitch at up to verticalRate /
        // horizontalReach = (MAX_CLIMB_GRADIENT x cruise) /
        // LOOKAT_MIN_HORIZONTAL_DISTANCE ~ 0.42 x 4.4 / 4 ~ 0.47 rad/s on
        // top of the eased triplet's own — a derived mechanism ceiling, not
        // a loosened blanket (the #116 review flagged the old
        // clamp-slack-for-every-frame bound as weakly guarding).
        const MAX_YAW_RATE = VIEW_YAW_MAX_RATE + 1e-6
        const MAX_PITCH_RATE = VIEW_PITCH_MAX_RATE + 1e-6
        const MAX_PITCH_RATE_CLAMPED = VIEW_PITCH_MAX_RATE + 0.47
        let previous = focusLookAngles(poses[0].position, poses[0].target)
        for (let i = 1; i < poses.length; i++) {
          const angles = focusLookAngles(poses[i].position, poses[i].target)
          expect(Math.abs(wrapAngle(angles.yaw - previous.yaw)) / DT).toBeLessThanOrEqual(
            MAX_YAW_RATE,
          )
          const pitchBound = aimClampEngagedNear(poses, i, 1)
            ? MAX_PITCH_RATE_CLAMPED
            : MAX_PITCH_RATE
          expect(Math.abs(wrapAngle(angles.pitch - previous.pitch)) / DT).toBeLessThanOrEqual(
            pitchBound,
          )
          previous = angles
        }
      })

      it('turns its head smoothly: per-frame view yaw/pitch angular acceleration stays bounded (no C1 head-snap at waypoint boundaries)', () => {
        // The #105 root cause: the view triplet was a plain rate limiter —
        // C0-continuous but C1-discontinuous, so its angular velocity stepped
        // instantly between 0 and ±MAX_RATE on saturation, release, or a
        // target-side flip (instrumented at up to 180 rad/s² of rendered yaw
        // acceleration, overwhelmingly at segment boundaries — the "pilot
        // abruptly turns their head" at every waypoint). The bounded
        // second-order follower makes these accelerations hold by
        // construction, exactly as the roll invariants above do for the bank.
        //
        // The yaw bound is exact (the rendered yaw is the eased triplet's yaw
        // verbatim). The pitch bound is exact except on aim-window-clamp
        // frames (see the rate test above for the mechanism), which carry
        // *two* bounds, one of each of this file's kinds:
        //
        // - a construction guard at the derived mechanism ceiling: the
        //   clamp's engagement/release re-keys the rendered pitch rate by up
        //   to verticalSpeed / minHorizontalReach ≈ 0.47 rad/s within ~a
        //   frame ⇒ 0.47/DT ≈ 28 rad/s². Nothing the aim tuning does can
        //   legitimately exceed this; crossing it means the clamp mechanism
        //   itself changed.
        // - a calibrated drift guard well below it: observed clamp-frame
        //   values move with aim tuning (≤ 5.5 with iteration 2's weak pull;
        //   ≤ 14.7 with iteration 3's strong *roofline* pull, whose ceiling
        //   pin against the camera's own climb was the mechanism; ≤ 6.5
        //   since iteration 4 made the pull horizontal-only and pulled the
        //   aim demand's window strictly inside the rendered clamp — the
        //   clamp now barely engages at all). Bounded at 9 (~1.4x the
        //   observed 6.5, below both known-bad regimes: iteration 3's 14.7
        //   and even the 9.6 of the build before it) so a drift back toward
        //   clamp-driven pitch spikes fails loudly — this is the dimension
        //   ("no abrupt jitters") the maintainer praised in #116, so quiet
        //   growth here is not acceptable.
        //
        // The pre-#105 rate-limiter snaps (up to 96 rad/s² of pitch) sit far
        // above both. The exception stays narrow via the clamp-share
        // invariant below (clamp frames ≤ 15% of the tour), and the exact
        // cap guards every ordinary frame (the #116 review flagged the old
        // blanket 6x slack as weakly guarding).
        const MAX_YAW_ACCEL = VIEW_YAW_MAX_ACCEL + 1e-6
        const MAX_PITCH_ACCEL = VIEW_PITCH_MAX_ACCEL + 1e-6
        const MAX_PITCH_ACCEL_CLAMPED_CEILING = 28
        const MAX_PITCH_ACCEL_CLAMPED_DRIFT = 9
        let previous = focusLookAngles(poses[0].position, poses[0].target)
        let previousYawRate: number | null = null
        let previousPitchRate: number | null = null
        let maxClampedPitchAccel = 0
        for (let i = 1; i < poses.length; i++) {
          const angles = focusLookAngles(poses[i].position, poses[i].target)
          const yawRate = wrapAngle(angles.yaw - previous.yaw) / DT
          const pitchRate = wrapAngle(angles.pitch - previous.pitch) / DT
          if (previousYawRate !== null && previousPitchRate !== null) {
            expect(Math.abs(yawRate - previousYawRate) / DT).toBeLessThanOrEqual(MAX_YAW_ACCEL)
            const pitchAccel = Math.abs(pitchRate - previousPitchRate) / DT
            if (aimClampEngagedNear(poses, i, 2)) {
              maxClampedPitchAccel = Math.max(maxClampedPitchAccel, pitchAccel)
              expect(pitchAccel).toBeLessThanOrEqual(MAX_PITCH_ACCEL_CLAMPED_CEILING)
            } else {
              expect(pitchAccel).toBeLessThanOrEqual(MAX_PITCH_ACCEL)
            }
          }
          previousYawRate = yawRate
          previousPitchRate = pitchRate
          previous = angles
        }
        expect(maxClampedPitchAccel).toBeLessThanOrEqual(MAX_PITCH_ACCEL_CLAMPED_DRIFT)
      })

      it('keeps the aim-window-clamp exception narrow: clamp-engaged frames stay a small share of the tour', () => {
        // The pitch invariants above hold the exact follower caps on every
        // frame *except* mechanically identified aim-window-clamp frames.
        // That exception is only honest while it stays rare: without this
        // bound, a future change that parks the aim on the clamp (e.g. an
        // altitude program living at the roofline) would silently move most
        // frames onto the looser clamp-frame bounds with nothing failing.
        // Observed across all seeds/grids: 3.8-7.8% at iteration 3 (nearly
        // all of it the *ceiling*); ≤ 5% since iteration 4 (the remainder
        // mostly brief floor grazes during dives — the ceiling share has its
        // own, tighter invariant below). Calibrated bound: 15% (unchanged —
        // still ~2x iteration 3's worst, and the exception-narrowness
        // property it guards is unchanged).
        const MAX_CLAMP_FRACTION = 0.15
        const engaged = poses.filter(aimClampEngaged).length
        expect(engaged / poses.length).toBeLessThanOrEqual(MAX_CLAMP_FRACTION)
      })

      it('keeps its gaze level: the aim does not spend the tour pitched up (the "captain cranking his head up" guard — #105 iteration 4)', () => {
        // The metric iteration 3 regressed *without any invariant noticing*
        // — for the second time on this ticket, an axis nobody measured:
        // every existing bound measured smoothness or framing, none
        // measured where the aim points vertically. The maintainer saw it
        // in 90 seconds of flying; the ceiling-clamp share had already
        // doubled and was read only as a jitter risk.
        //
        // Rendered aim pitch, signed (+ = above the horizon). Two
        // calibrated bounds, both bracketed between iteration 4's
        // observations and iteration 3's (main's) known-bad values:
        //
        // - median ≤ 0 (level or below — a pilot's gaze): observed
        //   −3.2..−1.6° across all seeds/grids; main measured +4.0..+11.1°
        //   (its *best* seed is 4° above the bound, so a regression to
        //   roofline-anchored aiming fails on every seed);
        // - pitched-up share (> +5°) ≤ 0.30: observed 0.12-0.21; main
        //   0.48-0.60 — more than half of every tour looking up.
        const MAX_MEDIAN_PITCH = 0
        const MAX_UP_SHARE = 0.3
        const UP_PITCH = (5 * Math.PI) / 180
        const pitches: number[] = []
        let up = 0
        for (const pose of poses) {
          const dx = pose.target[0] - pose.position[0]
          const dy = pose.target[1] - pose.position[1]
          const dz = pose.target[2] - pose.position[2]
          const pitch = Math.atan2(dy, Math.hypot(dx, dz))
          pitches.push(pitch)
          if (pitch > UP_PITCH) up++
        }
        pitches.sort((a, b) => a - b)
        expect(pitches[Math.floor(pitches.length / 2)]).toBeLessThanOrEqual(MAX_MEDIAN_PITCH)
        expect(up / poses.length).toBeLessThanOrEqual(MAX_UP_SHARE)
      })

      it('rarely looks up as far as it is allowed to: the aim-ceiling-pinned share stays small (#105 iteration 4)', () => {
        // The number that was on the table for a full review round and
        // misread: frames whose rendered aim altitude sits pinned at the
        // roofline ceiling are frames where the camera is looking up as far
        // as it is permitted to. Iteration 3 moved it 0.04-0.08 → 0.06-0.13
        // and the review filed it as a jitter risk only. Observed since
        // iteration 4 (horizontal-only pull + the aim demand clamped
        // strictly inside the rendered window): ≤ 0.042. Calibrated bound:
        // 0.055 — ~1.3x the observed worst, deliberately *below* main's
        // smallest per-seed value (0.059), so a regression to
        // roofline-anchored aiming fails on every seed. Thinner headroom
        // than this file's usual 1.25-1.5x convention, documented rather
        // than hidden: the bracket between "worst current" and "best
        // known-bad" is only 1.4x wide.
        const MAX_CEILING_SHARE = 0.055
        const pinned = poses.filter((pose) => pose.target[1] >= TOWER_HEIGHT - 1e-6).length
        expect(pinned / poses.length).toBeLessThanOrEqual(MAX_CEILING_SHARE)
      })

      it('varies its vantage: wide overview passes actually happen (the anti-uniformly-cramped guard — #105 iteration 4)', () => {
        // The maintainer's iteration-3 verdict in metric form: "the current
        // state gives a cramped/narrow view the whole time". Wide-vantage
        // frames — a Tower framed near frame centre from ≥ 1.5 Tower
        // spacings away — are the hero-overview shots; a tour can be
        // perfectly smooth and perfectly framed and still fail this by
        // never once stepping back. Observed on kwok7 with iteration 4's
        // episode-gated ring widening: 0.031-0.120 per seed; main's worst
        // kwok7 seed measures 0.000 (a 90-second tour without a single
        // wide-vantage frame — "uniformly cramped", literally). Calibrated
        // per-seed floor: 0.02. Skipped (bound 0) on the grids whose
        // lattice makes ring-riding episodes a per-seed coin flip — see
        // GRIDS.
        if (minWideFraction <= 0) {
          return
        }
        const WIDE_DISTANCE = 1.5 * TOWER_SPACING
        let wide = 0
        for (const pose of poses) {
          const f = framing(pose, placements)
          if (f.framed && f.nearest >= WIDE_DISTANCE) wide++
        }
        expect(wide / poses.length).toBeGreaterThanOrEqual(minWideFraction)
      })

      it('pans deliberately: rate-cap saturation only as sustained corner sweeps, never a per-waypoint head-turn rhythm', () => {
        // Calibrated bounds on the rendered yaw running pinned at its rate
        // cap. Since corner rounding (#105 iteration 2) a genuine corner is
        // a wide arc the aim sweeps through — steadily, at up to the
        // deliberate-pan cap for the corner's duration — so *some* saturated
        // panning is by design and the raw fraction alone no longer
        // discriminates good from bad. What distinguishes the two known-bad
        // regimes is the *event structure*:
        //
        // - the pre-#105 demand-pinning bug produced a saturation burst at
        //   nearly every waypoint boundary (~65 rollovers/90s, ~18% of all
        //   frames) — an event *count* far above the corner count;
        // - a corner-geometry regression (pivot corners) would push the
        //   sustained-pan share back up (pre-rounding: brief rate-capped
        //   pans at every 90° corner).
        //
        // Observed with iteration 3's stronger tower pull (the aim actively
        // pans between Towers): worst single seed 17 events per 90s tour,
        // each ≤ 2.4s, worst fraction 0.14 (iteration 4: 15 events / 0.146
        // — essentially unchanged). Bounds:
        //
        // - events ≤ 24: ~1.4x the observed worst, still far below the
        //   40-65 of a per-waypoint rhythm — the sharper discriminator;
        // - fraction ≤ 16%: only ~1.14x the observed worst, *below* this
        //   file's usual 1.25-1.5x headroom convention — deliberately, and
        //   documented rather than hidden: the bound is pinned from above
        //   by the ~18% the pre-#105 pinning bug produced (a looser bound
        //   would no longer exclude the known-bad regime). The suite's
        //   seeds are fixed, so this cannot flake; a benign-looking tuning
        //   change that trips it has genuinely eaten most of the distance
        //   to known-bad and deserves the look;
        // - ≤ 3.5s per event (sustained sweeps stay corner-scale).
        const MAX_SATURATION_FRACTION = 0.16
        const MAX_SATURATION_EVENTS = 24
        const MAX_SATURATION_RUN_SECONDS = 3.5
        let saturated = 0
        let events = 0
        let run = 0
        let maxRun = 0
        let previous = focusLookAngles(poses[0].position, poses[0].target)
        for (let i = 1; i < poses.length; i++) {
          const angles = focusLookAngles(poses[i].position, poses[i].target)
          if (Math.abs(wrapAngle(angles.yaw - previous.yaw)) / DT > VIEW_YAW_MAX_RATE * 0.98) {
            saturated++
            run++
            if (run === 1) events++
            maxRun = Math.max(maxRun, run)
          } else {
            run = 0
          }
          previous = angles
        }
        expect(saturated / (poses.length - 1)).toBeLessThanOrEqual(MAX_SATURATION_FRACTION)
        expect(events).toBeLessThanOrEqual(MAX_SATURATION_EVENTS)
        expect(maxRun * DT).toBeLessThanOrEqual(MAX_SATURATION_RUN_SECONDS)
      })

      it('holds a steady horizon: the rendered roll crosses sides at most a few times a minute (finding A of the #116 review)', () => {
        // The direct measure of the maintainer's "horizon flip-flops" report:
        // how often the rendered bank swings from one side to the other
        // (hysteresis at ±0.03 rad ≈ ±1.7°, so dithering around level does
        // not count). Pre-iteration-2 the point-pivot corners plus the bank
        // target tracking the raw instantaneous heading rate produced
        // 16.7-25.3 side changes per minute across these seeds/grids — a
        // horizon rocking every 2-4 seconds. With corner rounding
        // (CORNER_TURN_RADIUS) and the smoothed bank driver
        // (BANK_YAW_RATE_SMOOTHING), observed ≤ 12.7/min. Since #105
        // iteration 4 the observed worst is 15.3/min (kwok7 seed 99 / 5x5
        // seed 13) — decomposed by a route-controlled A/B (same routes,
        // widening offset zeroed): all but ≤ 1.4/min of any tour's total is
        // the seed's route realization under the new episode structure, and
        // that ≤ 1.4/min marginal cost is the wide passes' deliberate banks
        // off and back onto the ring. Bound: 16/min — unchanged, pinned
        // from above by the 16.7 known-bad floor, now with only ~5% headroom
        // over the worst seed: deliberate and documented (fixed seeds, so it
        // cannot flake) — a tuning change that trips it has eaten the whole
        // remaining distance to the flip-flop regime and deserves the look.
        // Whether the wide passes' slow, paired banks *read* as flown is
        // explicitly a layer-3 question.
        const HYSTERESIS = 0.03
        const MAX_SIGN_CHANGES_PER_MINUTE = 16
        let changes = 0
        let lastSide = 0
        for (const pose of poses) {
          const side = pose.roll > HYSTERESIS ? 1 : pose.roll < -HYSTERESIS ? -1 : 0
          if (side !== 0) {
            if (lastSide !== 0 && side !== lastSide) changes++
            lastSide = side
          }
        }
        expect(changes / (TOUR_SECONDS / 60)).toBeLessThanOrEqual(MAX_SIGN_CHANGES_PER_MINUTE)
      })

      it('never cusps: the per-frame heading rate stays at flyable-corner scale (the spin/cusp guard)', () => {
        // At constant ground speed, heading rate *is* curvature. Iteration 2
        // bounded this at 5.5 rad/s on the theory that tight corners read as
        // a drone pivot — a premise the maintainer's layer-3 verdict
        // *falsified*: the merged pivot-tight corners (6.1-9.1 rad/s) are
        // the "rapid zip" he wants, and what actually made them read badly
        // was the rocking horizon and the whipping aim, both guarded
        // elsewhere (the roll side-change invariant; the view-follower
        // caps). Iteration 3 therefore re-tightened CORNER_TURN_RADIUS to a
        // quarter spacing (peak ≈ 7.6 rad/s — deliberately at the merged
        // build's corner pace) and this bound now guards what heading rate
        // is genuinely pathological: spline cusps and near-spins, the
        // failure mode found repeatedly during corner-rounding development
        // (~100-186 rad/s, with visible ground-speed dips; the pre-existing
        // 2-Tower cusp of #119 measures ~176-188). Calibrated: observed
        // peak ≤ 7.62 across all seeds/grids, bounded at 9.5 (~1.25x) —
        // far below any cusp.
        const MAX_HEADING_RATE = 9.5
        expect(CANYON_TRAVEL_SPEED / CORNER_TURN_RADIUS).toBeLessThan(MAX_HEADING_RATE)
        // The geometry-degeneration cliff sits exactly where the turn radius
        // meets the arc-sampling chord target (a radius-r arc can't be
        // sampled at chords ≥ ~r without collapsing to near-tangent points;
        // measured: at CORNER_TURN_RADIUS = CORNER_ARC_TARGET_CHORD the
        // spline wiggle returns and the horizon side-change rate triples).
        // Nothing else couples the two constants, so pin the ordering here —
        // a future chord tweak must not silently walk the geometry off the
        // cliff.
        expect(CORNER_TURN_RADIUS).toBeGreaterThan(CORNER_ARC_TARGET_CHORD)
        let previousHeading: number | null = null
        for (let i = 1; i < poses.length; i++) {
          const dx = poses[i].position[0] - poses[i - 1].position[0]
          const dz = poses[i].position[2] - poses[i - 1].position[2]
          const heading = Math.atan2(dx, dz)
          if (previousHeading !== null) {
            expect(Math.abs(wrapAngle(heading - previousHeading)) / DT).toBeLessThanOrEqual(
              MAX_HEADING_RATE,
            )
          }
          previousHeading = heading
        }
      })

      it('keeps the Towers on screen: the tour is not mostly black frames (the framing guard — finding "black frames" of the iteration-2 video verdict)', () => {
        // The metric iteration 2 regressed *without any invariant noticing*:
        // every existing bound measured smoothness, none measured whether
        // anything was in frame. Void fraction = share of frames with no
        // Tower inside the FRAMING_CONE_DEG cone of the view axis (see
        // framing()'s doc comment for the definition's deliberate limits and
        // its validation against the real captures). Calibrated per grid,
        // re-tightened by iteration 4 (whose level gaze improved framing
        // again). Observed per grid: 5x5 0.14-0.16 (bound 0.22, 1.38x
        // headroom), 4x2 0.21-0.28 (bound 0.33, 1.18x), kwok7 0.18-0.24
        // (bound 0.32, 1.33x). (Iteration 3 measured 0.15-0.32;
        // pre-iteration-3 `main` 0.29-0.51.) Each bound sits below every
        // pre-iteration-3 per-seed value on its grid, so a regression to
        // pre-retune framing fails on every seed, not merely on average.
        let voidFrames = 0
        for (const pose of poses) {
          if (!framing(pose, placements).framed) voidFrames++
        }
        expect(voidFrames / poses.length).toBeLessThanOrEqual(maxVoidFraction)
      })

      it('stays in among the Towers: a healthy share of the tour is genuine canyon flying (the zip guard — finding "dynamism" of the iteration-2 video verdict)', () => {
        // Time-in-canyon = share of frames below the roofline within 1.25
        // Tower spacings of the nearest Tower prism — the "zip through the
        // urban canyons" sensation, mechanically. Calibrated per grid, and
        // re-tightened by iteration 4 specifically because its wide
        // overview passes *spend* this metric if left unguarded (every
        // second of hero pass is a second not in a canyon — the widening
        // is episode-gated and length-refunded so it converts existing
        // rooftop-cruise time instead): observed 0.70-0.85 across all
        // seeds/grids (iteration 3: 0.70-0.84; the pre-iteration-3 rebuild
        // of the ring measured ~0.40-0.55). The bounds sit just below the
        // per-grid worst observations (kwok7: 0.68 vs observed 0.70, the
        // ticket's stated floor) — deliberately snug, so any future widening
        // tune that starts eating canyon time fails here first.
        let canyonFrames = 0
        for (const pose of poses) {
          const f = framing(pose, placements)
          if (pose.position[1] < TOWER_HEIGHT && f.nearest <= 1.25 * TOWER_SPACING) canyonFrames++
        }
        expect(canyonFrames / poses.length).toBeGreaterThanOrEqual(minCanyonFraction)
      })
    })

    it('actually cruises straight for sustained stretches somewhere across the seeds (the wings-level invariant is exercised)', () => {
      // Sanity check on the wings-level test above: across all recorded seeds
      // on this grid, some frames must qualify as settled straight flight —
      // otherwise "level on straights" was never actually checked. Aggregated
      // across seeds because any *single* seed's 90s walk may legitimately
      // spend its whole run weaving; skipped on grids whose small lattice
      // never sustains a full settle window (see GRIDS).
      if (!expectStraightCruise) {
        return
      }
      let straightFrames = 0
      for (const seed of SEEDS) {
        straightFrames += straightFlightFrames(recordedTour(name, seed, placements)).filter(
          Boolean,
        ).length
      }
      expect(straightFrames).toBeGreaterThan(0)
    })
  },
)

describe('Demo Mode activation (the takeoff + intro, composited as FreeFlyControls does)', () => {
  const placements = grid(5, 5)
  // A far-out, elevated activation pose — the shape of the app's default
  // framed-skyline camera, the exact case that used to produce the "~1s
  // standing still, then rushes way too fast" opening.
  const entry: Pose = { position: [20, 12, 26], target: [0, 3, 0] }

  it.each(SEEDS)(
    'seed %i: takes flight from the activation pose itself (first spline point is the camera)',
    (seed) => {
      const tour = createDemoTour({ seed, placements, entry })
      expect(tour.kind).toBe('canyon')
      if (tour.kind === 'canyon') {
        expect([tour.window[1].x, tour.window[1].y, tour.window[1].z]).toEqual(entry.position)
      }
    },
  )

  it.each(SEEDS)(
    'seed %i: never rushes — the composited camera speed stays near cruise for the whole intro and beyond',
    (seed) => {
      // Composite exactly what FreeFlyControls renders during activation: the
      // tour's advancement is ramped by demoIntroSpeedFactor while the intro
      // runs, and the camera is the intro's ease between the activation pose
      // and the (slowly departing) flight pose.
      let tour: DemoTourState = createDemoTour({ seed, placements, entry })
      let elapsed = 0
      let previous: [number, number, number] = [...entry.position]
      let maxSpeed = 0
      const seconds = DEMO_TRANSITION_SECONDS + 3
      const steps = Math.round(seconds / DT)
      for (let i = 0; i < steps; i++) {
        elapsed += DT
        const ramp = elapsed < DEMO_TRANSITION_SECONDS ? demoIntroSpeedFactor(elapsed) : 1
        tour = stepDemoTour(tour, DT * ramp, placements)
        const flight = sampleDemoTourPose(tour)
        const pose =
          elapsed < DEMO_TRANSITION_SECONDS
            ? sampleDemoIntro({ from: entry, elapsed }, flight).pose
            : flight
        const speed =
          Math.hypot(
            pose.position[0] - previous[0],
            pose.position[1] - previous[1],
            pose.position[2] - previous[2],
          ) / DT
        maxSpeed = Math.max(maxSpeed, speed)
        previous = pose.position
      }

      // Calibrated bound: the ramped takeoff peaks barely above cruise
      // (~1.1-1.2x, 3D speed during the initial descent included); the
      // pre-fix flight-to-the-entry-waypoint intro peaked at over 2x cruise
      // even from the tour's own start (and far more from a distant pose) —
      // the visible rush.
      expect(maxSpeed).toBeLessThanOrEqual(CANYON_TRAVEL_SPEED * 1.4)
    },
  )

  it('starts the intro exactly at the activation pose (no initial jump)', () => {
    const tour = createDemoTour({ seed: 42424242, placements, entry })
    const { pose } = sampleDemoIntro({ from: entry, elapsed: 0 }, sampleDemoTourPose(tour))
    expect(pose.position).toEqual(entry.position)
    expect(pose.roll).toBeCloseTo(0, 9)
  })
})
