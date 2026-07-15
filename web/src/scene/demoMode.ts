import { CatmullRomCurve3, Vector3 } from 'three'
import {
  easeInOutCubic,
  FOCUS_DURATION_SECONDS,
  focusLookAngles,
  samplePose,
  type Pose,
} from './focus'
import { TOWER_FOOTPRINT, TOWER_HEIGHT, TOWER_SPACING, type TowerPlacement } from './towerLayout'

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

/**
 * The "over the rooftops" overview altitude band (world Y), above the
 * Towers. Lowered by the #91 climb-rate tuning pass (was `TOWER_HEIGHT *
 * 1.5` / `* 2.4`): still clears the `y = TOWER_HEIGHT` roofline comfortably,
 * but sits close enough above it that the climb out of the canyon (now
 * additionally rate-limited — see {@link MAX_CLIMB_GRADIENT}) stays gentle
 * and the Towers stay large in frame during an overview pass, rather than
 * shrinking under a soaring wide-orbit camera.
 */
export const OVERVIEW_ALTITUDE_MIN = TOWER_HEIGHT * 1.1
export const OVERVIEW_ALTITUDE_MAX = TOWER_HEIGHT * 1.6

/**
 * Overview passes are *episodes*, not per-waypoint coin flips (#91 feel pass).
 *
 * The original design drew every waypoint's altitude independently
 * (`OVERVIEW_PROBABILITY = 0.15` per waypoint), so an overview target usually
 * lived on a *single* waypoint: all of the climb had to happen within the one
 * short segment leading to it, and the moment that segment ended the target
 * reset — a quick vertical pop-up, never the long, sweeping climb-out of a
 * small plane. The maintainer's diagnosis (and the fix here): the low canyon
 * waypoint and the high overview waypoint were too close together
 * horizontally, so all the altitude was gained over a short run.
 *
 * Now the altitude program commits to an overview *intent* that persists
 * across {@link OVERVIEW_EPISODE_WAYPOINTS} consecutive waypoints: one apex
 * altitude is drawn for the whole episode, every waypoint in it carries that
 * apex, and the glide-slope pursuit ({@link MAX_CLIMB_GRADIENT}) therefore
 * has several segments' worth of horizontal run to climb over — a gradual
 * ascent, a genuine rooftop cruise once the apex is reached, then (when the
 * episode ends and waypoints return to canyon draws) an equally gradual
 * descent back into the canyons.
 *
 * Episodes are *paced*, not Bernoulli-rolled: after each episode (and at tour
 * start) the program draws a canyon-flying gap of
 * {@link OVERVIEW_GAP_WAYPOINTS_MIN}..{@link OVERVIEW_GAP_WAYPOINTS_MAX}
 * waypoints before the next one begins. That keeps the "every so often it
 * rises to peek over the rooftops" rhythm — episodes can never chain
 * back-to-back into a yo-yo, and one is *guaranteed* within a bounded stretch
 * of flight (which the e2e capture window and the overview-reached unit
 * invariant both rely on, where a per-waypoint probability only made it
 * likely).
 */
export const OVERVIEW_EPISODE_WAYPOINTS = 6
export const OVERVIEW_GAP_WAYPOINTS_MIN = 12
export const OVERVIEW_GAP_WAYPOINTS_MAX = 24

/** CANYON_TRAVEL_SPEED is the flight's speed along the spline, world units/second. */
export const CANYON_TRAVEL_SPEED = TOWER_SPACING * 1.1

