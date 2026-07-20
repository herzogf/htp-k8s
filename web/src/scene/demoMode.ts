import { CatmullRomCurve3, Vector3 } from 'three'
import { easeInOutCubic, FOCUS_DURATION_SECONDS, samplePose, type Pose } from './focus'
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
 *
 * Lowered from π/6 (30°) by #105 iteration 2: the maintainer's video review
 * of the first pass flagged the heavy left/right lean as a likely
 * motion-sickness contributor. 20° is a light aircraft's gentle cruise
 * turn — still an unmistakable lean into every corner, no longer a
 * steep-turn wing-drop. The lean is a *cinematic cue*, not flight physics:
 * per ADR-0003 this is a cinematic viewer, and #105 iteration 3 explicitly
 * decoupled the bank cap from any bank-coordination constraint on the turn
 * radius (see {@link CORNER_TURN_RADIUS} — corners turn far faster than a
 * 20° bank could coordinate, deliberately). What keeps the lean comfortable
 * is this cap plus the horizon-stability machinery (the roll follower and
 * {@link BANK_YAW_RATE_SMOOTHING}), not wide corners.
 */
export const DEMO_BANK_MAX = Math.PI / 9

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
 * flagged in #91 as needing visual tuning — and tuned down 1.5 → 1.1 by #105
 * iteration 3: on a small cluster the ring is *most* of the Canyon graph (a
 * 7-Tower scene's lattice is 12 ring nodes to 4 interior ones), so the ring
 * distance dominates how close the tour flies to anything. At 1.1 spacings
 * the ring passes 3.6 units from the outer Tower faces — comfortably wider
 * than an interior canyon's 1.2, nowhere near cramped, but close enough
 * that Towers fill the frame on ring legs instead of receding into the
 * dark. Measured (layer-1 framing metrics, 5 seeds x 3 grids): median
 * distance to the nearest Tower 5.15 → 3.44 on the 7-Tower scene, and the
 * time-in-canyon share roughly doubles.
 */
export const PERIMETER_OFFSET = TOWER_SPACING * 1.1

/**
 * World-space Y of a Tower's roofline (its prism top) at the resting
 * {@link TOWER_HEIGHT} — since a Tower's centre sits at `TOWER_HEIGHT / 2`
 * (towerLayout.ts) resting on the floor at y = 0. The reference the altitude
 * program, the Tower-box clearance ({@link towerBoxClearance}) and the
 * rendered aim's hard ceiling ({@link sampleDemoTourPose}) are measured
 * against — via {@link AltitudeBands}' `rooflineY`, which scales this to a
 * grown scene's ACTUAL roofline (#59) rather than staying pinned here.
 */
export const TOWER_ROOFLINE_Y = TOWER_HEIGHT

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

/**
 * The wide-vantage half of an overview episode (#105 iteration 4 — "could
 * the plane fly a tad more to the outside sometimes, to give the viewer an
 * overview? Not often, but sometimes"): while a *wide* episode's wide phase
 * runs (see {@link isWideOverviewDraw}), waypoints on a perimeter line swing
 * OVERVIEW_PERIMETER_EXTRA farther out than {@link PERIMETER_OFFSET} — a
 * brief high-and-wide hero pass along the cluster edge (up to two
 * consecutive waypoints of it — see {@link OVERVIEW_WIDE_START_WAYPOINT}),
 * then back to the tight ring.
 *
 * 0.7 spacings is a calibration between two measured cliffs. Larger (0.9
 * tried): the entry/exit diagonals steepen to ~42° of heading change against
 * the lattice, and where such a diagonal meets a real 90° ring corner the
 * leg-fraction clamp shrinks the corner's arc — peak heading rate rose from
 * 7.6 to 8.7-9.2 rad/s, walking toward the 9.5 cusp guard. At 0.7 the
 * diagonals are ~32° and the peak heading rate stays at the merged build's
 * 7.5-7.9. Smaller offsets stop reading as a vantage change at all (the
 * widened ring sits inside the wide-vantage framing distance). Only
 * *straight* perimeter nodes widen — ring corners keep their exact geometry.
 */
export const OVERVIEW_PERIMETER_EXTRA = TOWER_SPACING * 0.7

/**
 * A *wide* overview episode is one waypoint shorter than a tight one: the
 * wide detour's perpendicular entry/exit legs add roughly one leg's worth of
 * apex-cruise distance, and the shorter episode refunds it — measured
 * (layer-1, kwok7), without the refund every wide pass grew the tour's total
 * time over the rooftops and time-in-canyon paid for it (0.70 → 0.68 on the
 * worst seed).
 */
export const OVERVIEW_WIDE_EPISODE_WAYPOINTS = OVERVIEW_EPISODE_WAYPOINTS - 1

/**
 * Only *shallow-apex* episodes (apex at or below this altitude — the lower
 * half of the overview band) go wide: a shallow climb clears the roofline
 * within the wide phase's lead-in, while a deep apex is still climbing below
 * the roofline when the wide phase would start — measured, deep wide
 * episodes are exactly where time-in-canyon regressed. Deep episodes staying
 * tight over the rooftops is also vantage *variety*, and the gate is what
 * makes wide passes "sometimes, not often" by construction (roughly every
 * other episode).
 */
export const OVERVIEW_WIDE_APEX_MAX = (OVERVIEW_ALTITUDE_MIN + OVERVIEW_ALTITUDE_MAX) / 2

/**
 * The wide phase starts this many waypoints into a wide episode — the
 * climb-out's run — so widened legs are flown high, above the roofline, not
 * during the climb. Two waypoints of lead-in clear the roofline from the
 * *median* canyon start altitude ((CANYON_ALTITUDE_MIN + CANYON_ALTITUDE_MAX)/2
 * ≈ 2.7 → (TOWER_HEIGHT − 2.7) / (MAX_CLIMB_GRADIENT × TOWER_SPACING) ≈ 2.0
 * waypoints); the shallow-apex gate ({@link OVERVIEW_WIDE_APEX_MAX}) covers
 * the deeper-start tail — measured, time-in-canyon holds its floor with this
 * pairing, and one waypoint later the wide phase shrank to a single node
 * whose out-and-back dogleg paid the same two roll side-changes for half the
 * wide dwell.
 *
 * With a 5-waypoint wide episode this makes the wide phase waypoints #3-#4 —
 * up to two *consecutive* widened waypoints (where the lattice cooperates: a
 * shared perimeter line makes them one parallel widened stretch flown for a
 * full leg) before the episode's final, never-widened waypoint.
 */
export const OVERVIEW_WIDE_START_WAYPOINT = 2

/**
 * CANYON_TRAVEL_SPEED is the flight's *horizontal ground speed*, world
 * units/second, held constant along the whole route (#91 smoothness pass).
 * The spline is advanced by horizontal (x, z) arc length — not by uniform
 * spline parameter `t` per segment — so the camera covers exactly this much
 * ground every second regardless of how a segment bends or how long it is.
 * The uniform-`t` scheme this replaces made speed wobble through corners
 * (arc length ≠ chord length) and hitch at segment boundaries (the leftover
 * `t` fraction carried over in the *old* segment's time units, worth up to a
 * ~2x one-frame speed error where segment durations differed) — the "~42s
 * stutter" of the maintainer's review. Actual 3D speed is slightly above
 * ground speed while climbing/descending (by at most
 * `sqrt(1 + MAX_CLIMB_GRADIENT²)` ≈ 1.08) — a plane holding ground speed
 * through a gentle climb, still continuous because the climb gradient itself
 * is slewed (see {@link CLIMB_GRADIENT_SLEW}).
 */
export const CANYON_TRAVEL_SPEED = TOWER_SPACING * 1.1

/**
 * Below this horizontal distance between the activation pose and its nearest
 * Canyon graph node, {@link createDemoTour} skips the takeoff segment (the
 * camera is already effectively *on* the node — a takeoff segment that short
 * would be degenerate: a near-zero-length spline piece with an unstable
 * tangent) and starts the walk at the node directly, as the pre-takeoff
 * design always did.
 */
export const TAKEOFF_MIN_DISTANCE = TOWER_SPACING / 8

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
 * The symmetric ease *into* a climb/descent (#91 smoothness pass): the actual
 * flown gradient (Δaltitude per world unit of horizontal travel) may change
 * by at most this much per world unit travelled. Without it the altitude
 * pursuit engaged the full {@link MAX_CLIMB_GRADIENT} in a single frame the
 * moment a new target altitude appeared at a waypoint boundary — a vertical
 * *velocity discontinuity* (a visible kink where level flight snaps into a
 * 23° climb), the counterpart at the bottom of a climb to the hard corner
 * {@link CLIMB_LEVELOFF_DISTANCE} already smoothed at the top. At this slew
 * the plane rotates from level onto the full glide slope over
 * `MAX_CLIMB_GRADIENT / CLIMB_GRADIENT_SLEW` = 2 world units of travel
 * (~0.45s at cruise) — a gentle pitch-up, never a snap. Because the flown
 * gradient is slewed *toward* a target that is itself clamped to
 * ±`MAX_CLIMB_GRADIENT × levelOff`, its magnitude can never exceed
 * {@link MAX_CLIMB_GRADIENT}, so the per-frame climb-gradient invariant is
 * untouched.
 */
export const CLIMB_GRADIENT_SLEW = MAX_CLIMB_GRADIENT / (TOWER_SPACING / 2)

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
export const GLANCE_MAX_ANGLE = Math.PI / 12
const GLANCE_DURATION_SECONDS = 3.5

/** How far ahead along the path's tangent the forward look-at point sits. */
const LOOKAT_LOOKAHEAD_DISTANCE = TOWER_SPACING * 2

/**
 * Hard caps on the rendered view's angular velocity (#91 smoothness pass —
 * the final motion-sickness guardrail, and the one that makes "no aim snap"
 * true *by construction*). The look-at pipeline's inputs are all individually
 * eased, but its output could still whip: with the Tower pull fully engaged,
 * the blended aim point can pass close to the camera's own vertical axis
 * during an overhead pass, where its horizontal *direction* — and therefore
 * the view yaw — is ill-conditioned (instrumented at up to ~160 rad/s of view
 * yaw on the pre-fix code, a hard snap, even though every input was eased).
 * So the view direction itself is now state: {@link stepDemoTour} eases a
 * yaw/pitch/distance triplet toward the demand-driven target at no more than
 * these rates, and {@link sampleDemoTourPose} reconstructs the look-at point
 * from that triplet. Whatever the blend geometry does, the rendered aim can
 * never turn faster than a deliberate pan.
 *
 * Because the forward aim is a point on the *future flight path* (see
 * {@link stepDemoTour} — it sweeps around a corner ahead of the aircraft
 * rather than whipping with the tangent at the apex), the legitimate demand
 * on these caps is low (~0.5-0.8 rad/s); they only truly engage in the
 * pathological cancellation moments, turning what was a snap into a calm
 * pan two orders of magnitude slower. Two designs that did NOT work, for
 * the record: deriving the forward point from the instantaneous tangent
 * left ~200°/s corner whips for the caps to fight (visible as lag), and
 * cascading a *second* rate limit on the forward heading upstream of this
 * one compounded the lags through perimeter corners until the aim pointed
 * outward into the void for over a second — caught by the void-clearance
 * invariant. One smooth on-path aim + one output-stage cap is the shape
 * that keeps the aim glued to the Towers *and* snap-free.
 *
 * Exported for the pose-stream smoothness invariants, which assert the
 * rendered yaw/pitch rates across full seeded tours.
 */
export const VIEW_YAW_MAX_RATE = 1.5
export const VIEW_PITCH_MAX_RATE = 0.8
const VIEW_DISTANCE_MAX_RATE = CANYON_TRAVEL_SPEED * 2

/**
 * Hard caps on the rendered view's angular *acceleration* (#105 — "several
 * route segments bolted together" / the split-second view jumps): the view
 * triplet is promoted from a plain rate limiter to the same bounded
 * second-order follower the roll already uses ({@link stepBoundedFollower},
 * mirroring {@link DEMO_ROLL_MAX_RATE}/{@link DEMO_ROLL_MAX_ACCEL}).
 *
 * A rate limiter is C0-continuous but C1-*dis*continuous: its angular
 * velocity steps instantly between 0 and ±MAX_RATE whenever it saturates,
 * releases, or the target crosses to the other side — instrumented on the
 * pre-#105 code at up to **180 rad/s²** of rendered view-yaw acceleration (a
 * full ±VIEW_YAW_MAX_RATE sign flip within one frame), overwhelmingly
 * clustered at segment boundaries (near-boundary p99 ≈ 80 rad/s² vs ≈ 2
 * rad/s² elsewhere). That C1 step *is* the maintainer's "pilot abruptly turns
 * their head" at every waypoint, and — because a saturated yaw pans at a
 * constant rate visibly decoupled from the flight's own banking — a large
 * part of the "hovering quadcopter, not a Cessna" read. With the follower,
 * the pan rate itself ramps smoothly through every demand change, so a
 * heading change reads as a flowing head-turn that eases in and out.
 *
 * Each cap must satisfy `maxAccel × VIEW_RESPONSE_TIME > maxRate` (the same
 * non-overshoot condition the roll follower documents: the rate can always
 * decay at least as fast as the closing demand shrinks). Exported for the
 * pose-stream smoothness invariants, which assert the rendered yaw/pitch
 * accelerations across full seeded tours.
 */
export const VIEW_YAW_MAX_ACCEL = 4.0
export const VIEW_PITCH_MAX_ACCEL = 2.5
const VIEW_DISTANCE_MAX_ACCEL = CANYON_TRAVEL_SPEED * 6
/** The view followers' shared response time constant (seconds) — how eagerly the eased view chases its demand, the counterpart of the roll's ROLL_RESPONSE_TIME. */
const VIEW_RESPONSE_TIME = 0.4

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
 *
 * Retuned by #105 iteration 3 against the layer-1 *framing* metrics (the
 * maintainer's "black frames" report, measured as the share of frames with
 * no Tower within 35° of frame centre): the old calibration — NEAR 0.6 /
 * FAR 3.0 Tower spacings (2.4 / 12 world units), max 0.6 — treated a
 * perimeter-ring forward point — ~3.6 world units from the outer Tower
 * faces — as barely deficient (pull ≈ 0.1), so on ring legs and ring turns
 * the aim tracked the empty path ahead while the Towers slid to the frame
 * edge: roughly *half* of a tour's frames on the 7-Tower demo scene were
 * Tower-less by the framing metric, on `main` and iteration 2 alike. The
 * new, tighter window — NEAR 0.35 / FAR 1.125 spacings (1.4 / 4.5 world
 * units) — spans "clearly inside a canyon" (an interior canyon's forward
 * point sits at ~1.2 world units of clearance, still pulled ≈ 0) to "fully
 * deficient" (reached just past the ring distance), with a stronger cap
 * (0.85) so a deficient aim really centres a Tower rather than splitting
 * the difference. Measured across
 * 5 seeds x 3 grids: Tower-less frames 0.47 → 0.28 (7-Tower scene),
 * 0.31 → 0.19 (5x5), 0.48 → 0.29 (4x2), with the roll pipeline untouched
 * and pan-rate saturation still far below the per-waypoint-rhythm regime.
 */
export const LOOKAT_TOWER_PULL_MAX = 0.85
const LOOKAT_NEAR_CLEARANCE = TOWER_SPACING * 0.35
const LOOKAT_FAR_CLEARANCE = TOWER_SPACING * 1.125
const LOOKAT_BLEND_RATE = 0.8

/**
 * How fast (world units/second) the demand-driven pull's *anchor point* — the
 * nearest Tower's anchor the blend aims toward (see {@link nearestTowerPull})
 * — is allowed to move
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

/**
 * How much of the flown climb gradient the aim's altitude leads by (#105
 * iteration 4 — the pitch analogue of #91's level-on-straight roll rule):
 * the forward aim's altitude is `position.y + climbGradient ×
 * LOOKAT_GAZE_GRADIENT_FACTOR × LOOKAT_LOOKAHEAD_DISTANCE`, so genuinely
 * level flight aims exactly level down the canyon — the vanishing-point shot
 * the tour never had — and a full climb/dive tilts the gaze gently
 * (~atan(0.42 × 0.4) ≈ 9.5°) toward where the plane is going.
 *
 * Both endpoints of this dial were measured wrong before landing here
 * (layer-1 aim-pitch metrics, 5 seeds × 3 grids). Before iteration 4 the aim
 * altitude tracked the *route's upcoming waypoint altitudes* (the spline
 * altitude metadata): with waypoints drawn anywhere in the canyon band, the
 * aim led every altitude change at up to the full ±23° glide slope plus the
 * roofline pull on top — median aim pitch +4..+11°, p90 +23..+32°, more than
 * half of every tour pitched up > 5° (the "captain cranking his head up").
 * At factor 1.0 (aim fully along the flown slope), dives dragged the aim
 * into the canyon-floor clamp and the clamp re-keyed the rendered pitch at
 * up to 40 rad/s² — worse than the bug being fixed. At 0.4 the whole pitch
 * distribution sits at −5..+7° (p50 slightly below level — a pilot's gaze),
 * and the demand stays clear of both aim-window bounds on nearly every
 * frame (ceiling-pinned share 0.06-0.13 → ≤ 0.04).
 */
export const LOOKAT_GAZE_GRADIENT_FACTOR = 0.4

/**
 * The sliding-window spline's parameterization (#91 smoothness pass):
 * three.js's `'centripetal'` Catmull-Rom. The previous uniform
 * (`'catmullrom'`) parameterization is well known to concentrate extreme
 * curvature at knots where chord lengths differ — and this route's chords
 * differ all the time (a short takeoff hop meeting a full canyon segment, an
 * 8-unit perimeter chord meeting a 4-unit interior chord at every
 * turnaround). Instrumented on the pre-fix code those knots turned the
 * heading by ~30° within a single frame's travel (~129 world-units/s² of
 * acceleration at the takeoff knot; the repeated "massively jumpy" moments
 * of the maintainer's review at the perimeter). Centripetal parameterization
 * is the standard cure: it guarantees no cusps or self-intersections within
 * segments and distributes curvature far more evenly across unequal chords,
 * which is exactly "softer path curvature so yaw-rate doesn't spike".
 */
const CATMULL_ROM_TYPE = 'centripetal'

/**
 * CORNER_TURN_RADIUS (#105 iteration 2 — the route-geometry change ADR-0010
 * deferred from the first pass): how far before and after a lattice corner
 * the spline's control points sit, so the flight rounds every turn as a wide
 * arc instead of pivoting on the corner node.
 *
 * Measured on the pre-fix route, a 90° lattice corner turned the heading at a
 * peak of 6-9 rad/s (implied turn radius 0.5-0.7 world units at the constant
 * {@link CANYON_TRAVEL_SPEED} — an eighth of a Tower spacing): a helicopter
 * pivot, not a flown turn, and the direct source of both maintainer findings
 * of the #116 video review — the saturated-bank rocking (the bank target
 * `DEMO_BANK_GAIN × yawRate` is pinned at its clamp through every corner) and
 * the horizon flip-flop (the centripetal Catmull-Rom *counter-flexes* around
 * a sharp corner, so the heading rate — and with it the bank target's sign —
 * flipped 1-3 times per corner, rocking the horizon even through an isolated
 * turn).
 *
 * How wide, exactly, went through two calibrations. Iteration 2 chose the
 * widest arc the lattice affords (0.45 spacings — just under half the
 * shortest canyon leg), reasoning from bank coordination (`tan φ = v²/(g·r)`)
 * that wider is better; the maintainer's layer-3 verdict falsified that
 * premise: the long outer-edge turns "cost us dynamism … takes away this
 * rapid zip-through the urban canyons feeling". Coordination is the
 * constraint a cinematic viewer (ADR-0003) cares least about — the *aim*
 * never whipping (the #116 view followers) is what keeps a fast corner
 * comfortable, not the path being gentle. Iteration 3 therefore takes most
 * of the radius back: at a quarter spacing a 90° corner is carved in ~0.36s
 * with a peak heading rate ≈ that of the merged pivots (~7.6 vs ~6.4-8.4
 * rad/s, 5 seeds x 3 grids) — the zip — while keeping everything the arcs
 * bought over pivots: single-signed heading through a corner (no
 * counter-flexure, so the horizon side-change rate stays ~9-11/min vs the
 * pivots' ~20-23), a bank capped at {@link DEMO_BANK_MAX}, and no
 * ground-speed dips. Below ~a fifth of a spacing the geometry degenerates
 * (measured: at 0.2 spacings the spline wiggle returns and the horizon
 * side-change rate triples back to pivot levels) — this value sits above
 * that cliff with margin. The hard never-collide guarantee for any turn
 * angle or leg length is {@link CORNER_MAX_LEG_FRACTION}'s.
 */
export const CORNER_TURN_RADIUS = TOWER_SPACING * 0.25

/**
 * The hard cap on how far along either adjacent leg a corner's tangent
 * offset may reach: just under half, so two corners rounding a shared leg
 * always leave a nonzero straight remnant between their control points
 * (0.49, not 0.5 — offsets meeting exactly at a leg's midpoint would place
 * coincident control points, which degenerate a Catmull-Rom tangent). This —
 * not the design radius {@link CORNER_TURN_RADIUS} — is the guard that
 * *enforces* no-collision; the design radius merely stays inside it for the
 * standard lattice geometry.
 */
const CORNER_MAX_LEG_FRACTION = 0.49

/**
 * Below this arc radius a corner is not meaningfully roundable and keeps its
 * sharp node instead (the pre-rounding pivot behaviour): the leg-fraction
 * clamp shrinks the inscribed radius, and an "arc" this small collapses
 * into near-coincident control points beside full-length legs — the
 * tiny-chord regime that produces spline cusps (see
 * {@link CORNER_ARC_TARGET_CHORD}'s history). Being a *radius* floor (not an
 * angle cutoff — deliberately, so sharp-but-roundable turns on long legs
 * still get their arc), it catches every route that degenerates the radius:
 * near-hairpin turns (tan(θ/2) → ∞ — dead-end backtracks on 1×N clusters,
 * pathological activation angles), but also ordinary-angle corners whose
 * adjacent leg is very short — a 90° corner needs a leg of at least
 * `CORNER_MIN_TURN_RADIUS / CORNER_MAX_LEG_FRACTION` ≈ 0.51 world units to
 * clear the floor, while a takeoff leg is only gated at
 * {@link TAKEOFF_MIN_DISTANCE} (0.5). In practice that short-leg case has
 * not been observed to fire (the walk's approach-alignment filter keeps
 * ordinary entry corners at ≤ 90° and lattice legs are ≥ one
 * {@link TOWER_SPACING}), but it is covered by design, not by accident.
 */
const CORNER_MIN_TURN_RADIUS = CORNER_TURN_RADIUS / 4

/**
 * Below this turn angle (~1°) a "corner" is treated as straight-through and
 * keeps its node: it is visually straight (an open Catmull-Rom absorbs a
 * sub-degree kink smoothly on its own), and its inscribed arc would collapse
 * to near-coincident control points beside full-length legs — the same
 * degenerate-chord regime {@link CORNER_MIN_TURN_RADIUS} guards at the
 * hairpin end. Lattice corners are exactly 90°; only a takeoff corner from
 * an almost-perfectly-aligned activation pose can land under this.
 */
const CORNER_MIN_TURN_ANGLE = 0.02

/**
 * Scales the path's turn rate (rad/s of heading change) into a *target* bank
 * angle (shared by the Canyon tour and the orbit fallback). Tuned so the
 * gentle weave produces a clearly visible, but not extreme, bank.
 */
const DEMO_BANK_GAIN = 1.4

/**
 * The temporally smoothed roll (#91 smoothness pass — the maintainer's core
 * feedback: "abrupt rolls", "instant/jumping roll back to level", "off-level
 * even when flying straight"). The old code derived the bank *instantaneously*
 * from the spline's local turn rate every sample: turn rate (curvature) is
 * discontinuous at every waypoint knot, and the per-segment duration it was
 * divided by jumped between segments — so the roll snapped at every heading
 * discontinuity and never reliably settled to zero on straights.
 *
 * Now the instantaneous turn rate only sets a *target* bank; the actual roll
 * is a stateful, bounded second-order follower threaded through
 * {@link DemoTourState} and advanced by {@link stepBoundedFollower}:
 *
 * - the roll *rate* is hard-capped at {@link DEMO_ROLL_MAX_RATE} (a calm
 *   ~40°/s — a light aircraft's gentle coordinated roll, never a flick), and
 * - the roll rate's own change is hard-capped at {@link DEMO_ROLL_MAX_ACCEL},
 *   so the roll eases in *and* out of every bank (C1-smooth roll, bounded
 *   angular acceleration — mathematically no snap is possible), and
 * - the follower chases the target with time constant
 *   {@link ROLL_RESPONSE_TIME}; because `DEMO_ROLL_MAX_ACCEL ×
 *   ROLL_RESPONSE_TIME (0.8) > DEMO_ROLL_MAX_RATE (0.7)` the rate can always
 *   decay as fast as the closing demand shrinks, so the follower does not
 *   overshoot its target, and
 * - a small yaw-rate deadband ({@link BANK_YAW_RATE_DEADBAND}) maps genuinely
 *   straight flight to a target of *exactly* level, so cruising between turns
 *   always settles wings-level (roll → 0) instead of hovering off-level.
 *
 * The target itself is clamped to {@link ROLL_TARGET_MAX} — just inside
 * {@link DEMO_BANK_MAX} — leaving headroom for the follower's residual
 * discretization error so the DEMO_BANK_MAX invariant holds without ever
 * hard-clipping the smooth roll signal.
 *
 * These are exported for the pose-stream smoothness invariants
 * (`demoModeSmoothness.test.ts`), which assert the rate/acceleration bounds
 * over full seeded tours.
 */
export const DEMO_ROLL_MAX_RATE = 0.7
export const DEMO_ROLL_MAX_ACCEL = 2.0
export const BANK_YAW_RATE_DEADBAND = 0.06

/**
 * The time constant (seconds) of the exponential moving average the bank
 * target's yaw-rate input runs through (#105 iteration 2 — finding A of the
 * #116 video review, "the horizon flip-flops"). The finite-differenced
 * heading rate carries brief opposite-sign wiggles where the spline
 * transitions between a straight and a corner arc (small even after corner
 * rounding — but {@link DEMO_BANK_GAIN} amplifies a 0.2 rad/s wiggle into a
 * ~10° opposite bank demand, and {@link BANK_YAW_RATE_DEADBAND} only
 * suppresses wiggles near *zero* heading rate, not sign changes after a real
 * corner). Smoothing the rate over a quarter second erases sub-corner-scale
 * sign flips while a genuine corner (~0.4-1s of sustained single-signed
 * turn) still drives an essentially full bank demand — measured, it roughly
 * halves the bank-target sign-change rate at unchanged corner banking.
 */
export const BANK_YAW_RATE_SMOOTHING = 0.25
const ROLL_RESPONSE_TIME = 0.4
const ROLL_TARGET_MAX = DEMO_BANK_MAX - 0.035
/**
 * A bounded follower integrates in substeps no longer than this, so a single
 * huge frame delta (a stall, or a test deliberately stepping seconds at a
 * time) degrades to "several small smooth steps", never to one wild
 * integration step that could hurl the value past its bounds.
 */
const FOLLOWER_MAX_SUBSTEP = 1 / 30

/** The target bank for a given instantaneous heading rate: deadbanded (straight flight targets exactly level), scaled, and clamped just inside the bank limit. */
function bankTargetFromYawRate(yawRate: number): number {
  const excess = Math.max(0, Math.abs(yawRate) - BANK_YAW_RATE_DEADBAND)
  return clamp(-Math.sign(yawRate) * DEMO_BANK_GAIN * excess, -ROLL_TARGET_MAX, ROLL_TARGET_MAX)
}

/**
 * The tuning of one bounded second-order follower (see
 * {@link stepBoundedFollower}): its hard rate cap, its hard acceleration cap,
 * the time constant it chases its target with, and (optionally) a hard clamp
 * on the followed value itself. Each instance should satisfy
 * `maxAccel × responseTime > maxRate` so the rate can always decay at least
 * as fast as the closing demand shrinks — the follower then cannot overshoot
 * its target (the property {@link DEMO_ROLL_MAX_RATE}'s doc comment
 * established for the roll).
 */
interface FollowerLimits {
  readonly maxRate: number
  readonly maxAccel: number
  readonly responseTime: number
  readonly clampMin?: number
  readonly clampMax?: number
}

const ROLL_FOLLOWER: FollowerLimits = {
  maxRate: DEMO_ROLL_MAX_RATE,
  maxAccel: DEMO_ROLL_MAX_ACCEL,
  responseTime: ROLL_RESPONSE_TIME,
  clampMin: -DEMO_BANK_MAX,
  clampMax: DEMO_BANK_MAX,
}
const VIEW_YAW_FOLLOWER: FollowerLimits = {
  maxRate: VIEW_YAW_MAX_RATE,
  maxAccel: VIEW_YAW_MAX_ACCEL,
  responseTime: VIEW_RESPONSE_TIME,
}
const VIEW_PITCH_FOLLOWER: FollowerLimits = {
  maxRate: VIEW_PITCH_MAX_RATE,
  maxAccel: VIEW_PITCH_MAX_ACCEL,
  responseTime: VIEW_RESPONSE_TIME,
}
const VIEW_DISTANCE_FOLLOWER: FollowerLimits = {
  maxRate: VIEW_DISTANCE_MAX_RATE,
  maxAccel: VIEW_DISTANCE_MAX_ACCEL,
  responseTime: VIEW_RESPONSE_TIME,
  // A hard floor on the rendered view distance (#117): the non-overshoot
  // condition (`maxAccel × responseTime > maxRate`) only holds against a
  // *static* target — chasing a moving demand, a second-order follower can
  // overshoot, and a view distance that ever reached ≤ 0 would flip the
  // reconstructed aim by π (`horizontalReach = cos(pitch) × distance` in
  // sampleDemoTourPose changes sign). The demand itself is never below
  // LOOKAT_MIN_HORIZONTAL_DISTANCE (composeLookAt's collapse guard), so a
  // floor at half of it never engages in legitimate flight; it exists purely
  // to make the sign flip impossible by construction.
  clampMin: LOOKAT_MIN_HORIZONTAL_DISTANCE / 2,
}

/**
 * One frame of a bounded second-order follower — the one smoothing shape this
 * module uses for every rendered degree of freedom that must never snap (the
 * roll since #91; the view yaw/pitch/distance triplet since #105): the rate
 * approaches the demand `(target - value) / responseTime` (clamped to
 * ±maxRate) at no more than maxAccel per second, and the value integrates
 * that rate — bounded rate *and* bounded acceleration, so the followed signal
 * is C1-smooth by construction where a plain rate limiter steps its velocity
 * instantly on saturation/release/target flips. `angular` computes the demand
 * through the shortest arc (for the wrapping yaw). Pure `state -> state`,
 * like everything else in this module.
 */
function stepBoundedFollower(
  value: number,
  rate: number,
  target: number,
  delta: number,
  limits: FollowerLimits,
  angular = false,
): { value: number; rate: number } {
  let remaining = delta
  while (remaining > 1e-9) {
    const h = Math.min(remaining, FOLLOWER_MAX_SUBSTEP)
    const error = angular ? angleDelta(value, target) : target - value
    const desired = clamp(error / limits.responseTime, -limits.maxRate, limits.maxRate)
    rate = approach(rate, desired, limits.maxAccel * h)
    value += rate * h
    if (limits.clampMin !== undefined) {
      value = Math.max(value, limits.clampMin)
    }
    if (limits.clampMax !== undefined) {
      value = Math.min(value, limits.clampMax)
    }
    remaining -= h
  }
  return { value, rate }
}

/** Orbit-and-bob fallback tuning (single Tower / empty scene — see {@link createDemoTour}). */
const ORBIT_RADIUS = TOWER_SPACING * 2.2
const ORBIT_ALTITUDE_BASE = TOWER_HEIGHT * 0.9
const ORBIT_BOB_AMPLITUDE = TOWER_HEIGHT * 0.3
const ORBIT_BOB_PERIOD_SECONDS = 14
/** One full revolution every 50 seconds — a slow, steady circle, not a spin. */
const ORBIT_ANGULAR_SPEED = (2 * Math.PI) / 50

// ---------------------------------------------------------------------------
// Scene-height-aware altitude bands (#59 follow-up)
// ---------------------------------------------------------------------------

/**
 * Every altitude-band constant above (`CANYON_ALTITUDE_MIN/MAX`,
 * `OVERVIEW_ALTITUDE_MIN/MAX`, `OVERVIEW_WIDE_APEX_MAX`,
 * `CLIMB_LEVELOFF_DISTANCE`, `LOOKAT_AIM_CEILING/FLOOR`,
 * `ORBIT_ALTITUDE_BASE/BOB_AMPLITUDE`, and the Tower roofline itself) bundled
 * as one value, scaled to the scene's ACTUAL Tower height rather than baked
 * in against the resting {@link TOWER_HEIGHT}.
 *
 * #59 lets every Tower in a busy scene grow uniformly taller than
 * `TOWER_HEIGHT` (`panelLayout.ts`'s `sceneTowerHeight`, applied scene-wide so
 * the skyline stays level); before this type existed every one of Demo Mode's
 * altitude thresholds stayed pinned to the resting height regardless — the
 * "over the rooftops" overview band could fly *below* the real roofline of a
 * grown scene, and the Tower-box clearance ({@link towerBoxClearance}) measured
 * against a shorter box than the one actually rendered, so the showcase
 * camera clipped through Towers at exactly the scale #59 exists to support.
 *
 * Every field keeps the same *fraction* of the roofline the resting-height
 * constant above was tuned at (e.g. `OVERVIEW_ALTITUDE_MIN = TOWER_HEIGHT *
 * 1.1` becomes `rooflineY * 1.1`), so the carefully-tuned *feel* — how far
 * above the roofline an overview cruises, how gently a climb levels off — is
 * preserved exactly at any scene height, and every field here is
 * byte-identical to its bare exported constant above when `rooflineY ===
 * TOWER_HEIGHT` (the resting-height case every pre-#59 test exercises, via
 * {@link DEFAULT_ALTITUDE_BANDS}).
 */
interface AltitudeBands {
  /** World-space Y of the scene's actual Tower roofline (every Tower's prism top — uniform, #59). */
  rooflineY: number
  canyonMin: number
  canyonMax: number
  overviewMin: number
  overviewMax: number
  overviewWideApexMax: number
  climbLeveloffDistance: number
  aimCeiling: number
  aimFloor: number
  orbitAltitudeBase: number
  orbitBobAmplitude: number
}

/** Builds the {@link AltitudeBands} for a scene whose Tower roofline sits at `rooflineY` — see that type's doc comment. */
function altitudeBandsForRoofline(rooflineY: number): AltitudeBands {
  const scale = rooflineY / TOWER_HEIGHT
  return {
    rooflineY,
    canyonMin: CANYON_ALTITUDE_MIN * scale,
    canyonMax: CANYON_ALTITUDE_MAX * scale,
    overviewMin: OVERVIEW_ALTITUDE_MIN * scale,
    overviewMax: OVERVIEW_ALTITUDE_MAX * scale,
    overviewWideApexMax: OVERVIEW_WIDE_APEX_MAX * scale,
    climbLeveloffDistance: CLIMB_LEVELOFF_DISTANCE * scale,
    aimCeiling: LOOKAT_AIM_CEILING * scale,
    aimFloor: LOOKAT_AIM_FLOOR * scale,
    orbitAltitudeBase: ORBIT_ALTITUDE_BASE * scale,
    orbitBobAmplitude: ORBIT_BOB_AMPLITUDE * scale,
  }
}

/**
 * The altitude bands at the resting {@link TOWER_HEIGHT} — field-for-field
 * identical to the bare exported constants above. The default every
 * altitude-consuming function below falls back to, so every caller that
 * predates #59's scene-height awareness (and every test that never passes a
 * grown scene) is completely unaffected.
 */
const DEFAULT_ALTITUDE_BANDS: AltitudeBands = altitudeBandsForRoofline(TOWER_HEIGHT)

/**
 * The scene-wide roofline Y for a set of Tower `placements`: #59 renders
 * every Tower in a scene at the SAME uniform height, so any one placement's
 * Y-centre doubled (a Tower's centre sits at `height / 2`, resting on the
 * floor at y = 0 — see `towerLayout.ts`'s `towerPlacements`) already *is* the
 * whole scene's roofline — no separate "scene height" input needs to be
 * threaded in alongside `placements`, matching ADR-0010's "derived from the
 * real Tower placements … no magic numbers" property. Falls back to the
 * resting {@link TOWER_HEIGHT} for an empty scene (mirroring {@link
 * fallbackCenter}'s degenerate-scene handling).
 */
function rooflineFromPlacements(placements: readonly TowerPlacement[]): number {
  return placements.length === 0 ? TOWER_HEIGHT : placements[0].position[1] * 2
}

/**
 * {@link altitudeBandsForRoofline} for `placements`' scene-wide roofline
 * ({@link rooflineFromPlacements}), short-circuiting to the already-built
 * {@link DEFAULT_ALTITUDE_BANDS} at the (overwhelmingly common — most scenes
 * never grow past it) resting height instead of allocating an equal-valued
 * object fresh. {@link stepDemoTour} calls this every frame, so skipping the
 * allocation on the common path is cheap render-loop garbage avoided for
 * free — a grown scene still recomputes (and re-allocates) exactly as before.
 */
function bandsForPlacements(placements: readonly TowerPlacement[]): AltitudeBands {
  const rooflineY = rooflineFromPlacements(placements)
  return rooflineY === TOWER_HEIGHT ? DEFAULT_ALTITUDE_BANDS : altitudeBandsForRoofline(rooflineY)
}

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
 * A takeoff's horizontal approach direction (unit-ish `{x, z}`): how the
 * camera flies *into* the entry node when a tour takes flight from an
 * off-lattice activation pose. The walk's first move must respect it — see
 * {@link candidateMoves}.
 */
interface ApproachDirection {
  readonly x: number
  readonly z: number
}

/** The alignment (`[-1, 1]`) between a lattice move's world direction and a takeoff approach. */
function approachAlignment(approach: ApproachDirection, move: LatticeMove): number {
  return approach.x * move.di + approach.z * move.dj
}

/**
 * The legal next moves from `coord`, given the move that led into it
 * (`null` at the very start of a tour). Immediate backtracking is forbidden
 * outright (ADR-0010) — filtered out, not merely down-weighted — *unless* it
 * is the only legal move at all (a dead end, e.g. the end of a 1×N line
 * cluster), in which case it's the sole candidate rather than a stuck walk.
 *
 * `approach` (takeoff only, #91 smoothness pass) plays the role `prevMove`
 * plays mid-walk, for the very first move of a tour that flew in from an
 * off-lattice activation pose: only moves that *continue* the approach
 * (positive alignment — a turn of at most 90°) are kept, because the walk
 * knows nothing of the takeoff otherwise and could draw a first waypoint
 * that hairpins ≥135° against the arrival direction — instrumented as the
 * single sharpest kink of the whole route (~130 world-units/s² right at the
 * entry node). Falls back to every in-bounds move if none aligns (an
 * approach dead-ended against the lattice boundary).
 */
function candidateMoves(
  graph: CanyonGraph,
  coord: LatticeCoord,
  prevMove: LatticeMove | null,
  approach: ApproachDirection | null = null,
): LatticeMove[] {
  const inBounds = LATTICE_MOVES.filter((m) => isInBounds(graph, coord.i + m.di, coord.j + m.dj))
  if (approach) {
    const aligned = inBounds.filter((m) => approachAlignment(approach, m) > 1e-9)
    if (aligned.length > 0) {
      return aligned
    }
  }
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
  approach: ApproachDirection | null = null,
): number {
  let weight =
    prevMove && move.di === prevMove.di && move.dj === prevMove.dj ? STRAIGHT_WEIGHT : TURN_WEIGHT
  if (approach) {
    // Takeoff: prefer the move that best continues the approach direction,
    // scaled between the ordinary turn/straight weights.
    weight =
      TURN_WEIGHT + (STRAIGHT_WEIGHT - TURN_WEIGHT) * Math.max(0, approachAlignment(approach, move))
  }
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
  approach: ApproachDirection | null = null,
): { move: LatticeMove; nextState: number } {
  const candidates = candidateMoves(graph, coord, prevMove, approach)
  const weights = candidates.map((m) => moveWeight(graph, coord, m, prevMove, approach))
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
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
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
    // Gap exhausted: this waypoint begins a new overview episode — a *wide*
    // (and one-waypoint-shorter) one when the drawn apex is shallow (see
    // OVERVIEW_WIDE_EPISODE_WAYPOINTS / OVERVIEW_WIDE_APEX_MAX).
    const apexRoll = mulberry32Step(rngState)
    const apexAltitude =
      bands.overviewMin + apexRoll.value * (bands.overviewMax - bands.overviewMin)
    const episodeWaypoints = isWideApex(apexAltitude, bands)
      ? OVERVIEW_WIDE_EPISODE_WAYPOINTS
      : OVERVIEW_EPISODE_WAYPOINTS
    return {
      altitude: apexAltitude,
      isOverview: true,
      program: { mode: 'overview', waypointsLeft: episodeWaypoints - 1, apexAltitude },
      nextState: apexRoll.nextState,
    }
  }
  const jitterRoll = mulberry32Step(rngState)
  return {
    altitude: bands.canyonMin + jitterRoll.value * (bands.canyonMax - bands.canyonMin),
    isOverview: false,
    program: { mode: 'canyon', waypointsLeft: program.waypointsLeft - 1, apexAltitude: 0 },
    nextState: jitterRoll.nextState,
  }
}

