import { describe, expect, it } from 'vitest'
import { ActivityEvent, ActivityPhaseChange, ActivityRestart } from '../generated/scenestate'
import { BLINK_DURATION_MS, BlinkStore, blinkIntensity, blinkPeak, panelKey } from './blinks'

describe('blinkIntensity envelope', () => {
  it('peaks at the activity amplitude the instant the blink starts', () => {
    expect(blinkIntensity(0, ActivityRestart)).toBeCloseTo(blinkPeak(ActivityRestart))
    expect(blinkIntensity(0, ActivityPhaseChange)).toBeCloseTo(blinkPeak(ActivityPhaseChange))
  })

  it('decays monotonically toward zero over the blink duration', () => {
    const quarter = blinkIntensity(BLINK_DURATION_MS * 0.25, ActivityRestart)
    const half = blinkIntensity(BLINK_DURATION_MS * 0.5, ActivityRestart)
    const threeQuarter = blinkIntensity(BLINK_DURATION_MS * 0.75, ActivityRestart)
    expect(quarter).toBeGreaterThan(half)
    expect(half).toBeGreaterThan(threeQuarter)
    expect(threeQuarter).toBeGreaterThan(0)
  })

  it('has fully settled (zero) once the duration has elapsed', () => {
    expect(blinkIntensity(BLINK_DURATION_MS, ActivityRestart)).toBe(0)
    expect(blinkIntensity(BLINK_DURATION_MS + 1, ActivityRestart)).toBe(0)
  })

  it('is zero before the blink has started (a negative elapsed)', () => {
    expect(blinkIntensity(-1, ActivityRestart)).toBe(0)
  })

  it('pulses a restart harder than a phase change, and a phase change harder than an event', () => {
    // The activity ranking from the generated docs: a restart/crash should read
    // as a stronger flash than a routine phase change or a plain Event.
    expect(blinkPeak(ActivityRestart)).toBeGreaterThan(blinkPeak(ActivityPhaseChange))
    expect(blinkPeak(ActivityPhaseChange)).toBeGreaterThan(blinkPeak(ActivityEvent))
  })

  it('falls back to a sane peak for an unrecognized activity', () => {
    const peak = blinkPeak('somethingNew')
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(1)
  })
})

describe('panelKey', () => {
  it('is stable for the same (namespace, pod) pair', () => {
    expect(panelKey('team', 'web-1')).toBe(panelKey('team', 'web-1'))
  })

  it('does not collide across namespace/pod boundaries', () => {
    // "a" + "bc" must not key the same as "ab" + "c".
    expect(panelKey('a', 'bc')).not.toBe(panelKey('ab', 'c'))
  })
})

describe('BlinkStore', () => {
  it('reports no intensity for a panel that has never blinked', () => {
    const store = new BlinkStore()
    expect(store.intensityFor('team', 'web-1', 1000)).toBe(0)
    expect(store.hasActive(1000)).toBe(false)
  })

  it('pulses the panel it was triggered for, at the activity peak, right away', () => {
    const store = new BlinkStore()
    store.trigger('team', 'web-1', ActivityRestart, 1000)
    expect(store.intensityFor('team', 'web-1', 1000)).toBeCloseTo(blinkPeak(ActivityRestart))
    expect(store.hasActive(1000)).toBe(true)
  })

  it('only pulses the triggered instance, leaving every other panel untouched', () => {
    const store = new BlinkStore()
    store.trigger('team', 'web-1', ActivityRestart, 1000)
    expect(store.intensityFor('team', 'web-1', 1000)).toBeGreaterThan(0)
    // Same pod name, different namespace — a distinct instance — must stay dark.
    expect(store.intensityFor('other', 'web-1', 1000)).toBe(0)
    // Same namespace, different pod — likewise untouched.
    expect(store.intensityFor('team', 'web-2', 1000)).toBe(0)
  })

  it('decays a blink over its duration and settles back to zero', () => {
    const store = new BlinkStore()
    store.trigger('team', 'web-1', ActivityRestart, 1000)
    const early = store.intensityFor('team', 'web-1', 1000 + BLINK_DURATION_MS * 0.25)
    const late = store.intensityFor('team', 'web-1', 1000 + BLINK_DURATION_MS * 0.75)
    expect(early).toBeGreaterThan(late)
    expect(late).toBeGreaterThan(0)
    expect(store.intensityFor('team', 'web-1', 1000 + BLINK_DURATION_MS)).toBe(0)
    expect(store.hasActive(1000 + BLINK_DURATION_MS)).toBe(false)
  })

  it('re-triggering a still-blinking panel restarts its envelope from the new time', () => {
    const store = new BlinkStore()
    store.trigger('team', 'web-1', ActivityRestart, 1000)
    // Half-way through, a fresh activity re-arms the pulse from full peak again.
    store.trigger('team', 'web-1', ActivityRestart, 1000 + BLINK_DURATION_MS * 0.5)
    expect(store.intensityFor('team', 'web-1', 1000 + BLINK_DURATION_MS * 0.5)).toBeCloseTo(
      blinkPeak(ActivityRestart),
    )
  })

  it('does not leak a blink for a panel nothing ever reads (pruned on next trigger)', () => {
    const store = new BlinkStore()
    store.trigger('gone', 'orphan', ActivityEvent, 1000)
    // Long after it settled, another blink triggers; the settled one is swept.
    store.trigger('team', 'web-1', ActivityRestart, 1000 + BLINK_DURATION_MS * 10)
    expect(store.hasActive(1000 + BLINK_DURATION_MS * 10)).toBe(true)
    expect(store.intensityFor('gone', 'orphan', 1000 + BLINK_DURATION_MS * 10)).toBe(0)
    // Only the live blink remains active.
    expect(store.hasActive(1000 + BLINK_DURATION_MS * 10 + BLINK_DURATION_MS)).toBe(false)
  })
})
