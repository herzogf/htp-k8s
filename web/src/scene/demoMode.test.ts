import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  buildCanyonGraph,
  CANYON_ALTITUDE_MAX,
  createDemoTour,
  demandDrivenLookAt,
  DEMO_BANK_MAX,
  DEMO_TRANSITION_SECONDS,
  type DemoTourState,
  LOOKAT_TOWER_PULL_MAX,
  nearestTowerPull,
  NO_GLANCE,
  OVERVIEW_ALTITUDE_MAX,
  OVERVIEW_ALTITUDE_MIN,
  PERIMETER_OFFSET,
  sampleDemoIntro,
  sampleDemoTourPose,
  stepDemoTour,
  stepRollRecovery,
  type RollRecovery,
} from './demoMode'
import { type Pose } from './focus'
import { TOWER_HEIGHT, TOWER_SPACING, towerPlacements, type TowerPlacement } from './towerLayout'
import { type Tower } from '../generated/scenestate'
import { makeTower } from '../test-support/sceneFixtures'

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** A `cols` x `rows` grid of Towers, placed exactly as the real backend/frontend layout would. */
function grid(cols: number, rows: number): TowerPlacement[] {
  const towers: Tower[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      towers.push(makeTower({ name: `t-${col}-${row}`, grid: { col, row } }))
    }
  }
  return towerPlacements(towers)
}

const ORIGIN_POSE: Pose = { position: [0, 5, 0], target: [0, 5, -1] }

describe('buildCanyonGraph', () => {
  it('is null for an empty scene and for a single Tower (no canyon exists)', () => {
    expect(buildCanyonGraph([])).toBeNull()
    expect(buildCanyonGraph(grid(1, 1))).toBeNull()
  })

  it('lays out a 2x2 grid as one interior canyon per axis plus the perimeter pair', () => {
    const graph = buildCanyonGraph(grid(2, 2))!

    // Columns at x = -2, 2 (TOWER_SPACING=4, centred): interior canyon at the
    // midpoint (0), perimeter lines PERIMETER_OFFSET outside each flank.
    expect(graph.xs).toEqual([-2 - PERIMETER_OFFSET, 0, 2 + PERIMETER_OFFSET])
    expect(graph.zs).toEqual([-2 - PERIMETER_OFFSET, 0, 2 + PERIMETER_OFFSET])
  })

  it('handles a 1xN line cluster with no special case: no interior canyon on the single-column axis', () => {
    const graph = buildCanyonGraph(grid(1, 3))!

    // Only one column -> no interior canyon on X, just the perimeter pair.
    expect(graph.xs).toHaveLength(2)
    expect(graph.xs[1] - graph.xs[0]).toBe(2 * PERIMETER_OFFSET)
    // Three rows -> two interior canyons plus the perimeter pair.
    expect(graph.zs).toHaveLength(4)
  })

  it('scales to a larger grid without hardcoded bounds', () => {
    const graph = buildCanyonGraph(grid(4, 3))!

    expect(graph.xs).toHaveLength(5) // 4 columns -> 3 interior + 2 perimeter
    expect(graph.zs).toHaveLength(4) // 3 rows -> 2 interior + 2 perimeter
    // Monotonically increasing lattice lines on both axes.
    expect([...graph.xs].sort((a, b) => a - b)).toEqual(graph.xs)
    expect([...graph.zs].sort((a, b) => a - b)).toEqual(graph.zs)
  })
})

describe('createDemoTour', () => {
  it('enters at the Canyon graph node nearest the activation pose', () => {
    const placements = grid(4, 4)
    const graph = buildCanyonGraph(placements)!
    // The activation pose sits near the interior canyon crossing at (xs[2], zs[1]).
    const entry: Pose = { position: [graph.xs[2] + 0.2, 5, graph.zs[1] - 0.1], target: [0, 5, 0] }

    const tour = createDemoTour({ seed: 1, placements, entry })

    expect(tour.kind).toBe('canyon')
    if (tour.kind === 'canyon') {
      expect(tour.window[1].x).toBeCloseTo(graph.xs[2], 9)
      expect(tour.window[1].z).toBeCloseTo(graph.zs[1], 9)
    }
  })

  it('falls back to the orbit-and-bob state for an empty scene, centred on the origin', () => {
    const tour = createDemoTour({ seed: 1, placements: [], entry: ORIGIN_POSE })

    expect(tour.kind).toBe('orbit')
    if (tour.kind === 'orbit') {
      expect(tour.center).toEqual([0, 0, 0])
    }
  })

  it('falls back to the orbit-and-bob state for a single Tower, centred on it', () => {
    const placements = grid(1, 1)
    const tour = createDemoTour({ seed: 1, placements, entry: ORIGIN_POSE })

    expect(tour.kind).toBe('orbit')
    if (tour.kind === 'orbit') {
      expect(tour.center).toEqual(placements[0].position)
    }
  })
})

