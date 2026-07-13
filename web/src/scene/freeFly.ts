import { TOWER_SPACING } from './towerLayout'

/**
 * The pure, WebGL-free core of the free-fly camera (#20): the movement-direction
 * and mouse-look maths, kept separate from the React/three rig ({@link
 * FreeFlyControls}) so it can be unit-tested without a renderer. The rig owns the
 * live camera and per-frame integration; everything here is a plain function of
 * its inputs.
 */

/** Which of the six free-fly movement keys are currently held. */
export interface MoveKeys {
  /** W — fly toward where the camera looks. */
  forward: boolean
  /** S — fly back, away from where the camera looks. */
  backward: boolean
  /** A — strafe left. */
  left: boolean
  /** D — strafe right. */
  right: boolean
  /** Space — rise (along the camera's local up). */
  up: boolean
  /** Shift — descend. */
  down: boolean
}

/** No keys held — the resting state, which produces no movement. */
export const NO_KEYS: MoveKeys = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  up: false,
  down: false,
}

/**
 * Maps a `KeyboardEvent.code` to the movement it drives, or `null` for keys the
 * free-fly rig ignores. Using physical `code`s (not `key`) keeps WASD on the
 * same physical keys across keyboard layouts.
 */
export function keyToMove(code: string): keyof MoveKeys | null {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      return 'forward'
    case 'KeyS':
    case 'ArrowDown':
      return 'backward'
    case 'KeyA':
    case 'ArrowLeft':
      return 'left'
    case 'KeyD':
    case 'ArrowRight':
      return 'right'
    case 'Space':
      return 'up'
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'down'
    default:
      return null
  }
}

/**
 * The camera-local movement direction for the held keys, as a unit vector in
 * three.js camera space (+x right, +y up, −z forward). The result is normalized
 * so a diagonal (two keys) is not faster than a single axis, and is exactly the
 * zero vector when nothing — or only opposing keys — is held. That zero is why a
 * camera with no keys down never drifts, which keeps the default framed view
 * still until the user actually presses a key (#20).
 */
export function moveDirection(keys: MoveKeys): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  if (keys.forward) z -= 1
  if (keys.backward) z += 1
  if (keys.left) x -= 1
  if (keys.right) x += 1
  if (keys.up) y += 1
  if (keys.down) y -= 1

  const length = Math.hypot(x, y, z)
  if (length === 0) {
    return [0, 0, 0]
  }
  return [x / length, y / length, z / length]
}

/**
 * FLY_SPEED is the default free-fly translation speed in world units per second.
 * Tuned to the tower grid's scale ({@link TOWER_SPACING} between neighbouring
 * Towers): a few tower-gaps per second, so flying through the landscape reads as
 * a small plane cruising between skyscrapers rather than teleporting or crawling.
 */
export const FLY_SPEED = 3 * TOWER_SPACING

/**
 * LOOK_SENSITIVITY is the default mouse-look gain in radians of rotation per
 * pixel of pointer movement — the pointer-lock feel of a typical first-person /
 * fly camera.
 */
export const LOOK_SENSITIVITY = 0.0022

/**
 * MAX_PITCH clamps how far the camera can look up or down: just shy of straight
 * up/down, so mouse-look can never tip past the pole and flip the view upside
 * down.
 */
export const MAX_PITCH = Math.PI / 2 - 0.01

/**
 * The new `[yaw, pitch]` orientation (radians) after a pointer-lock mouse delta.
 * Moving the mouse right/down turns the view right/down (screen-natural), pitch
 * is clamped to {@link MAX_PITCH} so the view can't flip over the pole, and yaw
 * is left unbounded (it wraps naturally). Applied by the rig as a YXZ euler.
 */
export function applyLook(
  yaw: number,
  pitch: number,
  dx: number,
  dy: number,
  sensitivity = LOOK_SENSITIVITY,
): [number, number] {
  const nextYaw = yaw - dx * sensitivity
  const nextPitch = clamp(pitch - dy * sensitivity, -MAX_PITCH, MAX_PITCH)
  return [nextYaw, nextPitch]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
