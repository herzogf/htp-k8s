import { describe, expect, it } from 'vitest'
import {
  applyLook,
  FLY_SPEED,
  keyToMove,
  LOOK_SENSITIVITY,
  MAX_PITCH,
  moveDirection,
  NO_KEYS,
  type MoveKeys,
} from './freeFly'
import { TOWER_SPACING } from './towerLayout'

const keys = (over: Partial<MoveKeys>): MoveKeys => ({ ...NO_KEYS, ...over })

describe('keyToMove', () => {
  it('maps the WASD keys to their movements by physical code', () => {
    expect(keyToMove('KeyW')).toBe('forward')
    expect(keyToMove('KeyS')).toBe('backward')
    expect(keyToMove('KeyA')).toBe('left')
    expect(keyToMove('KeyD')).toBe('right')
  })

  it('maps the vertical and arrow keys too', () => {
    expect(keyToMove('Space')).toBe('up')
    expect(keyToMove('ShiftLeft')).toBe('down')
    expect(keyToMove('ArrowUp')).toBe('forward')
    expect(keyToMove('ArrowLeft')).toBe('left')
  })

  it('ignores keys the rig does not bind', () => {
    expect(keyToMove('KeyQ')).toBeNull()
    expect(keyToMove('Enter')).toBeNull()
    expect(keyToMove('')).toBeNull()
  })
})

describe('moveDirection', () => {
  it('is the zero vector when no keys are held — a resting camera never drifts', () => {
    expect(moveDirection(NO_KEYS)).toEqual([0, 0, 0])
  })

  it('is the zero vector when opposing keys cancel', () => {
    expect(moveDirection(keys({ forward: true, backward: true }))).toEqual([0, 0, 0])
    expect(moveDirection(keys({ left: true, right: true, up: true, down: true }))).toEqual([
      0, 0, 0,
    ])
  })

  it('sends forward down −z and back down +z (three.js camera space)', () => {
    expect(moveDirection(keys({ forward: true }))).toEqual([0, 0, -1])
    expect(moveDirection(keys({ backward: true }))).toEqual([0, 0, 1])
  })

  it('strafes right down +x and left down −x', () => {
    expect(moveDirection(keys({ right: true }))).toEqual([1, 0, 0])
    expect(moveDirection(keys({ left: true }))).toEqual([-1, 0, 0])
  })

  it('rises down +y and descends down −y', () => {
    expect(moveDirection(keys({ up: true }))).toEqual([0, 1, 0])
    expect(moveDirection(keys({ down: true }))).toEqual([0, -1, 0])
  })

  it('normalizes a diagonal so two keys are not faster than one', () => {
    const [x, y, z] = moveDirection(keys({ forward: true, right: true }))
    expect(Math.hypot(x, y, z)).toBeCloseTo(1)
    expect(x).toBeCloseTo(Math.SQRT1_2)
    expect(z).toBeCloseTo(-Math.SQRT1_2)
    expect(y).toBe(0)
  })
})

describe('applyLook', () => {
  it('turns the view right when the mouse moves right (negative yaw about +y)', () => {
    const [yaw, pitch] = applyLook(0, 0, 100, 0)
    expect(yaw).toBeCloseTo(-100 * LOOK_SENSITIVITY)
    expect(pitch).toBe(0)
  })

  it('turns the view down when the mouse moves down (negative pitch)', () => {
    const [yaw, pitch] = applyLook(0, 0, 0, 50)
    expect(pitch).toBeCloseTo(-50 * LOOK_SENSITIVITY)
    expect(yaw).toBe(0)
  })

  it('clamps pitch to just under the poles so the view cannot flip over', () => {
    expect(applyLook(0, 0, 0, -100000)[1]).toBeCloseTo(MAX_PITCH)
    expect(applyLook(0, 0, 0, 100000)[1]).toBeCloseTo(-MAX_PITCH)
  })

  it('leaves yaw unbounded so a full spin wraps naturally', () => {
    const [yaw] = applyLook(0, 0, 100000, 0)
    expect(Math.abs(yaw)).toBeGreaterThan(2 * Math.PI)
  })

  it('honours a custom sensitivity', () => {
    expect(applyLook(0, 0, 10, 0, 0.01)[0]).toBeCloseTo(-0.1)
  })
})

describe('FLY_SPEED', () => {
  it('is tuned to the tower grid so flying crosses a few tower-gaps per second', () => {
    expect(FLY_SPEED).toBeGreaterThan(TOWER_SPACING)
    expect(FLY_SPEED).toBeLessThanOrEqual(6 * TOWER_SPACING)
  })
})
