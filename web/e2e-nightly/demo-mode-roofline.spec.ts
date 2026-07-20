import { expect, type Page, test } from '@playwright/test'

// Nightly permanent guard (issue #29): Demo Mode's automated flight reaches
// an "over the rooftops" overview altitude that genuinely clears the
// scene's REAL, grown roofline — not just the resting TOWER_HEIGHT one.
//
// #59 lets a busy scene's Towers grow well past the resting height (a
// 260-Pod Tower sits at h ≈ 11.24, per #162's own verification notes); #162
// made every one of Demo Mode's altitude bands scale off the scene's actual
// roofline (`demoMode.ts`'s `altitudeBandsForRoofline`/`bandsForPlacements`)
// specifically because the OLD fixed bands did not: at a grown scene they
// flew the "overview" pass *below* the real rooftops — the camera clipping
// through Towers at exactly the scale #59 exists to support. That fix is
// unit-tested WebGL-free (`demoMode.test.ts`), but nothing had proven it
// against the *rendered*, grown scene — and the math is now height-
// dependent, so it is worth a standing regression guard rather than a
// one-off manual check (#162's own verification was exactly that: "done by
// hand against a throwaway kind+KWOK cluster ... relayed to the maintainer
// as stills and clips ... not repeatable and leaves nothing to regress
// against").
//
// Runs ONLY against the nightly job's full-scale KWOK seed
// (test/e2e/kwok/seed-scale.sh), never the PR suite's modest seed: a scene
// that never grows past the resting height can't exercise this at all
// (playwright.config.ts's HTP_K8S_E2E_SUITE branch keeps the two suites in
// separate testDirs so this can't run there by accident).
//
// Modelled directly on web/e2e/demo-canyon-tour.spec.ts (same activation,
// sampling, and "guaranteed within FLIGHT_DURATION_MS" reasoning — see that
// file's header comment for the full rationale on why overview episodes are
// bounded, not just probable), scaled to the scene's real roofline instead
// of the resting-height constants that spec restates.

// Mirror of DetailTestHook in src/detail/useDetailTestHook.ts.
interface DetailTestHook {
  pods: () => { namespace: string; pod: string }[]
  sceneHeight: () => number
}

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx.
interface CameraTestHook {
  getPosition: () => [number, number, number]
  getQuaternion: () => [number, number, number, number]
  isDemoActive: () => boolean
}

declare global {
  interface Window {
    __htpDetailTest?: DetailTestHook
    __htpCameraTest?: CameraTestHook
  }
}

// Resting TOWER_HEIGHT (towerLayout.ts) — the floor sceneHeight() never goes
// below; used only to assert the seed actually grew the scene, never to
// frame anything.
const RESTING_TOWER_HEIGHT = 6

/**
 * How long to fly and sample. Matches demo-canyon-tour.spec.ts's own
 * FLIGHT_DURATION_MS exactly (65s): the tour's episode pacing
 * (`OVERVIEW_GAP_WAYPOINTS_MIN/MAX`, `OVERVIEW_EPISODE_WAYPOINTS`) is driven
 * by waypoint count and ground speed, neither of which depends on scene
 * height, so the same bounded window that guarantees an overview episode on
 * the modest PR scene guarantees one here too — confirmed empirically in
 * this issue's rehearsal (a ~19-unit-roofline scene's flight cleared the
 * roofline by t≈27s, well inside this window).
 */
const FLIGHT_DURATION_MS = 65_000
const POLL_INTERVAL_MS = 400

async function waitForPopulatedScene(page: Page, minPods: number): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(
    (min) => {
      const hook = window.__htpDetailTest
      return !!hook && hook.pods().length >= min
    },
    minPods,
    { timeout: 90_000 },
  )
}

async function cameraPosition(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getPosition()
  })
}

test('demo mode over a grown scene: the automated flight climbs above the REAL (grown) roofline', async ({
  page,
}, testInfo) => {
  test.setTimeout(FLIGHT_DURATION_MS + 60_000)

  await page.goto('/')
  await waitForPopulatedScene(page, 500)

  // The scene's actual roofline — every Tower's prism top, per #59's
  // uniform-height rule (`sceneHeight()`, added for this issue). The whole
  // point of this test: the seed must have genuinely grown the scene past
  // the resting height, or this guard would trivially pass against the same
  // fixed bands the bug shipped with.
  const rooflineY = await page.evaluate(() => window.__htpDetailTest!.sceneHeight())
  expect(rooflineY).toBeGreaterThan(RESTING_TOWER_HEIGHT)

  const toggle = page.getByRole('button', { name: /demo mode/i })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === true)

  let maxY = -Infinity
  let sawOverRoofline = false
  const start = Date.now()
  while (Date.now() - start < FLIGHT_DURATION_MS) {
    const pos = await cameraPosition(page)
    expect(pos.every((v) => Number.isFinite(v))).toBe(true)
    maxY = Math.max(maxY, pos[1])

    // The regression #162 fixed, caught the instant it recurs: the flight
    // reaching an altitude that genuinely clears the real roofline (a small
    // margin above it, not merely touching it).
    if (!sawOverRoofline && pos[1] >= rooflineY * 1.02) {
      await page.screenshot({ path: testInfo.outputPath('demo-mode-over-grown-roofline.png') })
      sawOverRoofline = true
    }

    await page.waitForTimeout(POLL_INTERVAL_MS)
  }

  // Tidy: hand control back to free-fly before the test ends (mirrors
  // demo.spec.ts's own toggle-off discipline), though not itself part of
  // the guard.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  // Guaranteed within FLIGHT_DURATION_MS (see the header comment): an
  // overview episode always begins within OVERVIEW_GAP_WAYPOINTS_MAX
  // waypoints of tour start, and is sustained long enough for the
  // rate-limited climb to genuinely reach the overview band. If this ever
  // regresses to flying below the real roofline again (the pre-#162 bug,
  // at scene-height-dependent scale), this fails here rather than only
  // being caught by a maintainer's manual review.
  expect(sawOverRoofline).toBe(true)
  expect(maxY).toBeGreaterThanOrEqual(rooflineY * 1.02)
})
