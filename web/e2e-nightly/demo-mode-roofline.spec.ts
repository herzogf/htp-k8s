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
// Modelled on web/e2e/demo-canyon-tour.spec.ts (same activation/sampling
// shape), but NOT that spec's 65s FLIGHT_DURATION_MS — see that constant's
// own doc comment below for why: the modest suite's 65s budget is provably
// too tight here, found empirically (issue #171 review), not assumed.
//
// A SEPARATE, PRE-EXISTING finding this test surfaced, out of THIS PR's
// scope: demoMode.ts's climb-out is rate-limited by `MAX_CLIMB_GRADIENT` —
// a FIXED world-units-per-horizontal-distance gradient (independent of
// scene height) — while #162 made the ALTITUDE TARGETS ({@link
// altitudeBandsForRoofline}) scale WITH the scene's real roofline. At a
// grown scene the vertical distance to climb grows with height but the rate
// available to climb it, and the episode-length budget to do so in
// (`OVERVIEW_EPISODE_WAYPOINTS`), do not — so how long a genuine climb takes
// in real seconds is scene-height-dependent even though the underlying
// per-waypoint PACING is not. Recorded in docs/agents/findings.md; fixing
// the choreography itself needs the ADR-0011 build-metric/tune/pin/human-
// review loop this PR is not chartered to run.

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
 * How long to fly and sample. NOT demo-canyon-tour.spec.ts's 65s (see the
 * header comment's climb-rate finding for why a taller roofline needs
 * longer, not just the same, window): the time-to-first-clear-roofline is
 * real-wall-clock, not simulated-tour-time, because `FreeFlyControls`' demo
 * step is itself capped per frame at `MAX_FOCUS_STEP_SECONDS` (1/30s) — on a
 * software-rendered (no GPU) headless run below ~30 FPS, each real frame
 * only ever advances the tour by that cap, so a slower frame rate makes the
 * SAME simulated flight take MORE real seconds, not the same. Measured
 * directly (4 independent real runs, this h ≈ 11.24 default scale, this kind
 * of headless/software-WebGL environment): time-to-first-clear-roofline
 * samples were 48.8s, 56.3s, 63.5s, 82.4s — i.e. the OLD 65s budget was
 * already failing on 2 of those 4 real seeds. 260s is > 3x the worst of
 * those four observations, matching this project's "state the live
 * observation beside the bound" convention (ADR-0011). A CI-hosted runner
 * has no GPU either (same software-rendering regime the measurement above
 * used), so this is expected to transfer, not just a local-machine number —
 * but if `$GITHUB_STEP_SUMMARY`'s per-test wall clock (issue #171) shows
 * this creeping toward the budget over time, that is this bound's own early
 * warning to revisit, per the same ADR-0011 discipline.
 */
const FLIGHT_DURATION_MS = 260_000
const POLL_INTERVAL_MS = 400

async function waitForPopulatedScene(page: Page, minPods: number): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(
    (min) => {
      const hook = window.__htpDetailTest
      return !!hook && hook.pods().length >= min
    },
    minPods,
    // Measured (issue #171 rehearsal, this suite's shipped default scale):
    // navigation-to-populated in the ~1.4s range on that rehearsal hardware
    // (see perf.spec.ts's own nightly-perf-summary.json for the canonical,
    // per-run measurement of this exact number) — so 90s is enormous
    // headroom even against a materially slower/contended CI runner. Kept
    // wide rather than trimmed to a tight multiple of the local number
    // specifically because a GitHub-hosted runner is not the hardware this
    // was measured on; $GITHUB_STEP_SUMMARY's per-test wall clock is what
    // would show this margin actually eroding on real CI runs over time.
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
  // Unlike the PR-time demo-canyon-tour.spec.ts this mirrors (which budgets
  // FLIGHT_DURATION_MS + 60s total), this nightly spec's own
  // waitForPopulatedScene ALONE budgets up to 90s against the full-scale
  // seed — measured at ~1.4s on this issue's rehearsal hardware (see
  // perf.spec.ts's own nightly-perf-summary.json for the canonical, per-run
  // measurement of this), so 90s is enormous headroom for populate alone
  // even accounting for a materially slower/contended CI runner; kept wide
  // rather than trimmed to a tighter multiple of that number specifically
  // because CI hardware is not the same hardware this was measured on (see
  // FLIGHT_DURATION_MS's own comment for the same caveat, where it matters
  // far more). 90s populate + 260s flight + two toggle round-trips + margin.
  test.setTimeout(FLIGHT_DURATION_MS + 150_000)

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
    // margin above it, not merely touching it). Break the instant this is
    // satisfied — FLIGHT_DURATION_MS (260s, >3x the worst of 4 real
    // measured samples) is meant to be HEADROOM for a slow/contended run,
    // not a fixed spend every run pays regardless of outcome. Sampling for
    // the full window unconditionally would burn ~4.3 real minutes of the
    // job's 60-minute budget on every green run (worse on a retry) instead
    // of holding that margin in reserve.
    if (pos[1] >= rooflineY * 1.02) {
      await page.screenshot({ path: testInfo.outputPath('demo-mode-over-grown-roofline.png') })
      sawOverRoofline = true
      break
    }

    await page.waitForTimeout(POLL_INTERVAL_MS)
  }

  // Tidy: hand control back to free-fly before the test ends (mirrors
  // demo.spec.ts's own toggle-off discipline), though not itself part of
  // the guard.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  // An overview episode always begins within OVERVIEW_GAP_WAYPOINTS_MAX
  // waypoints of tour start, so it is reliably observed within
  // FLIGHT_DURATION_MS — see that constant's own doc comment for why this
  // window is sized off 4 REAL measured samples rather than assumed from
  // the waypoint pacing alone (which, unlike a fixed simulated-time budget,
  // does not by itself bound REAL wall-clock seconds under a throttled
  // frame rate). If this ever regresses to flying below the real roofline
  // again (the pre-#162 bug, at scene-height-dependent scale), this fails
  // here rather than only being caught by a maintainer's manual review.
  expect(sawOverRoofline).toBe(true)
  expect(maxY).toBeGreaterThanOrEqual(rooflineY * 1.02)
})
