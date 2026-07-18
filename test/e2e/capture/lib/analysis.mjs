// Pure ADR-0011 layer-3 pose-trace analysis math (issue #120): strongest
// turns (yaw-rate maxima) and sustained yaw-rate saturation events. Split out
// of analyze.mjs so it's importable and unit-testable directly against a
// recorded pose-samples.json fixture and its expected output, without
// shelling out to the CLI — the validation this tool depends on (see the
// #120 PR discussion) needs to be a permanent, re-runnable test, not a
// one-off check in a PR description.
//
// Methodology (matches the #118-iter2/iter3 capture's validated analysis):
//  - yaw derived from the *rendered* camera quaternion via lib/quat.mjs's
//    yawFromQuaternion — deliberately independent of Demo Mode's internal
//    pose-stream model (see that module's doc comment).
//  - "Strongest turns": raw trace downsampled to nearest-real-sample at a
//    fixed cadence (default ~178ms, matching the #116 baseline capture's
//    native average frame spacing, chosen so turn-strength numbers stay
//    comparable across captures taken at different CDP screencast delivery
//    rates), then simple per-sample finite difference of unwrapped yaw, with
//    non-max suppression (>=1s apart) so one physical turn isn't reported as
//    several downsampled points.
//  - "Sustained yaw-rate saturation events": full-resolution raw per-sample
//    finite difference, thresholded (default 0.98x Demo Mode's max yaw rate
//    — see analyze.mjs's CLI defaults for where that number comes from and
//    why it's a CLI flag rather than hardcoded here). Individual
//    over-threshold samples within 0.3s of each other are merged into one
//    cluster/event — REQUIRED: at full resolution, per-sample
//    capture/async-evaluate jitter otherwise fragments one
//    visually-continuous pan into dozens of sub-frame blips.

import { unwrap, yawFromQuaternion } from './quat.mjs'

/**
 * @typedef {{ elapsedMs: number, quat: [number, number, number, number] }} PoseSample
 */

/** Builds the (seconds, unwrapped-yaw-radians) series from raw pose samples. */
export function buildSeries(samples) {
  const ts = samples.map((s) => s.elapsedMs / 1000)
  const rawYaw = samples.map((s) => yawFromQuaternion(s.quat))
  const yaw = unwrap(rawYaw)
  return { ts, yaw }
}

/** Downsamples a (ts, yaw) series to the nearest real sample at a fixed cadence (seconds). */
export function downsample(ts, yaw, cadence) {
  const duration = ts[ts.length - 1]
  const outT = []
  const outY = []
  let j = 0
  const nSteps = Math.floor(duration / cadence) + 1
  for (let k = 0; k <= nSteps; k++) {
    const target = k * cadence
    if (target > duration) break
    while (j + 1 < ts.length && Math.abs(ts[j + 1] - target) <= Math.abs(ts[j] - target)) j++
    if (outT.length === 0 || ts[j] !== outT[outT.length - 1]) {
      outT.push(ts[j])
      outY.push(yaw[j])
    }
  }
  return { t: outT, y: outY }
}

/** Per-sample finite difference of a (ts, yaw) series: [[t, rate], ...] for i=1..n-1. */
export function rates(ts, yaw) {
  const out = []
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1]
    if (dt <= 0) continue
    out.push([ts[i], (yaw[i] - yaw[i - 1]) / dt])
  }
  return out
}

/** Non-max suppression: strongest |rate| samples, no two within minGapS of each other. */
export function strongestTurns(ts, yaw, topN, minGapS) {
  const allRates = rates(ts, yaw).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  const picked = []
  for (const [t, r] of allRates) {
    if (picked.every(([pt]) => Math.abs(t - pt) >= minGapS)) {
      picked.push([t, r])
    }
    if (picked.length >= topN) break
  }
  picked.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  return picked
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

/**
 * Merges full-resolution over-threshold yaw-rate samples into sustained
 * saturation events/clusters — samples within `gapMerge` seconds of each
 * other are one event. This merge step is required: without it, capture/
 * async-evaluate jitter fragments one visually-continuous pan into dozens of
 * sub-frame blips (see the module doc comment).
 */
export function saturationClusters(rateSeries, threshold, gapMerge) {
  const over = rateSeries.filter(([, r]) => Math.abs(r) >= threshold)
  const clusters = []
  let cur = []
  for (const sample of over) {
    if (cur.length > 0 && sample[0] - cur[cur.length - 1][0] > gapMerge) {
      clusters.push(cur)
      cur = []
    }
    cur.push(sample)
  }
  if (cur.length > 0) clusters.push(cur)
  return clusters.map((c) => {
    const ts = c.map(([t]) => t)
    const peak = Math.max(...c.map(([, r]) => Math.abs(r)))
    return {
      start: round3(ts[0]),
      end: round3(ts[ts.length - 1]),
      duration: round3(ts[ts.length - 1] - ts[0]),
      n: c.length,
      peak,
    }
  })
}

/**
 * Full analysis of a raw pose-samples array, matching analyze.mjs's CLI
 * output shape exactly — the one function a fixture-based test can call
 * directly against a recorded pose-samples.json and compare to a recorded
 * expected result, with no CLI/filesystem involved.
 *
 * @param {readonly PoseSample[]} samples sorted ascending by elapsedMs
 * @param {{ label?: string, source?: string, cadence?: number, threshold: number, gapMerge?: number, topN?: number }} options
 *   `threshold` has no default here on purpose — see analyze.mjs for why
 *   it's derived from Demo Mode's max yaw rate rather than hardcoded.
 */
export function analyzePoseTrace(samples, options) {
  const { label, source, cadence = 0.178, threshold, gapMerge = 0.3, topN = 15 } = options
  const { ts, yaw } = buildSeries(samples)
  const duration = ts[ts.length - 1]

  const { t: dt, y: dy } = downsample(ts, yaw, cadence)
  const turns = strongestTurns(dt, dy, topN, 1.0)

  const fullResRates = rates(ts, yaw)
  const clusters = saturationClusters(fullResRates, threshold, gapMerge)

  return {
    label: label ?? source,
    source,
    n_samples: samples.length,
    duration_s: round3(duration),
    avg_native_spacing_ms: Math.round(((1000 * duration) / (samples.length - 1)) * 100) / 100,
    downsampled_n: dt.length,
    strongest_turns: turns.map(([t, r]) => ({ t: round3(t), yaw_rate: r })),
    saturation_clusters: clusters,
    n_saturation_clusters: clusters.length,
  }
}
