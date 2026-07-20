import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  buildCanyonGraph,
  CANYON_ALTITUDE_MAX,
  CANYON_ALTITUDE_MIN,
  createDemoTour,
  demandDrivenLookAt,
  DEMO_BANK_MAX,
  DEMO_TRANSITION_SECONDS,
  type DemoTourState,
  LOOKAT_AIM_CEILING,
  LOOKAT_TOWER_PULL_MAX,
  MAX_CLIMB_GRADIENT,
  nearestTowerPull,
  NO_GLANCE,
  OVERVIEW_ALTITUDE_MAX,
  OVERVIEW_ALTITUDE_MIN,
  OVERVIEW_EPISODE_WAYPOINTS,
  OVERVIEW_PERIMETER_EXTRA,
  OVERVIEW_WIDE_APEX_MAX,
  OVERVIEW_WIDE_EPISODE_WAYPOINTS,
  OVERVIEW_WIDE_START_WAYPOINT,
  OVERVIEW_GAP_WAYPOINTS_MIN,
  PERIMETER_OFFSET,
  sampleDemoIntro,
  sampleDemoTourPose,
  stepBoundedFollower,
  stepDemoTour,
  stepRollRecovery,
  type RollRecovery,
  VIEW_DISTANCE_FOLLOWER,
} from './demoMode'
import { type Pose } from './focus'
import {
  TOWER_FOOTPRINT,
  TOWER_HEIGHT,
  TOWER_SPACING,
  towerPlacements,
  type TowerPlacement,
} from './towerLayout'
import { type Tower } from '../generated/scenestate'
import { makeTower } from '../test-support/sceneFixtures'

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * Independent re-implementation of point-to-Tower-bounding-box distance
 * (deliberately not imported from demoMode.ts — see "the demand-driven
 * look-at never aims into the void" describe block's doc comment below):
 * the real, geometric "is this actually near a Tower" measurement several
 * tests share, so a bug in the production clearance calculation itself
 * wouldn't slip through as a tautology.
 */
function clearanceToNearestTower(
  target: readonly number[],
  allPlacements: TowerPlacement[],
): number {
  const halfFootprint = TOWER_FOOTPRINT / 2
  let nearest = Infinity
  for (const placement of allPlacements) {
    const dx = Math.max(0, Math.abs(target[0] - placement.position[0]) - halfFootprint)
    const dz = Math.max(0, Math.abs(target[2] - placement.position[2]) - halfFootprint)
    const dy = Math.max(0, target[1] - TOWER_HEIGHT, -target[1])
    nearest = Math.min(nearest, Math.hypot(dx, dy, dz))
  }
  return nearest
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
      expect(sampleDemoTourPose(a)).toEqual(sampleDemoTourPose(b))
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
      distance(sampleDemoTourPose(a).position, sampleDemoTourPose(b).position),
    ).toBeGreaterThan(0.1)
  })

  it('moves over time — Demo Mode flies the camera on its own', () => {
    let tour: DemoTourState = createDemoTour({ seed: 7, placements, entry: ORIGIN_POSE })
    const start = sampleDemoTourPose(tour).position
    for (let i = 0; i < 20; i++) {
      tour = stepDemoTour(tour, 0.1, placements)
    }
    const later = sampleDemoTourPose(tour).position

    expect(distance(start, later)).toBeGreaterThan(0.5)
  })

  it('never jumps: consecutive frames stay within a small, speed-bounded step (C1 continuity)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 3, placements, entry: ORIGIN_POSE })
    const delta = 0.05
    let previous = sampleDemoTourPose(tour).position
    // Enough steps to cross several segment boundaries (rollovers), where a
    // stitching bug would show up as a jump.
    for (let i = 0; i < 600; i++) {
      tour = stepDemoTour(tour, delta, placements)
      const current = sampleDemoTourPose(tour).position
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
      const [x, y, z] = sampleDemoTourPose(tour).position
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
      expect(Math.abs(sampleDemoTourPose(tour).roll)).toBeLessThanOrEqual(DEMO_BANK_MAX + 1e-9)
    }
  })

  it('produces a visible bank at some point during the tour (it actually turns)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 5, placements, entry: ORIGIN_POSE })
    let maxRoll = 0
    for (let i = 0; i < 400; i++) {
      tour = stepDemoTour(tour, 0.05, placements)
      maxRoll = Math.max(maxRoll, Math.abs(sampleDemoTourPose(tour).roll))
    }
    expect(maxRoll).toBeGreaterThan(0.02)
  })

  it('looks somewhere ahead of its own position (a nonzero look-at direction)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 9, placements, entry: ORIGIN_POSE })
    tour = stepDemoTour(tour, 0.2, placements)
    const pose = sampleDemoTourPose(tour)

    expect(distance(pose.position, pose.target)).toBeGreaterThan(0)
  })

  it('never immediately backtracks while a forward option exists (a large-enough grid never dead-ends)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 21, placements, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')

    // Observe the walk through the state's leading raw waypoint (headCoord):
    // since corner rounding (#105 iteration 2) the spline's control points
    // are no longer lattice nodes, so the walk's node sequence is read off
    // the lattice coordinate of each newly drawn waypoint instead of off the
    // window. Steps are kept small enough that at most one waypoint can be
    // drawn per step (a step's travel is well below the window arc a single
    // draw appends), so the recorded sequence has no gaps — an immediate
    // backtrack would appear as `visited[i] === visited[i - 2]`.
    const visited: string[] = []
    const record = () => {
      if (tour.kind !== 'canyon') return
      const key = `${tour.headCoord.i},${tour.headCoord.j}`
      if (visited[visited.length - 1] !== key) {
        visited.push(key)
      }
    }
    record()
    for (let i = 0; i < 2600; i++) {
      tour = stepDemoTour(tour, 0.15, placements)
      record()
    }

    // A run this long must actually exercise a long walk (sanity on the
    // observation mechanism itself), and this 5x5 grid has no dead ends, so
    // the "only legal move is to backtrack" escape hatch never triggers.
    expect(visited.length).toBeGreaterThan(100)
    for (let i = 2; i < visited.length; i++) {
      expect(visited[i]).not.toBe(visited[i - 2])
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

/**
 * The forcing-function test for the "elevator climb" bug (#91 follow-up): the
 * camera's altitude was previously rate-limited *temporally*
 * (`MAX_VERTICAL_RATE` units/second against elapsed time), which does not
 * bound the *visual* climb angle — wherever the horizontal spline speed dips
 * within a frame (a tight corner, a slow point in the Catmull-Rom's uniform-
 * `t` parameterization, a near-stationary moment near a waypoint), altitude
 * kept changing at the full rate while the camera barely moved forward, so
 * the apparent climb/descent angle could spike toward vertical — the
 * "elevator" look. The fix (see {@link MAX_CLIMB_GRADIENT}'s doc comment)
 * gates `|Δaltitude|` each frame by the horizontal (x, z) distance the camera
 * actually travelled *that* frame, so the climb/descent angle can never
 * exceed `atan(MAX_CLIMB_GRADIENT)` regardless of how the horizontal speed
 * varies. This test densely samples several full seeded tours and asserts
 * that invariant holds on every single frame — not just on average — which is
 * exactly the property a temporal rate cap cannot guarantee and a spatial
 * gradient cap can.
 */
describe('the Canyon tour altitude never climbs/descends steeper than the glide-slope cap (#91 elevator-climb fix)', () => {
  const placements = grid(5, 5)
  const seeds = [3, 17, 101, 555, 42424242]
  const delta = 0.05
  const STEPS = 800
  // Generous floating-point slack, not a loosened bound: the cap itself is
  // exact (`approach`'s maxDelta), this only absorbs the sqrt/hypot rounding
  // in re-deriving horizontal distance from two sampled positions.
  const EPSILON = 1e-9

  it.each(seeds)(
    'seed %i: every frame’s altitude change stays within MAX_CLIMB_GRADIENT × that frame’s horizontal travel',
    (seed) => {
      let tour: DemoTourState = createDemoTour({ seed, placements, entry: ORIGIN_POSE })
      let previousPosition = sampleDemoTourPose(tour).position
      let sawNontrivialHorizontalMove = false

      for (let i = 0; i < STEPS; i++) {
        tour = stepDemoTour(tour, delta, placements)
        const position = sampleDemoTourPose(tour).position

        const horizontalDelta = Math.hypot(
          position[0] - previousPosition[0],
          position[2] - previousPosition[2],
        )
        const verticalDelta = Math.abs(position[1] - previousPosition[1])

        // The core invariant: the climb/descent angle this frame never
        // exceeds atan(MAX_CLIMB_GRADIENT) — an elevator-like near-vertical
        // rise while horizontal speed is low is exactly what this forbids.
        expect(verticalDelta).toBeLessThanOrEqual(MAX_CLIMB_GRADIENT * horizontalDelta + EPSILON)

        if (horizontalDelta > 0.01) {
          sawNontrivialHorizontalMove = true
        }
        previousPosition = position
      }

      // Sanity check on the test itself: a run this long over a 5x5 grid
      // should spend the overwhelming majority of frames actually moving
      // horizontally (not stalled at a waypoint) — otherwise the invariant
      // above would be trivially satisfied by near-zero altitude at every
      // step and wouldn't actually be exercising the cap.
      expect(sawNontrivialHorizontalMove).toBe(true)
    },
  )

  it('still reaches its target altitude once the plane resumes horizontal travel (holding altitude near-stationary is not a stuck climb)', () => {
    let tour: DemoTourState = createDemoTour({ seed: 8, placements, entry: ORIGIN_POSE })
    let reachedATargetAltitude = false

    for (let i = 0; i < STEPS; i++) {
      tour = stepDemoTour(tour, delta, placements)
      if (tour.kind === 'canyon' && Math.abs(tour.altitude - tour.window[2].y) < 1e-6) {
        reachedATargetAltitude = true
        break
      }
    }

    expect(reachedATargetAltitude).toBe(true)
  })
})

/**
 * The forcing-function tests for #91's climb-choreography feel pass. The
 * maintainer's diagnosis of the remaining "sharp turn up" was that the low
 * canyon waypoint and the high overview waypoint sat too close together
 * horizontally — all the altitude gained over one short run. The fix makes
 * the overview an *intent sustained across consecutive waypoints* (see
 * OVERVIEW_EPISODE_WAYPOINTS's doc comment): one apex is drawn per episode
 * and held for the whole episode, so the (now shallower, ~23°) glide-slope
 * pursuit has several segments of horizontal distance to climb over, cruise
 * at, and descend from. These tests lock that structure — a per-frame slope
 * cap alone (the previous describe block) cannot distinguish a long graceful
 * arc from a maximal-slope pop-up-and-back spike.
 */
/**
 * Steps a tour in small increments and records each newly drawn raw
 * waypoint's altitude (walk order, no gaps) — the altitude program's actual
 * per-waypoint output. Small steps guarantee at most one draw per step (see
 * the no-backtrack test's doc comment), so runs of identical apex altitude
 * in the result correspond 1:1 to waypoint runs.
 */
function recordWaypointAltitudes(
  tour: DemoTourState,
  placements: TowerPlacement[],
  steps: number,
): number[] {
  const altitudes: number[] = []
  let lastKey = ''
  const record = () => {
    if (tour.kind !== 'canyon') return
    const key = `${tour.headCoord.i},${tour.headCoord.j}`
    if (key !== lastKey) {
      lastKey = key
      altitudes.push(tour.rawTail.y)
    }
  }
  record()
  for (let i = 0; i < steps; i++) {
    tour = stepDemoTour(tour, 0.15, placements)
    record()
  }
  return altitudes
}

describe('overview passes are sustained, paced episodes (#91 climb-choreography feel pass)', () => {
  const placements = grid(5, 5)

  it('sustains one apex altitude across a whole episode of consecutive waypoints (a climb-out is a long arc, not a one-waypoint spike)', () => {
    const tour: DemoTourState = createDemoTour({ seed: 42424242, placements, entry: ORIGIN_POSE })
    // The per-waypoint altitude sequence in walk order, read off the state's
    // leading raw waypoint (rawTail carries each newly drawn waypoint's
    // altitude; the spline window no longer maps 1:1 to waypoints since
    // corner rounding, #105 iteration 2). Small steps so no draw is skipped
    // — same observation mechanism as the no-backtrack test.
    const targetAltitudes = recordWaypointAltitudes(tour, placements, 3400)

    // Split the sequence into runs of identical target altitude and classify
    // each run as overview (above the roofline — the overview band starts at
    // 1.1 × TOWER_HEIGHT) or canyon.
    const runs: Array<{ y: number; length: number }> = []
    for (const y of targetAltitudes) {
      const last = runs[runs.length - 1]
      if (last && last.y === y) {
        last.length++
      } else {
        runs.push({ y, length: 1 })
      }
    }
    // Only completed runs: the recording window can cut off mid-episode, so
    // the very last run (whatever its kind) may be truncated.
    const overviewRuns = runs.slice(0, -1).filter((r) => r.y > TOWER_HEIGHT)

    // A long walk over paced episodes must contain several overview episodes…
    expect(overviewRuns.length).toBeGreaterThanOrEqual(3)
    // …and every one of them sustains its single drawn apex for exactly its
    // episode length — the intent never resets to a fresh draw mid-episode
    // (which is exactly what compressed the old climbs into pop-ups). Since
    // #105 iteration 4 the episode length is apex-dependent: shallow-apex
    // episodes are the *wide* ones and run one waypoint shorter (the length
    // refund that pays for their wide detour — see
    // OVERVIEW_WIDE_EPISODE_WAYPOINTS).
    for (const run of overviewRuns) {
      const expected =
        run.y <= OVERVIEW_WIDE_APEX_MAX
          ? OVERVIEW_WIDE_EPISODE_WAYPOINTS
          : OVERVIEW_EPISODE_WAYPOINTS
      expect(run.length).toBe(expected)
    }
  })

  it('paces episodes apart: every stretch between two overview episodes is a real canyon dwell, never a back-to-back yo-yo', () => {
    const tour: DemoTourState = createDemoTour({ seed: 7, placements, entry: ORIGIN_POSE })
    const targetAltitudes = recordWaypointAltitudes(tour, placements, 4600)

    // Count the canyon-waypoint gaps strictly *between* overview episodes
    // (the leading partial gap before the first episode is excluded — the
    // tour's creation already consumed part of it).
    const gaps: number[] = []
    let inOverview = false
    let sawFirstEpisode = false
    let gap = 0
    for (const y of targetAltitudes) {
      const overview = y > TOWER_HEIGHT
      if (overview) {
        if (!inOverview && sawFirstEpisode) {
          gaps.push(gap)
        }
        sawFirstEpisode = true
        gap = 0
      } else if (sawFirstEpisode) {
        gap++
      }
      inOverview = overview
    }

    expect(gaps.length).toBeGreaterThanOrEqual(2)
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(OVERVIEW_GAP_WAYPOINTS_MIN)
    }
  })

  it.each([42424242, 7, 13])(
    'seed %i: the camera still genuinely gets over the rooftops, then eases back down into the canyon (overviews not killed)',
    (seed) => {
      let tour: DemoTourState = createDemoTour({ seed, placements, entry: ORIGIN_POSE })
      const delta = 0.05
      let crossedAboveRoofline = false
      let returnedToCanyon = false

      // 120 simulated seconds: comfortably more than one full paced cycle
      // (max gap + episode + climb/descent), so this is deterministic per
      // seed, not probabilistic.
      for (let i = 0; i < 2400; i++) {
        tour = stepDemoTour(tour, delta, placements)
        const y = sampleDemoTourPose(tour).position[1]
        if (!crossedAboveRoofline) {
          crossedAboveRoofline = y > TOWER_HEIGHT
        } else if (y <= CANYON_ALTITUDE_MAX) {
          returnedToCanyon = true
          break
        }
      }

      expect(crossedAboveRoofline).toBe(true)
      expect(returnedToCanyon).toBe(true)
    },
  )
})