/** Whether an overview episode with this apex is a *wide* one — see {@link OVERVIEW_WIDE_APEX_MAX}. */
function isWideApex(apexAltitude: number, bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS): boolean {
  return apexAltitude <= bands.overviewWideApexMax
}

/**
 * Whether the waypoint just drawn under `program` belongs to the *wide*
 * phase of a wide overview episode. Three gates, all serving one constraint
 * — widened legs must only ever convert existing above-the-roofline
 * apex-cruise time, never canyon time (the "zip" floor):
 *
 * - only *shallow-apex* episodes go wide ({@link OVERVIEW_WIDE_APEX_MAX});
 * - the climb gets {@link OVERVIEW_WIDE_START_WAYPOINT} waypoints of run
 *   before the route swings out;
 * - the episode's final apex waypoint (`mode` already back to `'canyon'` on
 *   that draw) stays on the ordinary ring so the descent starts close-in.
 */
function isWideOverviewDraw(
  program: AltitudeProgram,
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): boolean {
  return (
    program.mode === 'overview' &&
    isWideApex(program.apexAltitude, bands) &&
    program.waypointsLeft <= OVERVIEW_WIDE_EPISODE_WAYPOINTS - 1 - OVERVIEW_WIDE_START_WAYPOINT
  )
}

/** One drawn waypoint: its lattice coordinate, resolved world position (with altitude), and overview flag. */
interface DrawnWaypoint {
  coord: LatticeCoord
  position: Vector3
  isOverview: boolean
}

