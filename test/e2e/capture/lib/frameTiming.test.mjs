// Permanent regression suite for computeFrameRepeats (issue #120). This is
// the single most important property the ADR-0011 layer-3 capture harness
// has to preserve — see frameTiming.mjs's module doc comment: any
// reimplementation that rounds each frame's duration independently (rather
// than the boundary-cumulative approach actually used) produces a subtly
// WRONG-SPEED video that would silently corrupt a maintainer's feel review.
// A one-off validation in a PR description can't catch a later regression;
// this file is what makes that validation permanent and re-runnable.

import { describe, expect, it } from 'vitest'
import { computeFrameRepeats } from './frameTiming.mjs'

const FPS = 60
const FRAME_MS = 1000 / FPS

// Deterministic PRNG (mulberry32) so the "irregular capture" stress test
// below is reproducible across runs/CI without needing a committed fixture.
function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Synthesizes a capture-like frame sequence: elapsedMs timestamps whose
 * inter-frame gaps are drawn uniformly from the real tool's observed
 * Page.startScreencast delivery range (5.6fps-29fps, per frameTiming.mjs's
 * doc comment and the #116/#118 capture logs), varying frame-to-frame within
 * the same run — never a fixed capture rate.
 */
function syntheticIrregularFrames(n, seed) {
  const rand = mulberry32(seed)
  const minGapMs = 1000 / 29 // fastest observed delivery
  const maxGapMs = 1000 / 5.6 // slowest observed delivery
  const frames = [{ elapsedMs: 0 }]
  let t = 0
  for (let i = 1; i < n; i++) {
    t += minGapMs + rand() * (maxGapMs - minGapMs)
    frames.push({ elapsedMs: t })
  }
  return frames
}

describe('computeFrameRepeats', () => {
  it('hand-verified small example: boundary-cumulative rounding + the "clamped up to 1" edge case', () => {
    // Frames captured faster than the 60fps output grid (8ms native spacing
    // vs a 16.667ms output tick) so consecutive frames sometimes land in the
    // same output tick and must be clamped up to at least 1 repeat each —
    // the one case where the documented invariant (total == round(duration /
    // frameMs)) is allowed to slip (by exactly +1 per clamp).
    const frames = [
      { elapsedMs: 0 },
      { elapsedMs: 8 },
      { elapsedMs: 16 },
      { elapsedMs: 24 },
      { elapsedMs: 32 },
      { elapsedMs: 1000 },
    ]
    const { repeats, totalOutputFrames } = computeFrameRepeats(frames, FPS)
    expect(repeats).toEqual([1, 1, 1, 1, 58, 1])
    // Telescoped boundary total (round(1016.667/16.667) - round(0/16.667) =
    // 61) plus exactly 2 clamp-ups (frames 0 and 2, whose tick range was
    // empty) = 63 — not the naive per-frame sum, and not equal to the clean
    // 61-frame telescoped total either. Pinning this exact number is what
    // guards the clamping branch (`Math.max(1, endTick - startTick)`).
    expect(totalOutputFrames).toBe(63)
  })

  it('two frames spanning exactly one second at 60fps', () => {
    // frame 0 covers the whole [0, 1000) window -> exactly 60 ticks; the
    // final frame has no successor, so it is given exactly one tick's worth
    // of assumed duration, per the module's documented last-frame rule.
    const { repeats, totalOutputFrames } = computeFrameRepeats(
      [{ elapsedMs: 0 }, { elapsedMs: 1000 }],
      FPS,
    )
    expect(repeats).toEqual([60, 1])
    expect(totalOutputFrames).toBe(61)
  })

  it('never repeats a frame fewer than 1 time, even for a zero-duration gap', () => {
    const { repeats } = computeFrameRepeats(
      [{ elapsedMs: 0 }, { elapsedMs: 0 }, { elapsedMs: 1000 }],
      FPS,
    )
    expect(repeats.every((n) => n >= 1)).toBe(true)
  })

  // --- The core anti-drift property -----------------------------------
  //
  // A per-frame-rounding implementation (repeats[i] = Math.max(1,
  // Math.round(durationMs[i] / frameMs)), applied independently per frame
  // instead of via boundary cumulative rounding) is NOT unbiased in the way
  // it might look: for capture delivery this irregular, it drifts the total
  // output duration by many frames over a multi-thousand-frame capture. This
  // test's tolerance (one frame) is tight enough that swapping in that naive
  // implementation fails it — see the PR description's "break it and
  // confirm" evidence for a live demonstration against this exact test.
  it('holds total output duration within one frame of total input duration, across a long irregular sequence', () => {
    const frames = syntheticIrregularFrames(3000, 42)
    const inputDurationMs = frames[frames.length - 1].elapsedMs - frames[0].elapsedMs

    const { totalOutputFrames } = computeFrameRepeats(frames, FPS)
    const outputDurationMs = totalOutputFrames * FRAME_MS

    // Real capture gaps here (34.5ms-178.6ms) are always well above one
    // output tick (16.667ms), so the "clamped up to 1" edge case never
    // triggers and the boundary-cumulative telescoping is exact modulo the
    // first/last boundary's own rounding (< 1 frame) plus the documented
    // one-tick allowance for the un-bounded last frame — at most ~2 frames,
    // nowhere near what per-frame rounding drifts to over 3000 frames.
    expect(Math.abs(outputDurationMs - inputDurationMs)).toBeLessThanOrEqual(2 * FRAME_MS)
  })

  it('holds the same anti-drift property across several independent irregular sequences and lengths', () => {
    for (const [n, seed] of [
      [500, 1],
      [1500, 7],
      [7200, 123], // ~2 minutes at ~20fps average, matching a real full-length capture
    ]) {
      const frames = syntheticIrregularFrames(n, seed)
      const inputDurationMs = frames[frames.length - 1].elapsedMs - frames[0].elapsedMs
      const { totalOutputFrames } = computeFrameRepeats(frames, FPS)
      const outputDurationMs = totalOutputFrames * FRAME_MS
      expect(Math.abs(outputDurationMs - inputDurationMs)).toBeLessThanOrEqual(2 * FRAME_MS)
    }
  })

  it('repeats.length always matches the number of input frames', () => {
    const frames = syntheticIrregularFrames(500, 99)
    const { repeats } = computeFrameRepeats(frames, FPS)
    expect(repeats.length).toBe(frames.length)
  })
})
