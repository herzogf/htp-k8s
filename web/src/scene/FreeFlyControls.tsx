import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Euler, Vector3 } from 'three'
import { FOCUS_DURATION_SECONDS, focusLookAngles, type Pose, samplePose } from './focus'
import { useFocus } from './focusContext'
import {
  applyLook,
  FLY_SPEED,
  keyToMove,
  LOOK_SENSITIVITY,
  moveDirection,
  NO_KEYS,
  type MoveKeys,
} from './freeFly'

/** An in-flight Focus fly-to: the pose we started from, where we're headed, and how far along we are. */
interface FocusTween {
  from: Pose
  to: Pose
  /** Seconds elapsed since the tween began. */
  elapsed: number
}

/** The shape exposed on `window` for the e2e camera-interaction test (#20, extended for Focus in #21). */
export interface CameraTestHook {
  /** The live camera world position as `[x, y, z]`. */
  getPosition: () => [number, number, number]
  /** The live camera orientation as a quaternion `[x, y, z, w]`. */
  getQuaternion: () => [number, number, number, number]
  /** Whether a click-to-Focus fly-to is currently animating the camera. */
  isFocusing: () => boolean
  /** The destination pose of the active Focus fly-to, or `null` when idle. */
  getFocusGoal: () => Pose | null
}

declare global {
  interface Window {
    /**
     * Test-only handle onto the live camera. The 3D scene renders into a WebGL
     * canvas that isn't DOM-queryable, so the Playwright interaction test reads
     * camera state through this hook to assert that simulated input moved it.
     */
    __htpCameraTest?: CameraTestHook
  }
}

/**
 * FreeFlyControls is the manual free-fly camera rig (#20): WASD (plus Space/Shift
 * for up/down) flies the camera through the tower landscape, and pointer-lock
 * mouse-look aims it — the *Hackers* flythrough feel, driven by the user rather
 * than the automated Demo Mode flight (a separate, later ticket).
 *
 * It is deliberately dormant until the user acts: it seeds its yaw/pitch from the
 * camera's *current* orientation on mount and only ever re-applies that same
 * orientation until a key is pressed or the pointer is locked and moved, so the
 * scene's default framed skyline is left untouched on load. The movement and
 * look maths live in the pure {@link moveDirection}/{@link applyLook} seam
 * (unit-tested without a renderer); this component is the thin rig that binds DOM
 * input and integrates it into the live camera each frame. Speed and look
 * sensitivity are the fixed {@link FLY_SPEED}/{@link LOOK_SENSITIVITY} tunings —
 * their single source of truth lives in the pure seam.
 */