describe('the seeded Canyon tour', () => {
  const placements = grid(5, 5)

  it('is a pure, deterministic function of (seed, placements, entry): replays identically', () => {
    let a: DemoTourState = createDemoTour({ seed: 42, placements, entry: ORIGIN_POSE })
    let b: DemoTourState = createDemoTour({ seed: 42, placements, entry: ORIGIN_POSE })

    for (let i = 0; i < 400; i++) {
      const delta = 0.05 + (i % 3) * 0.01
      a = stepDemoTour(a, delta, placements)
      b = stepDemoTour(b, delta, placements)
      expect(sampleDemoTourPose(a, placements)).toEqual(sampleDemoTourPose(b, placements))
    }
  })

  it('produces a different tour for a different seed', () => {
    let a: DemoTourState = createDemoTour({ seed: 1, placements, entry: ORIGIN_POSE })
    let b: DemoTourState = createDemoTour({ seed: 2, placements, entry: ORIGIN_POSE })

    for (let i = 0; i < 50; i++) {
      a = stepDemoTour(a, 0.1, placements)
      b = stepDemoTour(b, 0.1, placements)
    }

    expect(
      distance(
        sampleDemoTourPose(a, placements).position,
        sampleDemoTourPose(b, placements).position,
      ),
    ).toBeGreaterThan(0.1)
  })

  it('moves over time — Demo Mode flies the camera on its own', () => {
    let tour: DemoTourState = createDemoTour({ seed: 7, placements, entry: ORIGIN_POSE })
    const start = sampleDemoTourPose(tour, placements).position
    for (let i = 0; i < 20; i++) {
      tour = stepDemoTour(tour, 0.1, placements)
    }
    const later = sampleDemoTourPose(tour, placements).position

    expect(distance(start, later)).toBeGreaterThan(0.5)
  })

  it('never jumps: consecutive frames stay within a small, speed-bounded step (C1 continuity)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 3, placements, entry: ORIGIN_POSE })
    const delta = 0.05
    let previous = sampleDemoTourPose(tour, placements).position
    // Enough steps to cross several segment boundaries (rollovers), where a
    // stitching bug would show up as a jump.
    for (let i = 0; i < 600; i++) {
      tour = stepDemoTour(tour, delta, placements)
      const current = sampleDemoTourPose(tour, placements).position
      // Generous bound: a few times the nominal per-frame travel distance,
      // covering the transient right after a rollover.
      expect(distance(previous, current)).toBeLessThan(TOWER_SPACING)
      previous = current
    }
  })

  it('stays within a bounded region around the Canyon graph (never drifts into the void)', () => {
    const graph = buildCanyonGraph(placements)!
    const margin = TOWER_SPACING
    let tour: DemoTourState = createDemoTour({ seed: 11, placements, entry: ORIGIN_POSE })

    for (let i = 0; i < 800; i++) {
      tour = stepDemoTour(tour, 0.07, placements)
      const [x, y, z] = sampleDemoTourPose(tour, placements).position
      expect(x).toBeGreaterThanOrEqual(graph.xs[0] - margin)
      expect(x).toBeLessThanOrEqual(graph.xs[graph.xs.length - 1] + margin)
      expect(z).toBeGreaterThanOrEqual(graph.zs[0] - margin)
      expect(z).toBeLessThanOrEqual(graph.zs[graph.zs.length - 1] + margin)
      expect(y).toBeGreaterThan(0)
    }
  })

  it('never banks past DEMO_BANK_MAX', () => {
    let tour: DemoTourState = createDemoTour({ seed: 5, placements, entry: ORIGIN_POSE })
    for (let i = 0; i < 400; i++) {
      tour = stepDemoTour(tour, 0.05, placements)
      expect(Math.abs(sampleDemoTourPose(tour, placements).roll)).toBeLessThanOrEqual(
        DEMO_BANK_MAX + 1e-9,
      )
    }
  })

  it('produces a visible bank at some point during the tour (it actually turns)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 5, placements, entry: ORIGIN_POSE })
    let maxRoll = 0
    for (let i = 0; i < 400; i++) {
      tour = stepDemoTour(tour, 0.05, placements)
      maxRoll = Math.max(maxRoll, Math.abs(sampleDemoTourPose(tour, placements).roll))
    }
    expect(maxRoll).toBeGreaterThan(0.02)
  })

  it('looks somewhere ahead of its own position (a nonzero look-at direction)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 9, placements, entry: ORIGIN_POSE })
    tour = stepDemoTour(tour, 0.2, placements)
    const pose = sampleDemoTourPose(tour, placements)

    expect(distance(pose.position, pose.target)).toBeGreaterThan(0)
  })

  it('never immediately backtracks while a forward option exists (a large-enough grid never dead-ends)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 21, placements, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')
    const visited: string[] =
      tour.kind === 'canyon' ? [key(tour.window[1]), key(tour.window[2])] : []

    for (let i = 0; i < 300; i++) {
      tour = stepDemoTour(tour, 5, placements) // large delta: force a rollover every step
      if (tour.kind === 'canyon') {
        visited.push(key(tour.window[2]))
      }
    }

    // An immediate backtrack revisits the waypoint two steps back. This 5x5
    // grid is large relative to a 300-step walk, so the "only legal move is
    // to backtrack" dead-end escape hatch should never trigger.
    for (let i = 2; i < visited.length; i++) {
      expect(visited[i]).not.toBe(visited[i - 2])
    }

    function key(v: { x: number; z: number }): string {
      return `${v.x.toFixed(3)},${v.z.toFixed(3)}`
    }
  })

  it('regenerates the Canyon graph lazily: an in-progress segment ignores a placements change until it completes', () => {
    const before = grid(3, 3)
    const after = grid(6, 6)
    let tour: DemoTourState = createDemoTour({ seed: 1, placements: before, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')
    const graphBefore = tour.kind === 'canyon' ? tour.graph : null

    // A tiny step that does not complete the current segment.
    tour = stepDemoTour(tour, 0.001, after)
    expect(tour.kind).toBe('canyon')
    if (tour.kind === 'canyon') {
      expect(tour.graph).toEqual(graphBefore)
    }

    // Enough steps to guarantee at least one rollover onto the new graph.
    for (let i = 0; i < 100; i++) {
      tour = stepDemoTour(tour, 1, after)
    }
    expect(tour.kind).toBe('canyon')
    if (tour.kind === 'canyon') {
      expect(tour.graph).toEqual(buildCanyonGraph(after))
    }
  })
})

