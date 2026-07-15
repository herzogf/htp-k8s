import { CatmullRomCurve3, Vector3 } from 'three'
import {
  easeInOutCubic,
  FOCUS_DURATION_SECONDS,
  focusLookAngles,
  samplePose,
  type Pose,
} from './focus'
import { TOWER_HEIGHT, TOWER_SPACING, type TowerPlacement } from './towerLayout'

/**
 * The pure, WebGL-free core of Demo Mode (#22, redesigned by #91): an endless,
 * non-repeating cinematic camera flight that weaves *among and through* the
 * Towers — CONTEXT.md's Demo Mode, "like a small plane navigating between
 * skyscrapers" — for unattended/showcase viewing. Everything here is a plain
 * function of explicit state (never a hidden clock or `Math.random`), so it's
 * unit-tested without a renderer; the live per-frame integration onto the real
 * camera — and the on/off hand-off to/from free-fly (#20) — lives in
 * {@link FreeFlyControls}.
 *
 * ADR-0010 records the architectural pivot this module embodies: the route is
 * no longer a closed-loop pure function of one elapsed-seconds clock (that
 * structurally cannot avoid repeating on an hours-long unattended display).
 * Instead it's a **seeded, stateful random walk over the Canyon graph** — the
 * air corridors between grid-adjacent Towers, plus a one-lane perimeter ring
 * (CONTEXT.md's Canyon, distinct from the ground Floor Lane) — threaded by a
 * Catmull-Rom spline for continuity. The walk is a deterministic function of
 * `(seed, Tower placements, entry pose)` — {@link createDemoTour} — advanced
 * one frame at a time by {@link stepDemoTour}, mirroring the `state + delta ->
 * next state` shape {@link stepRollRecovery} already established in this file,
 * rather than the old single `demoPose(t)`. {@link sampleDemoTourPose} reads
 * the camera pose off a {@link DemoTourState} at any instant.
 */

/**
 * A DemoPose is a Focus {@link Pose} (eye position + look-at target) plus a
 * bank/roll angle in radians around the camera's forward axis — the one
 * degree of freedom Demo Mode needs that free-fly/Focus don't, since neither
 * of those ever rolls the camera.
 */
export interface DemoPose extends Pose {
  /** Bank/roll around the camera's forward axis, in radians. */
  roll: number
}

/**
 * DEMO_TRANSITION_SECONDS is how long both hand-offs take: easing onto the
 * flight path when Demo Mode switches on, and easing the bank back to level
 * when it switches off. Reuses {@link FOCUS_DURATION_SECONDS} — the same
 * "how long does a camera transition take to feel smooth, not sluggish"
 * tuning click-to-Focus (#21) already established, rather than inventing a
 * second magic number for the same kind of thing.
 */
export const DEMO_TRANSITION_SECONDS = FOCUS_DURATION_SECONDS

/**
 * DEMO_BANK_MAX caps how far Demo Mode ever banks the camera: a clearly
 * visible tilt into its turns, without ever rolling past a natural-looking
 * angle.
 */
export const DEMO_BANK_MAX = Math.PI / 6

// ---------------------------------------------------------------------------
// Tuning constants (#91). All of these are deliberately named/exported rather
// than inlined: the design is settled (ADR-0010), but the exact feel is not —
// they're dialled in against recorded e2e video and the exploratory local run
// (#90), not guessed blind. See each constant's doc comment for what it shapes.
// ---------------------------------------------------------------------------

/**
 * PERIMETER_OFFSET is how far outside the outermost Tower columns/rows the
 * perimeter ring canyon sits (world units). Too small reads as *einengend*
 * (cramped, clipping the outer Towers on every perimeter pass); too large
 * drifts back toward the old "orbiting wide in empty space" feel. Explicitly
 * flagged in #91 as needing visual tuning.
 */
export const PERIMETER_OFFSET = TOWER_SPACING * 1.5

/**
 * World-space Y of a Tower's roofline (its prism top) — `TOWER_HEIGHT`, since
 * a Tower's centre sits at `TOWER_HEIGHT / 2` (towerLayout.ts) resting on the
 * floor at y = 0. The one fixed reference the altitude program and the
 * look-at's vertical pull ({@link nearestTowerPull}) are both measured
 * against.
 */
const TOWER_ROOFLINE_Y = TOWER_HEIGHT

/** The canyon-low altitude band (world Y), mostly below the Tower roofline. */
export const CANYON_ALTITUDE_MIN = TOWER_HEIGHT * 0.15
export const CANYON_ALTITUDE_MAX = TOWER_HEIGHT * 0.75

/** The "over the rooftops" overview altitude band (world Y), above the Towers. */
export const OVERVIEW_ALTITUDE_MIN = TOWER_HEIGHT * 1.5
export const OVERVIEW_ALTITUDE_MAX = TOWER_HEIGHT * 2.4

/**
 * OVERVIEW_PROBABILITY is the chance each newly drawn waypoint is assigned an
 * overview (rather than canyon-low) altitude. Altitude is a per-waypoint draw
 * fully decoupled from the horizontal walk (ADR-0010's "overview is delivered
 * by altitude, not horizontal distance") — this is the canyon-vs-overview
 * ratio the design calls out for tuning.
 */
export const OVERVIEW_PROBABILITY = 0.15

