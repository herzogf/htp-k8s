#!/usr/bin/env node
// ADR-0011 layer-3 pose-trace analysis CLI (issue #120). The actual math
// lives in lib/analysis.mjs (pure, unit-testable); this is a thin
// read-JSON / call / write-JSON wrapper.
//
// Validated against the #118-iter3 baseline capture's pose trace: running
// this on that capture's pose-samples.json reproduces its recorded
// pose-analysis.json (strongest_turns/saturation_clusters, timestamps and
// yaw rates to full float precision — see the #120 PR discussion). Also
// spot-checked against the earlier #116 baseline's pose-samples.json (that
// directory has no recorded pose-analysis.json to diff against, but the
// output's turn timestamps land within ~0.1s of the maintainer's
// independently-reported 7.6s/51.5s/54.6s turns for that clip).

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import {
  analyzePoseTrace,
  DEFAULT_CADENCE_S,
  DEFAULT_GAP_MERGE_S,
  DEFAULT_TOP_N,
} from './lib/analysis.mjs'

const { values: args } = parseArgs({
  options: {
    'pose-samples': { type: 'string' },
    label: { type: 'string' },
    out: { type: 'string' },
    // cadence/gap-merge/top-n default to the SAME constants
    // analyzePoseTrace() itself defaults to (lib/analysis.mjs) rather than
    // duplicating the numbers here — see that file's comment on why: the
    // fixture regression test only exercises the lib's defaults, so a
    // CLI-only copy going stale would go uncaught (issue #130).
    cadence: { type: 'string', default: String(DEFAULT_CADENCE_S) },
    // The saturation threshold is deliberately NOT a single hardcoded
    // number: it's derived from Demo Mode's max yaw rate (VIEW_YAW_MAX_RATE,
    // web/src/scene/demoMode.ts — currently 1.5 rad/s) times a "how close to
    // the cap counts as saturated" fraction, so this tool doesn't silently
    // go stale the next time that constant changes. This tool gates PRs
    // that touch that exact constant — pass --max-yaw-rate to match it if
    // it's moved since this default was last updated.
    'max-yaw-rate': { type: 'string', default: '1.5' },
    'saturation-fraction': { type: 'string', default: '0.98' },
    'gap-merge': { type: 'string', default: String(DEFAULT_GAP_MERGE_S) },
    'top-n': { type: 'string', default: String(DEFAULT_TOP_N) },
  },
})

if (!args['pose-samples']) {
  console.error(
    'Usage: analyze.mjs --pose-samples <pose-samples.json> [--label <label>] [--out <pose-analysis.json>] ' +
      '[--max-yaw-rate 1.5] [--saturation-fraction 0.98]',
  )
  process.exit(1)
}

const samples = JSON.parse(fs.readFileSync(args['pose-samples'], 'utf8'))
const threshold = Number(args['max-yaw-rate']) * Number(args['saturation-fraction'])

const result = analyzePoseTrace(samples, {
  label: args.label,
  source: args['pose-samples'],
  cadence: Number(args.cadence),
  threshold,
  gapMerge: Number(args['gap-merge']),
  topN: Number(args['top-n']),
})

const json = JSON.stringify(result, null, 2)
if (args.out) {
  fs.writeFileSync(args.out, json)
  console.log(`Wrote ${args.out}`)
} else {
  console.log(json)
}