// Regression coverage for the "aims at the void" bug resurfacing at overview
// altitude: nearestTowerPull originally judged "are Towers already framed?"
// on horizontal distance alone, which reads a camera hovering directly above
// a Tower as framed — so the pull stayed ~0 and a level forward look-ahead
// floated into empty sky above the roofline. The fix adds a vertical
// (height-above-roofline) signal that engages regardless of horizontal
// distance, while leaving canyon-altitude flying (always below the roofline)
// untouched.
describe('the demand-driven look-at, at overview altitude (#91 follow-up)', () => {
  const placements = grid(3, 3)
  const centerTower = placements[4] // the middle Tower of the 3x3 grid

  describe('nearestTowerPull', () => {
    it('stays ~0 for a canyon-altitude camera flanked by Towers (unchanged canyon behaviour)', () => {
      // A point mid-canyon, aligned with a Tower row so it's genuinely flanked
      // by the two nearest Towers (not a lattice corner, equidistant from four
      // Towers diagonally — a different, farther-clearance case).
      const graph = buildCanyonGraph(placements)!
      const canyonPosition = new Vector3(graph.xs[1], CANYON_ALTITUDE_MAX, centerTower.position[2])

      expect(nearestTowerPull(canyonPosition, placements).strength).toBeCloseTo(0, 5)
    })

    it('engages even when horizontally right above a Tower, once high above the roofline', () => {
      const overviewPosition = new Vector3(
        centerTower.position[0],
        OVERVIEW_ALTITUDE_MAX,
        centerTower.position[2],
      )

      const pull = nearestTowerPull(overviewPosition, placements)

      // Horizontal distance here is ~0 — the pre-fix, horizontal-only test
      // would have read this as "already framed" and suppressed the pull
      // entirely (the bug). It must not.
      expect(pull.strength).toBeGreaterThan(LOOKAT_TOWER_PULL_MAX * 0.5)
    })

    it('ramps smoothly with altitude above the roofline (no snap — the motion-sickness guardrail)', () => {
      const altitudes = [
        TOWER_HEIGHT * 0.9, // still below the roofline (canyon-band top)
        TOWER_HEIGHT * 1.1,
        TOWER_HEIGHT * 1.6,
        OVERVIEW_ALTITUDE_MAX,
      ]
      const strengths = altitudes.map(
        (y) =>
          nearestTowerPull(
            new Vector3(centerTower.position[0], y, centerTower.position[2]),
            placements,
          ).strength,
      )

      // Monotonically non-decreasing with altitude — a smoothstep ramp, not a
      // step function.
      for (let i = 1; i < strengths.length; i++) {
        expect(strengths[i]).toBeGreaterThanOrEqual(strengths[i - 1] - 1e-9)
      }
      expect(strengths[0]).toBeCloseTo(0, 5)
      expect(strengths[strengths.length - 1]).toBeGreaterThan(0)
    })
  })

  describe('demandDrivenLookAt', () => {
    it('tilts the look-at down toward the Towers during an overview pass, instead of aiming into empty sky', () => {
      const position = new Vector3(
        centerTower.position[0],
        OVERVIEW_ALTITUDE_MAX,
        centerTower.position[2],
      )
      const tangent = new Vector3(1, 0, 0) // level forward travel
      const pull = nearestTowerPull(position, placements)

      const target = demandDrivenLookAt(position, tangent, pull.strength, placements, NO_GLANCE)

      // A level forward look-ahead alone (the pre-fix behaviour) sits at the
      // camera's own altitude. The fix must pull the target's Y meaningfully
      // below the camera's — tilting the aim down toward the skyline.
      expect(target.y).toBeLessThan(position.y - TOWER_HEIGHT * 0.3)
      // And it should land near the cluster horizontally, not drift into the void.
      const horizontalDistance = Math.hypot(
        target.x - centerTower.position[0],
        target.z - centerTower.position[2],
      )
      expect(horizontalDistance).toBeLessThan(TOWER_SPACING * 4)
    })

    it('leaves the look-at level inside a canyon (unchanged canyon behaviour)', () => {
      const graph = buildCanyonGraph(placements)!
      const position = new Vector3(graph.xs[1], CANYON_ALTITUDE_MAX, centerTower.position[2])
      const tangent = new Vector3(0, 0, 1)
      const pull = nearestTowerPull(position, placements)

      const target = demandDrivenLookAt(position, tangent, pull.strength, placements, NO_GLANCE)

      expect(target.y).toBeCloseTo(position.y, 5)
    })
  })

  it('integration: over a long tour, deep-overview samples keep looking toward the Towers, not into the void', () => {
    // The pull ramps in smoothly with altitude above the roofline (the
    // motion-sickness guardrail — no snap right at the roofline), so this
    // only asserts the strong "clearly tilted down" outcome once a sample is
    // well into the overview band, not at its very edge where a mild tilt is
    // the intended, correct behaviour.
    const deepOverviewY = (OVERVIEW_ALTITUDE_MIN + OVERVIEW_ALTITUDE_MAX) / 2
    let tour: DemoTourState = createDemoTour({ seed: 99, placements, entry: ORIGIN_POSE })
    let sawDeepOverview = false

    for (let i = 0; i < 600; i++) {
      tour = stepDemoTour(tour, 0.15, placements)
      const pose = sampleDemoTourPose(tour, placements)
      const [, positionY] = pose.position
      if (positionY > deepOverviewY) {
        sawDeepOverview = true
        const [, targetY] = pose.target
        expect(targetY).toBeLessThan(positionY - 1)
      }
    }

    // A seed run this long should hit at least one overview waypoint deep
    // enough into the band (OVERVIEW_PROBABILITY=0.15 per waypoint, and
    // altitude is jittered across the whole band) — otherwise this test isn't
    // actually exercising the regression.
    expect(sawDeepOverview).toBe(true)
  })
})