/** CANYON_TRAVEL_SPEED is the flight's speed along the spline, world units/second. */
export const CANYON_TRAVEL_SPEED = TOWER_SPACING * 1.1

/**
 * MIN_SEGMENT_SECONDS floors how short a spline segment's travel time can be,
 * so two waypoints landing unusually close together (a short perimeter hop
 * near a corner) never collapses toward a near-zero-duration segment and a
 * visible speed-up.
 */
const MIN_SEGMENT_SECONDS = 0.4

/**
 * Random-walk edge weights (unnormalized) for {@link pickNextMove}: prefer
 * continuing straight (momentum ⇒ smooth arcs) over turning, and add a bonus
 * toward the interior when standing on the graph's outer boundary (the
 * perimeter ring, or the outermost interior line) so the tour doesn't loop the
 * edge forever — "pull back toward the cluster near an edge" (ADR-0010).
 * Immediate backtracking is filtered out entirely before weighting (see
 * {@link candidateMoves}), not merely down-weighted.
 */
const STRAIGHT_WEIGHT = 5
const TURN_WEIGHT = 2
const EDGE_PULL_BONUS = 4

/**
 * Seeded "glances" (ADR-0010/#91): occasionally, for one whole spline segment,
 * the look-at target eases away from forward by up to {@link GLANCE_MAX_ANGLE}
 * and back — a beat of looking at a passing Tower or down a cross-canyon — then
 * returns to forward. GLANCE_PROBABILITY is the per-segment chance one starts;
 * kept low and the excursion kept small/slow as the motion-sickness guardrail
 * an hours-long unattended display requires (no snappy yaw, ever).
 */
const GLANCE_PROBABILITY = 0.2
export const GLANCE_MAX_ANGLE = Math.PI / 10
const GLANCE_DURATION_SECONDS = 3.5

/** How far ahead along the path's tangent the forward look-at point sits. */
const LOOKAT_LOOKAHEAD_DISTANCE = TOWER_SPACING * 2

/**
 * The demand-driven look-at blend (ADR-0010): inside a canyon, Towers already
 * flank the frame, so the pull toward the nearest one should contribute ≈0;
 * it should only ramp up when Towers would otherwise leave frame (an overview
 * hop, a turn into open space, the cluster edge). Modelled as a smoothstep of
 * the nearest Tower's horizontal distance between the two clearances below,
 * capped at {@link LOOKAT_TOWER_PULL_MAX}, and only allowed to *change* at
 * {@link LOOKAT_BLEND_RATE} per second so the aim ramps rather than snaps.
 */
export const LOOKAT_TOWER_PULL_MAX = 0.6
const LOOKAT_NEAR_CLEARANCE = TOWER_SPACING * 0.6
const LOOKAT_FAR_CLEARANCE = TOWER_SPACING * 3
const LOOKAT_BLEND_RATE = 0.8

/**
 * The vertical counterpart to {@link LOOKAT_NEAR_CLEARANCE}/{@link
 * LOOKAT_FAR_CLEARANCE}: how far above the Tower roofline ({@link
 * TOWER_ROOFLINE_Y}) the camera must climb before the look-at pull toward the
 * nearest Tower engages/fully engages, *regardless* of horizontal distance.
 * Overview passes fly directly above the cluster, where the horizontal test
 * alone reads as "already framed" — this is what actually tilts an overview
 * pass down to keep the skyline in frame instead of aiming into empty sky (see
 * {@link nearestTowerPull}). `NEAR` sits at the bottom of the overview
 * altitude band so the pull starts easing in the moment a waypoint lifts
 * above canyon altitude; `FAR` sits below the top of the band so the pull is
 * essentially maxed out for the highest overview passes.
 */
const LOOKAT_OVERVIEW_NEAR_CLEARANCE = TOWER_HEIGHT * 0.3
const LOOKAT_OVERVIEW_FAR_CLEARANCE = TOWER_HEIGHT * 1.3

/**
 * A hard ceiling on the forward look-ahead point's own altitude (#91
 * follow-up), applied unconditionally rather than blended: a steep climb
 * toward an overview waypoint can point the spline tangent steeply upward,
 * shooting the look-ahead point far above the camera *before* {@link
 * LOOKAT_BLEND_RATE}'s eased pull has had time to catch up — the "aims at the
 * void" bug via a different path than the suppressed-pull one {@link
 * nearestTowerPull} fixes. Reacting instantly (rather than waiting on the
 * ease) is what closes that gap; ordinary canyon flying's forward point sits
 * comfortably below this ceiling, so it only ever engages during a climb-out
 * or an overview pass, and never on canyon-altitude passes.
 */
const LOOKAT_FORWARD_ALTITUDE_CAP = TOWER_ROOFLINE_Y + TOWER_HEIGHT * 0.5

/** Catmull-Rom tension for the sliding-window spline (three.js's 'catmullrom' type). */
const CATMULL_ROM_TENSION = 0.5

/**
 * Half-width, in segment-local `t`, of the finite-difference window used to
 * estimate the spline's turn rate for banking (see {@link tourBankAngle}).
 * Small enough to stay local to the current segment even near its ends.
 */
const BANK_SAMPLE_T_EPS = 0.02

