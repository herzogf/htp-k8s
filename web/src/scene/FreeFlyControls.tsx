import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Euler, Vector3 } from 'three'
import {
  createDemoTour,
  type DemoIntro,
  demoIntroSpeedFactor,
  type DemoPose,
  type DemoTourState,
  type RollRecovery,
  sampleDemoIntro,
  sampleDemoTourPose,
  stepDemoTour,
  stepRollRecovery,
} from './demoMode'
import {
  FOCUS_DURATION_SECONDS,
  focusLookAngles,
  MAX_FOCUS_STEP_SECONDS,
  type Pose,
  samplePose,
} from './focus'
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
import { DEFAULT_APP_CONFIG } from '../appConfig'
import { type TowerPlacement } from './towerLayout'

/** An in-flight Focus fly-to: the pose we started from, where we're headed, and how far along we are. */
interface FocusTween {
  from: Pose
  to: Pose
  /** Seconds elapsed since the tween began. */
  elapsed: number
}

/** The shape exposed on `window` for the e2e camera-interaction test (#20, extended for Focus in #21 and Demo Mode in #22). */
export interface CameraTestHook {
  /** The live camera world position as `[x, y, z]`. */
  getPosition: () => [number, number, number]
  /** The live camera orientation as a quaternion `[x, y, z, w]`. */
  getQuaternion: () => [number, number, number, number]
  /** Whether a click-to-Focus fly-to is currently animating the camera. */
  isFocusing: () => boolean
  /** The destination pose of the active Focus fly-to, or `null` when idle. */
  getFocusGoal: () => Pose | null
  /** Whether Demo Mode's automated flight is currently driving the camera. */
  isDemoActive: () => boolean
  /**
   * Requests a Focus fly-to an arbitrary caller-supplied {@link Pose} — the
   * same tween `selectTower`/`selectPod` (`useDetailTestHook.ts`) drive via
   * their own fixed-distance `towerFocusPose`/`panelFocusPose` framings, but
   * without either preset. Added for issue #29's nightly dense-scene visual
   * coverage: a custom vantage is what lets a test frame a specific,
   * possibly scene-height-grown Tower (or two Towers at once, for a
   * busy/sparse side-by-side still) reliably, independent of #165 (Focus's
   * Tower framing is not yet scene-height-aware and can clip a grown Tower's
   * roof/base out of frame). Returns `false` (no-op) if there is no
   * `FocusContext` Provider in the tree, mirroring `isFocusing`/`getFocusGoal`
   * degrading gracefully in the same case.
   */
  requestFocus: (pose: Pose) => boolean
}