describe('wide overview episodes swing the perimeter waypoints outward (#105 iteration 4)', () => {
  // The exact 7-Tower KWOK demo scene: ring-dominant (12 ring nodes to 4
  // interior), so wide episodes reliably meet perimeter lines — on the
  // interior-heavy grids whole seeds can legitimately contain zero widened
  // waypoints, which would make the per-episode assertions below vacuous.
  const placements = towerPlacements(
    (
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
        [0, 2],
      ] as Array<[number, number]>
    ).map(([col, row]) => makeTower({ name: `t-${col}-${row}`, grid: { col, row } })),
  )
  const graph = buildCanyonGraph(placements)!
  const seeds = [42424242, 1, 7, 13, 99]

  it('the wide-phase constants stay a working pair (the coupling guard)', () => {
    // Nothing else couples these constants, so pin the relationships here —
    // the gate is `waypointsLeft <= WIDE_EPISODE - 1 - WIDE_START`, and a
    // seemingly innocent nudge to either constant can silently kill or
    // corrupt the feature:
    // - raise WIDE_START by one and the wide phase becomes empty — the
    //   feature never fires again, with nothing failing;
    expect(
      OVERVIEW_WIDE_EPISODE_WAYPOINTS - 1 - OVERVIEW_WIDE_START_WAYPOINT,
    ).toBeGreaterThanOrEqual(1)
    // - lower WIDE_START below the climb's lead-in and widened legs are
    //   flown *during* the climb, below the roofline — the measured
    //   mechanism that spent the time-in-canyon floor (see
    //   OVERVIEW_WIDE_START_WAYPOINT's doc comment: 2 waypoints clear the
    //   roofline from the median canyon start altitude, derived from
    //   MAX_CLIMB_GRADIENT — asserted against that derivation, not a bare
    //   literal; ceil, because a fractional waypoint of climb still needs
    //   the whole next leg to complete — floor would round the required
    //   lead-in down to 1 and this half of the guard would never bite);
    const medianCanyonStart = (CANYON_ALTITUDE_MIN + CANYON_ALTITUDE_MAX) / 2
    const climbWaypoints = (TOWER_HEIGHT - medianCanyonStart) / (MAX_CLIMB_GRADIENT * TOWER_SPACING)
    expect(OVERVIEW_WIDE_START_WAYPOINT).toBeGreaterThanOrEqual(Math.ceil(climbWaypoints))
    // - and the wide/tight split must actually split: the refund keeps wide
    //   episodes strictly shorter, and the shallow-apex gate strictly inside
    //   the overview band (a gate at/above the band top widens every
    //   episode; at/below the bottom, none).
    expect(OVERVIEW_WIDE_EPISODE_WAYPOINTS).toBeLessThan(OVERVIEW_EPISODE_WAYPOINTS)
    expect(OVERVIEW_WIDE_APEX_MAX).toBeGreaterThan(OVERVIEW_ALTITUDE_MIN)
    expect(OVERVIEW_WIDE_APEX_MAX).toBeLessThan(OVERVIEW_ALTITUDE_MAX)
  })

  /** Every raw waypoint (walk order) of a long tour, read off the state's leading edge like recordWaypointAltitudes does. */
  function recordWaypoints(seed: number): Vector3[] {
    let tour: DemoTourState = createDemoTour({ seed, placements, entry: ORIGIN_POSE })
    const waypoints: Vector3[] = []
    let lastKey = ''
    const record = () => {
      if (tour.kind !== 'canyon') return
      const key = `${tour.headCoord.i},${tour.headCoord.j}`
      if (key !== lastKey) {
        lastKey = key
        waypoints.push(tour.rawTail.clone())
      }
    }
    record()
    for (let i = 0; i < 3400; i++) {
      tour = stepDemoTour(tour, 0.15, placements)
      record()
    }
    return waypoints
  }

  const onLattice = (v: number, lines: readonly number[]) =>
    lines.some((line) => Math.abs(v - line) < 1e-9)
  /** Whether a lattice-line position pair is a straight (single-axis) perimeter node — the only widenable kind. */
  const isSingleAxisBoundary = (w: Vector3) => {
    const boundaryX =
      Math.abs(w.x - graph.xs[0]) < 1e-9 || Math.abs(w.x - graph.xs[graph.xs.length - 1]) < 1e-9
    const boundaryZ =
      Math.abs(w.z - graph.zs[0]) < 1e-9 || Math.abs(w.z - graph.zs[graph.zs.length - 1]) < 1e-9
    return boundaryX !== boundaryZ
  }

  /** Complete overview episodes of a recorded walk: runs of identical above-roofline altitude, first/last run dropped (may be truncated by the recording window). */
  function episodeRuns(waypoints: Vector3[]): Vector3[][] {
    const runs: Vector3[][] = []
    for (const w of waypoints) {
      const last = runs[runs.length - 1]
      if (last && Math.abs(last[0].y - w.y) < 1e-12) last.push(w)
      else runs.push([w])
    }
    return runs.slice(1, -1).filter((run) => run[0].y > TOWER_HEIGHT)
  }

  it('widens per episode: every wide-phase waypoint that lands on a straight perimeter node is widened — by exactly the offset, on one axis, at shallow apexes only', () => {
    let widened = 0
    let firingEpisodes = 0
    let wideEpisodes = 0
    for (const seed of seeds) {
      for (const run of episodeRuns(recordWaypoints(seed))) {
        const shallow = run[0].y <= OVERVIEW_WIDE_APEX_MAX
        if (!shallow) continue
        wideEpisodes++
        let episodeWidened = 0
        run.forEach((w, index) => {
          const offLattice = !onLattice(w.x, graph.xs) || !onLattice(w.z, graph.zs)
          const inWidePhase =
            index >= OVERVIEW_WIDE_START_WAYPOINT && index < OVERVIEW_WIDE_EPISODE_WAYPOINTS - 1
          if (!inWidePhase) {
            // Lead-in (climb) and final (descent hand-back) waypoints are
            // never widened — the route leaves and rejoins the tight ring
            // exactly where the phase boundaries say.
            expect(offLattice).toBe(false)
            return
          }
          if (offLattice) {
            episodeWidened++
            // Exactly one axis beyond its ring line, by exactly the wide
            // offset (the lattice knows no other off-ring position)…
            const outX = w.x < graph.xs[0] - 1e-9 || w.x > graph.xs[graph.xs.length - 1] + 1e-9
            const outZ = w.z < graph.zs[0] - 1e-9 || w.z > graph.zs[graph.zs.length - 1] + 1e-9
            expect(outX !== outZ).toBe(true)
            const overshoot = outX
              ? Math.min(Math.abs(w.x - graph.xs[0]), Math.abs(w.x - graph.xs[graph.xs.length - 1]))
              : Math.min(Math.abs(w.z - graph.zs[0]), Math.abs(w.z - graph.zs[graph.zs.length - 1]))
            expect(overshoot).toBeCloseTo(OVERVIEW_PERIMETER_EXTRA, 9)
          } else {
            // A wide-phase waypoint still on the lattice must be one the
            // widening legitimately skips (an interior or ring-corner node)
            // — an unwidened *straight perimeter* node here would mean the
            // feature silently degraded (the regression this per-episode
            // assertion exists to catch, where a bare `widened > 0` cannot).
            expect(isSingleAxisBoundary(w)).toBe(false)
          }
        })
        // The wide phase is never longer than its two waypoints.
        expect(episodeWidened).toBeLessThanOrEqual(
          OVERVIEW_WIDE_EPISODE_WAYPOINTS - 1 - OVERVIEW_WIDE_START_WAYPOINT,
        )
        if (episodeWidened > 0) firingEpisodes++
        widened += episodeWidened
      }
    }
    // Sanity checks on the test itself, calibrated on this ring-dominant
    // grid (observed: 35 complete shallow episodes across these seeds, 27
    // of them firing, 32 widened waypoints — 5 of them consecutive
    // two-waypoint stretches): the walks must contain many wide episodes, at
    // least half must actually fire, and consecutive widened stretches must
    // occur (widened > firing).
    expect(wideEpisodes).toBeGreaterThanOrEqual(20)
    expect(firingEpisodes * 2).toBeGreaterThanOrEqual(wideEpisodes)
    expect(widened).toBeGreaterThan(firingEpisodes)
  })

  it('never widens deep-apex overview waypoints (deep episodes stay on the tight ring)', () => {
    let deepOverview = 0
    for (const seed of seeds) {
      for (const run of episodeRuns(recordWaypoints(seed))) {
        if (run[0].y <= OVERVIEW_WIDE_APEX_MAX) continue
        for (const w of run) {
          deepOverview++
          expect(onLattice(w.x, graph.xs)).toBe(true)
          expect(onLattice(w.z, graph.zs)).toBe(true)
        }
      }
    }
    expect(deepOverview).toBeGreaterThan(0)
  })
})