describe('the orbit-and-bob fallback', () => {
  it('stays close to its centre and keeps moving, for an empty scene', () => {
    let tour: DemoTourState = createDemoTour({ seed: 4, placements: [], entry: ORIGIN_POSE })
    const start = sampleDemoTourPose(tour, []).position
    let maxDistanceFromOrigin = 0

    for (let i = 0; i < 100; i++) {
      tour = stepDemoTour(tour, 0.1, [])
      const position = sampleDemoTourPose(tour, []).position
      maxDistanceFromOrigin = Math.max(maxDistanceFromOrigin, Math.hypot(position[0], position[2]))
    }
    const later = sampleDemoTourPose(tour, []).position

    expect(distance(start, later)).toBeGreaterThan(0.1)
    expect(maxDistanceFromOrigin).toBeLessThan(TOWER_SPACING * 5)
  })

  it('never banks past DEMO_BANK_MAX', () => {
    let tour: DemoTourState = createDemoTour({ seed: 4, placements: [], entry: ORIGIN_POSE })
    for (let i = 0; i < 50; i++) {
      tour = stepDemoTour(tour, 0.1, [])
      expect(Math.abs(sampleDemoTourPose(tour, []).roll)).toBeLessThanOrEqual(DEMO_BANK_MAX + 1e-9)
    }
  })

  it('promotes to a real Canyon tour the moment enough Towers exist', () => {
    let tour: DemoTourState = createDemoTour({
      seed: 6,
      placements: grid(1, 1),
      entry: ORIGIN_POSE,
    })
    expect(tour.kind).toBe('orbit')

    tour = stepDemoTour(tour, 0.1, grid(3, 3))

    expect(tour.kind).toBe('canyon')
  })

  it('degrades a Canyon tour back to orbit if the cluster shrinks to degenerate mid-flight', () => {
    const placements = grid(3, 3)
    let tour: DemoTourState = createDemoTour({ seed: 6, placements, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')

    // A large delta forces a rollover, where the shrink is detected.
    tour = stepDemoTour(tour, 10, [])

    expect(tour.kind).toBe('orbit')
  })
})

describe('sampleDemoIntro', () => {
  const from: Pose = { position: [50, 20, 50], target: [0, 0, 0] }
  const flight = {
    position: [1, 2, 3] as [number, number, number],
    target: [4, 5, 6] as [number, number, number],
    roll: 0.3,
  }

  it('starts exactly at the pre-activation pose with zero bank', () => {
    const { pose } = sampleDemoIntro({ from, elapsed: 0 }, flight)
    expect(pose.position).toEqual(from.position)
    expect(pose.target).toEqual(from.target)
    expect(pose.roll).toBeCloseTo(0, 9)
  })

  it('ends exactly on the (moving) flight pose once the transition completes', () => {
    const { pose, done } = sampleDemoIntro({ from, elapsed: DEMO_TRANSITION_SECONDS }, flight)

    expect(done).toBe(true)
    expect(distance(pose.position, flight.position)).toBeLessThan(1e-9)
    expect(pose.roll).toBeCloseTo(flight.roll, 9)
  })

  it('is not done mid-transition, and sits strictly between start and the flight pose', () => {
    const { pose, done } = sampleDemoIntro({ from, elapsed: DEMO_TRANSITION_SECONDS / 2 }, flight)

    expect(done).toBe(false)
    expect(distance(pose.position, from.position)).toBeGreaterThan(0)
    expect(distance(pose.position, flight.position)).toBeGreaterThan(0)
  })
})

describe('stepRollRecovery', () => {
  it('starts at the banked angle and eases toward level, never overshooting it', () => {
    const initial: RollRecovery = { from: 0.4, elapsed: 0 }
    let recovery: RollRecovery | null = initial
    let lastAbsRoll = Math.abs(initial.from)
    const smallStep = DEMO_TRANSITION_SECONDS / 20
    for (let i = 0; i < 25 && recovery; i++) {
      const { roll, next } = stepRollRecovery(recovery, smallStep)
      expect(Math.abs(roll)).toBeLessThanOrEqual(lastAbsRoll + 1e-9)
      lastAbsRoll = Math.abs(roll)
      recovery = next
    }
    expect(recovery).toBeNull()
    expect(lastAbsRoll).toBeLessThan(1e-9)
  })

  it('clears to null once the transition duration has fully elapsed', () => {
    const { roll, next } = stepRollRecovery({ from: 0.3, elapsed: 0 }, DEMO_TRANSITION_SECONDS)
    expect(roll).toBe(0)
    expect(next).toBeNull()
  })
})
