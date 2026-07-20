import { expect, type Page, test } from '@playwright/test'

// Nightly full-scale visual coverage for #59's four-face Panel wrap and
// scene-wide uniform height growth (landed by PR #162), captured here per
// issue #29 as the follow-up job PR #162 always intended (#59's own
// acceptance criterion names this job as the home for it). The shared
// PR-blocking e2e seed (test/e2e/kwok/seed.sh — ~30 pods across 6 nodes)
// cannot engage panelLayout.ts's wrap (~34 pods/Tower) or height-growth
// (~132 pods/Tower) thresholds at all, so the feature shipped with zero
// rendered visual proof; #162's own math is unit-tested WebGL-free
// (panelLayout.test.ts), but nothing had proven the *rendered* result
// matches it.
//
// Runs ONLY against the nightly job's full-scale KWOK seed
// (test/e2e/kwok/seed-scale.sh — one deliberately "hot" Tower with hundreds
// of Pods, a deliberately "sparse" Tower, and dozens more of varied size),
// never the PR suite's modest seed: playwright.config.ts's HTP_K8S_E2E_SUITE
// branch keeps the two suites in separate testDirs specifically so this
// can't accidentally run there and fail against too-sparse data (ADR-0004).
//
// Every still here picks its subject (the busiest/sparsest Tower) at RUNTIME
// from the real scene via `__htpDetailTest.towers()`, and verifies the seed
// actually engaged the wrap/growth thresholds before screenshotting — this
// project's standing rule of proving a claim empirically rather than
// assuming a seed plan landed (see seed-scale.sh's own hard correctness
// gate for the seeding side of that same discipline).
//
// Framing uses `__htpCameraTest.requestFocus` (added for this issue) rather
// than the existing `selectTower`/`towerFocusPose` preset: that preset's
// fixed view distance is NOT scene-height-aware (tracked separately as
// issue #165) and clips a grown Tower's roof/base out of frame at exactly
// the scale this suite exercises. `requestFocus` reuses the same Focus
// tween machinery with an arbitrary caller-supplied Pose instead.

// Mirror of DetailTestHook in src/detail/useDetailTestHook.ts (its single
// source of truth) — restated per this suite's cross-compilation-boundary
// convention (see web/e2e/panel-lod.spec.ts for the same pattern).
interface DetailTestHook {
  towers: () => { name: string; panelCount: number; position: [number, number, number] }[]
  pods: () => { namespace: string; pod: string }[]
  sceneHeight: () => number
}

// Mirror of Pose (src/scene/focus.ts) and the relevant slice of
// CameraTestHook (src/scene/FreeFlyControls.tsx).
interface Pose {
  position: [number, number, number]
  target: [number, number, number]
}
interface CameraTestHook {
  isFocusing: () => boolean
  requestFocus: (pose: Pose) => boolean
}

declare global {
  interface Window {
    __htpDetailTest?: DetailTestHook
    __htpCameraTest?: CameraTestHook
  }
}

// Mirror of panelLayout.ts's TOWER_HEIGHT-derived resting capacity (restated
// per the cross-compilation-boundary convention above): the base row count
// at the resting height (11, from `panelRowsPerFace(TOWER_HEIGHT)`) times
// PANELS_PER_ROW (3) times PANEL_FACES_PER_TOWER (4) — the pod count a
// single-face-only (pre-#59) layout could never exceed. A Tower above this
// has necessarily wrapped past at least a second face.
const BASE_FACE_CAPACITY_ALL_FOUR_FACES = 132
// TOWER_HEIGHT at rest (towerLayout.ts) — the floor sceneHeight() never goes
// below.
const RESTING_TOWER_HEIGHT = 6

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

async function waitForFocusSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__htpCameraTest?.isFocusing() === false, undefined, {
    timeout: 15_000,
  })
}

/** Requests a custom camera vantage via `__htpCameraTest.requestFocus` and waits for the fly-to to settle. */
async function flyTo(page: Page, pose: Pose): Promise<void> {
  const requested = await page.evaluate(
    (p) => window.__htpCameraTest?.requestFocus(p) ?? false,
    pose,
  )
  expect(requested).toBe(true)
  await waitForFocusSettled(page)
  // A couple of extra frames so the LOD/atlas shader settles at the new
  // distance before the screenshot (mirrors panel-lod.spec.ts's own
  // post-settle wait).
  await page.waitForTimeout(300)
}