/**
 * The forcing-function invariant for #91's climb-out aim fix: the camera is
 * the pilot's eye — even while climbing it looks ahead and *down* into the
 * canyon and at the Towers, never up into the empty black sky. Before this
 * pass the forward aim could sit up to half a Tower *above* the roofline
 * (`LOOKAT_FORWARD_ALTITUDE_CAP`), and on a climb-out the steep raw spline
 * tangent pitched it there for a second or more (~32% of climb-out frames
 * read as dark sky). The aim is now projected along the *flyable* (glide-
 * slope-clamped) pitch and pinned below the roofline (LOOKAT_AIM_CEILING),
 * so every frame keeps Tower structure in front of the camera.
 */
describe('the look-at never aims above the roofline (#91 climb-out aim invariant)', () => {
  const placements = grid(5, 5)
  const seeds = [42424242, 1, 7, 13, 55]

  it.each(seeds)(
    'seed %i: every sampled aim stays below the roofline, and pitches below the camera once over the rooftops',
    (seed) => {
      let tour: DemoTourState = createDemoTour({ seed, placements, entry: ORIGIN_POSE })
      let sawOverRooftops = false

      for (let i = 0; i < 1200; i++) {
        tour = stepDemoTour(tour, 0.1, placements)
        const pose = sampleDemoTourPose(tour)

        // The aim's ceiling: the forward point is pinned at LOOKAT_AIM_CEILING
        // (below the roofline) and the partial Tower pull can only lift it
        // toward the roofline point itself — never past it. (Glances rotate
        // the target around the vertical axis, so they can't raise it either.)
        expect(pose.target[1]).toBeLessThanOrEqual(TOWER_HEIGHT + 1e-9)

        // And once the camera is above the rooftops, the pilot's eye is
        // looking *down* at them, not level into the sky at its own altitude.
        if (pose.position[1] > TOWER_HEIGHT) {
          sawOverRooftops = true
          expect(pose.target[1]).toBeLessThan(pose.position[1])
        }
      }

      // Sanity check on the test itself: the run must actually have exercised
      // the over-the-rooftops regime (paced episodes guarantee several).
      expect(sawOverRooftops).toBe(true)
    },
  )

  it('the aim ceiling itself sits below the roofline (the invariant above is geometric, not incidental)', () => {
    expect(LOOKAT_AIM_CEILING).toBeLessThan(TOWER_HEIGHT)
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
      // entirely (the bug, `strength === 0`). It must not: the vertical
      // clearance term must engage at all, however modestly. (The required
      // magnitude was lowered by #91's climb-rate tuning pass, which also
      // lowered OVERVIEW_ALTITUDE_MAX itself — closer to the roofline, so
      // there's simply less vertical clearance for this term to react to
      // than the old, much taller band gave it. `nearestTowerPull` and its
      // clearance thresholds were deliberately left untouched by that pass;
      // this is that same, unchanged formula evaluated at a new altitude.)
      expect(pull.strength).toBeGreaterThan(LOOKAT_TOWER_PULL_MAX * 0.02)
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

      const target = demandDrivenLookAt(position, tangent, pull.strength, pull.point, NO_GLANCE)

      // A level forward look-ahead alone (the pre-fix behaviour) sits at the
      // camera's own altitude. The fix must pull the target's Y meaningfully
      // below the camera's — tilting the aim down toward the skyline. (#91's
      // feel pass strengthened this further: the forward aim itself is now
      // clamped below the roofline by LOOKAT_AIM_CEILING — the pilot's eye
      // looks ahead and down at the Towers during an overview pass, never at
      // open sky — so the tilt here is now guaranteed by the aim window, with
      // the demand-driven pull refining it.)
      expect(target.y).toBeLessThan(position.y - TOWER_HEIGHT * 0.05)
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

      const target = demandDrivenLookAt(position, tangent, pull.strength, pull.point, NO_GLANCE)

      expect(target.y).toBeCloseTo(position.y, 5)
    })
  })

  it('integration: over a long tour, deep-overview samples keep looking toward the Towers, not into the void', () => {
    // The pull ramps in smoothly with altitude above the roofline (the
    // motion-sickness guardrail — no snap right at the roofline), so this
    // only asserts the "close to a Tower, not the void" outcome once a
    // sample is well into the overview band, not at its very edge where a
    // mild tilt is the intended, correct behaviour.
    //
    // This checks the real geometric invariant — clearance from the look-at
    // target to the nearest Tower's bounding volume (the same measurement
    // the #91 forcing-function invariant below uses) — rather than a bare
    // "target.y meaningfully below position.y" heuristic. (Since #91's feel
    // pass the aim is additionally pinned below the roofline by
    // LOOKAT_AIM_CEILING — that stronger per-frame property has its own
    // dedicated invariant test below; this one stays focused on the original
    // clearance regression.)
    const deepOverviewY = (OVERVIEW_ALTITUDE_MIN + OVERVIEW_ALTITUDE_MAX) / 2
    const VOID_CLEARANCE_THRESHOLD = TOWER_SPACING * 2
    let tour: DemoTourState = createDemoTour({ seed: 99, placements, entry: ORIGIN_POSE })
    let sawDeepOverview = false

    // 240 simulated seconds: episode apexes are jittered across the whole
    // overview band, so several paced episodes are needed before one lands
    // deep enough for the assertion window to be exercised.
    for (let i = 0; i < 1600; i++) {
      tour = stepDemoTour(tour, 0.15, placements)
      const pose = sampleDemoTourPose(tour)
      const [, positionY] = pose.position
      if (positionY > deepOverviewY) {
        sawDeepOverview = true
        expect(clearanceToNearestTower(pose.target, placements)).toBeLessThan(
          VOID_CLEARANCE_THRESHOLD,
        )
      }
    }

    // A seed run this long should hit at least one overview episode with an
    // apex deep enough into the band (episodes are paced — guaranteed within
    // every OVERVIEW_GAP_WAYPOINTS_MAX + OVERVIEW_EPISODE_WAYPOINTS stretch —
    // and the apex is jittered across the whole band) — otherwise this test
    // isn't actually exercising the regression.
    expect(sawDeepOverview).toBe(true)
  })
})