/**
 * Scales the path's estimated turn rate into a bank angle (shared by the
 * Canyon tour and the orbit fallback). Tuned so the gentle weave produces a
 * clearly visible, but not extreme, bank.
 */
const DEMO_BANK_GAIN = 1.4

/** Orbit-and-bob fallback tuning (single Tower / empty scene — see {@link createDemoTour}). */
const ORBIT_RADIUS = TOWER_SPACING * 2.2
const ORBIT_ALTITUDE_BASE = TOWER_HEIGHT * 0.9
const ORBIT_BOB_AMPLITUDE = TOWER_HEIGHT * 0.3
const ORBIT_BOB_PERIOD_SECONDS = 14
/** One full revolution every 50 seconds — a slow, steady circle, not a spin. */
const ORBIT_ANGULAR_SPEED = (2 * Math.PI) / 50

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * One step of the mulberry32 PRNG, expressed as a pure `state -> {value,
 * nextState}` function rather than the usual closure-over-a-mutable-variable
 * form, so every draw the Canyon tour makes is just more state threaded
 * through {@link DemoTourState} — deterministic, serializable, and testable
 * without any hidden mutable module state. `value` is uniform in `[0, 1)`.
 */
function mulberry32Step(state: number): { value: number; nextState: number } {
  const nextState = (state + 0x6d2b79f5) | 0
  let t = Math.imul(nextState ^ (nextState >>> 15), nextState | 1)
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return { value, nextState }
}

/** Picks a weighted-random item from `items` (parallel `weights`, all > 0), threading the PRNG state. */
function pickWeighted<T>(
  rngState: number,
  items: readonly T[],
  weights: readonly number[],
): { item: T; nextState: number } {
  const total = weights.reduce((sum, w) => sum + w, 0)
  const { value, nextState } = mulberry32Step(rngState)
  let threshold = value * total
  for (let i = 0; i < items.length; i++) {
    threshold -= weights[i]
    if (threshold <= 0) {
      return { item: items[i], nextState }
    }
  }
  return { item: items[items.length - 1], nextState }
}

// ---------------------------------------------------------------------------
// Canyon graph — the lattice of canyon lines derived from towerPlacements
// ---------------------------------------------------------------------------

/**
 * CanyonGraph is a Manhattan lattice: the sorted world-space X/Z lines every
 * canyon runs along. `xs`/`zs` each hold the *interior* canyon lines (the
 * midpoint between every pair of grid-adjacent Tower columns/rows) plus the
 * two perimeter lines {@link PERIMETER_OFFSET} outside the outermost column/
 * row. A lattice node `(i, j)` — a crossing of one X line and one Z line — is
 * one waypoint candidate; every crossing is reachable (interior canyons run
 * the lattice's full extent, crossing every other canyon, the way Manhattan
 * avenues and streets cross everywhere), so this single structure *is*
 * "interior canyons + perimeter ring + the corners where they meet"
 * (ADR-0010) without needing separate graph types for each.
 */
export interface CanyonGraph {
  readonly xs: number[]
  readonly zs: number[]
}

/** A lattice coordinate into a {@link CanyonGraph}: indices into `xs`/`zs`, not world units. */
interface LatticeCoord {
  readonly i: number
  readonly j: number
}

/** One of the four Manhattan moves a lattice walk can take. */
interface LatticeMove {
  readonly di: number
  readonly dj: number
}

const LATTICE_MOVES: readonly LatticeMove[] = [
  { di: 1, dj: 0 },
  { di: -1, dj: 0 },
  { di: 0, dj: 1 },
  { di: 0, dj: -1 },
]

/**
 * Builds the {@link CanyonGraph} for a Tower arrangement, or `null` for a
 * degenerate arrangement (0 or 1 Towers) where no canyon exists at all — the
 * caller ({@link createDemoTour}) falls back to orbit-and-bob for those. Two
 * Towers or more always yields a walkable graph regardless of their
 * arrangement (a 1×N line included — "no special case", ADR-0010): each axis
 * always contributes its two perimeter lines even with zero interior gaps.
 */
