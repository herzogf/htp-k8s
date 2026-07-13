import { Euler, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  createFocusController,
  easeInOutCubic,
  FOCUS_DURATION_SECONDS,
  focusLookAngles,
  MAX_FOCUS_STEP_SECONDS,
  PANEL_VIEW_DISTANCE,
  panelFocusPose,
  type Pose,
  samplePose,
  TOWER_VIEW_DISTANCE,
  towerFocusPose,
} from './focus'
import { TOWER_HEIGHT } from './towerLayout'

describe('towerFocusPose', () => {
  // A Tower's Panels sit on its +Z (front) face — see panelLayout — so a "good
  // viewing angle in front of a specific tower side" (CONTEXT.md's Focus) means
  // standing off the +Z face, looking back at the Tower's centre.
  it('looks at the Tower centre', () => {
    const center: [number, number, number] = [4, TOWER_HEIGHT / 2, -2]
    expect(towerFocusPose(center).target).toEqual(center)
  })

  it('stands the camera off the front (+Z) face at a sensible distance', () => {
    const center: [number, number, number] = [4, TOWER_HEIGHT / 2, -2]
    const { position, target } = towerFocusPose(center)
    // In front of the face (greater Z than the Tower centre)...
    expect(position[2]).toBeGreaterThan(target[2])
    // ...far enough back that the whole Tower is comfortably framed, not so far
    // the Tower shrinks to a speck: the eye-to-target distance is on the order
    // of the Tower's own height.
    const distance = Math.hypot(
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2],
    )
    expect(distance).toBeGreaterThan(TOWER_HEIGHT)
    expect(distance).toBeLessThan(4 * TOWER_HEIGHT)
    // The primary standoff is along +Z, the face the Panels are on.
    expect(position[2] - target[2]).toBeCloseTo(TOWER_VIEW_DISTANCE)
  })

  it('views from slightly above and to the side so the face reads at an angle', () => {
    const center: [number, number, number] = [0, TOWER_HEIGHT / 2, 0]
    const { position } = towerFocusPose(center)
    // Off the centre-line (an angled view of the side, not a flat-on elevation)...
    expect(position[0]).not.toBeCloseTo(center[0])
    // ...and above the floor.
    expect(position[1]).toBeGreaterThan(0)
  })

  it('translates with the Tower placement (pose is relative to the target)', () => {
    const a = towerFocusPose([0, TOWER_HEIGHT / 2, 0])
    const b = towerFocusPose([10, TOWER_HEIGHT / 2, 10])
    expect(b.position[0] - a.position[0]).toBeCloseTo(10)
    expect(b.position[2] - a.position[2]).toBeCloseTo(10)
  })
})

describe('panelFocusPose', () => {
  // A Panel is a small quad on the Tower's +Z face; Focus brings the camera
  // close enough to read it (and the future Detail Popup, #24) head-on.
  it('looks straight at the Panel from in front of the face', () => {
    const panel: [number, number, number] = [1.5, 4.2, 3.1]
    const { position, target } = panelFocusPose(panel)
    expect(target).toEqual(panel)
    // Head-on: same x/y as the Panel, standing off along +Z.
    expect(position[0]).toBeCloseTo(panel[0])
    expect(position[1]).toBeCloseTo(panel[1])
    expect(position[2]).toBeCloseTo(panel[2] + PANEL_VIEW_DISTANCE)
  })

  it('gets much closer than a Tower focus (close enough to read one Panel)', () => {
    expect(PANEL_VIEW_DISTANCE).toBeLessThan(TOWER_VIEW_DISTANCE)
  })
})

describe('easeInOutCubic', () => {
  it('is pinned at the endpoints', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('passes through the midpoint at half', () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5)
  })

  it('eases in — early progress is slower than linear', () => {
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25)
  })

  it('eases out — late progress is faster than linear', () => {
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75)
  })
})

describe('samplePose', () => {
  const from: Pose = { position: [0, 0, 0], target: [0, 0, 0] }
  const to: Pose = { position: [10, 20, 30], target: [1, 2, 3] }

  it('returns the start pose at t = 0 and the end pose at t = 1', () => {
    expect(samplePose(from, to, 0)).toEqual(from)
    expect(samplePose(from, to, 1)).toEqual(to)
  })

  it('clamps t outside [0, 1] so an over-run frame never overshoots', () => {
    expect(samplePose(from, to, -1)).toEqual(from)
    expect(samplePose(from, to, 2)).toEqual(to)
  })

  it('interpolates both the camera position and the look-at target together', () => {
    const mid = samplePose(from, to, 0.5)
    // Eased midpoint is the geometric midpoint of both endpoints.
    expect(mid.position).toEqual([5, 10, 15])
    expect(mid.target).toEqual([0.5, 1, 1.5])
  })

  it('is a smooth animation, not a teleport — a pre-end sample is strictly between', () => {
    const early = samplePose(from, to, 0.2)
    expect(early.position[0]).toBeGreaterThan(from.position[0])
    expect(early.position[0]).toBeLessThan(to.position[0])
  })
})