/**
 * The forcing-function test for #91's root-cause fix: a renderer-free
 * invariant, checked densely across several full seeded tours, that no
 * sampled look-at target ever aims into the void — the property both bug
 * flavours (the original horizontal-only "aims at empty sky" bug, and the
 * climb/dive transition bug this changeset fixes) violated. This does not
 * reuse {@link nearestTowerPull}'s internal clearance math — it's a
 * deliberately independent re-implementation of "distance from a point to the
 * nearest Tower's bounding volume", so a bug in the production clearance
 * calculation itself wouldn't slip through as a tautology.
 *
 * `VOID_CLEARANCE_THRESHOLD` is derived from the scene geometry: two Tower
 * spacings (`TOWER_SPACING * 2` = 8 world units). That's small relative to
 * the Canyon graph's full extent (a 5x5 grid plus the perimeter ring spans
 * several times that), but generous enough to allow the intentional partial
 * blend (`LOOKAT_TOWER_PULL_MAX` = 0.6, not 1.0 — the look-at is allowed to
 * sit partway between the forward point and the nearest Tower, not snap fully
 * onto it) during a legitimate deep-overview pass or a wide turn. It is not a
 * loosened-to-pass number: a version of this same measurement run against the
 * pre-fix code (this changeset's HEAD~1) put ~9% of sampled frames, across
 * every seed tried, above this exact threshold (max observed clearance ~10.6,
 * consistently, vs. this fix's observed max of ~6.8 across the same seeds and
 * duration) — i.e. this threshold is comfortably below what the known-broken
 * behaviour produces and comfortably above what the fixed behaviour produces.
 * (Re-calibrated unchanged after #91's climb-choreography feel pass: observed
 * max 6.6–6.9 across these seeds with the sustained-episode altitude program
 * and the roofline-capped aim.)
 */
