import {
  easeInOutCubic,
  FOCUS_DURATION_SECONDS,
  focusLookAngles,
  samplePose,
  type Pose,
} from './focus'
import { TOWER_HEIGHT, TOWER_SPACING } from './towerLayout'

/**
 * The pure, WebGL-free core of Demo Mode (#22): an endless, looping cinematic
 * camera flight through the tower landscape with a visible banking/swinging
 * motion (CONTEXT.md's Demo Mode — "like a small plane navigating between
 * skyscrapers"), for unattended/showcase viewing. Everything here is a plain
 * function of an elapsed-seconds clock, so it's unit-tested without a
 * renderer; the live per-frame integration onto the real camera — and the
 * on/off hand-off to/from free-fly (#20) — lives in {@link FreeFlyControls}.
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
 * DEMO_LOOP_SECONDS is how long one full lap of the demo flight path takes
 * before it repeats. The path (see {@link demoFlightPosition}) is built from
 * sinusoids whose periods all divide this evenly, so the loop is seamless —
 * position, heading, and bank all match exactly at `t` and
 * `t + DEMO_LOOP_SECONDS`.
 */
export const DEMO_LOOP_SECONDS = 40

/**
 * DEMO_TRANSITION_SECONDS is how long both hand-offs take: easing onto the
 * flight path when Demo Mode switches on, and easing the bank back to level
 * when it switches off. Reuses {@link FOCUS_DURATION_SECONDS} — the same
 * "how long does a camera transition take to feel smooth, not sluggish"
 * tuning click-to-Focus (#21) already established, rather than inventing a
 * second magic number for the same kind of thing.
 */
export const DEMO_TRANSITION_SECONDS = FOCUS_DURATION_SECONDS

// The flight path's spatial extent, scaled to the tower grid ({@link
// TOWER_SPACING}/{@link TOWER_HEIGHT}) so it reads as flying among the Towers
// rather than dwarfing or ignoring them.
const RADIUS_X = TOWER_SPACING * 6
const RADIUS_Z = TOWER_SPACING * 4
const HEIGHT_BASE = TOWER_HEIGHT * 1.3
const HEIGHT_AMPLITUDE = TOWER_HEIGHT * 0.5

/**
 * How far ahead along the path (in seconds) the look-at target is sampled, so
 * the camera aims where the flight is headed rather than straight down — the
 * same "look a little ahead" trick a chase camera uses.
 */
const LOOKAHEAD_SECONDS = 0.6

/**
 * The half-width (in seconds) of the finite-difference window used to
 * estimate the path's turn rate for banking (see {@link demoBankAngle}).
 */
const YAW_RATE_SAMPLE_SECONDS = 0.1

/**
 * DEMO_BANK_MAX caps how far Demo Mode ever banks the camera: a clearly
 * visible tilt into its turns, without ever rolling past a natural-looking
 * angle.
 */
export const DEMO_BANK_MAX = Math.PI / 6

/**
 * Scales the path's estimated turn rate into a bank angle. Tuned so the
 * path's gentle weave produces a clearly visible, but not extreme, bank.
 */
const BANK_GAIN = 1.4

/**
 * The flight path's world-space position at elapsed time `t` seconds: a
 * horizontal figure-eight (a 1:2 Lissajous curve) with a slower vertical bob,
 * so the camera weaves left/right through the tower grid rather than tracing
 * a plain circular orbit around it — CONTEXT.md's "small plane navigating
 * between skyscrapers". All three components are sinusoids of `t`'s phase
 * around the loop, so the path is closed and seamless every
 * {@link DEMO_LOOP_SECONDS}.
 */
export function demoFlightPosition(t: number): [number, number, number] {
  const phase = (2 * Math.PI * t) / DEMO_LOOP_SECONDS
  return [
    RADIUS_X * Math.sin(phase),
    HEIGHT_BASE + HEIGHT_AMPLITUDE * Math.sin(phase * 3),
    RADIUS_Z * Math.sin(phase * 2),
  ]
}

function demoYaw(t: number): number {
  return focusLookAngles(demoFlightPosition(t), demoFlightPosition(t + LOOKAHEAD_SECONDS)).yaw
}

/**
 * The bank/roll angle at elapsed time `t`: estimates the path's current turn
 * rate by finite-differencing the heading ({@link demoYaw}) a fraction of a
 * second either side of `t` (wrapped through the shortest angular distance so
 * a heading crossing ±π doesn't spike), then scales and clamps it to
 * {@link DEMO_BANK_MAX} — banking into turns the way a plane would, rather
 * than an arbitrary independent wobble.
 */
function demoBankAngle(t: number): number {
  const before = demoYaw(t - YAW_RATE_SAMPLE_SECONDS)
  const after = demoYaw(t + YAW_RATE_SAMPLE_SECONDS)
  const yawRate = angleDelta(before, after) / (2 * YAW_RATE_SAMPLE_SECONDS)
  return clamp(-BANK_GAIN * yawRate, -DEMO_BANK_MAX, DEMO_BANK_MAX)
}

/**
 * The full Demo Mode camera pose at elapsed time `t` seconds since the flight
 * loop began: the path's position, a look-ahead target for heading, and the
 * bank angle for that instant. This is what {@link FreeFlyControls} samples
 * every frame while Demo Mode is active.
 */
export function demoPose(t: number): DemoPose {
  return {
    position: demoFlightPosition(t),
    target: demoFlightPosition(t + LOOKAHEAD_SECONDS),
    roll: demoBankAngle(t),
  }
}

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
 * activation onto the flight path's *current* position (`flightElapsed` keeps
 * advancing during the intro, so the path doesn't wait for it), fading the
 * bank in from level rather than snapping to it. `done` is true once the
 * intro has finished easing — the rig should then sample {@link demoPose}
 * directly.
 */
export function sampleDemoIntro(
  intro: DemoIntro,
  flightElapsed: number,
): { pose: DemoPose; done: boolean } {
  const t = Math.min(1, intro.elapsed / DEMO_TRANSITION_SECONDS)
  const eased = easeInOutCubic(t)
  const flight = demoPose(flightElapsed)
  const pose = samplePose(intro.from, { position: flight.position, target: flight.target }, t)
  return {
    pose: { ...pose, roll: flight.roll * eased },
    done: t >= 1,
  }
}

/**
 * An in-progress ease of the camera's bank back to level, started the instant
 * Demo Mode switches off, so free-fly resumes without the roll snapping to
 * zero — the "no jarring jump" hand-back Demo Mode's off-toggle requires
 * (#22).
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

function angleDelta(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
