import { describe, expect, it } from 'vitest'
import { decorativeLaneActivitySource, decorativePulsesFor, PULSES_PER_LANE } from './laneActivity'

describe('decorativePulsesFor', () => {
  it('returns PULSES_PER_LANE pulses', () => {
    expect(decorativePulsesFor('a->b', 0)).toHaveLength(PULSES_PER_LANE)
  })

  it('keeps every pulse t within [0, 1)', () => {
    for (let now = 0; now < 5000; now += 137) {
      for (const pulse of decorativePulsesFor('a->b', now)) {
        expect(pulse.t).toBeGreaterThanOrEqual(0)
        expect(pulse.t).toBeLessThan(1)
      }
    }
  })

  it('is a deterministic pure function of (laneId, now)', () => {
    expect(decorativePulsesFor('a->b', 1234)).toEqual(decorativePulsesFor('a->b', 1234))
  })

  it('advances t as time passes, within one cycle', () => {
    const [early] = decorativePulsesFor('a->b', 0)
    const [later] = decorativePulsesFor('a->b', 200)

    expect(later.t).toBeGreaterThan(early.t)
  })

  it('wraps back to the same state after one full period', () => {
    const period = 2200 // mirrors PULSE_PERIOD_MS (not exported; behaviour-level check)
    expect(decorativePulsesFor('a->b', 500)).toEqual(decorativePulsesFor('a->b', 500 + period))
  })

  it('spaces simultaneous pulses on one lane apart, never overlapping', () => {
    const pulses = decorativePulsesFor('a->b', 999)
    const [p0, p1] = pulses
    // With PULSES_PER_LANE = 2, the two pulses sit roughly half a cycle apart.
    const gap = Math.abs(p0.t - p1.t)
    expect(gap).toBeGreaterThan(0.1)
  })

  it('phase-shifts different lanes so they do not all pulse in lockstep', () => {
    const a = decorativePulsesFor('tower-a->tower-b', 0)[0]
    const b = decorativePulsesFor('tower-c->tower-d', 0)[0]

    expect(a.t).not.toBeCloseTo(b.t, 5)
  })

  it('always reports full intensity in v1 (no dimming logic yet)', () => {
    for (const pulse of decorativePulsesFor('a->b', 42)) {
      expect(pulse.intensity).toBe(1)
    }
  })
})

describe('decorativeLaneActivitySource', () => {
  it('implements LaneActivitySource by delegating to decorativePulsesFor', () => {
    expect(decorativeLaneActivitySource.pulsesFor('a->b', 100)).toEqual(
      decorativePulsesFor('a->b', 100),
    )
  })
})