describe('the demand-driven look-at never aims into the void (#91 forcing-function invariant)', () => {
  const placements = grid(5, 5)
  const VOID_CLEARANCE_THRESHOLD = TOWER_SPACING * 2

  // Several seeds, including the one explicitly called out for coverage.
  // Each is driven for a long, densely-sampled run — several full tours'
  // worth of segments (canyon hops and overview hops both), not just a few
  // seconds — so the invariant is checked across every regime the tour
  // visits: canyon-forward, flat overview, and the climb/dive transitions
  // between them.
  const seeds = [42424242, 1, 7, 13, 55]
  const SAMPLE_INTERVAL_SECONDS = 0.25
  const TOUR_DURATION_SECONDS = 150 // several dozen segments per seed

  it.each(seeds)(
    'seed %i: every sampled pose looks at/near a Tower, never into the void',
    (seed) => {
      let tour: DemoTourState = createDemoTour({ seed, placements, entry: ORIGIN_POSE })
      const steps = Math.round(TOUR_DURATION_SECONDS / SAMPLE_INTERVAL_SECONDS)
      let maxClearanceSeen = 0

      for (let i = 0; i < steps; i++) {
        tour = stepDemoTour(tour, SAMPLE_INTERVAL_SECONDS, placements)
        const pose = sampleDemoTourPose(tour)
        const clearance = clearanceToNearestTower(pose.target, placements)
        maxClearanceSeen = Math.max(maxClearanceSeen, clearance)

        expect(clearance).toBeLessThan(VOID_CLEARANCE_THRESHOLD)
      }

      // Sanity check on the test itself: a run this long, over a 5x5 grid with
      // OVERVIEW_PROBABILITY=0.15, should have exercised a real mix of canyon
      // and overview altitude (i.e. this isn't accidentally a no-op check that
      // never got near the danger zone in the first place).
      expect(maxClearanceSeen).toBeGreaterThan(0)
    },
  )
})

