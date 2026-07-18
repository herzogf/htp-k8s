#!/usr/bin/env node
// Selects and copies labeled interval + tower-proximity stills out of a raw
// capture (issue #120, ADR-0011 layer 3), before run.sh deletes the raw JPEG
// frame cache. Produces a manifest (stills-manifest.json) pairing each still
// with its requested/actual timestamp, camera altitude, and an
// altitude-band classification mirroring the bands
// web/e2e/demo-canyon-tour.spec.ts screenshots on (canyon-low-pass /
// overview-high-pass / transition-pass) — restated here per that file's own
// cross-compilation-boundary convention, not imported.
//
// Fixed interval stills give an even sampling across the whole clip; the
// optional --proximity file (proximity.mjs's output) adds a handful of
// genuine "threading between the towers" moments, picked as the closest
// distinct near-events at least 5s apart so they don't all cluster around
// one pass.

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

// Mirrors of web/src/scene/towerLayout.ts's world-space constants, same
// altitude-band thresholds web/e2e/demo-canyon-tour.spec.ts uses.
const TOWER_HEIGHT = 6
const CANYON_ALTITUDE_MAX = TOWER_HEIGHT * 0.75
const OVERVIEW_ALTITUDE_MIN = TOWER_HEIGHT * 1.1

const { values: args } = parseArgs({
  options: {
    'out-dir': { type: 'string' },
    proximity: { type: 'string' },
    'interval-ms': { type: 'string', default: '20000' },
    'near-tower-count': { type: 'string', default: '3' },
  },
})

if (!args['out-dir']) {
  console.error(
    'Usage: stills.mjs --out-dir <dir> [--proximity proximity.json] [--interval-ms 20000] [--near-tower-count 3]',
  )
  process.exit(1)
}

const OUT_DIR = args['out-dir']
const STILLS_DIR = path.join(OUT_DIR, 'stills')
const intervalMs = Number(args['interval-ms'])
const nearTowerCount = Number(args['near-tower-count'])

fs.mkdirSync(STILLS_DIR, { recursive: true })

const frameMeta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'frame-meta.json'), 'utf8'))
const poseSamples = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pose-samples.json'), 'utf8'))
frameMeta.sort((a, b) => a.elapsedMs - b.elapsedMs)
poseSamples.sort((a, b) => a.elapsedMs - b.elapsedMs)

function nearestFrame(elapsedMs) {
  let best = frameMeta[0]
  for (const f of frameMeta) {
    if (Math.abs(f.elapsedMs - elapsedMs) < Math.abs(best.elapsedMs - elapsedMs)) best = f
  }
  return best
}

function nearestPose(elapsedMs) {
  let best = poseSamples[0]
  for (const p of poseSamples) {
    if (Math.abs(p.elapsedMs - elapsedMs) < Math.abs(best.elapsedMs - elapsedMs)) best = p
  }
  return best
}

function band(y) {
  if (y <= CANYON_ALTITUDE_MAX) return 'canyon-low-pass'
  if (y >= OVERVIEW_ALTITUDE_MIN) return 'overview-high-pass'
  return 'transition-pass'
}

const durationMs = frameMeta[frameMeta.length - 1].elapsedMs

// Fixed labeled targets: scene load, an early moment, the descent into the
// canyon, then even intervals across the whole clip, then the end.
const targets = [
  { label: '01-start', requestedMs: 0 },
  { label: '02-early', requestedMs: 1000 },
  { label: '03-early-transition', requestedMs: 2500 },
  { label: '04-early-canyon', requestedMs: 4000 },
]
let n = 5
for (let ms = intervalMs; ms < durationMs; ms += intervalMs) {
  targets.push({
    label: `${String(n).padStart(2, '0')}-interval-t${Math.round(ms / 1000)}s`,
    requestedMs: ms,
  })
  n++
}
targets.push({
  label: `${String(n).padStart(2, '0')}-end`,
  requestedMs: durationMs,
})

// Tower-proximity moments (optional): the closest distinct near-events, kept
// at least 5s apart in capture time so they don't all cluster around one
// pass, sorted back into timeline order for a readable manifest.
if (args.proximity) {
  const proximity = JSON.parse(fs.readFileSync(args.proximity, 'utf8'))
  const sorted = [...proximity.near_events].sort((a, b) => a.dist - b.dist)
  const picked = []
  for (const e of sorted) {
    if (picked.every((p) => Math.abs(p.t - e.t) >= 5)) picked.push(e)
    if (picked.length >= nearTowerCount) break
  }
  picked.sort((a, b) => a.t - b.t)
  picked.forEach((e, i) => {
    targets.push({
      label: `near-tower-${i + 1}`,
      requestedMs: Math.round(e.t * 1000),
    })
  })
}

targets.sort((a, b) => a.requestedMs - b.requestedMs)

const manifest = []
targets.forEach((target, i) => {
  const frame = nearestFrame(target.requestedMs)
  const pose = nearestPose(target.requestedMs)
  const actualS = Math.round((frame.elapsedMs / 1000) * 100) / 100
  const y = Math.round(pose.pos[1] * 1000) / 1000
  const b = band(y)
  const filename = `${String(i + 1).padStart(2, '0')}-${target.label}-${b}-t${actualS}s.jpg`
  const dest = path.join(STILLS_DIR, filename)
  fs.copyFileSync(frame.file, dest)
  manifest.push({
    label: target.label,
    requested_ms: target.requestedMs,
    actual_s: actualS,
    y,
    band: b,
    file: dest,
  })
  console.log(`${filename}  (requested ${target.requestedMs}ms, actual ${actualS}s, y=${y}, ${b})`)
})

fs.writeFileSync(path.join(OUT_DIR, 'stills-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Wrote ${manifest.length} stills to ${STILLS_DIR} and stills-manifest.json`)
