// Shared quaternion/yaw math for the ADR-0011 layer-3 pose-trace analysis
// (analyze.mjs). Deliberately derives yaw from the *rendered* camera
// quaternion (three.js scalar-last [x, y, z, w] convention, forward =
// quat * (0, 0, -1)) rather than from Demo Mode's internal deterministic
// pose-stream model (src/scene/demoMode.ts) — see issue #120. That
// independence is what makes this analysis evidence a feel-review can trust,
// rather than a restatement of the model under test.

/**
 * Rotates the camera-local forward vector (0, 0, -1) by a quaternion, using
 * the standard "v + 2*w*cross(q.xyz,v) + 2*cross(q.xyz,cross(q.xyz,v))"
 * expansion (here inlined for the fixed v = (0,0,-1) case).
 *
 * @param {[number, number, number, number]} quat [x, y, z, w]
 * @returns {[number, number, number]}
 */
export function rotateForward(quat) {
  const [x, y, z, w] = quat
  const vx = 0
  const vy = 0
  const vz = -1
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  // v' = v + w*t + cross(q.xyz, t)
  const cx = y * tz - z * ty
  const cy = z * tx - x * tz
  const cz = x * ty - y * tx
  return [vx + w * tx + cx, vy + w * ty + cy, vz + w * tz + cz]
}

/**
 * Yaw (radians, world frame) of a camera quaternion, derived from where its
 * rendered forward vector points in the XZ plane.
 *
 * @param {[number, number, number, number]} quat [x, y, z, w]
 * @returns {number}
 */
export function yawFromQuaternion(quat) {
  const [fx, , fz] = rotateForward(quat)
  return Math.atan2(fx, fz)
}

/**
 * Unwraps a sequence of angles (radians) so consecutive samples never jump by
 * more than pi — turns a raw atan2 series (which wraps at +/-pi) into a
 * continuous trace that finite-differencing can safely rate-of-change over.
 *
 * @param {number[]} angles
 * @returns {number[]}
 */
export function unwrap(angles) {
  const out = [angles[0]]
  for (let i = 1; i < angles.length; i++) {
    const prev = out[out.length - 1]
    let d = angles[i] - (((prev % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
    while (d > Math.PI) d -= 2 * Math.PI
    while (d <= -Math.PI) d += 2 * Math.PI
    out.push(prev + d)
  }
  return out
}