describe('the orbit-and-bob fallback', () => {
  it('stays close to its centre and keeps moving, for an empty scene', () => {
    let tour: DemoTourState = createDemoTour({ seed: 4, placements: [], entry: ORIGIN_POSE })
    const start = sampleDemoTourPose(tour).position
    let maxDistanceFromOrigin = 0

    for (let i = 0; i < 100; i++) {
      tour = stepDemoTour(tour, 0.1, [])
      const position = sampleDemoTourPose(tour).position
      maxDistanceFromOrigin = Math.max(maxDistanceFromOrigin, Math.hypot(position[0], position[2]))
    }
    const later = sampleDemoTourPose(tour).position

    expect(distance(start, later)).toBeGreaterThan(0.1)
    expect(maxDistanceFromOrigin).toBeLessThan(TOWER_SPACING * 5)
  })

  it('never banks past DEMO_BANK_MAX', () => {
    let tour: DemoTourState = createDemoTour({ seed: 4, placements: [], entry: ORIGIN_POSE })
    for (let i = 0; i < 50; i++) {
      tour = stepDemoTour(tour, 0.1, [])
      expect(Math.abs(sampleDemoTourPose(tour).roll)).toBeLessThanOrEqual(DEMO_BANK_MAX + 1e-9)
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

/**
 * #59 lets every Tower in a busy scene render at a SINGLE uniform height
 * taller than the resting TOWER_HEIGHT (panelLayout.ts's sceneTowerHeight).
 * Before this describe block's fix, every one of Demo Mode's altitude
 * thresholds (the overview band, the aim ceiling, the Tower-box clearance)
 * stayed pinned to the resting height regardless — a grown scene's "over the
 * rooftops" overview pass could fly BELOW the real roofline, and the
 * nearest-Tower pull measured clearance against a shorter box than the one
 * actually rendered. These tests exercise a scene grown well past the
 * resting height and assert the tour's altitude program tracks the ACTUAL
 * roofline derived from the real Tower placements (ADR-0010's "no magic
 * numbers" property), not the fixed constant.
 */
describe('altitude bands scale with the scene-wide Tower height (#59)', () => {
  // Double the resting height — comfortably past what any pre-#59 fixed
  // constant would clear.
  const GROWN_HEIGHT = TOWER_HEIGHT * 2
  const restingPlacements = grid(5, 5)
  const grownTowers: Tower[] = []
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      grownTowers.push(makeTower({ name: `t-${col}-${row}`, grid: { col, row } }))
    }
  }
  const grownPlacements = towerPlacements(grownTowers, GROWN_HEIGHT)

  it("derives the tour's roofline from the real (grown) Tower placements, not the resting TOWER_HEIGHT", () => {
    const tour = createDemoTour({ seed: 1, placements: grownPlacements, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')
    if (tour.kind !== 'canyon') return
    expect(tour.bands.rooflineY).toBe(GROWN_HEIGHT)
    // Every band keeps the exact same fraction of the roofline the
    // resting-height constant was tuned at.
    const factor = GROWN_HEIGHT / TOWER_HEIGHT
    expect(tour.bands.overviewMin).toBeCloseTo(OVERVIEW_ALTITUDE_MIN * factor)
    expect(tour.bands.overviewMax).toBeCloseTo(OVERVIEW_ALTITUDE_MAX * factor)
    expect(tour.bands.canyonMin).toBeCloseTo(CANYON_ALTITUDE_MIN * factor)
    expect(tour.bands.canyonMax).toBeCloseTo(CANYON_ALTITUDE_MAX * factor)
    expect(tour.bands.aimCeiling).toBeCloseTo(LOOKAT_AIM_CEILING * factor)
  })

  it('is byte-identical to the resting-height bands for a scene that never grows — every pre-#59 test stays valid', () => {
    const tour = createDemoTour({ seed: 1, placements: restingPlacements, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')
    if (tour.kind !== 'canyon') return
    expect(tour.bands.rooflineY).toBe(TOWER_HEIGHT)
    expect(tour.bands.overviewMin).toBe(OVERVIEW_ALTITUDE_MIN)
    expect(tour.bands.overviewMax).toBe(OVERVIEW_ALTITUDE_MAX)
    expect(tour.bands.canyonMin).toBe(CANYON_ALTITUDE_MIN)
    expect(tour.bands.canyonMax).toBe(CANYON_ALTITUDE_MAX)
    expect(tour.bands.aimCeiling).toBe(LOOKAT_AIM_CEILING)
  })

  it('reaches overview altitudes that clear the ACTUAL grown roofline — the showcase-camera-clips-through-Towers regression this closes', () => {
    const tour = createDemoTour({ seed: 42424242, placements: grownPlacements, entry: ORIGIN_POSE })
    const waypointAltitudes = recordWaypointAltitudes(tour, grownPlacements, 3400)
    const overviewAltitudes = waypointAltitudes.filter((y) => y > GROWN_HEIGHT)

    // A long walk over paced episodes must reach at least one overview apex
    // that genuinely clears the grown roofline…
    expect(overviewAltitudes.length).toBeGreaterThan(0)
    // …and every one lands inside the GROWN overview band. The resting-height
    // band (1.1x-1.6x TOWER_HEIGHT) sits entirely BELOW GROWN_HEIGHT here, so
    // this could only pass if the bands actually scaled with the real Tower
    // height rather than staying pinned to the old constant.
    for (const y of overviewAltitudes) {
      expect(y).toBeGreaterThanOrEqual(GROWN_HEIGHT * 1.1 - 1e-6)
      expect(y).toBeLessThanOrEqual(GROWN_HEIGHT * 1.6 + 1e-6)
    }
  })

  it('measures the nearest-Tower pull’s clearance against the grown roofline, not the resting one', () => {
    const tour = createDemoTour({ seed: 1, placements: grownPlacements, entry: ORIGIN_POSE })
    expect(tour.kind).toBe('canyon')
    if (tour.kind !== 'canyon') return

    // A point ON the GROWN Tower's actual roofline — genuinely at its
    // surface, so the real clearance is ~0 (nearestTowerPull's strength stays
    // ≈0 exactly when a Tower already fills the aim point — see its doc
    // comment). Well above the RESTING roofline, though: the pre-#59 fixed
    // box would have read this same point as already well clear of the
    // (wrongly shorter) Tower.
    const [towerX, , towerZ] = grownPlacements[0].position
    const point = new Vector3(towerX, GROWN_HEIGHT, towerZ)

    const grownPull = nearestTowerPull(point, grownPlacements, tour.bands)
    // Default bands (resting roofline) — the pre-#59 behaviour every caller
    // that doesn't pass bands still gets, and what this fix moves callers off.
    const restingBandsPull = nearestTowerPull(point, grownPlacements)

    // Against the real, grown roofline the point sits right at the surface
    // (clearance ≈ 0 → strength ≈ 0); measured against the wrong, shorter
    // resting box the same point reads as clear above the (assumed) roof, so
    // clearance — and the pull strength it drives — is spuriously large. That
    // gap between "actually at the Tower" and "reads as clear of it" is
    // exactly the clipping-risk #59 opened.
    expect(grownPull.strength).toBeCloseTo(0, 6)
    expect(restingBandsPull.strength).toBeGreaterThan(grownPull.strength)
  })

  it('scales the single-Tower orbit fallback altitude to that Tower’s own grown height too', () => {
    const [lone] = towerPlacements(
      [makeTower({ name: 'solo', grid: { col: 0, row: 0 } })],
      GROWN_HEIGHT,
    )
    const tour = createDemoTour({ seed: 1, placements: [lone], entry: ORIGIN_POSE })
    expect(tour.kind).toBe('orbit')

    const pose = sampleDemoTourPose(tour)
    // The orbit perches above the Tower's own (grown) centre, scaling with
    // it — not a fixed offset tuned only for the resting height.
    expect(pose.position[1]).toBeGreaterThan(GROWN_HEIGHT * 0.9)
  })

  it('picks up a scene that grows mid-flight: the very next stepDemoTour call reflects the new placements', () => {
    let tour: DemoTourState = createDemoTour({
      seed: 1,
      placements: restingPlacements,
      entry: ORIGIN_POSE,
    })
    expect(tour.kind === 'canyon' && tour.bands.rooflineY).toBe(TOWER_HEIGHT)

    tour = stepDemoTour(tour, 0.1, grownPlacements)

    expect(tour.kind === 'canyon' && tour.bands.rooflineY).toBe(GROWN_HEIGHT)
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

describe('stepBoundedFollower (#117 items 1 and 5)', () => {
  // #117 item 1, round 2. Round 1's test claimed to demonstrate a moving
  // target "overshooting" an unclamped follower — review caught that the
  // scenario (a target only ever *falling*, 6 down to -6, then held) only
  // measures the follower *lagging behind* a target moving faster than its
  // own maxRate: `value` never actually drops below `target` at any point
  // (instrumented: min(value - target) = 0.000 across the whole run). That
  // is not overshoot.
  //
  // Re-derived from the follower math instead of searching for a scenario:
  // reaching this follower's maxRate via any state its *own* continuous
  // dynamics could produce (never an externally reset rate) requires a
  // spin-up/tracking lag of at least maxRate² / (2 × maxAccel) between
  // value and target — which upper-bounds how close the two can be while
  // carrying near-maximum rate. A ~1.9M-trial random search over
  // piecewise-linear target trajectories (2-15 segments, rates to
  // ±1200/s, always respecting a positive floor, follower seeded
  // consistently with the target's own start — i.e. only physically
  // reachable states) found no counterexample: undershoot stayed at noise
  // level (≤ 0.008) in every trial. See VIEW_DISTANCE_FOLLOWER's doc
  // comment for the full derivation. This investigation did **not**
  // establish that the follower can undershoot a strictly positive demand
  // reachable in production — the opposite of round 1's claim.
  //
  // What the tests below establish instead, and it is real: the *clamp
  // mechanism itself* is correct — exact, one-sided, and inert on the
  // untouched side — so it is a free, correct defence against the
  // catastrophic failure mode (a negative view distance flips the rendered
  // yaw by π) if some future change ever does reach it, even though this
  // investigation found no such path today.

  it("the clamp holds a strictly positive floor exactly, even from the follower's own worst-case rate — and an unclamped follower genuinely breaches it from that same state", () => {
    // The tightest state the follower's own dynamics can produce close to a
    // target (see the derivation above): value at the target, carrying rate
    // = -maxRate. Explicitly *not* claimed to be reachable by continuous
    // motion against a positive-floor-respecting target (the search above
    // found no path to it) — constructed directly as the single worst
    // starting condition for testing the clamp mechanism itself, which must
    // hold regardless of how that state was reached.
    const floor = 2
    const worstCaseValue = floor + 0.05
    const worstCaseRate = -VIEW_DISTANCE_FOLLOWER.maxRate
    const target = (t: number) => worstCaseValue + 40 * t // recedes upward, away from the floor

    function run(clampMin?: number): number {
      let value = worstCaseValue
      let rate = worstCaseRate
      let min = value
      const dt = 1 / 60
      for (let i = 0; i < 30; i++) {
        const t = (i + 1) * dt
        const result = stepBoundedFollower(value, rate, target(t), dt, {
          ...VIEW_DISTANCE_FOLLOWER,
          clamp: clampMin === undefined ? undefined : { min: clampMin },
        })
        value = result.value
        rate = result.rate
        min = Math.min(min, value)
      }
      return min
    }

    // Unclamped: genuinely breaches the floor from this state (not merely
    // lags behind a still-falling target, as round 1's flawed test did).
    expect(run(undefined)).toBeLessThan(floor - 1)
    // Clamped at the real floor: holds exactly.
    expect(run(floor)).toBe(floor)
  })

  it('a one-sided clamp (min only) never touches the untouched side', () => {
    // The old clampMin/clampMax shape (#117 item 5) applied independently, so
    // this always worked — but the fold into one `clamp: {min?, max?}` object
    // must keep it working: a min-only clamp must not accidentally cap the
    // value from above too.
    const result = stepBoundedFollower(2, 0, 1000, 10, {
      ...VIEW_DISTANCE_FOLLOWER,
      clamp: { min: 0 },
    })
    expect(result.value).toBeGreaterThan(50)
  })

  it("a two-sided clamp (roll's shape) holds both bounds", () => {
    const limits = { ...VIEW_DISTANCE_FOLLOWER, clamp: { min: -1, max: 1 } }
    const high = stepBoundedFollower(0, 0, 1000, 10, limits)
    expect(high.value).toBeLessThanOrEqual(1)
    const low = stepBoundedFollower(0, 0, -1000, 10, limits)
    expect(low.value).toBeGreaterThanOrEqual(-1)
  })

  it('the angular flag (folded from the old positional argument, #117 item 5) still takes the shortest arc', () => {
    // From just past +π chasing a target just past -π: the shortest arc is
    // the short way across the wrap, not the long way straight through 0.
    const result = stepBoundedFollower(Math.PI - 0.1, 0, -Math.PI + 0.1, 1 / 60, {
      maxRate: 100,
      maxAccel: 1000,
      responseTime: 0.05,
      angular: true,
    })
    // Wrapped toward +π (increasing), not swung all the way down toward 0.
    expect(result.value).toBeGreaterThan(Math.PI - 0.1)
  })
})