/**
 * MAX_CLIMB_GRADIENT caps how fast the tour's altitude is ever allowed to
 * change *relative to the horizontal distance the camera actually travels* —
 * expressed as a dimensionless ratio (`tan` of the climb angle) rather than a
 * bare units/second number, so it reads as what it is: a shallow glide slope,
 * the gentle climb/descent of a small plane, never an elevator.
 *
 * This is enforced *per frame, relative to that frame's own horizontal (x, z)
 * travel* — not as a units/second rate against elapsed time (see {@link
 * stepDemoTour}'s altitude pursuit, which clamps `|Δaltitude|` to
 * `MAX_CLIMB_GRADIENT * horizontalDistanceMovedThisFrame`). A time-based
 * units/second cap looks identical *on average*, but fails exactly where the
 * elevator bug came from: wherever horizontal speed dips within a frame (a
 * tight corner, a slow point in the Catmull-Rom's uniform-`t`
 * parameterization, a near-stationary moment near a waypoint), a temporal cap
 * keeps climbing at full rate while the camera barely moves forward, so the
 * *visual* climb angle spikes toward vertical even though the average rate
 * looks fine. Gating on the frame's actual horizontal travel instead means
 * the apparent climb/descent angle can never exceed `atan(MAX_CLIMB_GRADIENT)`
 * regardless of how fast or slow the horizontal path is moving — including
 * holding altitude outright while the camera is essentially stationary
 * horizontally (a waypoint dwell, or the first frame after activation), which
 * is correct: there's nothing to compute a glide angle against.
 *
 * Two adjacent waypoints can land in very different altitude bands (a
 * canyon-low hop followed by an overview episode's apex) regardless of how
 * far apart they are horizontally or how the horizontal path between them
 * bends — this is what keeps that transition from ever reading as "the plane
 * turns straight up". `0.42` ⇒ roughly a 23° climb angle — the gentle,
 * gradual climb-out of a small plane. An earlier attempt at a slope this
 * shallow failed only because the overview target reset every waypoint before
 * the climb could catch up to it; now that an overview intent persists for a
 * whole {@link OVERVIEW_EPISODE_WAYPOINTS}-waypoint episode, the pursuit has
 * several segments of horizontal run to complete the climb, so the shallow
 * angle actually reaches the rooftops instead of being forever cut short.
 * Tune this (not the spline or the altitude bands) to make climbs feel
 * shallower or brisker.
 */
export const MAX_CLIMB_GRADIENT = 0.42

/**
 * The level-off ease at the top (and bottom) of a climb/descent (#91 feel
 * pass): within {@link CLIMB_LEVELOFF_DISTANCE} world units of the target
 * altitude, the allowed glide slope tapers linearly with the remaining
 * altitude difference (floored at {@link CLIMB_LEVELOFF_MIN_FACTOR} of
 * {@link MAX_CLIMB_GRADIENT} so the pursuit still *reaches* the target
 * exactly rather than approaching it asymptotically forever). Without this,
 * the vertical profile has a hard corner where a 23° climb snaps to level in
 * a single frame — a real plane eases off the climb as it reaches its
 * ceiling, and that gentle level-off is a large part of what makes an ascent
 * read as flown rather than driven. The taper only ever *reduces* the
 * per-frame altitude change, so the {@link MAX_CLIMB_GRADIENT} per-frame
 * invariant is untouched.
 */
