#!/usr/bin/env node
// Tower-proximity check on a captured pose trace (issue #120, ADR-0011 layer
// 3). Reports how close the camera came to each Tower and flags "near
// events" under a threshold — used to pick out good "threading between the
// towers" moments for stills.mjs.
//
// Unlike the throwaway #118-iter3 version this replaces, Tower positions are
// NOT a hardcoded assumption about the seed cluster's grid shape — they come
// from towers.json (written by capture.mjs from the real /ws SceneState
// broadcast), recomputed with the same world-space centering formula as
// web/src/scene/towerLayout.ts's towerPlacements() (restated here per the
// e2e suite's own cross-compilation-boundary convention — see
// web/e2e/demo-canyon-tour.spec.ts). That keeps this correct however many
// Towers a given capture's cluster has, not just the 7-Tower ADR-0004
// "modest" seed.

import fs from 'node:fs'
import { parseArgs } from 'node:util'

// Mirrors of web/src/scene/towerLayout.ts's world-space constants (restated,
// not imported — see the file doc comment above).
const TOWER_SPACING = 4
const TOWER_HEIGHT = 6
const TOWER_FOOTPRINT = 1.6
const TOWER_HALF_FOOTPRINT = TOWER_FOOTPRINT / 2

const { values: args } = parseArgs({
  options: {
    'pose-samples': { type: 'string' },
    towers: { type: 'string' },
    // 1.6 is a tight default — close to TOWER_FOOTPRINT, i.e. "almost
    // brushing the tower". run.sh deliberately passes a looser 2.5 instead,
    // to pick out more/broader "flew near a tower" moments across a whole
    // flight for stills.mjs's picker; this CLI default stays tight so a
    // standalone `node proximity.mjs` run (no --near-threshold) reports only
    // genuinely close passes.
    'near-threshold': { type: 'string', default: '1.6' },
    out: { type: 'string' },
  },
})

if (!args['pose-samples'] || !args.towers) {
  console.error(
    'Usage: proximity.mjs --pose-samples <pose-samples.json> --towers <towers.json> [--near-threshold 1.6] [--out proximity.json]',
  )
  process.exit(1)
}

const nearThreshold = Number(args['near-threshold'])
const samples = JSON.parse(fs.readFileSync(args['pose-samples'], 'utf8'))
const towerList = JSON.parse(fs.readFileSync(args.towers, 'utf8'))

function worldPlacements(towerListIn) {
  if (towerListIn.length === 0) return []
  const cols = towerListIn.map((t) => t.grid.col)
  const rows = towerListIn.map((t) => t.grid.row)
  const centerCol = (Math.min(...cols) + Math.max(...cols)) / 2
  const centerRow = (Math.min(...rows) + Math.max(...rows)) / 2
  return towerListIn.map((t) => ({
    name: t.name,
    x: (t.grid.col - centerCol) * TOWER_SPACING,
    z: (t.grid.row - centerRow) * TOWER_SPACING,
  }))
}

const towers = worldPlacements(towerList)

function nearestTower(x, z) {
  let best = null
  for (const t of towers) {
    const d = Math.hypot(x - t.x, z - t.z)
    if (best === null || d < best.dist) best = { dist: d, tower: t }
  }
  return best
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

const events = []
let minSeen = null
for (const s of samples) {
  const t = s.elapsedMs / 1000
  const [x, y, z] = s.pos
  const { dist, tower } = nearestTower(x, z)
  const insideFootprintXZ =
    Math.abs(x - tower.x) <= TOWER_HALF_FOOTPRINT && Math.abs(z - tower.z) <= TOWER_HALF_FOOTPRINT
  const inTowerHeightBand = y >= 0 && y <= TOWER_HEIGHT
  if (minSeen === null || dist < minSeen.dist) {
    minSeen = {
      t,
      dist,
      pos: [x, y, z],
      tower: [tower.x, tower.z],
      insideFootprintXZ,
      inTowerHeightBand,
    }
  }
  if (dist <= nearThreshold) {
    events.push({
      t: round3(t),
      dist: round3(dist),
      pos: [round3(x), round3(y), round3(z)],
      tower: [tower.x, tower.z],
      insideFootprintXZ,
      inTowerHeightBand,
    })
  }
}

const result = {
  source: args['pose-samples'],
  near_threshold: nearThreshold,
  min_distance_overall: {
    t: round3(minSeen.t),
    dist: round3(minSeen.dist),
    pos: minSeen.pos.map(round3),
    tower: minSeen.tower,
    insideFootprintXZ: minSeen.insideFootprintXZ,
    inTowerHeightBand: minSeen.inTowerHeightBand,
  },
  n_near_events: events.length,
  near_events: events,
}

const json = JSON.stringify(result, null, 2)
if (args.out) {
  fs.writeFileSync(args.out, json)
  console.log(`Wrote ${args.out}`)
} else {
  console.log(json)
}