export function FreeFlyControls() {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const focus = useFocus()

  const held = useRef<MoveKeys>({ ...NO_KEYS })
  // yaw/pitch seeded from the camera's initial orientation (see the mount
  // effect) so the rig starts pointing exactly where the scene framed it.
  const look = useRef({ yaw: 0, pitch: 0, ready: false })
  const euler = useRef(new Euler(0, 0, 0, 'YXZ'))
  const step = useRef(new Vector3())
  // The active click-to-Focus fly-to (#21), or null when the user is in
  // ordinary free-fly. The rig integrates it in the same useFrame that drives
  // free-fly, so the two share the one camera without fighting over it.
  const tween = useRef<FocusTween | null>(null)
  // Scratch vector reused each frame to read the camera's current forward
  // direction (the `from` look-at a new fly-to eases away from), without
  // allocating in the render loop.
  const forward = useRef(new Vector3())

  // Seed yaw/pitch from the camera's current orientation. Reading it (rather
  // than assuming a look-at-origin default) is what guarantees activating the
  // controls never jumps the default view. YXZ order keeps yaw independent of
  // pitch, the natural decomposition for a no-roll fly camera.
  useEffect(() => {
    euler.current.setFromQuaternion(camera.quaternion, 'YXZ')
    look.current.yaw = euler.current.y
    look.current.pitch = euler.current.x
    look.current.ready = true
  }, [camera])

  // WASD / Space / Shift held-key tracking, on window so the scene need not hold
  // DOM focus. We only flip our own booleans, so unrelated keys pass through.
  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      const move = keyToMove(event.code)
      if (move) {
        held.current[move] = true
      }
    }
    const onUp = (event: KeyboardEvent) => {
      const move = keyToMove(event.code)
      if (move) {
        held.current[move] = false
      }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // Pointer-lock mouse-look: click the canvas to capture the pointer, then
  // relative mouse deltas aim the camera. We only rotate while our canvas holds
  // the lock, so the mouse is free for HUD/UI when it doesn't.
  useEffect(() => {
    const canvas = gl.domElement
    const requestLock = () => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.()
      }
    }
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) {
        return
      }
      const [yaw, pitch] = applyLook(
        look.current.yaw,
        look.current.pitch,
        event.movementX,
        event.movementY,
        LOOK_SENSITIVITY,
      )
      look.current.yaw = yaw
      look.current.pitch = pitch
    }
    canvas.addEventListener('click', requestLock)
    document.addEventListener('mousemove', onMouseMove)
    return () => {
      canvas.removeEventListener('click', requestLock)
      document.removeEventListener('mousemove', onMouseMove)
    }
  }, [gl])

  // Expose the live camera to the e2e interaction test (the WebGL canvas isn't
  // DOM-queryable, so this read-only getter is how the test observes that input
  // moved it). It ships in the production bundle on purpose: this project's e2e
  // runs against the real built binary (ADR-0004), so a dev-only guard would
  // remove the hook from the very build the test exercises. It's a read-only
  // peek at the camera in a read-only cinematic viewer (ADR-0003) — no surface.
  useEffect(() => {
    window.__htpCameraTest = {
      getPosition: () => camera.position.toArray() as [number, number, number],
      getQuaternion: () => camera.quaternion.toArray() as [number, number, number, number],
      // Focus (#21) also renders into the WebGL canvas, so the e2e reads whether
      // a fly-to is running and where it's headed through the same hook to prove
      // a click animates the camera to the clicked Tower/Panel.
      isFocusing: () => tween.current !== null,
      getFocusGoal: () =>
        tween.current
          ? {
              position: [...tween.current.to.position],
              target: [...tween.current.to.target],
            }
          : null,
    }
    return () => {
      delete window.__htpCameraTest
    }
  }, [camera])

  useFrame((_, delta) => {
    // Until yaw/pitch are seeded from the initial orientation, do nothing — never
    // overwrite the framed default view with an un-seeded (identity) rotation.
    if (!look.current.ready) {
      return
    }

    // A click on a Tower/Panel queues a target pose; pick it up and start a fresh
    // fly-to from wherever the camera is *now*, so the animation is continuous
    // from the current view rather than snapping to a start pose.
    const request = focus?.takeRequest()
    if (request) {
      // The `from` look-at is a unit step down the camera's current forward axis,
      // so the tween eases the aim away from where we're already looking rather
      // than snapping it.
      forward.current.set(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position)
      tween.current = {
        from: {
          position: camera.position.toArray() as [number, number, number],
          target: forward.current.toArray() as [number, number, number],
        },
        to: request,
        elapsed: 0,
      }
    }

    const [x, y, z] = moveDirection(held.current)
    const moving = x !== 0 || y !== 0 || z !== 0

    // Free-fly input takes precedence: any movement key hands control straight
    // back from an in-progress fly-to, so the user can interrupt Focus by flying.
    if (moving && tween.current) {
      tween.current = null
    }

    if (tween.current && !moving) {
      // Advance the Focus fly-to: sample the eased pose for this frame, place the
      // camera there, and aim it at the pose's look-at target. We also fold that
      // aim back into yaw/pitch so free-fly resumes seamlessly from the focused
      // view once the tween ends (or the user interrupts it).
      tween.current.elapsed += delta
      const pose = samplePose(
        tween.current.from,
        tween.current.to,
        tween.current.elapsed / FOCUS_DURATION_SECONDS,
      )
      camera.position.set(...pose.position)
      // focusLookAngles is the pure, tested reduction of the look-at to yaw/pitch;
      // applying it through the same euler as free-fly below means both paths
      // orient the camera identically, so control hands over without a jump.
      const { yaw, pitch } = focusLookAngles(pose.position, pose.target)
      look.current.yaw = yaw
      look.current.pitch = pitch
      euler.current.set(pitch, yaw, 0, 'YXZ')
      camera.quaternion.setFromEuler(euler.current)

      if (tween.current.elapsed >= FOCUS_DURATION_SECONDS) {
        tween.current = null
      }
      return
    }

    // Re-apply the current aim. While the pointer isn't locked this is the exact
    // seeded orientation, so the view holds perfectly still.
    euler.current.set(look.current.pitch, look.current.yaw, 0, 'YXZ')
    camera.quaternion.setFromEuler(euler.current)

    // Translate along the camera-local move direction, rotated into world space,
    // scaled by speed and the frame time so travel is frame-rate independent.
    if (moving) {
      step.current
        .set(x, y, z)
        .applyQuaternion(camera.quaternion)
        .multiplyScalar(FLY_SPEED * delta)
      camera.position.add(step.current)
    }
  })

  return null
}
