import { describe, expect, it } from 'vitest'
import {
  PANEL_LOD_FAR_DISTANCE,
  PANEL_LOD_NEAR_DISTANCE,
  PANEL_NAME_MAX_CHARS,
  panelDetailBlend,
  panelTextPhase,
  truncatePanelName,
} from './panelLOD'

describe('panel LOD thresholds', () => {
  it('keeps the far threshold strictly beyond the near threshold', () => {
    // A degenerate or inverted near/far pair would make the blend curve
    // undefined (division by zero or negative width) — the tuned constants
    // must leave real headroom for the eased transition band.
    expect(PANEL_LOD_FAR_DISTANCE).toBeGreaterThan(PANEL_LOD_NEAR_DISTANCE)
  })
})

describe('panelDetailBlend', () => {
  it('is full detail (1) right at the camera', () => {
    expect(panelDetailBlend(0)).toBe(1)
  })

  it('is full detail (1) at and below the near threshold — close/mid range', () => {
    expect(panelDetailBlend(PANEL_LOD_NEAR_DISTANCE)).toBeCloseTo(1)
    expect(panelDetailBlend(PANEL_LOD_NEAR_DISTANCE * 0.5)).toBeCloseTo(1)
  })

  it('is a flat blob (0) at and beyond the far threshold', () => {
    expect(panelDetailBlend(PANEL_LOD_FAR_DISTANCE)).toBeCloseTo(0)
    expect(panelDetailBlend(PANEL_LOD_FAR_DISTANCE * 10)).toBe(0)
  })

  it('eases smoothly and monotonically through the transition band', () => {
    const near = PANEL_LOD_NEAR_DISTANCE
    const far = PANEL_LOD_FAR_DISTANCE
    const quarter = panelDetailBlend(near + (far - near) * 0.25)
    const mid = panelDetailBlend(near + (far - near) * 0.5)
    const threeQuarter = panelDetailBlend(near + (far - near) * 0.75)

    expect(quarter).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(threeQuarter)
    expect(mid).toBeCloseTo(0.5)
    expect(quarter).toBeLessThan(1)
    expect(threeQuarter).toBeGreaterThan(0)
  })

  it('never leaves the 0..1 range for an arbitrary distance, including negative', () => {
    for (const distance of [-100, -1, 0, 1, 5, 50, 10_000]) {
      const blend = panelDetailBlend(distance)
      expect(blend).toBeGreaterThanOrEqual(0)
      expect(blend).toBeLessThanOrEqual(1)
    }
  })

  it('respects explicit near/far overrides independent of the tuned defaults', () => {
    expect(panelDetailBlend(5, 10, 20)).toBe(1)
    expect(panelDetailBlend(20, 10, 20)).toBeCloseTo(0)
    expect(panelDetailBlend(15, 10, 20)).toBeCloseTo(0.5)
  })
})

describe('truncatePanelName', () => {
  it('leaves a name within the budget unchanged', () => {
    expect(truncatePanelName('web-1', 13)).toBe('web-1')
  })

  it('leaves a name exactly at the budget unchanged (no needless ..)', () => {
    expect('exactly-13-ch').toHaveLength(13)
    expect(truncatePanelName('exactly-13-ch', 13)).toBe('exactly-13-ch')
  })

  it('truncates a too-long name to first (maxChars-2) chars plus a trailing ..', () => {
    // The coordinator's worked example — a real long pod name at the default budget.
    expect(truncatePanelName('coredns-7d764666f9-ltwd5', 13)).toBe('coredns-7d7..')
  })

  it('produces a result of exactly maxChars for any over-budget name', () => {
    const result = truncatePanelName('a-very-long-pod-name-indeed', 13)
    expect(result).toHaveLength(13)
    expect(result.endsWith('..')).toBe(true)
  })

  it('handles the empty string and a zero/negative budget', () => {
    expect(truncatePanelName('', 13)).toBe('')
    expect(truncatePanelName('anything', 0)).toBe('')
    expect(truncatePanelName('anything', -5)).toBe('')
  })

  it('hard-cuts (no .. marker) when the budget is too small to hold one', () => {
    // maxChars <= 2 leaves no room for content + the two-char marker.
    expect(truncatePanelName('anything', 2)).toBe('an')
    expect(truncatePanelName('anything', 1)).toBe('a')
  })

  it('never exceeds the default budget for a realistic set of pod names', () => {
    const names = [
      'coredns-7d764666f9-ltwd5',
      'kube-proxy-abc12',
      'nginx',
      'my-app-deployment-6c9f7b8d5c-qh2xz',
    ]
    for (const name of names) {
      expect(truncatePanelName(name, PANEL_NAME_MAX_CHARS).length).toBeLessThanOrEqual(
        PANEL_NAME_MAX_CHARS,
      )
    }
  })
})

describe('panelTextPhase', () => {
  it('is deterministic for the same (namespace, pod) pair', () => {
    expect(panelTextPhase('team', 'web-1')).toBe(panelTextPhase('team', 'web-1'))
  })

  it('does not collide across the namespace/pod boundary', () => {
    // "a" + "bc" must not phase the same as "ab" + "c" (mirrors panelKey's own
    // no-collision guarantee, which this hash is built on top of).
    expect(panelTextPhase('a', 'bc')).not.toBe(panelTextPhase('ab', 'c'))
  })

  it('differs across distinct pods (spot check, not guaranteed uniqueness)', () => {
    const phases = new Set(Array.from({ length: 20 }, (_, i) => panelTextPhase('ns', `pod-${i}`)))
    expect(phases.size).toBeGreaterThan(1)
  })

  it('always lands in [0, 1)', () => {
    for (const pod of ['a', 'zzz', 'pod-with-a-much-longer-name-than-usual', '']) {
      const phase = panelTextPhase('ns', pod)
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(1)
    }
  })
})
