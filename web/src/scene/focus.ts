import { Euler, Matrix4, Vector3 } from 'three'
import { TOWER_FOOTPRINT, TOWER_HEIGHT } from './towerLayout'

/**
 * The pure, WebGL-free core of click-to-Focus (#21): the camera *poses* a click
 * on a Tower or Panel should fly to, the eased tween that samples the path
 * between two poses, and the tiny request queue that carries a click's target
 * pose from a mesh's pointer handler to the camera rig a frame later. All of it
 * is plain functions/data so it can be unit-tested without a renderer; the live
 * per-frame integration onto the real camera lives in {@link FreeFlyControls}.
 */

/**
 * A Pose is a camera framing: where the eye sits and the point it looks at. Both
 * are world-space `[x, y, z]`. Focus animates the camera from its current Pose
 * to a target Pose; keeping the look-at point explicit (rather than a rotation)
 * is what lets the tween swing the aim onto the Tower/Panel as it flies in.
 */
export interface Pose {
  /** World-space camera eye position: [x, y, z]. */
  position: [number, number, number]
  /** World-space point the camera looks at: [x, y, z]. */
  target: [number, number, number]
}

/**
 * TOWER_VIEW_DISTANCE is how far off a Tower's front (+Z) face the Focus camera
 * stands. Scaled to the Tower's own height so the whole prism is comfortably
 * framed at the scene's field of view — far enough to see it entire, close
 * enough that it fills the view rather than shrinking to a speck.
 */
export const TOWER_VIEW_DISTANCE = TOWER_HEIGHT * 1.6

/**
 * TOWER_VIEW_SIDE_OFFSET nudges the Focus camera off the Tower's centre-line so
 * the face is seen at a slight angle — a "good viewing angle in front of a
 * specific tower side" (CONTEXT.md's Focus), reading as a structure with depth
 * rather than a flat elevation.
 */
export const TOWER_VIEW_SIDE_OFFSET = TOWER_FOOTPRINT * 2

/**
 * TOWER_VIEW_HEIGHT is the Focus camera's eye height when framing a Tower: a
 * little above the Tower's mid-point (its centre sits at `TOWER_HEIGHT / 2`), so
 * the view looks gently down onto the face the way the reference stills do.
 */
export const TOWER_VIEW_HEIGHT = TOWER_HEIGHT * 0.6

/**
 * PANEL_VIEW_DISTANCE is how far off the Tower face the Focus camera stands when
 * framing a single Panel — close enough to read that one Pod's Panel and the
 * Detail Popup that will open beside it (#24). Much nearer than
 * {@link TOWER_VIEW_DISTANCE}: a Panel is a small quad, not a whole Tower.
 */
export const PANEL_VIEW_DISTANCE = 1.8

/**
 * FOCUS_DURATION_SECONDS is how long the Focus fly-to takes. Tuned to read as a
 * smooth, deliberate camera move (CONTEXT.md's Focus: "rather than teleporting")
 * without making the user wait — long enough to see the motion, short enough to
 * feel responsive to the click.
 */
export const FOCUS_DURATION_SECONDS = 0.9

/**
 * The Focus camera Pose for a Tower, given the world-space centre of its prism
 * (a {@link TowerPlacement} position). The camera stands off the Tower's front
 * (+Z) face — the face its Panels are on — raised to {@link TOWER_VIEW_HEIGHT}
 * and nudged sideways by {@link TOWER_VIEW_SIDE_OFFSET} for an angled view,
 * looking back at the Tower centre so the whole prism is framed.
 */
export function towerFocusPose(center: readonly [number, number, number]): Pose {
  const [cx, cy, cz] = center
  return {
    position: [cx + TOWER_VIEW_SIDE_OFFSET, TOWER_VIEW_HEIGHT, cz + TOWER_VIEW_DISTANCE],
    target: [cx, cy, cz],
  }
}

/**
 * The Focus camera Pose for a single Panel, given its world-space centre (a
 * {@link PanelInstance} position). The camera pulls straight in front of the
 * Panel on the Tower's +Z face at {@link PANEL_VIEW_DISTANCE}, looking head-on
 * so the Pod's Panel — and the future Detail Popup — is centred and legible.
 */
export function panelFocusPose(position: readonly [number, number, number]): Pose {
  const [px, py, pz] = position
  return {
    position: [px, py, pz + PANEL_VIEW_DISTANCE],
    target: [px, py, pz],
  }
}

/**
 * easeInOutCubic maps linear progress `t` in [0, 1] to an eased [0, 1]: a slow
 * start, quick middle, and gentle settle. It's what gives the Focus fly-to its
 * cinematic ease-in/ease-out rather than a mechanical constant-speed slide.
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * The Pose partway along the Focus tween from `from` to `to` at linear progress
 * `t`. `t` is clamped to [0, 1] (an over-run frame settles exactly on `to`
 * rather than overshooting) and eased by {@link easeInOutCubic}, then both the
 * eye position and the look-at target are interpolated together — so the camera
 * both flies toward the subject and swings its aim onto it over the same arc.
 */
export function samplePose(from: Pose, to: Pose, t: number): Pose {
  const eased = easeInOutCubic(clamp01(t))
  return {
    position: lerp3(from.position, to.position, eased),
    target: lerp3(from.target, to.target, eased),
  }
}

// Scratch three.js math objects reused by focusLookAngles so it allocates
// nothing when called every frame of a fly-to. Single-threaded and fully
// overwritten on each call, so sharing them across calls is safe.
const angleMatrix = new Matrix4()
const angleEye = new Vector3()
const angleTarget = new Vector3()
const angleUp = new Vector3(0, 1, 0)
const angleEuler = new Euler(0, 0, 0, 'YXZ')

/**
 * The free-fly camera's `{ yaw, pitch }` (a YXZ euler, matching {@link
 * FreeFlyControls}' orientation convention) for looking from `position` toward
 * `target`. This is the pure reduction the rig folds a Focus pose's look-at back
 * into so free-fly resumes seamlessly from the focused aim once a fly-to ends —
 * kept here, unit-tested, rather than as untested three.js math inside the rig.
 */
export function focusLookAngles(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): { yaw: number; pitch: number } {
  angleEye.set(...position)
  angleTarget.set(...target)
  angleMatrix.lookAt(angleEye, angleTarget, angleUp)
  angleEuler.setFromRotationMatrix(angleMatrix, 'YXZ')
  return { yaw: angleEuler.y, pitch: angleEuler.x }
}

/**
 * FocusController is the one-slot hand-off between a click and the camera rig: a
 * Tower/Panel pointer handler {@link requestFocus | requests} a target Pose, and
 * the rig {@link takeRequest | takes} it on its next frame to start a tween. The
 * slot holds only the latest request, so rapid clicks collapse to the last one,
 * and taking it clears the slot so a request starts exactly one fly-to.
 */
export interface FocusController {
  /** Queue a Focus fly-to toward `pose`; overwrites any not-yet-taken request. */
  requestFocus(pose: Pose): void
  /** Take and clear the pending request, or `null` if none is waiting. */
  takeRequest(): Pose | null
}

/** Creates an idle {@link FocusController} with no pending request. */
export function createFocusController(): FocusController {
  let pending: Pose | null = null
  return {
    requestFocus(pose) {
      pending = pose
    },
    takeRequest() {
      const request = pending
      pending = null
      return request
    },
  }
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