export function buildCanyonGraph(placements: readonly TowerPlacement[]): CanyonGraph | null {
  if (placements.length <= 1) {
    return null
  }
  return {
    xs: canyonLines(uniqueSorted(placements.map((p) => p.position[0]))),
    zs: canyonLines(uniqueSorted(placements.map((p) => p.position[2]))),
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/** One axis's canyon lines: the perimeter pair plus every interior gap midpoint. */
function canyonLines(towerCoords: readonly number[]): number[] {
  const lines = [towerCoords[0] - PERIMETER_OFFSET]
  for (let i = 0; i < towerCoords.length - 1; i++) {
    lines.push((towerCoords[i] + towerCoords[i + 1]) / 2)
  }
  lines.push(towerCoords[towerCoords.length - 1] + PERIMETER_OFFSET)
  return lines
}

function isInBounds(graph: CanyonGraph, i: number, j: number): boolean {
  return i >= 0 && i < graph.xs.length && j >= 0 && j < graph.zs.length
}

function isOpposite(a: LatticeMove, b: LatticeMove): boolean {
  return a.di === -b.di && a.dj === -b.dj
}

/**
 * Whether `move`, taken from `coord`, heads toward the graph's interior — used
 * to bias the walk away from hugging the perimeter forever. A coordinate can
 * be on the boundary along one axis (e.g. the perimeter ring) while free to
 * move either way along the other.
 */
function movesInward(graph: CanyonGraph, coord: LatticeCoord, move: LatticeMove): boolean {
  const lastI = graph.xs.length - 1
  const lastJ = graph.zs.length - 1
  if (coord.i === 0 && move.di === 1) return true
  if (coord.i === lastI && move.di === -1) return true
  if (coord.j === 0 && move.dj === 1) return true
  if (coord.j === lastJ && move.dj === -1) return true
  return false
}

/**
 * The legal next moves from `coord`, given the move that led into it
 * (`null` at the very start of a tour). Immediate backtracking is forbidden
 * outright (ADR-0010) — filtered out, not merely down-weighted — *unless* it
 * is the only legal move at all (a dead end, e.g. the end of a 1×N line
 * cluster), in which case it's the sole candidate rather than a stuck walk.
 */
function candidateMoves(
  graph: CanyonGraph,
  coord: LatticeCoord,
  prevMove: LatticeMove | null,
): LatticeMove[] {
  const inBounds = LATTICE_MOVES.filter((m) => isInBounds(graph, coord.i + m.di, coord.j + m.dj))
  if (!prevMove) {
    return inBounds
  }
  const noBacktrack = inBounds.filter((m) => !isOpposite(m, prevMove))
  return noBacktrack.length > 0 ? noBacktrack : inBounds
}

function moveWeight(
  graph: CanyonGraph,
  coord: LatticeCoord,
  move: LatticeMove,
  prevMove: LatticeMove | null,
): number {
  let weight =
    prevMove && move.di === prevMove.di && move.dj === prevMove.dj ? STRAIGHT_WEIGHT : TURN_WEIGHT
  if (movesInward(graph, coord, move)) {
    weight += EDGE_PULL_BONUS
  }
  return weight
}

/** Weighted-random pick of the next lattice move from `coord`/`prevMove`, threading the PRNG state. */
function pickNextMove(
  graph: CanyonGraph,
  coord: LatticeCoord,
  prevMove: LatticeMove | null,
  rngState: number,
): { move: LatticeMove; nextState: number } {
  const candidates = candidateMoves(graph, coord, prevMove)
  const weights = candidates.map((m) => moveWeight(graph, coord, m, prevMove))
  const picked = pickWeighted(rngState, candidates, weights)
  return { move: picked.item, nextState: picked.nextState }
}

/** The lattice coordinate nearest a world-space `(x, z)` — how a tour enters (see {@link createDemoTour}). */
function nearestLatticeCoord(graph: CanyonGraph, x: number, z: number): LatticeCoord {
  return { i: nearestIndex(graph.xs, x), j: nearestIndex(graph.zs, z) }
}

function nearestIndex(values: readonly number[], target: number): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < values.length; i++) {
    const distance = Math.abs(values[i] - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/** Draws a per-waypoint altitude + overview flag (ADR-0010: decoupled from the horizontal walk). */
function drawAltitude(rngState: number): {
  altitude: number
  isOverview: boolean
  nextState: number
} {
  const overviewRoll = mulberry32Step(rngState)
  const isOverview = overviewRoll.value < OVERVIEW_PROBABILITY
  const jitterRoll = mulberry32Step(overviewRoll.nextState)
  const [min, max] = isOverview
    ? [OVERVIEW_ALTITUDE_MIN, OVERVIEW_ALTITUDE_MAX]
    : [CANYON_ALTITUDE_MIN, CANYON_ALTITUDE_MAX]
  return {
    altitude: min + jitterRoll.value * (max - min),
    isOverview,
    nextState: jitterRoll.nextState,
  }
}

/** One drawn waypoint: its lattice coordinate, resolved world position (with altitude), and overview flag. */
interface DrawnWaypoint {
  coord: LatticeCoord
  position: Vector3
  isOverview: boolean
}

/** Draws the next waypoint from `coord`/`prevMove`: a lattice move plus an independent altitude draw. */
function drawNextWaypoint(
  graph: CanyonGraph,
  coord: LatticeCoord,
  prevMove: LatticeMove | null,
  rngState: number,
): { waypoint: DrawnWaypoint; move: LatticeMove; nextState: number } {
  const picked = pickNextMove(graph, coord, prevMove, rngState)
  const nextCoord: LatticeCoord = { i: coord.i + picked.move.di, j: coord.j + picked.move.dj }
  const altitude = drawAltitude(picked.nextState)
  const position = new Vector3(graph.xs[nextCoord.i], altitude.altitude, graph.zs[nextCoord.j])
  return {
    waypoint: { coord: nextCoord, position, isOverview: altitude.isOverview },
    move: picked.move,
    nextState: altitude.nextState,
  }
}

// ---------------------------------------------------------------------------
// Seeded glances
// ---------------------------------------------------------------------------

/** An in-progress (or idle) seeded glance — see {@link GLANCE_PROBABILITY}'s doc comment. */
interface GlanceState {
  active: boolean
  elapsed: number
  durationSeconds: number
  /** Signed yaw offset (radians) the glance eases toward and back from, within ±{@link GLANCE_MAX_ANGLE}. */
  angle: number
}

/** The idle glance — no excursion applied. Exported so tests can pass a "no glance" state into {@link demandDrivenLookAt} without hand-rolling the (otherwise-internal) {@link GlanceState} shape. */
export const NO_GLANCE: GlanceState = { active: false, elapsed: 0, durationSeconds: 0, angle: 0 }

/** Rolls whether a new segment starts a glance, threading the PRNG state. */
function rollGlance(rngState: number): { glance: GlanceState; nextState: number } {
  const trigger = mulberry32Step(rngState)
  if (trigger.value >= GLANCE_PROBABILITY) {
    return { glance: NO_GLANCE, nextState: trigger.nextState }
  }
  const angleRoll = mulberry32Step(trigger.nextState)
  const angle = (angleRoll.value * 2 - 1) * GLANCE_MAX_ANGLE
  return {
    glance: { active: true, elapsed: 0, durationSeconds: GLANCE_DURATION_SECONDS, angle },
    nextState: angleRoll.nextState,
  }
}

function stepGlance(glance: GlanceState, delta: number): GlanceState {
  if (!glance.active) {
    return glance
  }
  const elapsed = glance.elapsed + delta
  return elapsed >= glance.durationSeconds ? NO_GLANCE : { ...glance, elapsed }
}

const UP_AXIS = new Vector3(0, 1, 0)

/**
 * Applies the current glance to a look-at `target`, rotating it around the
 * camera position by the glance's angle scaled by a smooth 0→1→0 envelope
 * (`sin(π·t)`) over its duration — slow ease in and out, never a snap, the
 * motion-sickness guardrail ADR-0010 requires.
 */
function applyGlance(position: Vector3, target: Vector3, glance: GlanceState): Vector3 {
  if (!glance.active) {
    return target
  }
  const t = clamp01(glance.elapsed / glance.durationSeconds)
  const offset = glance.angle * Math.sin(Math.PI * t)
  if (Math.abs(offset) < 1e-6) {
    return target
  }
  return target.clone().sub(position).applyAxisAngle(UP_AXIS, offset).add(position)
}

// ---------------------------------------------------------------------------
// Spline sampling
// ---------------------------------------------------------------------------

/** A 4-point sliding window: `window[1] -> window[2]` is the segment currently being flown. */
type SplineWindow = readonly [Vector3, Vector3, Vector3, Vector3]

/**
 * Samples a {@link SplineWindow} at `localT` in `[0, 1]` (0 = `window[1]`, 1 =
 * `window[2]`). Builds a `CatmullRomCurve3` over all four points but only ever
 * reads the middle third of its parameter range — the standard trick for an
 * open, C1-continuous Catmull-Rom segment that still has the two outer points
 * to shape its tangents at both ends, so consecutive segments meet with
 * matching position *and* velocity (no teleport, no kink).
 */
function sampleSpline(
  window: SplineWindow,
  localT: number,
): { position: Vector3; tangent: Vector3 } {
  const curve = new CatmullRomCurve3([...window], false, 'catmullrom', CATMULL_ROM_TENSION)
  const globalT = (1 + clamp01(localT)) / 3
  return { position: curve.getPoint(globalT), tangent: curve.getTangent(globalT).normalize() }
}

/** Samples at `localT` outside `[0, 1]` too (a small over/undershoot into the neighbouring segment), for banking's finite difference across a segment boundary. */
function sampleSplineUnclamped(
  window: SplineWindow,
  localT: number,
): { position: Vector3; tangent: Vector3 } {
  const curve = new CatmullRomCurve3([...window], false, 'catmullrom', CATMULL_ROM_TENSION)
  const globalT = (1 + localT) / 3
  return { position: curve.getPoint(globalT), tangent: curve.getTangent(globalT).normalize() }
}

/** The yaw (radians) of looking from `position` along `tangent`, via the shared, tested {@link focusLookAngles} reduction. */
function tangentYaw(position: Vector3, tangent: Vector3): number {
  const ahead = position.clone().add(tangent)
  return focusLookAngles(
    position.toArray() as [number, number, number],
    ahead.toArray() as [number, number, number],
  ).yaw
}

/**
 * The bank angle at `localT`: estimates the *path's* turn rate — its actual
 * velocity direction, via the spline tangent — a fraction either side of
 * `localT` (wrapped through the shortest angular distance), then scales and
 * clamps it to {@link DEMO_BANK_MAX}. This is ADR-0010's "re-derive banking
 * from the path's actual velocity, not the look-at yaw": the look-at now
 * independently blends in a Tower pull and glances (see
 * {@link demandDrivenLookAt}), so it's no longer the right banking signal —
 * only the spline itself is.
 */
function tourBankAngle(window: SplineWindow, segmentSeconds: number, localT: number): number {
  const before = sampleSplineUnclamped(window, localT - BANK_SAMPLE_T_EPS)
  const after = sampleSplineUnclamped(window, localT + BANK_SAMPLE_T_EPS)
  const yawBefore = tangentYaw(before.position, before.tangent)
  const yawAfter = tangentYaw(after.position, after.tangent)
  const yawRate = angleDelta(yawBefore, yawAfter) / (2 * BANK_SAMPLE_T_EPS * segmentSeconds)
  return clamp(-DEMO_BANK_GAIN * yawRate, -DEMO_BANK_MAX, DEMO_BANK_MAX)
}

// ---------------------------------------------------------------------------
// Demand-driven look-at
// ---------------------------------------------------------------------------

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * The blend weight (`[0, LOOKAT_TOWER_PULL_MAX]`) the look-at should currently
 * pull toward the nearest Tower, and that Tower's position — ADR-0010's
 * demand-driven blend, engaged by *either* of two "Towers would otherwise
 * leave frame" cases, combined with `max` (whichever more urgently needs the
 * pull):
 *
 *  - **Horizontally far** from the nearest Tower (an overview hop's
 *    horizontal travel, a turn into open space, the cluster edge) — the
 *    original signal.
 *  - **High above the Tower roofline**, regardless of horizontal distance.
 *    Without this, a camera hovering directly over a Tower at overview
 *    altitude reads as "already framed" by the horizontal test alone (it
 *    *is* horizontally right on top of one), so the pull stayed ≈0 and the
 *    level forward look-ahead floated into empty sky above the skyline — the
 *    original "aims at the void" bug resurfacing at overview height. Ordinary
 *    canyon flying stays untouched: canyon altitude never reaches the
 *    roofline (`CANYON_ALTITUDE_MAX` < `TOWER_HEIGHT`), so this component is
 *    always exactly 0 there.
 */
export function nearestTowerPull(
  position: Vector3,
  placements: readonly TowerPlacement[],
): { point: Vector3; strength: number } {
  if (placements.length === 0) {
    return { point: position.clone(), strength: 0 }
  }
  let nearest = placements[0]
  let nearestDistanceSq = Infinity
  for (const placement of placements) {
    const dx = placement.position[0] - position.x
    const dz = placement.position[2] - position.z
    const distanceSq = dx * dx + dz * dz
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq
      nearest = placement
    }
  }
  const horizontalDistance = Math.sqrt(nearestDistanceSq)
  const horizontalStrength = smoothstep(
    LOOKAT_NEAR_CLEARANCE,
    LOOKAT_FAR_CLEARANCE,
    horizontalDistance,
  )
  const heightAboveRoofline = Math.max(0, position.y - TOWER_ROOFLINE_Y)
  const verticalStrength = smoothstep(
    LOOKAT_OVERVIEW_NEAR_CLEARANCE,
    LOOKAT_OVERVIEW_FAR_CLEARANCE,
    heightAboveRoofline,
  )
  const strength = LOOKAT_TOWER_PULL_MAX * Math.max(horizontalStrength, verticalStrength)
  return { point: new Vector3(...nearest.position), strength }
}

function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current
  if (Math.abs(diff) <= maxDelta) {
    return target
  }
  return current + Math.sign(diff) * maxDelta
}

