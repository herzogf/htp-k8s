import { describe, expect, it } from 'vitest'
import {
  BANK_YAW_RATE_DEADBAND,
  CANYON_TRAVEL_SPEED,
  createDemoTour,
  DEMO_BANK_MAX,
  DEMO_ROLL_MAX_ACCEL,
  DEMO_ROLL_MAX_RATE,
  DEMO_TRANSITION_SECONDS,
  demoIntroSpeedFactor,
  type DemoPose,
  type DemoTourState,
  sampleDemoIntro,
  sampleDemoTourPose,
  stepDemoTour,
  VIEW_PITCH_MAX_RATE,
  VIEW_YAW_MAX_RATE,
} from './demoMode'
import { focusLookAngles, type Pose } from './focus'
import { towerPlacements, type TowerPlacement } from './towerLayout'
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
 * - **Exact bounds** re-assert limits the implementation enforces by
 *   construction (roll rate ≤ DEMO_ROLL_MAX_RATE, roll acceleration ≤
 *   DEMO_ROLL_MAX_ACCEL, |roll| ≤ DEMO_BANK_MAX, view yaw rate ≤
 *   VIEW_YAW_MAX_RATE): these hold with only floating-point slack.
 * - **Calibrated bounds** (the ground-speed window, 3D acceleration, the
 *   activation speed factor, the view pitch margin for the aim-window
 *   clamp) are set with ~1.5x headroom above the maximum observed across all
 *   seeds/grids at the time of writing — far below what the pre-fix code
 *   produced — so they catch a regression to snappy behaviour without
 *   flaking on benign tuning.
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
        // construction. The pitch bound is the triplet's cap plus the
        // aim-window clamp's worst contribution: the clamp (never above the
        // roofline / below the canyon floor) pins the target's altitude while
        // the camera itself climbs/descends, which re-derives the rendered
        // pitch at up to verticalRate / horizontalReach =
        // (MAX_CLIMB_GRADIENT x cruise) / LOOKAT_MIN_HORIZONTAL_DISTANCE
        // ~ 0.42 x 4.4 / 4 ~ 0.47 rad/s on top of the eased triplet's own.
        const MAX_YAW_RATE = VIEW_YAW_MAX_RATE + 1e-6
        const MAX_PITCH_RATE = VIEW_PITCH_MAX_RATE + 0.47
        let previous = focusLookAngles(poses[0].position, poses[0].target)
        for (let i = 1; i < poses.length; i++) {
          const angles = focusLookAngles(poses[i].position, poses[i].target)
          expect(Math.abs(wrapAngle(angles.yaw - previous.yaw)) / DT).toBeLessThanOrEqual(
            MAX_YAW_RATE,
          )
          expect(Math.abs(wrapAngle(angles.pitch - previous.pitch)) / DT).toBeLessThanOrEqual(
            MAX_PITCH_RATE,
          )
          previous = angles
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