/** Draws the next waypoint from `coord`/`prevMove`: a lattice move plus the altitude program's next step. `approach` biases a takeoff's first move — see {@link candidateMoves}. */
function drawNextWaypoint(
  graph: CanyonGraph,
  coord: LatticeCoord,
  prevMove: LatticeMove | null,
  program: AltitudeProgram,
  rngState: number,
  approach: ApproachDirection | null = null,
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): { waypoint: DrawnWaypoint; move: LatticeMove; program: AltitudeProgram; nextState: number } {
  const picked = pickNextMove(graph, coord, prevMove, rngState, approach)
  const nextCoord: LatticeCoord = { i: coord.i + picked.move.di, j: coord.j + picked.move.dj }
  const altitude = drawAltitude(picked.nextState, program, bands)
  const position = new Vector3(graph.xs[nextCoord.i], altitude.altitude, graph.zs[nextCoord.j])
  // A wide overview episode's wide phase (#105 iteration 4 — see
  // OVERVIEW_PERIMETER_EXTRA): waypoints on a *straight* stretch of
  // perimeter line swing outward, so the tour flies wide-and-high past the
  // cluster edge for a beat — the occasional hero overview — and returns to
  // the tight ring as the episode ends. Ring-corner nodes (boundary in both
  // axes) stay put so the 90° ring-corner geometry is never reshaped (at
  // wider offsets the reshaped corners measurably sharpened toward the cusp
  // guard). A pure function of the drawn state (deterministic per ADR-0010),
  // derived from TOWER_SPACING (scale-free).
  if (isWideOverviewDraw(altitude.program, bands)) {
    const onWest = nextCoord.i === 0
    const onEast = nextCoord.i === graph.xs.length - 1
    const onNorth = nextCoord.j === 0
    const onSouth = nextCoord.j === graph.zs.length - 1
    const boundaryX = onWest || onEast
    const boundaryZ = onNorth || onSouth
    if (boundaryX && !boundaryZ) {
      position.x += onWest ? -OVERVIEW_PERIMETER_EXTRA : OVERVIEW_PERIMETER_EXTRA
    } else if (boundaryZ && !boundaryX) {
      position.z += onNorth ? -OVERVIEW_PERIMETER_EXTRA : OVERVIEW_PERIMETER_EXTRA
    }
  }
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
function applyGlance(
  position: Vector3,
  target: Vector3,
  glance: GlanceState,
  envelopeScale: number = 1,
): Vector3 {
  if (!glance.active) {
    return target
  }
  const t = clamp01(glance.elapsed / glance.durationSeconds)
  const offset = glance.angle * Math.sin(Math.PI * t) * envelopeScale
  if (Math.abs(offset) < 1e-6) {
    return target
  }
  return target.clone().sub(position).applyAxisAngle(UP_AXIS, offset).add(position)
}

// ---------------------------------------------------------------------------
// Spline sampling
// ---------------------------------------------------------------------------

/**
 * The spline's sliding control polygon: `window[0]` shapes the entry tangent
 * (history), `window[1] -> window[2]` is the piece currently being flown, and
 * everything after `window[2]` is already-drawn future route. Two structural
 * properties, one from each #105 pass:
 *
 * - **Corner rounding** (iteration 2 — see {@link CORNER_TURN_RADIUS} and
 *   {@link expandWaypoint}): lattice waypoints are no longer control points
 *   verbatim. A waypoint the walk flies straight through enters the polygon
 *   as itself; a waypoint where the walk turns is replaced by a *pair* of
 *   points — one a turn radius back along the incoming leg, one a turn
 *   radius out along the outgoing leg — so the spline arcs around the corner
 *   instead of pivoting on the node. This makes the window variable-length:
 *   a corner-dense stretch packs more control points into the same ground
 *   distance than a straightaway.
 * - **A measured look-ahead guarantee** (replacing iteration 1's counted
 *   one): the on-path look-ahead aims a fixed {@link
 *   LOOKAT_LOOKAHEAD_DISTANCE} of arc ahead, and before #105 the window's
 *   arc table could run out mid-segment — the aim demand pinned at the table
 *   end for ~40% of all frames and teleported a median ~3.9 world units at
 *   every rollover (the "bolted-together segments" rhythm at its source).
 *   Iteration 1 fixed that by counting future waypoints (two future
 *   segments ≥ the look-ahead, since canyon lines are ≥ one Tower spacing
 *   apart); with corner rounding a "future control point" no longer implies
 *   any fixed amount of future arc, so {@link extendWindow} instead
 *   replenishes the polygon until the *measured* final-shape arc covers the
 *   current travel plus the full look-ahead. Same guarantee — the aim demand
 *   never pins and never samples a provisional piece — enforced by
 *   measurement rather than by counting.
 *
 * A Catmull-Rom piece's shape depends on its four surrounding points, so the
 * polygon's *last* piece is provisional (an open curve reflects its missing
 * end point) and refines when the next control point lands. The arc table
 * therefore spans only pieces `1 .. length-3` — every piece it (and the
 * look-ahead) can reach has its final shape by construction. Catmull-Rom
 * locality is also why appending points never changes the flown piece:
 * `window[1] -> window[2]` is shaped by `window[0..3]` alone.
 */
type SplineWindow = readonly Vector3[]

/**
 * The chord length a rounded corner's on-arc control points aim for (#105
 * iteration 3 — replacing a fixed angular step): the spacing at which a
 * centripetal Catmull-Rom demonstrably hugs an arc without wiggling. A fixed
 * angular step made chord length *scale with the radius and turn angle*
 * (chord = 2·r·sin(step/2)), so small radii or small turn angles produced
 * tiny chords flanked by full-length canyon legs — the exact unequal-chord
 * regime that whips the CR tangent (measured: a 45° takeoff corner's 0.55u
 * chords spiked the heading rate to ~6 rad/s at activation; an early
 * chamfer-pair variant with a 0.4u chord hit ~100 rad/s). Targeting a fixed
 * *chord length* instead keeps the sampling in the proven-stable scale at
 * every radius and angle — down to a single apex point for small turns,
 * which an open CR rounds smoothly by itself.
 */
export const CORNER_ARC_TARGET_CHORD = TOWER_SPACING * 0.2

/**
 * Expands one raw walk waypoint into its spline control points (#105
 * iteration 2 — the corner rounding {@link CORNER_TURN_RADIUS} documents).
 * Straight-through waypoints pass through unchanged. A corner is replaced by
 * points sampled on the exact inscribed circular arc of radius
 * {@link CORNER_TURN_RADIUS} tangent to both legs — spaced to chords of
 * roughly {@link CORNER_ARC_TARGET_CHORD} — shrunk where a leg is too short
 * for the tangent offset ({@link CORNER_MAX_LEG_FRACTION}, so neighbouring
 * corners' points never collide or reorder). A turn so sharp that the
 * shrunken radius falls below {@link CORNER_MIN_TURN_RADIUS} (a near-exact
 * hairpin) keeps its sharp node. All points carry the waypoint's own drawn
 * altitude, so the altitude program's rhythm is untouched by the expansion.
 * Pure geometry over three consecutive raw positions — the lattice/graph
 * logic above knows nothing of it.
 */
function expandWaypoint(previous: Vector3, current: Vector3, next: Vector3): Vector3[] {
  const inX = current.x - previous.x
  const inZ = current.z - previous.z
  const outX = next.x - current.x
  const outZ = next.z - current.z
  const lengthIn = Math.hypot(inX, inZ)
  const lengthOut = Math.hypot(outX, outZ)
  if (lengthIn < 1e-9 || lengthOut < 1e-9) {
    return [current.clone()]
  }
  const uInX = inX / lengthIn
  const uInZ = inZ / lengthIn
  const uOutX = outX / lengthOut
  const uOutZ = outZ / lengthOut
  const cross = uInX * uOutZ - uInZ * uOutX
  const dot = uInX * uOutX + uInZ * uOutZ
  const turnAngle = Math.abs(Math.atan2(cross, dot))
  if (turnAngle < CORNER_MIN_TURN_ANGLE) {
    return [current.clone()]
  }
  // The tangent offset `d` along each leg for an inscribed arc of the
  // desired radius (d = r·tan(θ/2)); where a leg is too short for that
  // offset, the offset is clamped and the radius shrinks to match. As the
  // turn approaches a hairpin, tan(θ/2) → ∞ drives the clamped radius
  // toward zero — the CORNER_MIN_TURN_RADIUS floor below then bails to the
  // sharp node (this also covers exact 180°, where the arc construction
  // itself would degenerate: cross = 0 ⇒ no turn side).
  const tangentOffset = Math.min(
    CORNER_TURN_RADIUS * Math.tan(turnAngle / 2),
    CORNER_MAX_LEG_FRACTION * lengthIn,
    CORNER_MAX_LEG_FRACTION * lengthOut,
  )
  const radius = tangentOffset / Math.tan(turnAngle / 2)
  if (radius < CORNER_MIN_TURN_RADIUS) {
    return [current.clone()]
  }
  // The arc's centre sits one radius inside the turn from the entry tangent
  // point, perpendicular to the incoming leg.
  const entryX = current.x - uInX * tangentOffset
  const entryZ = current.z - uInZ * tangentOffset
  const side = Math.sign(cross)
  const centerX = entryX + side * -uInZ * radius
  const centerZ = entryZ + side * uInX * radius
  // The angular step that yields chords of ~CORNER_ARC_TARGET_CHORD at this
  // radius (chord = 2·r·sin(step/2)); rounded — not ceiled — to the nearest
  // whole number of steps so the realized chords stay as close to the target
  // as the turn allows, with a single apex point as the small-turn floor.
  const idealStep = 2 * Math.asin(Math.min(1, CORNER_ARC_TARGET_CHORD / (2 * radius)))
  const steps = Math.max(1, Math.round(turnAngle / idealStep))
  const points: Vector3[] = []
  // Rotate the centre->entry spoke through the signed turn, sampling at the
  // *midpoints* of the angular steps (never the tangent endpoints): when two
  // corners abut across a short straight remnant, tangent-endpoint control
  // points sat only ~0.4 units apart across the remnant and the Catmull-Rom
  // wiggled between them (~6 rad/s heading blips); interior-only samples
  // keep neighbouring chords uniform, and the spline's natural rounding
  // through them supplies the tangency the endpoints provided.
  const spokeX = entryX - centerX
  const spokeZ = entryZ - centerZ
  for (let i = 0; i < steps; i++) {
    const angle = (-side * turnAngle * (i + 0.5)) / steps
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    points.push(
      new Vector3(
        centerX + spokeX * cos + spokeZ * sin,
        current.y,
        centerZ - spokeX * sin + spokeZ * cos,
      ),
    )
  }
  return points
}

/**
 * The horizontal (x, z) Catmull-Rom the route is actually flown on (#105
 * iteration 2): the control points' Y is the *altitude-target metadata* the
 * glide-slope pursuit chases (see `CanyonTourState.altitude`) — it was never
 * the rendered altitude — but feeding it into a 3D curve let it warp the
 * horizontal path: a big waypoint-to-waypoint altitude change (an overview
 * episode boundary) landing on a short corner-rounded piece dominated the
 * centripetal parameterization (a 0.4-unit horizontal chord read as a
 * ~6-unit 3D chord), and the horizontal projection looped — instrumented at
 * up to ~186 rad/s of heading (a spin cusp), the worst single artefact of
 * the whole route. Flattening Y out of the curve makes the flown ground path
 * a pure function of the route's horizontal geometry, which is the one the
 * viewer experiences: rendered altitude comes from the pursuit, and the
 * aim's altitude from {@link splineAltitudeAt}.
 */
function flattenedCurve(window: SplineWindow): CatmullRomCurve3 {
  return new CatmullRomCurve3(
    window.map((p) => new Vector3(p.x, 0, p.z)),
    false,
    CATMULL_ROM_TYPE,
  )
}

/**
 * The route's altitude-target at an extended piece-local `t` — the linear
 * blend of the two surrounding control points' drawn altitudes. Only the
 * *aim* reads this (the camera's own altitude is the glide-slope pursuit's),
 * and the aim target is clamped into the aim window and eased through the
 * view pitch follower downstream, so linear is plenty smooth.
 */
function splineAltitudeAt(window: SplineWindow, localT: number): number {
  const t = clamp(localT, 0, tablePieceCount(window))
  const piece = Math.min(Math.floor(t), tablePieceCount(window) - 1)
  const fraction = t - piece
  return window[1 + piece].y + (window[2 + piece].y - window[1 + piece].y) * fraction
}

/**
 * Samples a {@link SplineWindow} at `localT` in `[0, 1]` (0 = `window[1]`, 1 =
 * `window[2]`). Builds the flattened curve over the whole polygon but only
 * ever reads the `window[1] -> window[2]` slice of its parameter range — the
 * standard trick for an open, C1-continuous Catmull-Rom segment that still has
 * the outer points to shape its tangents at both ends, so consecutive segments
 * meet with matching position *and* velocity (no teleport, no kink). The
 * returned position/tangent are horizontal (y = 0) — see {@link
 * flattenedCurve}; every consumer reads only their x/z.
 */
function sampleSpline(
  window: SplineWindow,
  localT: number,
): { position: Vector3; tangent: Vector3 } {
  const curve = flattenedCurve(window)
  const globalT = (1 + clamp01(localT)) / (window.length - 1)
  return { position: curve.getPoint(globalT), tangent: curve.getTangent(globalT).normalize() }
}

/**
 * Number of subdivisions used to measure a piece's horizontal arc length.
 * At piece lengths up to two Tower spacings this puts samples a small
 * fraction of a world unit apart — the piecewise-linear inversion's speed
 * ripple is far below anything visible.
 */
const ARC_LENGTH_SAMPLES = 64

/** How many spline pieces a window's arc table spans: every final-shape piece from the flown one on — see {@link SplineWindow}. */
function tablePieceCount(window: SplineWindow): number {
  return window.length - 3
}

/**
 * The cumulative *horizontal* (x, z) arc length along the flyable remainder
 * of the sliding window — the flown piece (`window[1] -> window[2]`, `localT`
 * 0..1) plus every already-final future piece (see {@link SplineWindow}) —
 * at {@link ARC_LENGTH_SAMPLES} evenly spaced stations per piece. Two
 * consumers:
 *
 * - the tour's advance: turning "move `CANYON_TRAVEL_SPEED × delta` world
 *   units of ground travel" into a spline parameter (see
 *   {@link arcDistanceToLocalT}) — constant ground speed by construction,
 *   where advancing `t` uniformly made the speed wobble through corners and
 *   hitch at segment boundaries (the "~42s stutter");
 * - the look-at: the forward aim point sits a fixed *arc distance ahead on
 *   the future flight path* (see {@link stepDemoTour}), which is why the
 *   table extends across the future pieces — and why {@link extendWindow}
 *   grows the window until the table provably outreaches the look-ahead.
 *
 * Horizontal (not 3D) arc length on purpose: the camera's rendered altitude
 * is the glide-slope pursuit's (`state.altitude`), not the spline's own Y,
 * so ground distance is the one the viewer actually experiences.
 */
function segmentHorizontalArc(window: SplineWindow): number[] {
  const curve = flattenedCurve(window)
  const cumulative = [0]
  let previous = curve.getPoint(1 / (window.length - 1))
  const pieces = tablePieceCount(window)
  for (let i = 1; i <= pieces * ARC_LENGTH_SAMPLES; i++) {
    const point = curve.getPoint((1 + i / ARC_LENGTH_SAMPLES) / (window.length - 1))
    cumulative.push(cumulative[i - 1] + Math.hypot(point.x - previous.x, point.z - previous.z))
    previous = point
  }
  return cumulative
}

/** Samples the window at an extended `localT` — reaching into the already-known future pieces the arc table spans, for the on-path look-ahead. Horizontal position from the flattened curve; altitude from {@link splineAltitudeAt}. */
function sampleSplineExtended(window: SplineWindow, localT: number): Vector3 {
  const curve = flattenedCurve(window)
  const t = clamp(localT, 0, tablePieceCount(window))
  const point = curve.getPoint((1 + t) / (window.length - 1))
  point.y = splineAltitudeAt(window, t)
  return point
}

/** The current segment's (`window[1] -> window[2]`) total horizontal arc length off a {@link segmentHorizontalArc} table. */
function segmentArcLength(cumulative: readonly number[]): number {
  return cumulative[ARC_LENGTH_SAMPLES]
}

/**
 * Inverts a {@link segmentHorizontalArc} table: the piece-local `t` (in
 * `[0, pieceCount]` — the table spans the flown piece *and* every known
 * final-shape future piece) at which `distance` world units of horizontal
 * travel have been covered. Clamps to the table's extent.
 */
function arcDistanceToLocalT(cumulative: readonly number[], distance: number): number {
  const total = cumulative[cumulative.length - 1]
  if (total <= 1e-9) {
    return 1
  }
  const d = clamp(distance, 0, total)
  let i = 1
  while (i < cumulative.length - 1 && cumulative[i] < d) {
    i++
  }
  const span = cumulative[i] - cumulative[i - 1]
  const fraction = span > 1e-12 ? (d - cumulative[i - 1]) / span : 1
  return (i - 1 + fraction) / ARC_LENGTH_SAMPLES
}

/**
 * The horizontal heading (radians) of a travel direction — the signal whose
 * per-frame rate of change drives the bank target (see
 * {@link bankTargetFromYawRate}). `fallback` covers a (never walk-produced)
 * vertical tangent, so the heading never degenerates to `atan2(0, 0)`.
 */
function horizontalHeading(tangent: Vector3, fallback: number): number {
  if (Math.hypot(tangent.x, tangent.z) < 1e-9) {
    return fallback
  }
  return Math.atan2(tangent.x, tangent.z)
}

/**
 * Decomposes a look-at `target` relative to `position` into the eased view
 * triplet's coordinates (see {@link VIEW_YAW_MAX_RATE}). The horizontal
 * distance is never below {@link LOOKAT_MIN_HORIZONTAL_DISTANCE} for a
 * {@link demandDrivenLookAt} output, so the yaw is always well-conditioned.
 */
function viewTripletTo(
  position: Vector3,
  target: Vector3,
): { yaw: number; pitch: number; distance: number } {
  const dx = target.x - position.x
  const dy = target.y - position.y
  const dz = target.z - position.z
  const horizontal = Math.hypot(dx, dz)
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.atan2(dy, horizontal),
    distance: Math.hypot(dx, dy, dz),
  }
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
  rooflineY: number = TOWER_ROOFLINE_Y,
): number {
  const halfFootprint = TOWER_FOOTPRINT / 2
  const dx = Math.max(0, Math.abs(point.x - towerPosition[0]) - halfFootprint)
  const dz = Math.max(0, Math.abs(point.z - towerPosition[2]) - halfFootprint)
  const dy = Math.max(0, point.y - rooflineY, -point.y)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * The blend weight (`[0, LOOKAT_TOWER_PULL_MAX]`) the look-at should pull
 * toward the nearest Tower, and that Tower's anchor point — ADR-0010's
 * demand-driven blend. The anchor sits on the Tower's vertical axis at the
 * *aim's own altitude* (clamped into the aim window), not at the roofline:
 * the pull frames Towers *horizontally* and leaves the aim's pitch to the
 * flown-gradient gaze (#105 iteration 4). Anchoring at the roofline — as
 * every version through iteration 3 did — dragged the aim toward Tower tops
 * whenever the pull engaged, which iteration 3's stronger/earlier pull
 * turned into the maintainer's "captain always cranking his head up" (and
 * drove the aim-ceiling clamp share from 0.04-0.08 to 0.10-0.13, with
 * clamp-frame pitch-acceleration spikes to 14.7 rad/s² as the clamp pinned
 * the aim's altitude against the camera's own climb). `point` is expected to be the forward look-ahead point
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
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): { point: Vector3; strength: number } {
  if (placements.length === 0) {
    return { point: point.clone(), strength: 0 }
  }
  let nearest = placements[0]
  let nearestClearance = Infinity
  for (const placement of placements) {
    const clearance = towerBoxClearance(point, placement.position, bands.rooflineY)
    if (clearance < nearestClearance) {
      nearestClearance = clearance
      nearest = placement
    }
  }
  const strength =
    LOOKAT_TOWER_PULL_MAX *
    smoothstep(LOOKAT_NEAR_CLEARANCE, LOOKAT_FAR_CLEARANCE, nearestClearance)
  // Horizontal-only pull: the anchor keeps the aim point's own (already
  // window-clamped) altitude, so the blend can steer the aim's yaw onto a
  // Tower without ever steering its pitch (see the doc comment).
  return {
    point: new Vector3(
      nearest.position[0],
      clamp(point.y, bands.aimFloor, bands.aimCeiling),
      nearest.position[2],
    ),
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
 *   ±{@link MAX_CLIMB_GRADIENT} and scaled by
 *   {@link LOOKAT_GAZE_GRADIENT_FACTOR} (#105 iteration 4) — the gentle gaze
 *   tilt of the pitch the camera's own glide-slope-limited motion can
 *   actually fly. The raw spline slope between a canyon waypoint and an
 *   episode apex can exceed 2.0 (~64°); aiming along *that* is exactly the
 *   old "crane up into black sky on a climb-out / stare at the floor on a
 *   dive" bug, and even the full flyable ±23° slope reads as the captain
 *   craning his head (the iteration-4 finding).
 * - The result is then clamped into [{@link LOOKAT_AIM_FLOOR},
 *   {@link LOOKAT_AIM_CEILING}] — into the canyon, onto the Towers, never
 *   above the roofline (see those constants' doc comment).
 *
 * Both stages are continuous in the camera's position and tangent, so the aim
 * pitches gradually with the (already eased) climb — no snap, the
 * motion-sickness guardrail.
 *
 * **Reached only through {@link demandDrivenLookAt} — the test-facing seam,
 * not the production path** (true since #105 iteration 2 made the live aim
 * an *on-path* point): {@link stepDemoTour} builds its forward point from
 * {@link sampleSplineExtended} and sets its altitude from the flown
 * `climbGradient` directly. This helper mirrors that rule — same look-ahead
 * distance, same gaze-factor scaling, same window clamp — with the
 * *tangent's* gradient standing in for the flown one (a stateless helper
 * has no glide-slope pursuit to read; on the flattened horizontal tangents
 * the production spline yields, both are simply "level"). If the production
 * aim rule changes, change this to match — the demandDrivenLookAt unit
 * tests exercise the blend/guardrail composition through it.
 */
function forwardLookAheadPoint(
  position: Vector3,
  tangent: Vector3,
  bounds: AimBounds | null = null,
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): Vector3 {
  const horizontalLength = Math.hypot(tangent.x, tangent.z)
  if (horizontalLength < 1e-9) {
    // Degenerate (never produced by the walk: adjacent waypoints always
    // differ horizontally) — fall back to the raw tangent rather than a
    // zero-length look direction.
    const fallback = position.clone().addScaledVector(tangent, LOOKAT_LOOKAHEAD_DISTANCE)
    fallback.y = clamp(fallback.y, bands.aimFloor, bands.aimCeiling)
    return clampToAimBounds(fallback, bounds)
  }
  const flyableGradient = clamp(
    tangent.y / horizontalLength,
    -MAX_CLIMB_GRADIENT,
    MAX_CLIMB_GRADIENT,
  )
  return clampToAimBounds(
    new Vector3(
      position.x + (tangent.x / horizontalLength) * LOOKAT_LOOKAHEAD_DISTANCE,
      clamp(
        position.y + flyableGradient * LOOKAT_GAZE_GRADIENT_FACTOR * LOOKAT_LOOKAHEAD_DISTANCE,
        bands.aimFloor,
        bands.aimCeiling,
      ),
      position.z + (tangent.z / horizontalLength) * LOOKAT_LOOKAHEAD_DISTANCE,
    ),
    bounds,
  )
}

/**
 * The horizontal region the forward look-ahead is confined to (#91 smoothness
 * pass): the Canyon graph's own extent — perimeter ring included. On a
 * perimeter pass the raw look-ahead projects straight past the ring into the
 * black outside the cluster (a corner's outward-bulging tangent especially),
 * which is exactly the "aims into the void" family of bug the void-clearance
 * invariant polices. Clamping the *forward point* (never the pull anchor,
 * which is always a Tower) back onto the graph's bounds keeps the baseline
 * aim on the cluster — on a perimeter straightaway the point sits on the ring
 * itself, aimed down the corridor, so nothing changes where the aim was
 * already sane. A continuous (1-Lipschitz) clamp, so it can never introduce a
 * snap of its own.
 */
interface AimBounds {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

function graphAimBounds(graph: CanyonGraph): AimBounds {
  return {
    minX: graph.xs[0],
    maxX: graph.xs[graph.xs.length - 1],
    minZ: graph.zs[0],
    maxZ: graph.zs[graph.zs.length - 1],
  }
}

function clampToAimBounds(point: Vector3, bounds: AimBounds | null): Vector3 {
  if (!bounds) {
    return point
  }
  point.x = clamp(point.x, bounds.minX, bounds.maxX)
  point.z = clamp(point.z, bounds.minZ, bounds.maxZ)
  return point
}

/**
 * The demand-driven look-at target: the forward look-ahead point ({@link
 * forwardLookAheadPoint}), blended toward `pullPoint` by `lookAtBlend`, then
 * a seeded {@link applyGlance} on top. **Test-facing seam**: production
 * ({@link stepDemoTour}) composes the same blend via {@link composeLookAt}
 * with its own on-path forward point — see forwardLookAheadPoint's doc
 * comment. Both blend inputs are threaded in
 * *already eased* — see {@link stepDemoTour} — so this function itself never
 * snaps: `lookAtBlend`'s rate of change is capped at {@link
 * LOOKAT_BLEND_RATE}/s, and `pullPoint` (the Tower anchor the blend aims
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
  bounds: AimBounds | null = null,
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): Vector3 {
  return composeLookAt(
    position,
    forwardLookAheadPoint(position, tangent, bounds, bands),
    lookAtBlend,
    pullPoint,
    glance,
  )
}

/**
 * The blend/guardrail half of {@link demandDrivenLookAt}, taking the forward
 * aim point explicitly: {@link stepDemoTour} feeds it the *on-path*
 * look-ahead (a point a fixed arc distance ahead on the future flight path —
 * which leads into turns and stays inside the canyon system by construction)
 * rather than a tangent projection.
 */
function composeLookAt(
  position: Vector3,
  forward: Vector3,
  lookAtBlend: number,
  pullPoint: Vector3,
  glance: GlanceState,
): Vector3 {
  const blended = forward.clone().lerp(pullPoint, lookAtBlend)
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
  // A glance is a beat of *looking at a passing Tower* — it makes no sense
  // while the pull is engaged (the aim is already deficient: near the cluster
  // edge, an overview hop, a turn into open space), where swinging the aim
  // further sideways is exactly how it ends up in the void. Fade the glance's
  // amplitude out as the blend engages — continuously, since the blend itself
  // is rate-limited (#91 smoothness pass).
  const glanceScale = 1 - clamp01(lookAtBlend / LOOKAT_TOWER_PULL_MAX)
  return applyGlance(position, blended, glance, glanceScale)
}

// ---------------------------------------------------------------------------
// Demo tour state
// ---------------------------------------------------------------------------

/** The Canyon-tour flavour of {@link DemoTourState}: a real Canyon graph exists to walk. */
interface CanyonTourState {
  kind: 'canyon'
  graph: CanyonGraph
  /**
   * The altitude bands this tour's waypoints/aim/pull are drawn and clamped
   * against (#59) — derived once (via {@link rooflineFromPlacements}) from
   * the Tower placements the tour was built/last advanced against, so a scene
   * that grows taller (busier Towers, uniform scene-wide height) keeps the
   * whole altitude program — canyon/overview bands, the aim window, the
   * Tower-box clearance — in step with the ACTUAL rendered roofline instead
   * of the resting {@link TOWER_HEIGHT}. Refreshed every {@link stepDemoTour}
   * call from that call's own `placements` argument, so a scene that grows or
   * shrinks mid-flight is picked up within the current frame.
   */
  bands: AltitudeBands
  rngState: number
  /**
   * The seeded glances' own PRNG stream (#105 iteration 2), advanced only by
   * {@link rollGlance} — deliberately *separate* from `rngState` (the
   * waypoint walk's stream). With one shared stream, any change to how often
   * glances draw shifted every subsequent waypoint draw, so the realized
   * route for a logged seed changed under pure aim-side tweaks — voiding
   * ADR-0010's logged-seed reproduction of visual reports across otherwise
   * route-neutral versions. Decoupled, seed → route is a function of the
   * walk alone.
   */
  glanceRngState: number
  /** Lattice coordinate of the walk's leading edge — the last *raw* waypoint drawn (`rawTail`). */
  headCoord: LatticeCoord
  headMove: LatticeMove
  /**
   * The last two *raw* (pre-{@link expandWaypoint}) walk waypoints: `rawTail`
   * is the leading edge (`headCoord`'s position, awaiting its successor
   * before it can be expanded into control points — a corner can only be
   * rounded once both its legs are known), `rawPrev` the raw waypoint before
   * it (the incoming leg's origin).
   */
  rawPrev: Vector3
  rawTail: Vector3
  window: SplineWindow
  /**
   * Spline parameter of the current sample, in `[0, 1]` — a *cache* derived
   * from `segmentDistance` via the horizontal arc-length inversion
   * ({@link arcDistanceToLocalT}), kept on the state so
   * {@link sampleDemoTourPose} stays a cheap pure read.
   */
  segmentT: number
  /**
   * Horizontal (x, z) arc distance travelled into the current segment, world
   * units — the tour's true progress variable (#91 smoothness pass). Advanced
   * by exactly `CANYON_TRAVEL_SPEED × delta` every frame and carried over
   * (minus the finished segment's length) across segment boundaries, so
   * ground speed is constant along the whole route, boundaries included.
   */
  segmentDistance: number
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
  /**
   * The currently *flown* climb gradient (signed Δaltitude per world unit of
   * horizontal travel), slewed toward the glide-slope pursuit's demand at
   * {@link CLIMB_GRADIENT_SLEW} per unit travelled — the ease *into* a climb
   * that makes a waypoint's new altitude target read as a gentle pitch-up,
   * not a vertical-velocity kink. Always within ±{@link MAX_CLIMB_GRADIENT}.
   */
  climbGradient: number
  /** The paced canyon/overview altitude intent the next waypoint draw advances — see {@link AltitudeProgram}. */
  altitudeProgram: AltitudeProgram
  /**
   * Last frame's horizontal travel heading (radians) — the finite-difference
   * partner for the bank target's yaw rate (see {@link bankTargetFromYawRate}).
   */
  heading: number
  /**
   * The exponentially smoothed heading rate (rad/s) driving the bank target —
   * see {@link BANK_YAW_RATE_SMOOTHING}.
   */
  yawRateSmoothed: number
  /** The temporally smoothed bank (radians) — what {@link sampleDemoTourPose} renders. See {@link DEMO_ROLL_MAX_RATE}. */
  roll: number
  /** The smoothed bank's current angular rate (rad/s) — the follower's second state variable. */
  rollRate: number
  /** The look-at's current Tower-pull weight, eased toward the geometric target at {@link LOOKAT_BLEND_RATE}/s. */
  lookAtBlend: number
  /**
   * The pull's current anchor point (on the nearest Tower's axis, at the
   * aim's altitude — see {@link nearestTowerPull}), eased toward the
   * geometric target at {@link LOOKAT_PULL_POINT_EASE_RATE} so a
   * nearest-Tower switch pans the aim instead of snapping it.
   */
  lookAtPullPoint: [number, number, number]
  glance: GlanceState
  /**
   * The rendered view direction, as camera-relative yaw/pitch/distance —
   * each a bounded second-order follower ({@link stepBoundedFollower}, #105)
   * chasing the demand-driven look-at under the {@link VIEW_YAW_MAX_RATE}/
   * {@link VIEW_PITCH_MAX_RATE}/{@link VIEW_DISTANCE_MAX_RATE} rate caps
   * *and* the {@link VIEW_YAW_MAX_ACCEL}/{@link VIEW_PITCH_MAX_ACCEL}
   * acceleration caps — the pipeline's *output* guardrail (see
   * VIEW_YAW_MAX_RATE's and VIEW_YAW_MAX_ACCEL's doc comments).
   * {@link sampleDemoTourPose} reconstructs the look-at point from these.
   */
  viewYaw: number
  viewPitch: number
  viewDistance: number
  /** The view followers' current rates — their second state variables, exactly as `rollRate` is the roll follower's. */
  viewYawRate: number
  viewPitchRate: number
  viewDistanceRate: number
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
  /** The altitude bands (#59) — see {@link CanyonTourState}'s `bands` doc comment; {@link sampleOrbitPose} reads its `orbitAltitudeBase`/`orbitBobAmplitude`/`rooflineY`. */
  bands: AltitudeBands
}

/** Demo Mode's full tour state: either flying the Canyon graph, or the degenerate orbit fallback. */
export type DemoTourState = CanyonTourState | OrbitTourState

function orbitTourState(
  seed: number,
  center: [number, number, number],
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): OrbitTourState {
  return { kind: 'orbit', center, elapsed: 0, seed: seed | 0, bands }
}

/** The orbit's starting angle, derived from its seed so different seeds still produce distinguishable (if simple) orbits. */
function orbitPhaseOffset(state: OrbitTourState): number {
  return mulberry32Step(state.seed).value * 2 * Math.PI
}

function fallbackCenter(placements: readonly TowerPlacement[]): [number, number, number] {
  return placements.length === 1 ? placements[0].position : [0, 0, 0]
}

/**
 * The walk's leading edge plus the control polygon being built from it — the
 * mutable bundle {@link extendWindow} advances. Internal to
 * {@link createDemoTour}/{@link stepDemoTour}, which copy state in, extend,
 * and read the results back into the immutable {@link DemoTourState}.
 */
interface WalkFrontier {
  window: Vector3[]
  rawPrev: Vector3
  rawTail: Vector3
  headCoord: LatticeCoord
  headMove: LatticeMove
  altitudeProgram: AltitudeProgram
  rngState: number
}

/**
 * Grows the control polygon until its final-shape arc table covers
 * `requiredArc` of horizontal travel (measured from the flown piece's start)
 * — the look-ahead guarantee {@link SplineWindow} documents: draw the next
 * raw waypoint from the walk, expand the previous leading edge into control
 * points now that both its legs are known ({@link expandWaypoint}), append,
 * repeat. {@link stepDemoTour} calls this **every frame** with the frame's
 * own `traveled + LOOKAT_LOOKAHEAD_DISTANCE`, not merely at rollovers: a
 * per-rollover check only guarantees coverage at the rollover instant, and
 * as travel accrues mid-piece the look-ahead would silently pin at the table
 * end again (the exact demand-teleport bug the first #105 pass fixed) while
 * the deficit forced a burst of draws at the next boundary. Checked per
 * frame, coverage holds on every frame by construction and drawing spreads
 * out to at most one waypoint per ordinary frame (every draw appends well
 * over a frame's travel of future arc). Termination is guaranteed because
 * every raw waypoint extends the polygon by a good fraction of a canyon leg
 * (adjacent canyon lines are ≥ one {@link TOWER_SPACING} apart and corner
 * tangent offsets are < half a leg).
 *
 * Mutates `frontier` in place — it's a local builder, not shared state — and
 * returns the window's up-to-date arc table so the caller never computes it
 * twice: pass `table` when one for the *current* window is already in hand
 * (the no-draw common path is then free).
 */
function extendWindow(
  frontier: WalkFrontier,
  graph: CanyonGraph,
  requiredArc: number,
  table: number[] | null = null,
  bands: AltitudeBands = DEFAULT_ALTITUDE_BANDS,
): number[] {
  let current = table
  for (;;) {
    if (frontier.window.length >= 5) {
      if (!current) {
        current = segmentHorizontalArc(frontier.window)
      }
      if (current[current.length - 1] >= requiredArc) {
        return current
      }
    }
    const picked = drawNextWaypoint(
      graph,
      frontier.headCoord,
      frontier.headMove,
      frontier.altitudeProgram,
      frontier.rngState,
      null,
      bands,
    )
    frontier.window.push(
      ...expandWaypoint(frontier.rawPrev, frontier.rawTail, picked.waypoint.position),
    )
    frontier.rawPrev = frontier.rawTail
    frontier.rawTail = picked.waypoint.position
    frontier.headCoord = picked.waypoint.coord
    frontier.headMove = picked.move
    frontier.altitudeProgram = picked.program
    frontier.rngState = picked.nextState
    current = null
  }
}

/**
 * The glance stream's seed derivation (see `glanceRngState` on
 * {@link CanyonTourState}): a fixed odd constant XORed into the tour seed so
 * the two mulberry32 streams start decorrelated while remaining a pure
 * function of the one user-visible seed.
 */
function glanceSeed(seed: number): number {
  return (seed ^ 0x5f356495) | 0
}

/**
 * Creates a fresh {@link DemoTourState}: the seam Demo Mode's activation
 * calls. The tour *takes flight from the entry pose itself* (#91 smoothness
 * pass): the spline's first point is the camera's own position, and its first
 * segment cruises — at the ordinary, constant {@link CANYON_TRAVEL_SPEED} —
 * to the Canyon graph node nearest that pose (ADR-0010's entry waypoint),
 * from where the seeded walk proceeds as ever. Before this pass the first
 * spline point *was* the entry waypoint, so the activation intro had to haul
 * the camera the whole camera→waypoint distance (easily tens of world units,
 * altitude included) inside its fixed {@link DEMO_TRANSITION_SECONDS} — the
 * "~1s standing still, then rushes way too fast, then settles" opening of the
 * maintainer's review. Now the intro only has to blend the aim/bank while the
 * position is already gliding out from under the camera at cruise speed.
 * (When the entry pose already sits essentially *on* the nearest node —
 * within {@link TAKEOFF_MIN_DISTANCE} horizontally — the takeoff segment
 * would be degenerate, so the tour starts at the node directly, as before.)
 *
 * A deterministic function of its three inputs — same seed + same Tower
 * placements + same entry pose always produces the same tour, the
 * reproduction contract #91 requires.
 *
 * Falls back to the orbit-and-bob state when `placements` is degenerate (see
 * {@link buildCanyonGraph}).
 */
export function createDemoTour(params: {
  seed: number
  placements: readonly TowerPlacement[]
  entry: Pose
}): DemoTourState {
  // #59: the altitude program, aim window, and Tower-box clearance all scale
  // to the scene's ACTUAL (possibly grown, uniform-across-Towers) roofline —
  // see AltitudeBands' doc comment — rather than staying pinned to the
  // resting TOWER_HEIGHT.
  const bands = bandsForPlacements(params.placements)
  const graph = buildCanyonGraph(params.placements)
  if (!graph) {
    return orbitTourState(params.seed, fallbackCenter(params.placements), bands)
  }

  let rngState = params.seed | 0
  const entryCoord = nearestLatticeCoord(graph, params.entry.position[0], params.entry.position[2])
  // The paced altitude program starts with a full canyon gap, so every tour
  // opens threading the canyons and the first climb-out arrives "every so
  // often" later, never in the activation transition itself.
  const initialProgram = initialAltitudeProgram(rngState)
  rngState = initialProgram.nextState
  const entryAltitude = drawAltitude(rngState, initialProgram.program, bands)
  rngState = entryAltitude.nextState
  const entryWaypoint = new Vector3(
    graph.xs[entryCoord.i],
    entryAltitude.altitude,
    graph.zs[entryCoord.j],
  )

  const cameraPosition = new Vector3(...params.entry.position)
  const takeoffDistance = Math.hypot(
    cameraPosition.x - entryWaypoint.x,
    cameraPosition.z - entryWaypoint.z,
  )

  let frontier: WalkFrontier
  if (takeoffDistance >= TAKEOFF_MIN_DISTANCE) {
    // Take flight from where the camera already is: the first segment cruises
    // from the entry pose to the nearest Canyon graph node, then the walk
    // takes over (see the function doc comment). The walk's first move is
    // constrained/biased by the takeoff's approach direction so it continues
    // the arrival instead of hairpinning against it (see candidateMoves).
    const approach: ApproachDirection = {
      x: (entryWaypoint.x - cameraPosition.x) / takeoffDistance,
      z: (entryWaypoint.z - cameraPosition.z) / takeoffDistance,
    }
    const step1 = drawNextWaypoint(
      graph,
      entryCoord,
      null,
      entryAltitude.program,
      rngState,
      approach,
      bands,
    )
    // The raw route so far is [camera, entryWaypoint, step1]; the entry
    // waypoint's corner (takeoff approach meeting the walk's first move) can
    // be rounded right away since both its legs are known.
    frontier = {
      window: [
        cameraPosition.clone(),
        ...expandWaypoint(cameraPosition, entryWaypoint, step1.waypoint.position),
      ],
      rawPrev: entryWaypoint,
      rawTail: step1.waypoint.position,
      headCoord: step1.waypoint.coord,
      headMove: step1.move,
      altitudeProgram: step1.program,
      rngState: step1.nextState,
    }
  } else {
    // The camera already sits on the entry node — start the walk there
    // directly rather than flying a degenerate zero-length takeoff segment.
    const step1 = drawNextWaypoint(
      graph,
      entryCoord,
      null,
      entryAltitude.program,
      rngState,
      null,
      bands,
    )
    const step2 = drawNextWaypoint(
      graph,
      step1.waypoint.coord,
      step1.move,
      step1.program,
      step1.nextState,
      null,
      bands,
    )
    frontier = {
      window: [
        entryWaypoint.clone(),
        ...expandWaypoint(entryWaypoint, step1.waypoint.position, step2.waypoint.position),
      ],
      rawPrev: step1.waypoint.position,
      rawTail: step2.waypoint.position,
      headCoord: step2.waypoint.coord,
      headMove: step2.move,
      altitudeProgram: step2.program,
      rngState: step2.nextState,
    }
  }
  // Mirror the second control point through the first for a synthetic "point
  // behind the entry" — the standard way to give an open Catmull-Rom curve a
  // sensible starting tangent (zero initial curvature) with no real history
  // to draw on yet.
  const mirror = frontier.window[0].clone().multiplyScalar(2).sub(frontier.window[1])
  frontier.window.unshift(mirror)
  // Draw until the arc table provably outreaches the look-ahead from the
  // very first frame (traveled = 0) — the measured guarantee SplineWindow
  // documents.
  extendWindow(frontier, graph, LOOKAT_LOOKAHEAD_DISTANCE, null, bands)
  const window: SplineWindow = frontier.window

  const glanceRoll = rollGlance(glanceSeed(params.seed))

  // Seed the eased pull anchor at its geometric target for the entry pose, so
  // there's nothing to pan from on the very first frame (the blend weight
  // starts at 0 anyway, so this only fixes the ease's starting point).
  const entrySample = sampleSpline(window, 0)
  const entryHeading = horizontalHeading(entrySample.tangent, 0)
  const bounds = graphAimBounds(graph)
  // The same on-path forward aim stepDemoTour uses, evaluated at the start.
  const entryForward = sampleSplineExtended(
    window,
    arcDistanceToLocalT(segmentHorizontalArc(window), LOOKAT_LOOKAHEAD_DISTANCE),
  )
  // The entry aim is level at the entry altitude (climbGradient starts at 0),
  // matching the flown-gradient aim altitude stepDemoTour maintains.
  entryForward.y = clamp(window[1].y, bands.canyonMin, bands.aimCeiling)
  clampToAimBounds(entryForward, bounds)
  const entryPull = nearestTowerPull(entryForward, params.placements, bands)
  // Seed the eased view triplet at its geometric entry target, same reason.
  const entryPose = window[1]
  const entryTarget = composeLookAt(entryPose, entryForward, 0, entryPull.point, NO_GLANCE)
  const entryView = viewTripletTo(entryPose, entryTarget)

  return {
    kind: 'canyon',
    graph,
    bands,
    rngState: frontier.rngState,
    glanceRngState: glanceRoll.nextState,
    headCoord: frontier.headCoord,
    headMove: frontier.headMove,
    rawPrev: frontier.rawPrev,
    rawTail: frontier.rawTail,
    window,
    segmentT: 0,
    segmentDistance: 0,
    // Start exactly at the entry pose's own altitude — window[1].y — so there
    // is no lag/jump the instant the tour begins; the glide-slope pursuit
    // only ever engages from here on, chasing each *next* segment's target.
    altitude: entryPose.y,
    climbGradient: 0,
    altitudeProgram: frontier.altitudeProgram,
    heading: entryHeading,
    yawRateSmoothed: 0,
    // Wings level at activation: the smoothed roll only ever banks from here.
    roll: 0,
    rollRate: 0,
    lookAtBlend: 0,
    lookAtPullPoint: entryPull.point.toArray() as [number, number, number],
    glance: glanceRoll.glance,
    viewYaw: entryView.yaw,
    viewPitch: entryView.pitch,
    viewDistance: entryView.distance,
    // The view followers start at rest, like the roll: their rates ramp in
    // under the acceleration caps from the very first frame.
    viewYawRate: 0,
    viewPitchRate: 0,
    viewDistanceRate: 0,
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
  // #59: re-derive the altitude bands from THIS call's placements every
  // frame (not just at createDemoTour time), so a scene that grows/shrinks
  // uniform height mid-flight (a Tower's Pod count crossing the four-face
  // capacity while Demo Mode is already running) is reflected within the
  // current frame — see AltitudeBands' doc comment. bandsForPlacements
  // reuses the shared DEFAULT_ALTITUDE_BANDS object at the (overwhelmingly
  // common) resting height rather than allocating an equal-valued one fresh
  // every frame of the render loop.
  const bands = bandsForPlacements(placements)
  if (state.kind === 'orbit') {
    const graph = buildCanyonGraph(placements)
    if (graph) {
      const entry = sampleOrbitPose(state)
      return createDemoTour({ seed: state.seed, placements, entry })
    }
    return { ...state, elapsed: state.elapsed + delta, bands }
  }

  // The camera's rendered horizontal position *before* this frame's advance —
  // what sampleDemoTourPose showed last frame — so the climb-gradient logic
  // below can measure how far the camera really moved horizontally this
  // frame, rather than assuming a nominal/average travel speed.
  const { position: previousPosition } = sampleSpline(state.window, state.segmentT)

  // Advance by ground distance at the constant CANYON_TRAVEL_SPEED (see its
  // doc comment): the horizontal arc-length table turns distance back into a
  // spline parameter, so the speed is even through corners and across
  // segment boundaries (the leftover distance — not a leftover `t` fraction
  // in mismatched time units — carries into the next segment).
  let traveled = state.segmentDistance + CANYON_TRAVEL_SPEED * delta
  let graph = state.graph
  const frontier: WalkFrontier = {
    window: [...state.window],
    rawPrev: state.rawPrev,
    rawTail: state.rawTail,
    headCoord: state.headCoord,
    headMove: state.headMove,
    altitudeProgram: state.altitudeProgram,
    rngState: state.rngState,
  }
  let cumulative = segmentHorizontalArc(frontier.window)
  let glanceRngState = state.glanceRngState
  // A glance always survives segment boundaries now: it steps by real time
  // and only ever ends by completing its own eased 0→1→0 envelope. (It used
  // to be *replaced* by a fresh roll on every rollover — but a glance lasts
  // several times a segment's flight time, so nearly every glance was chopped
  // mid-swing: an instant aim snap of up to several degrees at random
  // waypoint boundaries.)
  let glance = stepGlance(state.glance, delta)

  // A `while`, not an `if`: corner rounding makes some pieces much shorter
  // than a full canyon leg, so a single (large or hitchy) frame delta can
  // legitimately cross more than one piece boundary.
  let rolledOver = false
  while (traveled >= segmentArcLength(cumulative)) {
    if (!rolledOver) {
      // First rollover this frame: the just-finished piece played out on
      // `state.graph` (jump-free); further waypoints are planned on the
      // latest graph.
      const nextGraph = buildCanyonGraph(placements)
      if (!nextGraph) {
        // The cluster shrank to degenerate (≤1 Tower) mid-flight — a rare
        // edge kept simple: hand off to the orbit fallback rather than
        // engineering a seamless downgrade for an event this uncommon.
        return orbitTourState(state.rngState, fallbackCenter(placements), bands)
      }
      graph = nextGraph
      rolledOver = true
    }
    traveled -= segmentArcLength(cumulative)
    frontier.window.shift()
    cumulative = extendWindow(frontier, graph, traveled + LOOKAT_LOOKAHEAD_DISTANCE, null, bands)
    // A new piece may start a fresh glance — but only when no glance is
    // already in flight (see the doc comment on `glance` above). Drawn from
    // the glances' own PRNG stream, never the walk's (see glanceRngState).
    if (!glance.active) {
      const glanceRoll = rollGlance(glanceRngState)
      glanceRngState = glanceRoll.nextState
      glance = glanceRoll.glance
    }
  }
  // Per-frame look-ahead coverage — never only at rollovers (see
  // extendWindow's doc comment): the table must outreach this frame's own
  // travel + look-ahead so the aim demand can never pin at the table end.
  // Coverage draws plan on the frame's graph (refreshed at the last
  // rollover), so a placements change reaches *new* draws within at most
  // one piece of flight — though the waypoints already drawn ahead (up to a
  // look-ahead's worth of route) were planned on the older graph and are
  // still flown as drawn, the same laziness ADR-0010 already accepts.
  cumulative = extendWindow(
    frontier,
    graph,
    traveled + LOOKAT_LOOKAHEAD_DISTANCE,
    cumulative,
    bands,
  )
  const window: SplineWindow = frontier.window

  const segmentT = arcDistanceToLocalT(cumulative, traveled)
  const { position: currentPosition, tangent: currentTangent } = sampleSpline(window, segmentT)

  // The camera's actual altitude (#91 climb-rate tuning pass, reworked to a
  // per-frame gradient cap by the elevator-look follow-up, then to a *slewed*
  // gradient by the smoothness pass): a pursuit of the current piece's
  // destination altitude (`window[2].y` — the altitude-target metadata the
  // control point carries: the drawn altitude of the raw waypoint it came
  // from, whether that point is the waypoint itself or one of its corner's
  // arc samples), never the spline's own (possibly steep) Y directly. The flown
  // gradient — Δaltitude per world unit of *this frame's actual horizontal
  // travel* — is (a) capped at ±MAX_CLIMB_GRADIENT so the visual climb angle
  // can never exceed atan(MAX_CLIMB_GRADIENT) no matter how a frame moves,
  // (b) tapered near the target ({@link CLIMB_LEVELOFF_DISTANCE}) so a climb
  // levels off onto its ceiling instead of snapping from a 23° slope to flat,
  // and (c) slewed ({@link CLIMB_GRADIENT_SLEW}) so it also *enters* a climb
  // by pitching up gradually instead of snapping from flat to full slope the
  // frame a new target appears. Gating everything on horizontal travel means
  // holding altitude outright while the camera is essentially stationary
  // horizontally — correct: there's no glide angle to climb along. This is
  // what turns a big waypoint-to-waypoint altitude jump into a gradual,
  // shallow climb/descent that can span several segments rather than
  // snapping to the waypoint's altitude within the one segment that happens
  // to lead to it.
  const horizontalDelta = Math.hypot(
    currentPosition.x - previousPosition.x,
    currentPosition.z - previousPosition.z,
  )
  const altitudeRemaining = window[2].y - state.altitude
  const levelOff = clamp(
    Math.abs(altitudeRemaining) / bands.climbLeveloffDistance,
    CLIMB_LEVELOFF_MIN_FACTOR,
    1,
  )
  const gradientCap = MAX_CLIMB_GRADIENT * levelOff
  // The gradient that would land exactly on the target this frame, if the cap
  // allows it — so the pursuit terminates exactly instead of asymptotically.
  const landingGradient = horizontalDelta > 1e-9 ? altitudeRemaining / horizontalDelta : 0
  const targetGradient = clamp(landingGradient, -gradientCap, gradientCap)
  const climbGradient = approach(
    state.climbGradient,
    targetGradient,
    CLIMB_GRADIENT_SLEW * horizontalDelta,
  )
  const altitude = state.altitude + climbGradient * horizontalDelta
  const actualPosition = new Vector3(currentPosition.x, altitude, currentPosition.z)
  // The travel heading and the smoothed bank: the path's instantaneous
  // heading rate only sets a *target*; the rendered roll follows it through
  // the bounded second-order follower (rate- and acceleration-capped,
  // deadbanded to exactly level on straight flight) — see
  // DEMO_ROLL_MAX_RATE's doc comment.
  const heading = horizontalHeading(currentTangent, state.heading)
  const yawRateRaw = delta > 1e-9 ? angleDelta(state.heading, heading) / delta : 0
  // The bank target tracks the *smoothed* heading rate (see
  // BANK_YAW_RATE_SMOOTHING): brief opposite-sign wiggles at straight/arc
  // transitions must not rock the horizon.
  const yawRateSmoothed =
    state.yawRateSmoothed +
    (yawRateRaw - state.yawRateSmoothed) * (1 - Math.exp(-delta / BANK_YAW_RATE_SMOOTHING))
  const rolled = stepBoundedFollower(
    state.roll,
    state.rollRate,
    bankTargetFromYawRate(yawRateSmoothed),
    delta,
    ROLL_FOLLOWER,
  )

  // The blend must ease toward the deficiency of the *forward look-ahead
  // point* (what the camera is about to aim at), not the camera's own
  // position — the root cause of the climb/dive "aims at the void" bug (#91
  // follow-up 2): the aim can shoot past nearby Towers well before the
  // camera's own altitude/position would suggest anything's amiss. Built off
  // `actualPosition` (not the raw spline position) so the look-at pipeline is
  // anchored to where the camera actually now is, since that's what a
  // look-at is relative *to*.
  // The forward aim: a point a fixed arc distance ahead *on the future
  // flight path* (#91 smoothness pass), not a tangent projection. On a
  // straightaway the two are identical; through a corner the on-path point
  // sweeps around the bend ahead of the aircraft — the aim *leads* the turn
  // the way a pilot's eyes do, instead of whipping with the instantaneous
  // tangent at the apex — and it can never point out of the canyon system,
  // because the flight path doesn't. Its altitude is clamped into the aim
  // window, and the graph-bounds clamp guards the sliver of spline bulge
  // outside the perimeter ring.
  const bounds = graphAimBounds(graph)
  const forward = sampleSplineExtended(
    window,
    arcDistanceToLocalT(cumulative, traveled + LOOKAT_LOOKAHEAD_DISTANCE),
  )
  // The aim's altitude is the flown-gradient gaze (#105 iteration 4 — see
  // LOOKAT_GAZE_GRADIENT_FACTOR), *not* the spline's altitude metadata: level
  // flight looks level down the canyon, climbs/dives tilt the gaze gently
  // along the actual glide slope. Clamped into a window deliberately
  // *narrower* than sampleDemoTourPose's rendered clamp (floor
  // CANYON_ALTITUDE_MIN vs LOOKAT_AIM_FLOOR, ceiling LOOKAT_AIM_CEILING vs
  // the roofline): the margins absorb the view followers' lag, so the
  // rendered clamp — whose engagement re-keys the rendered pitch faster than
  // the followers allow (the clamp-frame exception the smoothness suite
  // carves out) — almost never engages at all. Measured: ceiling-pinned
  // share 0.06-0.13 → ≤ 0.04, worst clamp-frame pitch acceleration 14.7 →
  // ≤ 6.5 rad/s² (below the 9.6 of the build before the strong roofline
  // pull).
  forward.y = clamp(
    actualPosition.y + climbGradient * LOOKAT_GAZE_GRADIENT_FACTOR * LOOKAT_LOOKAHEAD_DISTANCE,
    bands.canyonMin,
    bands.aimCeiling,
  )
  clampToAimBounds(forward, bounds)
  const pull = nearestTowerPull(forward, placements, bands)
  const lookAtBlend = approach(state.lookAtBlend, pull.strength, LOOKAT_BLEND_RATE * delta)
  // The pull's anchor point eases too (never snaps on a nearest-Tower
  // switch) — see LOOKAT_PULL_POINT_EASE_RATE's doc comment.
  const lookAtPullPoint = approachPoint(
    state.lookAtPullPoint,
    pull.point,
    LOOKAT_PULL_POINT_EASE_RATE * delta,
  )

  // The rendered view direction follows the demand-driven target through the
  // bounded second-order followers — hard-capped angular rate *and*
  // acceleration, the pipeline's output guardrail (see VIEW_YAW_MAX_RATE's
  // and VIEW_YAW_MAX_ACCEL's doc comments). A plain rate limiter here was
  // #105's root cause: its velocity stepped instantly on saturation/release/
  // target flips — the "head snap" at waypoint boundaries.
  const rawTarget = composeLookAt(
    actualPosition,
    forward,
    lookAtBlend,
    new Vector3(...lookAtPullPoint),
    glance,
  )
  const rawView = viewTripletTo(actualPosition, rawTarget)
  const yawFollowed = stepBoundedFollower(
    state.viewYaw,
    state.viewYawRate,
    rawView.yaw,
    delta,
    VIEW_YAW_FOLLOWER,
    true,
  )
  const viewYaw = angleDelta(0, yawFollowed.value)
  const pitchFollowed = stepBoundedFollower(
    state.viewPitch,
    state.viewPitchRate,
    rawView.pitch,
    delta,
    VIEW_PITCH_FOLLOWER,
  )
  const distanceFollowed = stepBoundedFollower(
    state.viewDistance,
    state.viewDistanceRate,
    rawView.distance,
    delta,
    VIEW_DISTANCE_FOLLOWER,
  )

  return {
    kind: 'canyon',
    graph,
    bands,
    rngState: frontier.rngState,
    glanceRngState,
    headCoord: frontier.headCoord,
    headMove: frontier.headMove,
    rawPrev: frontier.rawPrev,
    rawTail: frontier.rawTail,
    window,
    segmentT,
    segmentDistance: traveled,
    altitude,
    climbGradient,
    altitudeProgram: frontier.altitudeProgram,
    heading,
    yawRateSmoothed,
    roll: rolled.value,
    rollRate: rolled.rate,
    lookAtBlend,
    lookAtPullPoint,
    glance,
    viewYaw,
    viewPitch: pitchFollowed.value,
    viewDistance: distanceFollowed.value,
    viewYawRate: yawFollowed.rate,
    viewPitchRate: pitchFollowed.rate,
    viewDistanceRate: distanceFollowed.rate,
  }
}

function sampleOrbitPose(state: OrbitTourState): DemoPose {
  const angle = orbitPhaseOffset(state) + state.elapsed * ORBIT_ANGULAR_SPEED
  const bobPhase = (2 * Math.PI * state.elapsed) / ORBIT_BOB_PERIOD_SECONDS
  const [cx, cy, cz] = state.center
  const position: [number, number, number] = [
    cx + ORBIT_RADIUS * Math.sin(angle),
    cy + state.bands.orbitAltitudeBase + state.bands.orbitBobAmplitude * Math.sin(bobPhase),
    cz + ORBIT_RADIUS * Math.cos(angle),
  ]
  const target: [number, number, number] = [cx, cy + state.bands.rooflineY * 0.5, cz]
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
  const { position } = sampleSpline(state.window, state.segmentT)
  // Horizontal (x, z) comes straight off the spline (unaffected); the actual
  // camera altitude is `state.altitude` — the glide-slope-limited pursuit
  // {@link stepDemoTour} maintains — never the spline's own (possibly steep)
  // Y. The bank is likewise read straight off the state: it's the temporally
  // smoothed roll {@link stepDemoTour}'s bounded follower maintains (see
  // {@link DEMO_ROLL_MAX_RATE}), never an instantaneous re-derivation from
  // the local spline curvature (which snaps at every waypoint knot). The
  // look-at point is reconstructed from the state's rate-limited view
  // triplet (see VIEW_YAW_MAX_RATE) — its altitude clamped once more into
  // the aim window so no easing combination can float it above the roofline.
  const actualPosition = new Vector3(position.x, state.altitude, position.z)
  const horizontalReach = Math.cos(state.viewPitch) * state.viewDistance
  const target = new Vector3(
    actualPosition.x + Math.sin(state.viewYaw) * horizontalReach,
    clamp(
      actualPosition.y + Math.sin(state.viewPitch) * state.viewDistance,
      state.bands.aimFloor,
      state.bands.rooflineY,
    ),
    actualPosition.z + Math.cos(state.viewYaw) * horizontalReach,
  )
  return {
    position: actualPosition.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
    roll: state.roll,
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
 * The tour's speed ramp during the activation intro (#91 smoothness pass):
 * the factor the rig scales the tour's own per-frame advancement by while a
 * {@link DemoIntro} runs, so the flight itself accelerates smoothly from
 * standstill up to cruise instead of departing at full speed the instant the
 * toggle flips. Combined with {@link createDemoTour} starting the spline *at*
 * the activation pose, this is what makes switching Demo Mode on read as
 * gently taking flight from where the camera already is: the composited
 * camera speed ramps 0 → cruise, peaking barely above cruise (~1.1x, from the
 * intro ease catching up to the ramped flight) — where the old
 * fly-to-the-entry-waypoint intro peaked at *many times* cruise (the "~1s
 * standing still, then rushes way too fast" opening of the maintainer's
 * review). Same easing curve as the intro's pose blend, so the two finish
 * together at exactly cruise speed.
 */
export function demoIntroSpeedFactor(elapsed: number): number {
  return easeInOutCubic(clamp01(elapsed / DEMO_TRANSITION_SECONDS))
}

/**
 * Samples an in-progress {@link DemoIntro}: eases the camera from its pose at
 * activation onto `flight` — the tour's *current* pose, sampled by the caller
 * every frame via {@link sampleDemoTourPose} so the tour keeps advancing
 * during the intro (ramped by {@link demoIntroSpeedFactor}) rather than
 * waiting for it — fading the bank in from level rather than snapping to it.
 * `done` is true once the intro has finished easing — the rig should then use
 * `flight` directly.
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