test.describe('nightly: four-face Panel wrap visual coverage (#29)', () => {
  test.beforeEach(async ({ page }) => {
    test.slow()
    await page.goto('/')
    // The full-scale seed carries thousands of Pods; wait for a healthy
    // chunk (not literally every one — KWOK settles the tail asynchronously)
    // before proceeding.
    await waitForPopulatedScene(page, 500)
  })

  test('a busy Tower wraps Panels across two or more faces, seen at an angle', async ({
    page,
  }, testInfo) => {
    const towers = await page.evaluate(() => window.__htpDetailTest!.towers())
    const busiest = towers.reduce((max, t) => (t.panelCount > max.panelCount ? t : max))

    // Empirical proof the seed actually engaged the wrap (issue #29: "prove
    // the dense scene actually engages the wrap ... rather than assuming
    // the seed is dense enough") — never assumed from seed-scale.sh's plan.
    expect(busiest.panelCount).toBeGreaterThan(34)

    const height = await page.evaluate(() => window.__htpDetailTest!.sceneHeight())
    const [cx, , cz] = busiest.position
    // A raised, diagonally-offset vantage close enough to read the wrap: the
    // Tower's front (+Z) and right (+X) faces (panelLayout.ts's
    // facePlacement order) both land in frame at once. Distance/height are
    // both scaled off the scene's real height, not the resting one, so this
    // frames correctly whether the seed grew the scene a little or a lot —
    // verified empirically against ~7, ~9, and ~19-unit rooflines in this
    // issue's rehearsals. 1.6x (not closer) is deliberate: at a denser
    // node count a tighter distance put a much-closer NEIGHBOUR Tower's
    // near-LOD (legible name text, see panelLOD.ts) panels in the way of
    // the subject Tower itself.
    const d = height * 1.6
    await flyTo(page, {
      position: [cx + d, height * 0.75, cz + d],
      target: [cx, height * 0.45, cz],
    })

    await page.screenshot({ path: testInfo.outputPath('tower-four-face-wrap.png') })
  })

  test('a busy and a sparse Tower stand at the SAME height — the sparse one unfilled, not shorter', async ({
    page,
  }, testInfo) => {
    const towers = await page.evaluate(() => window.__htpDetailTest!.towers())
    const height = await page.evaluate(() => window.__htpDetailTest!.sceneHeight())
    const busiest = towers.reduce((max, t) => (t.panelCount > max.panelCount ? t : max))
    const sparsest = towers.reduce((min, t) => (t.panelCount < min.panelCount ? t : min))

    // The seed's deliberate contrast (seed-scale.sh's "hot"/"sparse" nodes)
    // actually landed, and the busy Tower's growth actually raised the
    // WHOLE scene above the resting height — the property this still exists
    // to prove ("unfilled rather than shorter").
    expect(busiest.panelCount).toBeGreaterThan(sparsest.panelCount * 5)
    expect(height).toBeGreaterThan(RESTING_TOWER_HEIGHT)

    // A wide, elevated vantage centred on the midpoint of the two Towers, far
    // enough back and high enough to read both — and, critically, to see
    // that they reach the exact same roofline despite the Pod-count gulf.
    const mx = (busiest.position[0] + sparsest.position[0]) / 2
    const mz = (busiest.position[2] + sparsest.position[2]) / 2
    const spread = Math.hypot(
      busiest.position[0] - sparsest.position[0],
      busiest.position[2] - sparsest.position[2],
    )
    const back = Math.max(spread * 1.2, height * 2.2)
    await flyTo(page, {
      position: [mx, height * 2.3, mz + back],
      target: [mx, height * 0.25, mz],
    })

    await page.screenshot({ path: testInfo.outputPath('busy-vs-sparse-same-height.png') })
  })

  test('a 100+ pod Tower renders top-to-bottom without Panels overflowing the geometry', async ({
    page,
  }, testInfo) => {
    const towers = await page.evaluate(() => window.__htpDetailTest!.towers())
    const height = await page.evaluate(() => window.__htpDetailTest!.sceneHeight())
    const busiest = towers.reduce((max, t) => (t.panelCount > max.panelCount ? t : max))
    expect(busiest.panelCount).toBeGreaterThanOrEqual(100)
    // Comfortably past the single-height-tier capacity, so this Tower's
    // height genuinely grew rather than merely nearing the resting cap.
    expect(busiest.panelCount).toBeGreaterThan(BASE_FACE_CAPACITY_ALL_FOUR_FACES)

    // Pulled back far enough (scaled to the real, grown height) to fit the
    // WHOLE prism — cap to floor — in frame, so an overflowing top or bottom
    // row would be directly visible rather than cropped out of the shot.
    const [cx, , cz] = busiest.position
    const d = height * 2.5
    await flyTo(page, {
      position: [cx + d * 0.5, height * 0.85, cz + d],
      target: [cx, height * 0.42, cz],
    })

    await page.screenshot({ path: testInfo.outputPath('hundred-plus-pod-tower-no-overflow.png') })
  })
})
