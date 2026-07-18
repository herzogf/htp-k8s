#!/usr/bin/env node
// ADR-0011 layer-3 pose-trace analysis (issue #120).
//
// Methodology (matches the #118-iter2/iter3 capture's validated analysis):
//  - yaw derived from the *rendered* camera quaternion: forward = quat *
//    (0,0,-1) (three.js convention, scalar-last [x,y,z,w]) — see lib/quat.mjs
//    for why this is deliberately independent of Demo Mode's internal
//    pose-stream model.
//  - "Strongest turns": raw trace downsampled to nearest-real-sample at a
//    fixed ~178ms cadence (matching the #116 baseline capture's native
//    average frame spacing, chosen so turn-strength numbers stay comparable
//    across captures taken at different CDP screencast delivery rates), then
//    simple per-sample finite difference of unwrapped yaw, with non-max
//    suppression (>=1s apart) so one physical turn isn't reported as several
//    downsampled points.
//  - "Sustained yaw-rate saturation events": full-resolution raw per-sample
//    finite difference, thresholded at 0.98*VIEW_YAW_MAX_RATE (1.47 rad/s,
//    web/src/scene/demoMode.ts). Individual over-threshold samples within
//    0.3s of each other are merged into one cluster/event — REQUIRED: at
//    full resolution, per-sample capture/async-evaluate jitter otherwise
//    fragments one visually-continuous pan into dozens of sub-frame blips.
//
// Validated against the #116 baseline capture's pose trace: run this on
// /home/flo/Videos/htp-k8s-pr116-demo-flight-105/pose-samples.json and its
// strongest_turns/saturation_clusters output reproduces the #118 harness's
// prior analysis of the same file byte-for-byte (see the PR description for
// #120 for the diff proving that).

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { unwrap, yawFromQuaternion } from './lib/quat.mjs'

const { values: args } = parseArgs({
  options: {
    'pose-samples': { type: 'string' },
    label: { type: 'string' },
    out: { type: 'string' },
    cadence: { type: 'string', default: '0.178' },
    threshold: { type: 'string', default: '1.47' },
    'gap-merge': { type: 'string', default: '0.3' },
    'top-n': { type: 'string', default: '15' },
  },
})

if (!args['pose-samples']) {
  console.error(
    'Usage: analyze.mjs --pose-samples <pose-samples.json> [--label <label>] [--out <pose-analysis.json>]',
  )
  process.exit(1)
}

function buildSeries(samples) {
  const ts = samples.map((s) => s.elapsedMs / 1000)
  const rawYaw = samples.map((s) => yawFromQuaternion(s.quat))
  const yaw = unwrap(rawYaw)
  return { ts, yaw }
}

function downsample(ts, yaw, cadence) {
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

function rates(ts, yaw) {
  const out = []
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1]
    if (dt <= 0) continue
    out.push([ts[i], (yaw[i] - yaw[i - 1]) / dt])
  }
  return out
}

/** Non-max suppression: strongest |rate| samples, no two within minGapS of each other. */
function strongestTurns(ts, yaw, topN, minGapS) {
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

function saturationClusters(rateSeries, threshold, gapMerge) {
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

function round3(n) {
  return Math.round(n * 1000) / 1000
}

const samples = JSON.parse(fs.readFileSync(args['pose-samples'], 'utf8'))
const { ts, yaw } = buildSeries(samples)
const duration = ts[ts.length - 1]

const cadence = Number(args.cadence)
const threshold = Number(args.threshold)
const gapMerge = Number(args['gap-merge'])
const topN = Number(args['top-n'])

const { t: dt, y: dy } = downsample(ts, yaw, cadence)
const turns = strongestTurns(dt, dy, topN, 1.0)

const fullResRates = rates(ts, yaw)
const clusters = saturationClusters(fullResRates, threshold, gapMerge)

const result = {
  label: args.label ?? args['pose-samples'],
  source: args['pose-samples'],
  n_samples: samples.length,
  duration_s: round3(duration),
  avg_native_spacing_ms: Math.round(((1000 * duration) / (samples.length - 1)) * 100) / 100,
  downsampled_n: dt.length,
  strongest_turns: turns.map(([t, r]) => ({ t: round3(t), yaw_rate: r })),
  saturation_clusters: clusters,
  n_saturation_clusters: clusters.length,
}

const json = JSON.stringify(result, null, 2)
if (args.out) {
  fs.writeFileSync(args.out, json)
  console.log(`Wrote ${args.out}`)
} else {
  console.log(json)
}