export const CLIMB_LEVELOFF_DISTANCE = TOWER_HEIGHT * 0.2
export const CLIMB_LEVELOFF_MIN_FACTOR = 0.35

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
 * The demand-driven look-at blend (ADR-0010, root-caused #91 follow-up 2):
 * inside a canyon, Towers already flank the forward look-ahead point, so the
 * pull toward the nearest one should contribute ≈0; it should only ramp up
 * when the forward point itself would otherwise land in open space (an
 * overview hop, a turn into open space, the cluster edge, a steep climb/dive
 * transition). Modelled as a smoothstep of {@link towerBoxClearance} — the
 * forward point's actual 3D distance to the nearest Tower's bounding volume,
 * not a proxy like the camera's own altitude — between the two clearances
 * below, capped at {@link LOOKAT_TOWER_PULL_MAX}, and only allowed to
 * *change* at {@link LOOKAT_BLEND_RATE} per second so the aim ramps rather
 * than snaps. One uniform rule covers canyon, flat-overview, and steep-
 * transition alike: whichever regime, the question is always "is the forward
 * point actually near a Tower or not".
 */
export const LOOKAT_TOWER_PULL_MAX = 0.6
const LOOKAT_NEAR_CLEARANCE = TOWER_SPACING * 0.6
const LOOKAT_FAR_CLEARANCE = TOWER_SPACING * 3
const LOOKAT_BLEND_RATE = 0.8

/**
 * How fast (world units/second) the demand-driven pull's *anchor point* — the
 * nearest Tower's roofline point the blend aims toward — is allowed to move
 * (#91 feel pass). The geometric nearest Tower switches identity
 * *discontinuously* as the forward point sweeps across a Voronoi boundary
 * between two Towers; with any nonzero blend weight that used to snap the aim
 * sideways by several degrees in a single frame (instrumented at up to
 * ~2260°/s of aim pitch on the pre-fix code) even though the blend *weight*
 * itself was eased. Easing the point through those switches at a bounded rate
 * pans the aim smoothly from one Tower to the next — the motion-sickness
 * guardrail applied to the last remaining un-eased input of the look-at
 * pipeline. Twice the travel speed: fast enough to track the flight, slow
 * enough that a neighbouring-Tower handover reads as a deliberate pan
 * (~half a second), not a flick.
 */
const LOOKAT_PULL_POINT_EASE_RATE = CANYON_TRAVEL_SPEED * 2

/**
 * The aim's minimum horizontal reach (#91 feel pass): after the demand-driven
 * blend, the final look-at target is pushed back out along its own horizontal
 * direction from the camera if it has collapsed closer than this to the
 * camera's vertical axis. Flying over/past a Tower at overview altitude
 * (typically a perimeter pass), the pull anchor can slide almost directly
 * underfoot or just behind — dragging the blended aim point in beside the
 * camera, which both plunged the view to ~55° below the horizon and, with the
 * aim point so close to the camera's own axis, made its angular motion
 * hypersensitive (instrumented at hundreds of °/s of aim pitch). Re-projecting
 * the collapsed point back out to at least this horizontal reach preserves
 * the aim *direction* — the same Tower stays in frame, and the void-clearance
 * invariant keeps holding because the point stays near the Tower it frames —
 * while capping the down-stare at a gentle "ahead and down into the canyon"
 * pitch and restoring the slow, eased sweep the motion-sickness guardrail
 * requires. Ordinary aims sit a full {@link LOOKAT_LOOKAHEAD_DISTANCE} out
 * (farther than this), so the clamp only engages in exactly the near-overhead
 * collapse it exists for.
 */
const LOOKAT_MIN_HORIZONTAL_DISTANCE = TOWER_SPACING

/**
 * The forward aim's altitude window (#91 feel pass, replacing the old
 * `LOOKAT_FORWARD_ALTITUDE_CAP = 1.5 × TOWER_HEIGHT`): the camera is the
 * pilot's eye, and even while climbing it should look *ahead and down* into
 * the canyon and at the Towers — never crane up to stare into the empty black
 * sky. The old cap sat half a Tower *above* the roofline, so a climb-out
 * could legally aim at open sky for a second or more (~32% of climb-out
 * frames read as dark in the maintainer's review — a Tower technically near
 * the aim point, but only a sliver at frame edge).
 *
 * {@link LOOKAT_AIM_CEILING} pins the aim's highest possible altitude just
 * *below* the roofline, so the frame is always filled by Tower bodies or
 * rooftops: while the camera is below it (ordinary canyon flying) the aim is
 * level and unaffected; as the camera climbs past it, the aim stays put and
 * the view pitches gradually, smoothly downward — which is also what makes a
 * climb stop reading as "turning up" at all. {@link LOOKAT_AIM_FLOOR} is the
 * symmetric guard for dives: never aim below the canyon floor. Both bounds
 * are applied to the raw forward point *before* {@link nearestTowerPull}
 * measures its Tower deficiency, so the demand-driven blend only ever refines
 * an already-sane aim.
 */
export const LOOKAT_AIM_CEILING = TOWER_HEIGHT * 0.9
export const LOOKAT_AIM_FLOOR = TOWER_HEIGHT * 0.1

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

/**
 * The altitude program's persistent intent (#91 feel pass — see {@link
 * OVERVIEW_EPISODE_WAYPOINTS}'s doc comment for the why): plain serializable
 * state threaded through {@link DemoTourState} like every other piece of the
 * walk. In `'canyon'` mode, `waypointsLeft` counts down the paced gap until
 * the next overview episode begins; in `'overview'` mode it counts down the
 * remaining waypoints that sustain `apexAltitude`.
 */
interface AltitudeProgram {
  mode: 'canyon' | 'overview'
  /** Waypoints remaining in the current mode, *after* the most recent draw. */
  waypointsLeft: number
  /** The sustained overview apex altitude (world Y); meaningful only in `'overview'` mode. */
  apexAltitude: number
}

/** Draws the canyon-flying gap (in waypoints) before the next overview episode, threading the PRNG state. */
function drawOverviewGap(rngState: number): { gap: number; nextState: number } {
  const roll = mulberry32Step(rngState)
  const span = OVERVIEW_GAP_WAYPOINTS_MAX - OVERVIEW_GAP_WAYPOINTS_MIN + 1
  return {
    gap: OVERVIEW_GAP_WAYPOINTS_MIN + Math.min(span - 1, Math.floor(roll.value * span)),
    nextState: roll.nextState,
  }
}

/** A fresh program at tour start: a full canyon gap first, so every tour opens with canyon threading. */
function initialAltitudeProgram(rngState: number): { program: AltitudeProgram; nextState: number } {
  const { gap, nextState } = drawOverviewGap(rngState)
  return { program: { mode: 'canyon', waypointsLeft: gap, apexAltitude: 0 }, nextState }
}

/**
 * Draws a per-waypoint altitude by advancing the {@link AltitudeProgram} one
 * waypoint: a canyon-band jitter while the gap runs down, then one apex drawn
 * for the *whole* overview episode and sustained across all of its waypoints
 * (never re-rolled mid-episode — the "overview intent" that gives the
 * glide-slope pursuit a long horizontal run to climb over), then back to
 * canyon draws with a freshly drawn gap.
 */
function drawAltitude(
  rngState: number,
  program: AltitudeProgram,
): {
  altitude: number
  isOverview: boolean
  program: AltitudeProgram
  nextState: number
} {
  if (program.mode === 'overview') {
    const waypointsLeft = program.waypointsLeft - 1
    if (waypointsLeft > 0) {
      return {
        altitude: program.apexAltitude,
        isOverview: true,
        program: { ...program, waypointsLeft },
        nextState: rngState,
      }
    }
    // Episode complete: this is its final apex waypoint; pace out the next one.
    const { gap, nextState } = drawOverviewGap(rngState)
    return {
      altitude: program.apexAltitude,
      isOverview: true,
      program: { mode: 'canyon', waypointsLeft: gap, apexAltitude: 0 },
      nextState,
    }
  }
  if (program.waypointsLeft <= 0) {
    // Gap exhausted: this waypoint begins a new overview episode.
    const apexRoll = mulberry32Step(rngState)
    const apexAltitude =
      OVERVIEW_ALTITUDE_MIN + apexRoll.value * (OVERVIEW_ALTITUDE_MAX - OVERVIEW_ALTITUDE_MIN)
    return {
      altitude: apexAltitude,
      isOverview: true,
      program: { mode: 'overview', waypointsLeft: OVERVIEW_EPISODE_WAYPOINTS - 1, apexAltitude },
      nextState: apexRoll.nextState,
    }
  }
  const jitterRoll = mulberry32Step(rngState)
  return {
    altitude: CANYON_ALTITUDE_MIN + jitterRoll.value * (CANYON_ALTITUDE_MAX - CANYON_ALTITUDE_MIN),
    isOverview: false,
    program: { mode: 'canyon', waypointsLeft: program.waypointsLeft - 1, apexAltitude: 0 },
    nextState: jitterRoll.nextState,
  }
}

/** One drawn waypoint: its lattice coordinate, resolved world position (with altitude), and overview flag. */
interface DrawnWaypoint {
  coord: LatticeCoord
  position: Vector3
  isOverview: boolean
}

/** Draws the next waypoint from `coord`/`prevMove`: a lattice move plus the altitude program's next step. */
function drawNextWaypoint(
  graph: CanyonGraph,
  coord: LatticeCoord,
  prevMove: LatticeMove | null,
  program: AltitudeProgram,
  rngState: number,
): { waypoint: DrawnWaypoint; move: LatticeMove; program: AltitudeProgram; nextState: number } {
  const picked = pickNextMove(graph, coord, prevMove, rngState)
  const nextCoord: LatticeCoord = { i: coord.i + picked.move.di, j: coord.j + picked.move.dj }
  const altitude = drawAltitude(picked.nextState, program)
  const position = new Vector3(graph.xs[nextCoord.i], altitude.altitude, graph.zs[nextCoord.j])
  return {
    waypoint: { coord: nextCoord, position, isOverview: altitude.isOverview },
    move: picked.move,
    program: altitude.program,
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
 * The point-to-Tower-box clearance (world units): the distance from `point`
 * to the nearest surface of the Tower prism centred at `towerPosition`
 * (footprint {@link TOWER_FOOTPRINT}, height {@link TOWER_HEIGHT}, resting on
 * the floor at y = 0) — the standard per-axis-clamped point-to-AABB distance.
 * Zero once `point` is inside the box's horizontal footprint *and* vertical
 * span at once (e.g. any canyon-altitude point directly over a Tower); grows
 * smoothly in whichever direction — horizontal, vertical (above the roofline
 * or below the floor), or a mix of both on a diagonal climb/dive — `point`
 * actually moves away from the box. This one measurement is what replaces the
 * old horizontal-distance-*or*-height-above-roofline special-casing: a single
 * geometric "how far is this point from actually being near a Tower" number
 * that's correct regardless of the camera's own altitude or the spline
 * tangent's steepness (#91 follow-up 2's root-cause fix).
 */
function towerBoxClearance(
  point: Vector3,
  towerPosition: readonly [number, number, number],
): number {
  const halfFootprint = TOWER_FOOTPRINT / 2
  const dx = Math.max(0, Math.abs(point.x - towerPosition[0]) - halfFootprint)
  const dz = Math.max(0, Math.abs(point.z - towerPosition[2]) - halfFootprint)
  const dy = Math.max(0, point.y - TOWER_ROOFLINE_Y, -point.y)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * The blend weight (`[0, LOOKAT_TOWER_PULL_MAX]`) the look-at should pull
 * toward the nearest Tower, and that Tower's roofline point — ADR-0010's
 * demand-driven blend. `point` is expected to be the forward look-ahead point
 * (see {@link demandDrivenLookAt}'s `forward`), **not** the camera's own
 * position: the deficiency this measures is "is the point the camera is about
 * to aim at actually near a Tower", via {@link towerBoxClearance} to the
 * nearest one, smoothstepped between the two clearances below and capped at
 * {@link LOOKAT_TOWER_PULL_MAX}. Because the signal is the aim's own geometric
 * distance from Tower geometry — not a proxy like the camera's altitude or the
 * spline tangent's steepness — it stays ≈0 exactly when Towers already flank
 * or fill the aim point (ordinary canyon flying, and a level overview pass
 * that's already tilted at the skyline) and ramps up in every regime where
 * they don't (a horizontal turn into open space, a level overview hop, or a
 * steep climb/dive transition whose forward point shoots past the rooftops)
 * — one uniform rule instead of separate horizontal/vertical special cases.
 */
export function nearestTowerPull(
  point: Vector3,
  placements: readonly TowerPlacement[],
): { point: Vector3; strength: number } {
  if (placements.length === 0) {
    return { point: point.clone(), strength: 0 }
  }
  let nearest = placements[0]
  let nearestClearance = Infinity
  for (const placement of placements) {
    const clearance = towerBoxClearance(point, placement.position)
    if (clearance < nearestClearance) {
      nearestClearance = clearance
      nearest = placement
    }
  }
  const strength =
    LOOKAT_TOWER_PULL_MAX *
    smoothstep(LOOKAT_NEAR_CLEARANCE, LOOKAT_FAR_CLEARANCE, nearestClearance)
  return {
    point: new Vector3(nearest.position[0], TOWER_ROOFLINE_Y, nearest.position[2]),
    strength,
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current
  if (Math.abs(diff) <= maxDelta) {
    return target
  }
  return current + Math.sign(diff) * maxDelta
}

/** {@link approach} in 3D: moves `current` straight toward `target`, at most `maxDelta` world units. */
function approachPoint(
  current: readonly [number, number, number],
  target: Vector3,
  maxDelta: number,
): [number, number, number] {
  const from = new Vector3(...current)
  const distance = from.distanceTo(target)
  if (distance <= maxDelta) {
    return target.toArray() as [number, number, number]
  }
  return from.addScaledVector(target.clone().sub(from).normalize(), maxDelta).toArray() as [
    number,
    number,
    number,
  ]
}

/**
 * The raw forward look-at point (#91 feel pass — the pilot's eye): projected
 * a full {@link LOOKAT_LOOKAHEAD_DISTANCE} ahead along the tangent's
 * *horizontal* direction (never foreshortened by a steep spline section, so
 * the aim always reaches well down the canyon), at an altitude that follows
 * the *flyable* pitch, not the raw spline's:
 *
 * - The vertical component follows the tangent's gradient clamped to
 *   ±{@link MAX_CLIMB_GRADIENT} — the pitch the camera's own glide-slope-
 *   limited motion can actually fly. The raw spline slope between a canyon
 *   waypoint and an episode apex can exceed 2.0 (~64°); aiming along *that*
 *   is exactly the old "crane up into black sky on a climb-out / stare at the
 *   floor on a dive" bug. Aiming along the real flight path instead keeps the
 *   view on where the plane is genuinely going.
 * - The result is then clamped into [{@link LOOKAT_AIM_FLOOR},
 *   {@link LOOKAT_AIM_CEILING}] — into the canyon, onto the Towers, never
 *   above the roofline (see those constants' doc comment).
 *
 * Both stages are continuous in the camera's position and tangent, so the aim
 * pitches gradually with the (already eased) climb — no snap, the
 * motion-sickness guardrail. Shared by {@link demandDrivenLookAt} and
 * {@link stepDemoTour} (which needs the same point to know what deficiency to
 * ease the blend toward) so the two can never disagree about what "forward"
 * means.
 */
function forwardLookAheadPoint(position: Vector3, tangent: Vector3): Vector3 {
  const horizontalLength = Math.hypot(tangent.x, tangent.z)
  if (horizontalLength < 1e-9) {
    // Degenerate (never produced by the walk: adjacent waypoints always
    // differ horizontally) — fall back to the raw tangent rather than a
    // zero-length look direction.
    const fallback = position.clone().addScaledVector(tangent, LOOKAT_LOOKAHEAD_DISTANCE)
    fallback.y = clamp(fallback.y, LOOKAT_AIM_FLOOR, LOOKAT_AIM_CEILING)
    return fallback
  }
  const flyableGradient = clamp(
    tangent.y / horizontalLength,
    -MAX_CLIMB_GRADIENT,
    MAX_CLIMB_GRADIENT,
  )
  return new Vector3(
    position.x + (tangent.x / horizontalLength) * LOOKAT_LOOKAHEAD_DISTANCE,
    clamp(
      position.y + flyableGradient * LOOKAT_LOOKAHEAD_DISTANCE,
      LOOKAT_AIM_FLOOR,
      LOOKAT_AIM_CEILING,
    ),
    position.z + (tangent.z / horizontalLength) * LOOKAT_LOOKAHEAD_DISTANCE,
  )
}

/**
 * The demand-driven look-at target: the forward look-ahead point ({@link
 * forwardLookAheadPoint}), blended toward `pullPoint` by `lookAtBlend`, then
 * a seeded {@link applyGlance} on top. Both blend inputs are threaded in
 * *already eased* — see {@link stepDemoTour} — so this function itself never
 * snaps: `lookAtBlend`'s rate of change is capped at {@link
 * LOOKAT_BLEND_RATE}/s, and `pullPoint` (the roofline anchor the blend aims
 * toward) is rate-limited at {@link LOOKAT_PULL_POINT_EASE_RATE} through
 * nearest-Tower switches rather than read raw off {@link nearestTowerPull}
 * (whose point jumps discontinuously at Voronoi boundaries between Towers).
 * The forward point itself is still read fresh off the current position/
 * tangent on every call, so the target tracks the flight 1:1 while the two
 * blend inputs ease.
 */
export function demandDrivenLookAt(
  position: Vector3,
  tangent: Vector3,
  lookAtBlend: number,
  pullPoint: Vector3,
  glance: GlanceState,
): Vector3 {
  const forward = forwardLookAheadPoint(position, tangent)
  const blended = forward.lerp(pullPoint, lookAtBlend)
  // Never let the blend collapse the aim in toward the camera's own vertical
  // axis (the near-overhead down-stare) — see LOOKAT_MIN_HORIZONTAL_DISTANCE.
  const dx = blended.x - position.x
  const dz = blended.z - position.z
  const horizontal = Math.hypot(dx, dz)
  if (horizontal > 1e-9 && horizontal < LOOKAT_MIN_HORIZONTAL_DISTANCE) {
    const scale = LOOKAT_MIN_HORIZONTAL_DISTANCE / horizontal
    blended.x = position.x + dx * scale
    blended.z = position.z + dz * scale
  }
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
  /**
   * The camera's actual world-space altitude (world Y) — #91's climb-rate
   * tuning pass: **not** read directly off the spline's own Y (that follows
   * the waypoints' independently-drawn altitudes exactly, which can differ
   * steeply between two adjacent waypoints and produce the "elevator"
   * climb/dive this field exists to prevent). Instead this is a standalone
   * value {@link stepDemoTour} eases toward the current segment's destination
   * altitude (`window[2].y`), gated each frame by {@link MAX_CLIMB_GRADIENT}
   * relative to that frame's actual horizontal travel — a rate-limited
   * pursuit, not a snap — so the camera's height only ever changes at a
   * shallow, constant glide-slope *angle* regardless of how steep the
   * underlying waypoint-to-waypoint altitude change is, or how fast/slow the
   * horizontal path happens to be moving that frame. `window`'s Y
   * coordinates remain the *target* altitudes the walk actually drew; only
   * the horizontal (x, z) components of the spline drive the camera's
   * horizontal position and weave.
   */
  altitude: number
  /** The paced canyon/overview altitude intent the next waypoint draw advances — see {@link AltitudeProgram}. */
  altitudeProgram: AltitudeProgram
  /** The look-at's current Tower-pull weight, eased toward the geometric target at {@link LOOKAT_BLEND_RATE}/s. */
  lookAtBlend: number
  /**
   * The pull's current roofline anchor point, eased toward the geometric
   * nearest-Tower point at {@link LOOKAT_PULL_POINT_EASE_RATE} so a
   * nearest-Tower switch pans the aim instead of snapping it.
   */
  lookAtPullPoint: [number, number, number]
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
  // The paced altitude program starts with a full canyon gap, so every tour
  // opens threading the canyons and the first climb-out arrives "every so
  // often" later, never in the activation transition itself.
  const initialProgram = initialAltitudeProgram(rngState)
  rngState = initialProgram.nextState
  const entryAltitude = drawAltitude(rngState, initialProgram.program)
  rngState = entryAltitude.nextState
  const entryPosition = new Vector3(
    graph.xs[entryCoord.i],
    entryAltitude.altitude,
    graph.zs[entryCoord.j],
  )

  const step1 = drawNextWaypoint(graph, entryCoord, null, entryAltitude.program, rngState)
  const step2 = drawNextWaypoint(
    graph,
    step1.waypoint.coord,
    step1.move,
    step1.program,
    step1.nextState,
  )

  const p1 = entryPosition
  const p2 = step1.waypoint.position
  const p3 = step2.waypoint.position
  // Mirror p2 through p1 for a synthetic "point behind the entry" — the
  // standard way to give an open Catmull-Rom curve a sensible starting
  // tangent (zero initial curvature) with no real history to draw on yet.
  const p0 = p1.clone().multiplyScalar(2).sub(p2)

  const glanceRoll = rollGlance(step2.nextState)

  // Seed the eased pull anchor at its geometric target for the entry pose, so
  // there's nothing to pan from on the very first frame (the blend weight
  // starts at 0 anyway, so this only fixes the ease's starting point).
  const entrySample = sampleSpline([p0, p1, p2, p3], 0)
  const entryPull = nearestTowerPull(
    forwardLookAheadPoint(entrySample.position, entrySample.tangent),
    params.placements,
  )

  return {
    kind: 'canyon',
    graph,
    rngState: glanceRoll.nextState,
    headCoord: step2.waypoint.coord,
    headMove: step2.move,
    window: [p0, p1, p2, p3],
    segmentT: 0,
    segmentSeconds: segmentDuration(p1, p2),
    // Start exactly at the entry waypoint's own altitude — p1.y — so there is
    // no lag/jump the instant the tour begins; the glide-slope pursuit only
    // ever engages from here on, chasing each *next* segment's target.
    altitude: p1.y,
    altitudeProgram: step2.program,
    lookAtBlend: 0,
    lookAtPullPoint: entryPull.point.toArray() as [number, number, number],
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
  // The spline's horizontal position *before* this frame's advance — what was
  // actually rendered last frame (sampleDemoTourPose reads state.window at
  // state.segmentT, exactly what's sampled here) — so the gradient cap below
  // can measure how far the camera really moved horizontally this frame,
  // rather than assuming a nominal/average travel speed.
  const { position: previousPosition } = sampleSpline(state.window, state.segmentT)
  const { position: currentPosition, tangent: currentTangent } = sampleSpline(
    state.window,
    Math.min(segmentT, 1),
  )
  // The camera's actual altitude (#91 climb-rate tuning pass, reworked to a
  // per-frame gradient cap by the elevator-look follow-up): a rate-limited
  // pursuit of the *current segment's* destination altitude (`window[2].y`,
  // the waypoint this segment is flying toward), never the spline's own
  // (possibly steep) Y directly. The per-frame cap is {@link
  // MAX_CLIMB_GRADIENT} times the horizontal (x, z) distance the camera
  // actually moved *this frame* — not a units/second rate against elapsed
  // time — so the visual climb/descent angle can never exceed
  // atan(MAX_CLIMB_GRADIENT) no matter how the horizontal spline speed varies
  // frame to frame (a tight corner, a slow point in the uniform-`t`
  // parameterization, a near-stationary moment near a waypoint). When the
  // camera is essentially stationary horizontally, horizontalDelta ≈ 0 and
  // altitude simply holds — correct: there's no glide angle to climb along.
  // This is what turns a big waypoint-to-waypoint altitude jump into a
  // gradual, shallow climb/descent that can span several segments rather
  // than snapping to the waypoint's altitude within the one segment that
  // happens to lead to it. Near the target altitude the slope additionally
  // tapers off ({@link CLIMB_LEVELOFF_DISTANCE}) so the climb *levels off*
  // like a real plane easing onto its ceiling instead of snapping from a 23°
  // slope to flat in one frame; the taper only ever reduces the per-frame
  // change, so the gradient invariant is untouched.
  const horizontalDelta = Math.hypot(
    currentPosition.x - previousPosition.x,
    currentPosition.z - previousPosition.z,
  )
  const altitudeRemaining = Math.abs(state.window[2].y - state.altitude)
  const levelOff = clamp(altitudeRemaining / CLIMB_LEVELOFF_DISTANCE, CLIMB_LEVELOFF_MIN_FACTOR, 1)
  const altitude = approach(
    state.altitude,
    state.window[2].y,
    MAX_CLIMB_GRADIENT * horizontalDelta * levelOff,
  )
  const actualPosition = new Vector3(currentPosition.x, altitude, currentPosition.z)
  // The blend must ease toward the deficiency of the *forward look-ahead
  // point* (what the camera is about to aim at), not the camera's own
  // position — the root cause of the climb/dive "aims at the void" bug (#91
  // follow-up 2): the aim can shoot past nearby Towers well before the
  // camera's own altitude/position would suggest anything's amiss. Built off
  // `actualPosition` (not the raw spline position) so the look-at pipeline is
  // anchored to where the camera actually now is, since that's what a
  // look-at is relative *to*.
  const forward = forwardLookAheadPoint(actualPosition, currentTangent)
  const pull = nearestTowerPull(forward, placements)
  const lookAtBlend = approach(state.lookAtBlend, pull.strength, LOOKAT_BLEND_RATE * delta)
  // The pull's anchor point eases too (never snaps on a nearest-Tower
  // switch) — see LOOKAT_PULL_POINT_EASE_RATE's doc comment.
  const lookAtPullPoint = approachPoint(
    state.lookAtPullPoint,
    pull.point,
    LOOKAT_PULL_POINT_EASE_RATE * delta,
  )

  if (segmentT < 1) {
    return {
      ...state,
      segmentT,
      altitude,
      lookAtBlend,
      lookAtPullPoint,
      glance: stepGlance(state.glance, delta),
    }
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

  const picked = drawNextWaypoint(
    graph,
    state.headCoord,
    state.headMove,
    state.altitudeProgram,
    state.rngState,
  )
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
    altitude,
    altitudeProgram: picked.program,
    lookAtBlend,
    lookAtPullPoint,
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
 * sampleDemoIntro}'s moving target and once to detect "done"). A pure
 * function of the state alone since #91's feel pass: every placements-derived
 * input the look-at needs (the pull anchor and blend weight) is eased through
 * {@link stepDemoTour} into the state, so sampling needs no fresh geometry.
 */
export function sampleDemoTourPose(state: DemoTourState): DemoPose {
  if (state.kind === 'orbit') {
    return sampleOrbitPose(state)
  }
  const { position, tangent } = sampleSpline(state.window, state.segmentT)
  // Horizontal (x, z) comes straight off the spline (unaffected); the actual
  // camera altitude is `state.altitude` — the glide-slope-limited pursuit
  // {@link stepDemoTour} maintains — never the spline's own (possibly steep)
  // Y. Banking (below) is still derived from the raw spline tangent: it only
  // reads the tangent's horizontal turn rate, so it's unaffected by this.
  const actualPosition = new Vector3(position.x, state.altitude, position.z)
  const target = demandDrivenLookAt(
    actualPosition,
    tangent,
    state.lookAtBlend,
    new Vector3(...state.lookAtPullPoint),
    state.glance,
  )
  const roll = tourBankAngle(state.window, state.segmentSeconds, state.segmentT)
  return {
    position: actualPosition.toArray() as [number, number, number],
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