/**
 * The demand-driven look-at target: forward down the canyon by default (the
 * spline tangent, {@link LOOKAT_LOOKAHEAD_DISTANCE} ahead, its altitude capped
 * at {@link LOOKAT_FORWARD_ALTITUDE_CAP} so a steep climb can't shoot it into
 * empty sky before the blend below catches up), blended toward the nearest
 * Tower by `lookAtBlend` (already eased — see {@link stepDemoTour} — so this
 * function itself never snaps), then a seeded {@link applyGlance} on top.
 */
export function demandDrivenLookAt(
  position: Vector3,
  tangent: Vector3,
  lookAtBlend: number,
  placements: readonly TowerPlacement[],
  glance: GlanceState,
): Vector3 {
  const forward = position.clone().addScaledVector(tangent, LOOKAT_LOOKAHEAD_DISTANCE)
  forward.y = Math.min(forward.y, LOOKAT_FORWARD_ALTITUDE_CAP)
  const pull = nearestTowerPull(position, placements)
  const blended = forward.lerp(pull.point, lookAtBlend)
  return applyGlance(position, blended, glance)
}

// ---------------------------------------------------------------------------
// Demo tour state
// ---------------------------------------------------------------------------

function segmentDuration(a: Vector3, b: Vector3): number {
  return Math.max(MIN_SEGMENT_SECONDS, a.distanceTo(b) / CANYON_TRAVEL_SPEED)
}