/** Props for {@link FreeFlyControls}. */
export interface FreeFlyControlsProps {
  /**
   * Whether Demo Mode (#22) is switched on. While `true` the rig drives the
   * camera along the automated cinematic flight path instead of user input;
   * toggling it back to `false` hands control back to free-fly from the
   * camera's current pose, easing its bank back to level rather than
   * snapping — see the `useFrame` below for the hand-off mechanics.
   */
  demoActive?: boolean
  /**
   * The Tower placements Demo Mode's Canyon tour (#91) is built from — the
   * same {@link TowerPlacement}s the scene renders Towers at, so the flight
   * threads *this* cluster's actual canyons rather than a fixed shape. Empty
   * or a single Tower falls back to the orbit-and-bob behaviour (see
   * `demoMode.ts`).
   */
  placements?: readonly TowerPlacement[]
  /**
   * Seed for Demo Mode's Canyon-tour PRNG (#91), resolved by the backend and
   * fetched once via `GET /api/config` (see `useAppConfig`). Reused every
   * activation this session, so "same spot + same seed" replays identically
   * (ADR-0010) while the Tower arrangement stays unchanged.
   */
  demoSeed?: number
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
 * mouse-look aims it — the *Hackers* flythrough feel, driven by the user. It
 * also hosts the automated Demo Mode flight (#22, `demoActive` prop): both
 * live in the same rig because they share the one live camera and must hand
 * control between each other without a jump.
 *
 * It is deliberately dormant until the user acts: it seeds its yaw/pitch from the
 * camera's *current* orientation on mount and only ever re-applies that same
 * orientation until a key is pressed or the pointer is locked and moved, so the
 * scene's default framed skyline is left untouched on load. The movement and
 * look maths live in the pure {@link moveDirection}/{@link applyLook} seam
 * (unit-tested without a renderer); this component is the thin rig that binds DOM
 * input and integrates it into the live camera each frame. Speed and look
 * sensitivity are the fixed {@link FLY_SPEED}/{@link LOOK_SENSITIVITY} tunings —
 * their single source of truth lives in the pure seam. Demo Mode's Canyon-tour
 * route, intro ease-on, and roll ease-off likewise live in the pure {@link
 * createDemoTour}/{@link stepDemoTour}/{@link sampleDemoTourPose}/{@link
 * sampleDemoIntro}/{@link stepRollRecovery} seam in `demoMode.ts`.
 */
export function FreeFlyControls({
  demoActive = false,
  placements = [],
  demoSeed = DEFAULT_APP_CONFIG.demoSeed,
}: FreeFlyControlsProps = {}) {
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

  // Demo Mode state (#22, Canyon tour route #91). `demoTour` is the live
  // Canyon-tour walk (#91's `createDemoTour`/`stepDemoTour`), (re)created the
  // instant Demo Mode switches on and advanced one frame at a time; `null`
  // only before the very first activation. `demoIntro` is the brief ease
  // from wherever the camera was onto the (already-moving) tour, non-null
  // only for the first `DEMO_TRANSITION_SECONDS` after activation. `rollBank`
  // is the last bank angle Demo Mode applied — captured every demo frame so a
  // `rollRecovery` ease-back-to-level can start from the true value the
  // instant Demo Mode switches off, rather than guessing or snapping to zero.
  const demoTour = useRef<DemoTourState | null>(null)
  const demoIntro = useRef<DemoIntro | null>(null)
  const rollBank = useRef(0)
  const rollRecovery = useRef<RollRecovery | null>(null)
  const wasDemoActive = useRef(false)

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
      // Demo Mode (#22): lets the e2e prove the automated flight is driving
      // the camera (rather than merely observing incidental motion) and that
      // it stops the instant the toggle switches off.
      isDemoActive: () => demoActive,
      requestFocus: (pose) => {
        if (!focus) {
          return false
        }
        focus.requestFocus(pose)
        return true
      },
    }
    return () => {
      delete window.__htpCameraTest
    }
    // Re-registers the hook whenever demoActive changes so isDemoActive never
    // reads a stale closed-over value.
  }, [camera, demoActive, focus])

  useFrame((_, delta) => {
    // Until yaw/pitch are seeded from the initial orientation, do nothing — never
    // overwrite the framed default view with an un-seeded (identity) rotation.
    if (!look.current.ready) {
      return
    }

    // Detect the Demo Mode toggle's edges (compared against last frame, not
    // React's commit timing, so this can never race a useEffect against
    // useFrame — see the refs' doc comments above).
    if (demoActive && !wasDemoActive.current) {
      // Entering Demo Mode: capture the camera's current pose as the intro's
      // start, create a fresh Canyon tour entering at the nearest waypoint to
      // that pose (#91, ADR-0010), and drop any in-flight Focus tween — Demo
      // Mode takes the camera over outright.
      forward.current.set(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position)
      const entry: Pose = {
        position: camera.position.toArray() as [number, number, number],
        target: forward.current.toArray() as [number, number, number],
      }
      demoIntro.current = { from: entry, elapsed: 0 }
      demoTour.current = createDemoTour({ seed: demoSeed, placements, entry })
      tween.current = null
      // Reproduction-critical logging (#91): the seed and activation pose are
      // the "same spot + same seed replays identically" key (ADR-0010). Only
      // guaranteed to reproduce while Demo Mode is enabled at startup (the
      // camera unflown at the fixed default pose) — see `useAppConfig`/#91;
      // this console log covers the best-effort interactive-activation case.
      const { yaw, pitch } = focusLookAngles(entry.position, entry.target)
      console.log(
        `Demo Mode activated: seed=${demoSeed} position=[${entry.position.map((v) => v.toFixed(2)).join(', ')}] yaw=${yaw.toFixed(3)} pitch=${pitch.toFixed(3)}`,
      )
    } else if (!demoActive && wasDemoActive.current) {
      // Leaving Demo Mode: ease the bank back to level from whatever it was
      // the instant control hands back, instead of snapping it to zero — the
      // "no jarring jump" hand-back Demo Mode's off-toggle requires (#22).
      // Position/yaw/pitch need no equivalent recovery: `look.current` (and
      // the camera position) were kept in sync with the live demo pose every
      // demo frame below, so free-fly already resumes from exactly there.
      if (Math.abs(rollBank.current) > 1e-6) {
        rollRecovery.current = { from: rollBank.current, elapsed: 0 }
      }
    }
    wasDemoActive.current = demoActive

    // `demoTour.current` is always set the instant `demoActive` flips true
    // (the edge-detect block above runs earlier this same frame) — the `&&`
    // is only to satisfy the type checker's null-check, never a real fallthrough.
    if (demoActive && demoTour.current) {
      // Cap the tour's own step for the same reason the Focus tween caps its
      // elapsed step below: a stall's oversized delta must not leap the
      // Canyon tour far ahead in one frame.
      const step = Math.min(delta, MAX_FOCUS_STEP_SECONDS)
      if (demoIntro.current) {
        demoIntro.current.elapsed += step
      }
      // While the intro runs, the tour's own advancement is ramped from 0 up
      // to full speed (demoIntroSpeedFactor), so activation reads as gently
      // taking flight from the current pose rather than the flight departing
      // at full cruise the instant the toggle flips — the tour still advances
      // during the intro (never waits for it), just eased.
      const ramp = demoIntro.current ? demoIntroSpeedFactor(demoIntro.current.elapsed) : 1
      demoTour.current = stepDemoTour(demoTour.current, step * ramp, placements)
      const flight = sampleDemoTourPose(demoTour.current)

      let flightPose: DemoPose
      if (demoIntro.current) {
        const sample = sampleDemoIntro(demoIntro.current, flight)
        flightPose = sample.pose
        if (sample.done) {
          demoIntro.current = null
        }
      } else {
        flightPose = flight
      }

      camera.position.set(...flightPose.position)
      // focusLookAngles is the pure, tested reduction of the look-at to
      // yaw/pitch shared with Focus; `roll` is Demo Mode's one addition, the
      // bank neither Focus nor free-fly ever applies.
      const { yaw, pitch } = focusLookAngles(flightPose.position, flightPose.target)
      euler.current.set(pitch, yaw, flightPose.roll, 'YXZ')
      camera.quaternion.setFromEuler(euler.current)
      // Keep free-fly's own aim, and the last bank angle, continuously in
      // sync with the live demo pose, so the instant Demo Mode switches off
      // the code below picks up exactly where the flight left off.
      look.current.yaw = yaw
      look.current.pitch = pitch
      rollBank.current = flightPose.roll
      return
    }

    // The bank eased back toward level after Demo Mode switched off, or 0
    // once fully settled (or if Demo Mode was never active this session).
    let roll = 0
    if (rollRecovery.current) {
      const stepped = stepRollRecovery(
        rollRecovery.current,
        Math.min(delta, MAX_FOCUS_STEP_SECONDS),
      )
      roll = stepped.roll
      rollRecovery.current = stepped.next
    }

    // A click on a Tower/Panel queues a target pose; pick it up and start a fresh
    // fly-to from wherever the camera is *now*, so the animation is continuous
    // from the current view rather than snapping to a start pose. (While Demo
    // Mode is active we return above before ever reaching here, so a click
    // during the flight simply leaves its request queued until Demo Mode ends.)
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
      // Cap the step so a stall's oversized delta can't leap the tween to its
      // end in one frame (which would read as a teleport, not a smooth fly-to).
      tween.current.elapsed += Math.min(delta, MAX_FOCUS_STEP_SECONDS)
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
      euler.current.set(pitch, yaw, roll, 'YXZ')
      camera.quaternion.setFromEuler(euler.current)

      if (tween.current.elapsed >= FOCUS_DURATION_SECONDS) {
        tween.current = null
      }
      return
    }

    // Re-apply the current aim. While the pointer isn't locked this is the exact
    // seeded orientation, so the view holds perfectly still.
    euler.current.set(look.current.pitch, look.current.yaw, roll, 'YXZ')
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
