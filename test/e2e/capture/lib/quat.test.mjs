// Permanent regression suite for yawFromQuaternion/unwrap (issue #120). Both
// feed directly into every yaw-rate number analyze.mjs produces (strongest
// turns, saturation clusters) — a bug in either silently corrupts that whole
// analysis without looking broken, which is exactly the failure mode ADR-0011
// layer 3 exists to avoid. unwrap's wrap-around handling in particular is
// where such a bug would hide: it only misbehaves right at the ±pi seam, so a
// test suite that never crosses that seam would pass for the wrong reason.
//
// Cross-validates the hand-inlined quaternion rotation in rotateForward
// against three.js's own Quaternion/Vector3 math (the same library
// Scene.tsx's real camera uses) rather than re-deriving the formula a second
// time by hand, which would just duplicate whatever mistake a hand-derivation
// might make.

import { Euler, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { unwrap, yawFromQuaternion } from './quat.mjs'

/** three.js quaternion (scalar-last order, matching quat.mjs's convention) as a plain [x,y,z,w] array. */
function toArr(q) {
  return [q.x, q.y, q.z, q.w]
}

/** Reference yaw for a three.js quaternion: rotate (0,0,-1) with three.js itself, then atan2 in the XZ plane. */
function referenceYaw(q) {
  const forward = new Vector3(0, 0, -1).applyQuaternion(q)
  return Math.atan2(forward.x, forward.z)
}

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

describe('yawFromQuaternion', () => {
  it('is +/-pi for the identity quaternion (forward = -Z, so atan2(0, -1) sits at the wrap seam)', () => {
    expect(Math.abs(yawFromQuaternion([0, 0, 0, 1]))).toBeCloseTo(Math.PI, 12)
  })

  it('matches three.js Vector3.applyQuaternion + atan2 for a battery of known pure-yaw rotations', () => {
    for (const deg of [-179, -135, -90, -45, -1, 0, 1, 45, 90, 135, 179]) {
      const q = new Quaternion().setFromEuler(new Euler(0, (deg * Math.PI) / 180, 0, 'XYZ'))
      expect(yawFromQuaternion(toArr(q))).toBeCloseTo(referenceYaw(q), 10)
    }
  })

  it('matches three.js for combined pitch/yaw/roll orientations (not just pure yaw)', () => {
    for (const [x, y, z] of [
      [0.3, 1.2, -0.4],
      [-0.6, -2.1, 0.9],
      [1.1, 0.05, 0.2],
      [0, 3.0, 0.7],
    ]) {
      const q = new Quaternion().setFromEuler(new Euler(x, y, z, 'XYZ'))
      expect(yawFromQuaternion(toArr(q))).toBeCloseTo(referenceYaw(q), 10)
    }
  })

  it('matches three.js for a batch of random normalized quaternions', () => {
    const rand = mulberry32(1234)
    for (let i = 0; i < 200; i++) {
      const q = new Quaternion(
        rand() * 2 - 1,
        rand() * 2 - 1,
        rand() * 2 - 1,
        rand() * 2 - 1,
      ).normalize()
      expect(yawFromQuaternion(toArr(q))).toBeCloseTo(referenceYaw(q), 10)
    }
  })
})

describe('unwrap', () => {
  it('leaves an already-continuous (non-wrapping) sequence unchanged (up to float noise)', () => {
    // unwrap always round-trips each sample through a modulo, even when no
    // wrap actually occurs, so this is toBeCloseTo rather than exact
    // equality — real floating-point noise, not a bug.
    const angles = [0, 0.1, 0.3, 0.6, 1.0, 1.5]
    const out = unwrap(angles)
    out.forEach((v, i) => expect(v).toBeCloseTo(angles[i], 12))
  })

  it('unwraps a single crossing from just under +pi to just over -pi (continuing to turn the same direction)', () => {
    // A camera yawing steadily in the positive direction through the atan2
    // seam: raw samples would jump from near +pi down to near -pi, which
    // looks like a ~2pi reversal unless unwrapped.
    const raw = [Math.PI - 0.2, Math.PI - 0.05, -Math.PI + 0.1, -Math.PI + 0.25]
    const out = unwrap(raw)
    // Continuously increasing, no jump greater than the true per-step delta.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1])
      expect(out[i] - out[i - 1]).toBeLessThan(0.3)
    }
    expect(out[0]).toBeCloseTo(raw[0], 12)
  })

  it('unwraps a crossing in the negative direction symmetrically', () => {
    const raw = [-Math.PI + 0.2, -Math.PI + 0.05, Math.PI - 0.1, Math.PI - 0.25]
    const out = unwrap(raw)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeLessThan(out[i - 1])
      expect(out[i - 1] - out[i]).toBeLessThan(0.3)
    }
  })

  it('accumulates correctly across several consecutive full turns (multiple wraps in one sequence)', () => {
    // A steady turn at a fixed rate should unwrap to a straight line no
    // matter how many times the raw atan2 signal wraps around pi.
    const rate = 0.9 // rad/step, comfortably below the pi-per-step ambiguity limit
    const steps = 40 // spans several full rotations (40 * 0.9 ~= 36 rad ~= 5.7 turns)
    const raw = []
    for (let i = 0; i < steps; i++) {
      const theta = i * rate
      raw.push(Math.atan2(Math.sin(theta), Math.cos(theta))) // re-wrap into (-pi, pi]
    }
    const out = unwrap(raw)
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBeCloseTo(rate, 6)
    }
    // The unwrapped trace should have travelled the full physical distance,
    // not be stuck oscillating inside a single (-pi, pi] wrap.
    expect(out[out.length - 1] - out[0]).toBeCloseTo(rate * (steps - 1), 4)
  })

  it('a naive "just take the raw diff" implementation would fail the wrap tests above', () => {
    // Demonstrates why unwrap exists at all: without it, a per-step
    // finite-difference of the raw wrapped signal reports a huge false
    // spike right at the seam, which is exactly the kind of corrupted
    // yaw-rate number this whole suite exists to prevent.
    const raw = [Math.PI - 0.05, -Math.PI + 0.05]
    const naiveDiff = raw[1] - raw[0]
    expect(Math.abs(naiveDiff)).toBeGreaterThan(6) // ~2pi false jump
    const unwrapped = unwrap(raw)
    expect(Math.abs(unwrapped[1] - unwrapped[0])).toBeCloseTo(0.1, 6)
  })
})