describe('FOCUS_DURATION_SECONDS', () => {
  it('is a smooth animation, not an instant jump, but not a sluggish one', () => {
    expect(FOCUS_DURATION_SECONDS).toBeGreaterThan(0.3)
    expect(FOCUS_DURATION_SECONDS).toBeLessThan(2)
  })
})

describe('MAX_FOCUS_STEP_SECONDS', () => {
  it('caps a frame well below the whole duration, so a stalled frame cannot jump the fly-to to its end', () => {
    expect(MAX_FOCUS_STEP_SECONDS).toBeGreaterThan(0)
    // Many capped steps must fit inside a fly-to, so even a big stall leaves the
    // animation spread across several frames rather than teleporting.
    expect(MAX_FOCUS_STEP_SECONDS).toBeLessThan(FOCUS_DURATION_SECONDS / 4)
  })
})

describe('focusLookAngles', () => {
  // The yaw/pitch should aim the camera's forward axis (-Z, rotated by the YXZ
  // euler the rig applies) straight at the target — so reconstruct that forward
  // direction and check it's parallel to (target - position).
  const forwardOf = (yaw: number, pitch: number): Vector3 => {
    const quaternion = new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'))
    return new Vector3(0, 0, -1).applyQuaternion(quaternion)
  }

  it('leaves a camera already looking down -Z unturned', () => {
    const { yaw, pitch } = focusLookAngles([0, 0, 0], [0, 0, -1])
    expect(yaw).toBeCloseTo(0)
    expect(pitch).toBeCloseTo(0)
  })

  it('aims the forward axis at a target off to the side', () => {
    const position: [number, number, number] = [0, 0, 0]
    const target: [number, number, number] = [3, 0, 4]
    const { yaw, pitch } = focusLookAngles(position, target)
    const forward = forwardOf(yaw, pitch)
    const toTarget = new Vector3(...target).sub(new Vector3(...position)).normalize()
    expect(forward.dot(toTarget)).toBeCloseTo(1)
  })

  it('aims the forward axis at a target above and in front (pitches up)', () => {
    const position: [number, number, number] = [1, 2, 5]
    const target: [number, number, number] = [1, 6, 2]
    const { yaw, pitch } = focusLookAngles(position, target)
    const forward = forwardOf(yaw, pitch)
    const toTarget = new Vector3(...target).sub(new Vector3(...position)).normalize()
    expect(forward.dot(toTarget)).toBeCloseTo(1)
    // Target is higher than the eye, so the camera tilts up (positive pitch).
    expect(pitch).toBeGreaterThan(0)
  })

  it('matches the look-at a Panel focus needs (aims straight at the Panel)', () => {
    const pose = panelFocusPose([2, 4, 3])
    const { yaw, pitch } = focusLookAngles(pose.position, pose.target)
    const forward = forwardOf(yaw, pitch)
    const toTarget = new Vector3(...pose.target).sub(new Vector3(...pose.position)).normalize()
    expect(forward.dot(toTarget)).toBeCloseTo(1)
  })
})

describe('createFocusController', () => {
  const pose: Pose = { position: [1, 2, 3], target: [4, 5, 6] }

  it('has nothing to take until a focus is requested', () => {
    const controller = createFocusController()
    expect(controller.takeRequest()).toBeNull()
  })

  it('hands a requested pose to the next taker, then nothing (consumed once)', () => {
    const controller = createFocusController()
    controller.requestFocus(pose)
    expect(controller.takeRequest()).toEqual(pose)
    expect(controller.takeRequest()).toBeNull()
  })

  it('lets the latest request win when clicks arrive faster than frames', () => {
    const controller = createFocusController()
    const later: Pose = { position: [7, 8, 9], target: [0, 0, 0] }
    controller.requestFocus(pose)
    controller.requestFocus(later)
    expect(controller.takeRequest()).toEqual(later)
    expect(controller.takeRequest()).toBeNull()
  })
})
