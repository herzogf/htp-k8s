#!/usr/bin/env node
// Builds the nightly full-scale job's $GITHUB_STEP_SUMMARY (issue #171):
// the maintainer's question was "where does this nightly report its
// outcome?" — as shipped, the answer was "nowhere you'd see without
// downloading an artifact zip". This turns the numbers the Playwright specs
// already produce (never recomputed here — one source of truth per number)
// into a short, always-emitted markdown summary, so a run answers the
// obvious questions (did the seed reach the intended scale? were the wrap/
// growth thresholds genuinely engaged? how fast did it load? how much of
// each wall-clock budget did it use?) from the Actions run page alone.
//
// Deliberately Node (not a jq/bash pile inline in the workflow): the JSON
// shapes here (Playwright's own JSON reporter especially) are nested enough
// that plain `fs.readFileSync` + property access reads far more plainly
// than an equivalent jq filter, and Node is already provisioned in this job.
//
// Run with `if: always()` from nightly.yml so a FAILED run still gets a
// summary — that is when it matters most. Every JSON read is defensive
// (missing/unparsable file -> a "did not report" line, never a thrown
// error that would abort the step before anything is written).
import fs from 'node:fs'

const WEB_DIR = 'web'
const RESULTS_DIR = `${WEB_DIR}/e2e-nightly-results`

function readJson(relPath) {
  try {
    return JSON.parse(fs.readFileSync(relPath, 'utf8'))
  } catch {
    return null
  }
}

function fmtMs(ms) {
  return `${ms} ms (${(ms / 1000).toFixed(1)} s)`
}

function pct(numerator, denominator) {
  return `${Math.round((numerator / denominator) * 100)}%`
}

const lines = []
lines.push('## Nightly full-scale run summary')
lines.push('')
lines.push(
  '_Numbers below are read straight from this run'
    + "'s own artifacts (never recomputed) — see the linked spec for how each was measured. Cross-run trend tracking is issue #172, out of scope here._",
)
lines.push('')

// ---------------------------------------------------------------------------
// Seeded scale — MEASURED (from seed-scale.sh's own GITHUB_OUTPUT), not the
// script's documented defaults, so a future drift between the two is visible
// on every run instead of only in a diff (the exact review finding that
// prompted this: the PR body once claimed ~3,000 pods against a shipped
// default that actually computed 3,831).
// ---------------------------------------------------------------------------
lines.push('### Seeded scale (measured)')
const actualNodes = process.env.SEED_ACTUAL_NODES
if (actualNodes) {
  lines.push(
    `- Towers: **${process.env.SEED_ACTUAL_TOWERS}** ` +
      `(1 real kind node + **${actualNodes}** fake KWOK nodes)`,
  )
  lines.push(
    `- Pods: **${process.env.SEED_ACTUAL_TOTAL_PODS}** total ` +
      `(hot node: **${process.env.SEED_ACTUAL_HOT_PODS}**, sparse node: **${process.env.SEED_ACTUAL_SPARSE_PODS}**)`,
  )
} else {
  lines.push('- _Not available — the seeding step did not complete (see its own log)._')
}
lines.push('')

// ---------------------------------------------------------------------------
// Wrap / height-growth thresholds — proof the seed above actually engaged
// #59's layout math, not just that a screenshot exists (panel-wrap.spec.ts's
// own standing rule: never assume the seed is dense enough).
// ---------------------------------------------------------------------------
lines.push('### Wrap / height-growth thresholds engaged (panel-wrap.spec.ts)')
const wrap = readJson(`${RESULTS_DIR}/nightly-wrap-summary.json`)
if (wrap) {
  lines.push(
    `- Busiest Tower \`${wrap.busiestTowerName}\`: **${wrap.busiestPanelCount}** panels ` +
      `(wrap threshold > ${wrap.wrapThresholdPanels}, height-growth threshold > ${wrap.growthThresholdPanels})`,
  )
  lines.push(`- Sparse Tower \`${wrap.sparseTowerName}\`: **${wrap.sparsePanelCount}** panels`)
  lines.push(
    `- Scene height **${wrap.sceneHeight}** (resting floor ${wrap.restingTowerHeight}) — ` +
      `busiest/sparse Tower's own RENDERED height: **${wrap.busiestRenderedHeight}** / **${wrap.sparsestRenderedHeight}** ` +
      `(the "unfilled, not shorter" property: these must be equal)`,
  )
} else {
  lines.push(
    '- _Not available — the busy-vs-sparse test did not complete (see the uploaded artifacts)._',
  )
}
lines.push('')

