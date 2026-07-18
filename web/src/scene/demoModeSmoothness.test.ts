import { describe, expect, it } from 'vitest'
import {
  BANK_YAW_RATE_DEADBAND,
  CANYON_TRAVEL_SPEED,
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
import { TOWER_HEIGHT, towerPlacements, type TowerPlacement } from './towerLayout'
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

const DT = 1 / 60
const TOUR_SECONDS = 90
const SEEDS = [42424242, 1, 7, 13, 99]
/**
 * The 5x5 reference grid plus a small 4x2 — close to the 7-Tower KWOK scene
 * the maintainer reviews on. `expectStraightCruise` marks grids whose lattice
 * has avenues long enough that the walk reliably flies a full settle-window
 * dead straight within the recorded tours: the 4x2's avenues are short and
 * its edge-pull bias keeps the walk weaving, so the wings-level property is
 * only *guaranteed exercised* on the larger grid (it still holds — vacuously
 * or not — on the small one).
 */
const GRIDS: Array<{ name: string; placements: TowerPlacement[]; expectStraightCruise: boolean }> =
  [
    { name: '5x5', placements: grid(5, 5), expectStraightCruise: true },
    { name: '4x2', placements: grid(4, 2), expectStraightCruise: false },
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
  ({ name, placements, expectStraightCruise }) => {
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
        // frames (see the rate test above for the mechanism): the clamp's
        // engagement/release re-keys the rendered pitch rate by up to ~0.47
        // rad/s across ~a frame — a hard mechanism ceiling of 0.47/DT ≈ 28
        // rad/s², in practice far softer because the climb gradient it rides
        // on is itself slewed (observed ≤ 5.5 rad/s² across all seeds/grids;
        // bounded at 8 with ~1.45x headroom — vs the pre-#105 rate-limiter
        // snaps of up to 96 rad/s² of pitch). The clamp frames are
        // mechanically identified per frame, so the exact cap guards every
        // ordinary frame (the #116 review flagged the old blanket 6x slack
        // as weakly guarding).
        const MAX_YAW_ACCEL = VIEW_YAW_MAX_ACCEL + 1e-6
        const MAX_PITCH_ACCEL = VIEW_PITCH_MAX_ACCEL + 1e-6
        const MAX_PITCH_ACCEL_CLAMPED = 8
        let previous = focusLookAngles(poses[0].position, poses[0].target)
        let previousYawRate: number | null = null
        let previousPitchRate: number | null = null
        for (let i = 1; i < poses.length; i++) {
          const angles = focusLookAngles(poses[i].position, poses[i].target)
          const yawRate = wrapAngle(angles.yaw - previous.yaw) / DT
          const pitchRate = wrapAngle(angles.pitch - previous.pitch) / DT
          if (previousYawRate !== null && previousPitchRate !== null) {
            expect(Math.abs(yawRate - previousYawRate) / DT).toBeLessThanOrEqual(MAX_YAW_ACCEL)
            const pitchBound = aimClampEngagedNear(poses, i, 2)
              ? MAX_PITCH_ACCEL_CLAMPED
              : MAX_PITCH_ACCEL
            expect(Math.abs(pitchRate - previousPitchRate) / DT).toBeLessThanOrEqual(pitchBound)
          }
          previousYawRate = yawRate
          previousPitchRate = pitchRate
          previous = angles
        }
      })

      it('keeps the aim-window-clamp exception narrow: clamp-engaged frames stay a small share of the tour', () => {
        // The pitch invariants above hold the exact follower caps on every
        // frame *except* mechanically identified aim-window-clamp frames.
        // That exception is only honest while it stays rare: without this
        // bound, a future change that parks the aim on the clamp (e.g. an
        // altitude program living at the roofline) would silently move most
        // frames onto the looser clamp-frame bounds with nothing failing.
        // Observed across all seeds/grids: 3.8-7.8% of frames engaged.
        // Calibrated bound: 15% (~2x the observed worst).
        const MAX_CLAMP_FRACTION = 0.15
        const engaged = poses.filter(aimClampEngaged).length
        expect(engaged / poses.length).toBeLessThanOrEqual(MAX_CLAMP_FRACTION)
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
        // Observed across all seeds/grids: 2-12 events per 90s tour (one per
        // genuinely long turn), each ≤ 2.4s, total fraction ≤ 13.1%. Bounds:
        // ≤ 20 events (vs ~40-65 for a per-waypoint rhythm), ≤ 3.5s per
        // event, and ≤ 16% of frames — 1.25x the observed worst fraction,
        // deliberately *below* the ~18% the pre-#105 pinning bug produced,
        // so the fraction bound alone still excludes the known-bad regime
        // (the event-count bound is the sharper discriminator; this one
        // backstops it honestly rather than sitting above known-bad).
        const MAX_SATURATION_FRACTION = 0.16
        const MAX_SATURATION_EVENTS = 20
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
        // (BANK_YAW_RATE_SMOOTHING), observed ≤ 12/min (4x2 grids ≤ 6/min).
        // Calibrated bound: 16/min — below every pre-fix observation, ~1.3x
        // above the worst current one.
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

      it('flies corners as arcs, not pivots: the per-frame heading rate implies a real turn radius (the Cessna-vs-drone guard)', () => {
        // The route-geometry half of #105 iteration 2: at constant ground
        // speed, heading rate *is* curvature — a pivot corner is a heading-
        // rate spike. Pre-rounding, 90° lattice corners peaked at 6.1-9.1
        // rad/s (implied turn radius 0.5-0.7 world units — an eighth of a
        // Tower spacing: a drone yawing in place). The rounded corners' ideal
        // arc rate is CANYON_TRAVEL_SPEED / CORNER_TURN_RADIUS ≈ 2.4 rad/s;
        // the Catmull-Rom through the arc points runs a little tighter in
        // spots (observed peak ≤ 4.38 across all seeds/grids). Calibrated
        // bound: 5.5 rad/s (implied radius ≥ 0.8 units) — below every
        // pre-rounding corner, ~1.25x above the worst current frame.
        const MAX_HEADING_RATE = 5.5
        expect(CANYON_TRAVEL_SPEED / CORNER_TURN_RADIUS).toBeLessThan(MAX_HEADING_RATE)
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