/** The Canyon-tour flavour of {@link DemoTourState}: a real Canyon graph exists to walk. */
interface CanyonTourState {
  kind: 'canyon'
  graph: CanyonGraph
  rngState: number
  /** Lattice coordinate of `window[3]` — the walk's leading edge. */
  headCoord: LatticeCoord
  headMove: LatticeMove
  window: SplineWindow
  /** Progress through the current segment, in `[0, 1)`. */
  segmentT: number
  segmentSeconds: number
  /** The look-at's current Tower-pull weight, eased toward the geometric target at {@link LOOKAT_BLEND_RATE}/s. */
  lookAtBlend: number
  glance: GlanceState
}

/**
 * The orbit-and-bob fallback flavour of {@link DemoTourState} (ADR-0010): no
 * Canyon graph exists (0 or 1 Towers), so instead of a near-static camera
 * reading as "frozen/broken" on a wall, gently orbit `center` (the lone
 * Tower, or the origin when empty) with a slow vertical bob, reusing the
 * altitude program's rhythm loosely rather than the walk itself.
 */
interface OrbitTourState {
  kind: 'orbit'
  center: [number, number, number]
  elapsed: number
  /** The seed this fallback was created with — kept (not just its derived phase) so a mid-flight promotion to a real Canyon tour (see {@link stepDemoTour}) can hand it straight to {@link createDemoTour}. */
  seed: number
}

