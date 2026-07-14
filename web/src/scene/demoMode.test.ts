import { describe, expect, it } from 'vitest'
import {
  DEMO_BANK_MAX,
  DEMO_LOOP_SECONDS,
  DEMO_TRANSITION_SECONDS,
  demoFlightPosition,
  demoPose,
  sampleDemoIntro,
  stepRollRecovery,
  type RollRecovery,
} from './demoMode'

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

describe('demoFlightPosition', () => {
  it('is a closed loop: position repeats exactly one DEMO_LOOP_SECONDS later', () => {
    for (const t of [0, 3.7, 11, 19.9, 25]) {
      expect(
        distance(demoFlightPosition(t), demoFlightPosition(t + DEMO_LOOP_SECONDS)),
      ).toBeLessThan(1e-9)
    }
  })

  it('moves over time — Demo Mode flies the camera on its own', () => {
    const start = demoFlightPosition(0)
    const later = demoFlightPosition(5)
    expect(distance(start, later)).toBeGreaterThan(0.5)
  })

  it('stays within a bounded region around the origin (over the tower grid)', () => {
    for (let t = 0; t < DEMO_LOOP_SECONDS; t += 1) {
      const [x, , z] = demoFlightPosition(t)
      expect(Math.abs(x)).toBeLessThan(200)
      expect(Math.abs(z)).toBeLessThan(200)
    }
  })
})

describe('demoPose', () => {
  it('looks ahead of its own position (a nonzero look-at direction)', () => {
    const pose = demoPose(2)
    expect(distance(pose.position, pose.target)).toBeGreaterThan(0)
  })

  it('produces a visible bank at some point in the loop', () => {
    const rolls = []
    for (let t = 0; t < DEMO_LOOP_SECONDS; t += 0.5) {
      rolls.push(Math.abs(demoPose(t).roll))
    }
    expect(Math.max(...rolls)).toBeGreaterThan(0.05)
  })

  it('never banks past DEMO_BANK_MAX', () => {
    for (let t = 0; t < DEMO_LOOP_SECONDS; t += 0.25) {
      expect(Math.abs(demoPose(t).roll)).toBeLessThanOrEqual(DEMO_BANK_MAX + 1e-9)
    }
  })

  it('is periodic with DEMO_LOOP_SECONDS, bank included', () => {
    for (const t of [0, 4.2, 12, 30]) {
      const a = demoPose(t)
      const b = demoPose(t + DEMO_LOOP_SECONDS)
      expect(distance(a.position, b.position)).toBeLessThan(1e-6)
      expect(Math.abs(a.roll - b.roll)).toBeLessThan(1e-6)
    }
  })
})

describe('sampleDemoIntro', () => {
  const from = {
    position: [50, 20, 50] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
  }

  it('starts exactly at the pre-activation pose with zero bank', () => {
    const { pose } = sampleDemoIntro({ from, elapsed: 0 }, 0)
    expect(pose.position).toEqual(from.position)
    expect(pose.target).toEqual(from.target)
    expect(pose.roll).toBeCloseTo(0, 9)
  })

  it('ends exactly on the (moving) flight path once the transition completes', () => {
    const flightElapsed = 3
    const { pose, done } = sampleDemoIntro(
      { from, elapsed: DEMO_TRANSITION_SECONDS },
      flightElapsed,
    )
    const flight = demoPose(flightElapsed)
    expect(done).toBe(true)
    expect(distance(pose.position, flight.position)).toBeLessThan(1e-9)
    expect(pose.roll).toBeCloseTo(flight.roll, 9)
  })

  it('is not done mid-transition, and sits strictly between start and the path', () => {
    const flightElapsed = 3
    const { pose, done } = sampleDemoIntro(
      { from, elapsed: DEMO_TRANSITION_SECONDS / 2 },
      flightElapsed,
    )
    const flight = demoPose(flightElapsed)
    expect(done).toBe(false)
    expect(distance(pose.position, from.position)).toBeGreaterThan(0)
    expect(distance(pose.position, flight.position)).toBeGreaterThan(0)
  })
})

describe('stepRollRecovery', () => {
  it('starts at the banked angle and eases toward level, never overshooting it', () => {
    const initial: RollRecovery = { from: 0.4, elapsed: 0 }
    let recovery: RollRecovery | null = initial
    let lastAbsRoll = Math.abs(initial.from)
    const smallStep = DEMO_TRANSITION_SECONDS / 20
    for (let i = 0; i < 25 && recovery; i++) {
      const { roll, next } = stepRollRecovery(recovery, smallStep)
      expect(Math.abs(roll)).toBeLessThanOrEqual(lastAbsRoll + 1e-9)
      lastAbsRoll = Math.abs(roll)
      recovery = next
    }
    // Fully settled to level (no jarring snap left outstanding) within the
    // transition window.
    expect(recovery).toBeNull()
    expect(lastAbsRoll).toBeLessThan(1e-9)
  })

  it('clears to null once the transition duration has fully elapsed', () => {
    const { roll, next } = stepRollRecovery({ from: 0.3, elapsed: 0 }, DEMO_TRANSITION_SECONDS)
    expect(roll).toBe(0)
    expect(next).toBeNull()
  })
})
