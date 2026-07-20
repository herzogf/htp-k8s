import fs from 'node:fs'
import { expect, test } from '@playwright/test'

// Nightly full-scale performance signal (issue #29, ADR-0004): the KWOK
// "full target scale" tier (50+ nodes, thousands of pods) exists to exercise
// the rendering pipeline (InstancedMesh layout, the per-Pod name-texture
// atlas, #59's wrap/height-growth math) at a scale the PR-blocking job
// deliberately never reaches — but exercising it is only half the point
// without a captured, comparable-across-runs signal to notice a regression
// by. This test captures two numbers in a machine-readable JSON artifact
// every nightly run: how long the scene takes to go from navigation to fully
// populated, and the steady-state per-frame render cost once it has.
//
// This is NOT a hard performance gate: a single noisy CI runner's absolute
// numbers aren't a reliable pass/fail threshold (this job isn't
// PR-blocking either — ADR-0004), and comparing across runs is exactly what
// the maintainer reviewing the downloaded `nightly-perf.json` artifacts (or
// the console-logged summary, readable straight from the Action log without
// downloading anything) is for. The only hard assertions here are sanity
// checks that the measurement itself is real: the scene actually finished
// loading in bounded time, and the sampling loop actually produced frames
// (a wedged render loop should fail loudly, not silently report a bogus
// number).

interface DetailTestHook {
  towers: () => { name: string; panelCount: number }[]
  pods: () => { namespace: string; pod: string }[]
}

declare global {
  interface Window {
    __htpDetailTest?: DetailTestHook
  }
}

/** Wait for a healthy chunk of the full-scale seed to be visible — not literally every Pod (KWOK settles the tail asynchronously). */
const MIN_PODS_FOR_POPULATED = 500
/** How long the frame-time sampling loop runs once the scene has settled. */
const FRAME_SAMPLE_MS = 5_000

test('nightly performance signal: scene load time and steady-state frame time at full scale', async ({
  page,
}, testInfo) => {
  test.slow()

  const navStart = Date.now()
  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(
    (min) => {
      const hook = window.__htpDetailTest
      return !!hook && hook.pods().length >= min
    },
    MIN_PODS_FOR_POPULATED,
    { timeout: 120_000 },
  )
  const navigationToPopulatedMs = Date.now() - navStart

  const towers = await page.evaluate(() => window.__htpDetailTest!.towers())
  const pods = await page.evaluate(() => window.__htpDetailTest!.pods())

  // Let the scene settle — the name-texture atlas build, instance buffer
  // upload, and any first-paint hitch — before sampling STEADY-STATE frame
  // time, so the load-time cost above isn't double-counted into the
  // per-frame number below.
  await page.waitForTimeout(2_000)

  // A page-side requestAnimationFrame loop recording each frame's delta —
  // the same signal the browser's own render loop runs at, sampled directly
  // rather than inferred from screenshot timing.
  const frameDeltasMs: number[] = await page.evaluate((durationMs) => {
    return new Promise<number[]>((resolve) => {
      const deltas: number[] = []
      let last = performance.now()
      let elapsed = 0
      function tick(now: number) {
        deltas.push(now - last)
        elapsed += now - last
        last = now
        if (elapsed < durationMs) {
          requestAnimationFrame(tick)
        } else {
          resolve(deltas)
        }
      }
      requestAnimationFrame((t) => {
        last = t
        requestAnimationFrame(tick)
      })
    })
  }, FRAME_SAMPLE_MS)

  expect(frameDeltasMs.length).toBeGreaterThan(10)

  const sorted = [...frameDeltasMs].sort((a, b) => a - b)
  const avgMs = frameDeltasMs.reduce((a, b) => a + b, 0) / frameDeltasMs.length
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)]
  const maxMs = sorted[sorted.length - 1]

  const result = {
    // ISO timestamp so a maintainer downloading several nightly runs' JSON
    // artifacts can line them up chronologically without relying on the
    // GitHub Actions run metadata.
    timestamp: new Date().toISOString(),
    scene: {
      towerCount: towers.length,
      podCount: pods.length,
      busiestTowerPanelCount: towers.reduce((max, t) => Math.max(max, t.panelCount), 0),
    },
    loadMs: {
      navigationToPopulatedScene: navigationToPopulatedMs,
    },
    frameTimeMs: {
      sampleCount: frameDeltasMs.length,
      avg: Number(avgMs.toFixed(2)),
      p95: Number(p95Ms.toFixed(2)),
      max: Number(maxMs.toFixed(2)),
    },
    fpsAvg: Number((1000 / avgMs).toFixed(1)),
  }

  // Console-logged so the number is readable straight from the Action log —
  // the quickest way to notice "this run was 3x slower" without downloading
  // an artifact — in addition to the JSON artifact below for a proper
  // across-runs comparison.
  console.log('[nightly-perf]', JSON.stringify(result, null, 2))

  const jsonPath = testInfo.outputPath('nightly-perf.json')
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  await testInfo.attach('nightly-perf.json', { path: jsonPath, contentType: 'application/json' })

  // The visual companion to the numbers above: the full-scale scene the
  // measurement was actually taken against.
  await page.screenshot({ path: testInfo.outputPath('nightly-perf-scene.png') })

  // Sanity, not a performance gate (see header comment): the scene loaded in
  // bounded time and the busiest Tower is genuinely part of the dense seed
  // this job exists to exercise.
  expect(navigationToPopulatedMs).toBeLessThan(120_000)
  expect(result.scene.busiestTowerPanelCount).toBeGreaterThan(100)
})