/** Demo Mode's full tour state: either flying the Canyon graph, or the degenerate orbit fallback. */
export type DemoTourState = CanyonTourState | OrbitTourState

function orbitTourState(seed: number, center: [number, number, number]): OrbitTourState {
  return { kind: 'orbit', center, elapsed: 0, seed: seed | 0 }
}

/** The orbit's starting angle, derived from its seed so different seeds still produce distinguishable (if simple) orbits. */
function orbitPhaseOffset(state: OrbitTourState): number {
  return mulberry32Step(state.seed).value * 2 * Math.PI
}

function fallbackCenter(placements: readonly TowerPlacement[]): [number, number, number] {
  return placements.length === 1 ? placements[0].position : [0, 0, 0]
}

/**
 * Creates a fresh {@link DemoTourState}: the seam Demo Mode's activation calls
 * (ADR-0010's "enter at the nearest waypoint to the camera's current pose").
 * A deterministic function of its three inputs — same seed + same Tower
 * placements + same entry pose always produces the same tour, the
 * reproduction contract #91 requires. `entry` is typically the camera's pose
 * the instant Demo Mode switches on; {@link FreeFlyControls} eases onto the
 * result via the pre-existing {@link sampleDemoIntro} intro, unchanged by
 * this redesign.
 *
 * Falls back to the orbit-and-bob state when `placements` is degenerate (see
 * {@link buildCanyonGraph}).
 */
export function createDemoTour(params: {
  seed: number
  placements: readonly TowerPlacement[]
  entry: Pose
}): DemoTourState {
  const graph = buildCanyonGraph(params.placements)
  if (!graph) {
    return orbitTourState(params.seed, fallbackCenter(params.placements))
  }

  let rngState = params.seed | 0
  const entryCoord = nearestLatticeCoord(graph, params.entry.position[0], params.entry.position[2])
  const entryAltitude = drawAltitude(rngState)
  rngState = entryAltitude.nextState
  const entryPosition = new Vector3(
    graph.xs[entryCoord.i],
    entryAltitude.altitude,
    graph.zs[entryCoord.j],
  )

  const step1 = drawNextWaypoint(graph, entryCoord, null, rngState)
  const step2 = drawNextWaypoint(graph, step1.waypoint.coord, step1.move, step1.nextState)

  const p1 = entryPosition
  const p2 = step1.waypoint.position
  const p3 = step2.waypoint.position
  // Mirror p2 through p1 for a synthetic "point behind the entry" — the
  // standard way to give an open Catmull-Rom curve a sensible starting
  // tangent (zero initial curvature) with no real history to draw on yet.
  const p0 = p1.clone().multiplyScalar(2).sub(p2)

  const glanceRoll = rollGlance(step2.nextState)

  return {
    kind: 'canyon',
    graph,
    rngState: glanceRoll.nextState,
    headCoord: step2.waypoint.coord,
    headMove: step2.move,
    window: [p0, p1, p2, p3],
    segmentT: 0,
    segmentSeconds: segmentDuration(p1, p2),
    lookAtBlend: 0,
    glance: glanceRoll.glance,
  }
}

/**
 * Advances a {@link DemoTourState} by one frame's `delta` seconds. `placements`
 * is passed fresh every call (not captured at {@link createDemoTour} time) so a
 * live Tower add/remove regenerates the Canyon graph **lazily** (ADR-0010): the
 * in-progress segment always finishes on the graph it started with (still
 * jump-free), and only the *next* waypoint — drawn when the segment completes
 * — is planned against the latest placements. The one exception is the orbit
 * fallback, which re-checks every step whether enough Towers now exist to
 * start a real tour, so a single-Tower scene "becomes the real canyon tour the
 * moment more Towers arrive" without waiting for the next Demo Mode toggle.
 */
export function stepDemoTour(
  state: DemoTourState,
  delta: number,
  placements: readonly TowerPlacement[],
): DemoTourState {
  if (state.kind === 'orbit') {
    const graph = buildCanyonGraph(placements)
    if (graph) {
      const entry = sampleOrbitPose(state)
      return createDemoTour({ seed: state.seed, placements, entry })
    }
    return { ...state, elapsed: state.elapsed + delta }
  }

  const segmentT = state.segmentT + delta / state.segmentSeconds
  const { position: currentPosition } = sampleSpline(state.window, Math.min(segmentT, 1))
  const targetBlend = nearestTowerPull(currentPosition, placements).strength
  const lookAtBlend = approach(state.lookAtBlend, targetBlend, LOOKAT_BLEND_RATE * delta)

  if (segmentT < 1) {
    return { ...state, segmentT, lookAtBlend, glance: stepGlance(state.glance, delta) }
  }

  // Segment complete: the just-finished segment played out on `state.graph`
  // (jump-free); the next waypoint is planned on the latest graph.
  const graph = buildCanyonGraph(placements)
  if (!graph) {
    // The cluster shrank to degenerate (≤1 Tower) mid-flight — a rare edge
    // kept simple: hand off to the orbit fallback rather than engineering a
    // seamless downgrade for an event this uncommon.
    return orbitTourState(state.rngState, fallbackCenter(placements))
  }

  const picked = drawNextWaypoint(graph, state.headCoord, state.headMove, state.rngState)
  const window: SplineWindow = [
    state.window[1],
    state.window[2],
    state.window[3],
    picked.waypoint.position,
  ]
  const glanceRoll = rollGlance(picked.nextState)

  return {
    kind: 'canyon',
    graph,
    rngState: glanceRoll.nextState,
    headCoord: picked.waypoint.coord,
    headMove: picked.move,
    window,
    segmentT: segmentT - 1,
    segmentSeconds: segmentDuration(window[1], window[2]),
    lookAtBlend,
    glance: glanceRoll.glance,
  }
}