// ---------------------------------------------------------------------------
// Performance signal (perf.spec.ts) — a comparable-run-over-run number, not
// a pass/fail gate (ADR-0004). Reported here with its wall-clock BUDGET and
// the percentage consumed, so margin erosion is visible over weeks rather
// than only the day a timeout finally fires.
// ---------------------------------------------------------------------------
lines.push('### Performance signal (perf.spec.ts)')
const perf = readJson(`${RESULTS_DIR}/nightly-perf-summary.json`)
// Keep in sync BY HAND with perf.spec.ts's own waitForFunction timeout —
// restated here because the summary script has no import boundary into the
// e2e-nightly compilation domain (same restatement convention the specs
// themselves use for src/ constants).
const POPULATE_BUDGET_MS = 100_000
if (perf) {
  const loadMs = perf.loadMs.navigationToPopulatedScene
  lines.push(
    `- Load: navigation → populated scene in **${fmtMs(loadMs)}** ` +
      `(budget ${fmtMs(POPULATE_BUDGET_MS)}, ${pct(loadMs, POPULATE_BUDGET_MS)} used)`,
  )
  lines.push(
    `- Steady-state frame time: avg **${perf.frameTimeMs.avg} ms** (~${perf.fpsAvg} FPS), ` +
      `p95 **${perf.frameTimeMs.p95} ms**, max **${perf.frameTimeMs.max} ms** (${perf.frameTimeMs.sampleCount} samples)`,
  )
} else {
  lines.push('- _Not available — perf.spec.ts did not complete (see the uploaded artifacts)._')
}
lines.push('')

// ---------------------------------------------------------------------------
// Per-test wall clock + retries, from Playwright's own JSON reporter
// (nightly-only, see playwright.config.ts). A test that only passed on its
// retry is the single best early warning that a timeout's margin is too
// thin — surfaced explicitly rather than buried in a green check.
// ---------------------------------------------------------------------------
lines.push('### Per-test wall clock')
const results = readJson(`${RESULTS_DIR}/results.json`)
if (results) {
  /** Flattens Playwright's nested suite/spec tree into one list of specs. */
  function flattenSpecs(suites) {
    return suites.flatMap((suite) => [
      ...(suite.specs ?? []),
      ...flattenSpecs(suite.suites ?? []),
    ])
  }
  const specs = flattenSpecs(results.suites ?? [])
  let anyRetried = false
  for (const spec of specs) {
    for (const test of spec.tests ?? []) {
      const attempts = test.results ?? []
      const last = attempts[attempts.length - 1]
      if (!last) continue
      const retried = attempts.length > 1
      anyRetried = anyRetried || retried
      const totalMs = attempts.reduce((sum, r) => sum + (r.duration ?? 0), 0)
      const retryNote = retried ? ` (needed a retry — ${attempts.length} attempts)` : ''
      lines.push(`- \`${spec.title}\`: **${fmtMs(totalMs)}**, status ${last.status}${retryNote}`)
    }
  }
  lines.push('')
  lines.push(
    anyRetried
      ? '⚠️ **At least one test needed a retry this run** — an early signal its timeout margin may be eroding.'
      : '_No test needed a retry this run._',
  )
} else {
  lines.push(
    '- _Not available — the Playwright run did not produce its JSON report (see the uploaded artifacts)._',
  )
}
lines.push('')

// ---------------------------------------------------------------------------
// Total job wall clock.
// ---------------------------------------------------------------------------
lines.push('### Job wall clock')
const totalSeconds = process.env.TOTAL_JOB_SECONDS
if (totalSeconds) {
  const budgetMinutes = 60
  lines.push(
    `- This job so far: **${(Number(totalSeconds) / 60).toFixed(1)} min** ` +
      `(budget ${budgetMinutes} min, ${pct(Number(totalSeconds), budgetMinutes * 60)} used)`,
  )
} else {
  lines.push('- _Not available._')
}
lines.push('')

lines.push('### Artifacts')
lines.push(
  '- Screenshots, video, and traces for every test are in the `nightly-full-scale-results` artifact on this run.',
)
lines.push('- The full HTML report is in `nightly-full-scale-report`.')

fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