function sampleOrbitPose(state: OrbitTourState): DemoPose {
  const angle = orbitPhaseOffset(state) + state.elapsed * ORBIT_ANGULAR_SPEED
  const bobPhase = (2 * Math.PI * state.elapsed) / ORBIT_BOB_PERIOD_SECONDS
  const [cx, cy, cz] = state.center
  const position: [number, number, number] = [
    cx + ORBIT_RADIUS * Math.sin(angle),
    cy + ORBIT_ALTITUDE_BASE + ORBIT_BOB_AMPLITUDE * Math.sin(bobPhase),
    cz + ORBIT_RADIUS * Math.cos(angle),
  ]
  const target: [number, number, number] = [cx, cy + TOWER_HEIGHT * 0.5, cz]
  // A constant-radius, constant-angular-speed orbit has a constant turn rate,
  // so (unlike the Canyon tour) its bank is simplest computed directly rather
  // than finite-differenced — a steady, gentle lean into the circle.
  const roll = clamp(-DEMO_BANK_GAIN * ORBIT_ANGULAR_SPEED, -DEMO_BANK_MAX, DEMO_BANK_MAX)
  return { position, target, roll }
}

/**
 * Reads the current camera {@link DemoPose} off a {@link DemoTourState} —
 * position, the demand-driven look-at target, and the velocity-derived bank —
 * without advancing it (advancing is {@link stepDemoTour}'s job, so a caller
 * can sample the same instant repeatedly, e.g. once for {@link
 * sampleDemoIntro}'s moving target and once to detect "done").
 */
export function sampleDemoTourPose(
  state: DemoTourState,
  placements: readonly TowerPlacement[],
): DemoPose {
  if (state.kind === 'orbit') {
    return sampleOrbitPose(state)
  }
  const { position, tangent } = sampleSpline(state.window, state.segmentT)
  const target = demandDrivenLookAt(position, tangent, state.lookAtBlend, placements, state.glance)
  const roll = tourBankAngle(state.window, state.segmentSeconds, state.segmentT)
  return {
    position: position.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
    roll,
  }
}

// ---------------------------------------------------------------------------
// Activation intro / deactivation roll recovery — unchanged mechanics (#84)
// ---------------------------------------------------------------------------

/**
 * An in-progress ease from wherever the camera was onto the (already-moving)
 * demo flight path, started the instant Demo Mode switches on.
 */
export interface DemoIntro {
  /** The camera pose (position + look-at) at the moment Demo Mode activated. */
  from: Pose
  /** Seconds elapsed since the intro began. */
  elapsed: number
}

/**
 * Samples an in-progress {@link DemoIntro}: eases the camera from its pose at
 * activation onto `flight` — the tour's *current* pose, sampled by the caller
 * every frame via {@link sampleDemoTourPose} so the tour keeps advancing
 * during the intro rather than waiting for it — fading the bank in from level
 * rather than snapping to it. `done` is true once the intro has finished
 * easing — the rig should then use `flight` directly.
 */
export function sampleDemoIntro(
  intro: DemoIntro,
  flight: DemoPose,
): { pose: DemoPose; done: boolean } {
  const t = Math.min(1, intro.elapsed / DEMO_TRANSITION_SECONDS)
  const eased = easeInOutCubic(t)
  const pose = samplePose(intro.from, { position: flight.position, target: flight.target }, t)
  return {
    pose: { ...pose, roll: flight.roll * eased },
    done: t >= 1,
  }
}

/**
 * An in-progress ease of the camera's bank back to level, started the instant
 * Demo Mode switches off, so free-fly resumes without the roll snapping to
 * zero — the "no jarring jump" hand-back Demo Mode's off-toggle requires (#22).
 */
export interface RollRecovery {
  /** The bank angle at the moment Demo Mode deactivated. */
  from: number
  /** Seconds elapsed since the recovery began. */
  elapsed: number
}

/**
 * Advances a {@link RollRecovery} by one frame's `delta` seconds and returns
 * the roll to apply this frame plus the next recovery state (`null` once the
 * bank has settled level, at which point free-fly's own roll-less orientation
 * takes over for good).
 */
export function stepRollRecovery(
  recovery: RollRecovery,
  delta: number,
): { roll: number; next: RollRecovery | null } {
  const elapsed = recovery.elapsed + delta
  const t = Math.min(1, elapsed / DEMO_TRANSITION_SECONDS)
  const roll = recovery.from * (1 - easeInOutCubic(t))
  return t >= 1 ? { roll: 0, next: null } : { roll, next: { from: recovery.from, elapsed } }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function angleDelta(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}
