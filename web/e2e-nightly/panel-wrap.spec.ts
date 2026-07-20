import fs from 'node:fs'
import path from 'node:path'
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
// of Pods, a deliberately "sparse" Tower, and over a dozen more of varied
// size), never the PR suite's modest seed: playwright.config.ts's HTP_K8S_E2E_SUITE
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
  towerRenderedHeights: () => { name: string; height: number }[]
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
// Mirror of panelLayout.ts's per-FACE (not all-four) resting capacity: the
// same base row count (11) times PANELS_PER_ROW (3) alone — the pod count a
// Tower can hold on its front face before the (i+1)-th Pod wraps onto a
// second face. A named constant (review finding) rather than a bare literal.
const SINGLE_FACE_CAPACITY_AT_REST = 33
// TOWER_HEIGHT at rest (towerLayout.ts) — the floor sceneHeight() never goes
// below.
const RESTING_TOWER_HEIGHT = 6
// seed-scale.sh's known deliberately-sparse node (its own header comment:
// "node 1 ('sparse')") — pinned by name rather than `reduce(min)` over all
// Towers, which degenerates to "busiest > 0" if ANY Tower in the scene
// happens to have 0 Pods (KWOK settling asynchronously, a future seed
// change, etc.) instead of actually exercising the seed's deliberate
// busy/sparse contrast.
const SPARSE_TOWER_NAME = 'kwok-scale-node-1'

async function waitForPopulatedScene(page: Page, minPods: number): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(
    (min) => {
      const hook = window.__htpDetailTest
      return !!hook && hook.pods().length >= min
    },
    minPods,
    // Measured (issue #174 rehearsal, this suite's shipped 50-node/3,671-pod
    // default scale, GitHub Actions run 29761536223): navigation-to-populated
    // 2,012ms on that CI runner (up from ~1,401ms at the earlier 15-node
    // default — see perf.spec.ts's own nightly-perf-summary.json for the
    // canonical, per-run measurement of this exact number) — so 90s is still
    // ~45x that observation, enormous headroom even against a materially
    // slower/contended CI runner. Deliberately KEPT this wide rather than
    // tightened toward that ~45x multiple: a generous budget costs nothing
    // on a green run and protects against a slow/contended runner, whereas
    // tightening it buys nothing and risks an unattended flake; a
    // GitHub-hosted runner is also not the hardware this was measured on.
    // $GITHUB_STEP_SUMMARY's per-test wall clock is what would show this
    // margin actually eroding on real CI runs over time.
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
    // The full-scale seed carries well over a thousand Pods by default; wait
    // for a healthy chunk (not literally every one — KWOK settles the tail
    // asynchronously) before proceeding.
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
    expect(busiest.panelCount).toBeGreaterThan(SINGLE_FACE_CAPACITY_AT_REST)

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

  test('a busy and a sparse Tower stand at the SAME rendered height — the sparse one unfilled, not shorter', async ({
    page,
  }, testInfo) => {
    const towers = await page.evaluate(() => window.__htpDetailTest!.towers())
    const height = await page.evaluate(() => window.__htpDetailTest!.sceneHeight())
    const renderedHeights = await page.evaluate(() =>
      window.__htpDetailTest!.towerRenderedHeights(),
    )
    const busiest = towers.reduce((max, t) => (t.panelCount > max.panelCount ? t : max))
    // Pinned to the seed's known sparse node (see SPARSE_TOWER_NAME's doc
    // comment) rather than reduce(min) over all Towers.
    const sparsest = towers.find((t) => t.name === SPARSE_TOWER_NAME)
    expect(
      sparsest,
      `seed-scale.sh's known sparse node (${SPARSE_TOWER_NAME}) must be present in the scene`,
    ).toBeDefined()

    // The seed's deliberate contrast (seed-scale.sh's "hot"/"sparse" nodes)
    // actually landed, and the busy Tower's growth actually raised the
    // WHOLE scene above the resting height.
    expect(busiest.panelCount).toBeGreaterThan(sparsest!.panelCount * 5)
    expect(height).toBeGreaterThan(RESTING_TOWER_HEIGHT)

    // THE property this still exists to prove ("unfilled rather than
    // shorter", #29's own framing of "the property most likely to look wrong
    // even when the math is right"): each Tower's OWN, actually-rendered
    // prism height (not `sceneHeight()` read a second time — see
    // `towerRenderedHeights()`'s doc comment for why that scalar alone is
    // tautological and cannot catch a real per-Tower rendering divergence)
    // is identical between the busiest and sparsest Tower, and both are
    // genuinely above the resting floor.
    const busiestRendered = renderedHeights.find((r) => r.name === busiest.name)?.height
    const sparsestRendered = renderedHeights.find((r) => r.name === sparsest!.name)?.height
    expect(
      busiestRendered,
      'busiest Tower must have a rendered height in the registry',
    ).toBeGreaterThan(RESTING_TOWER_HEIGHT)
    expect(sparsestRendered, 'sparse Tower must render at the SAME height as the busy one').toBe(
      busiestRendered,
    )

    // Fixed-path summary (issue #171), mirroring perf.spec.ts's own —
    // nightly.yml's $GITHUB_STEP_SUMMARY step reads this so a reader can see
    // the wrap/growth thresholds were genuinely exercised (not just that the
    // screenshot exists) without downloading the artifact zip.
    fs.writeFileSync(
      path.join(testInfo.project.outputDir, 'nightly-wrap-summary.json'),
      JSON.stringify(
        {
          busiestTowerName: busiest.name,
          busiestPanelCount: busiest.panelCount,
          sparseTowerName: sparsest!.name,
          sparsePanelCount: sparsest!.panelCount,
          sceneHeight: height,
          busiestRenderedHeight: busiestRendered,
          sparsestRenderedHeight: sparsestRendered,
          wrapThresholdPanels: SINGLE_FACE_CAPACITY_AT_REST,
          growthThresholdPanels: BASE_FACE_CAPACITY_ALL_FOUR_FACES,
          restingTowerHeight: RESTING_TOWER_HEIGHT,
        },
        null,
        2,
      ),
    )

    // A vantage centred on the midpoint of the two Towers, pulled back along
    // the ray OUTWARD from the grid's own centre (world origin —
    // towerPlacements always centres the whole occupied grid there, see
    // towerLayout.ts) through that midpoint — rather than a fixed
    // camera-space "+Z" offset, which (review finding) put the subjects
    // mid-forest, occluded by whichever row of Towers happened to sit
    // between a fixed offset and the two subjects. seed-scale.sh's
    // alphabetically-sorted node-0/node-1 names always land in the grid's
    // lowest-index row (`towers.go`'s deterministic grid-by-name layout
    // walks sorted names left-to-right, top-to-bottom) — an edge row, never
    // an interior one — so stepping OUTWARD from the grid centre through
    // this pair's midpoint steps AWAY from every other row, never through
    // one, at any node count. Empirically verified end-to-end against a real
    // 15-node/16-Tower seed (issue #29 rehearsal): unobstructed, full
    // roofline in frame, both Towers legible at their true, identical
    // height.
    const mx = (busiest.position[0] + sparsest!.position[0]) / 2
    const mz = (busiest.position[2] + sparsest!.position[2]) / 2
    const spread = Math.hypot(
      busiest.position[0] - sparsest!.position[0],
      busiest.position[2] - sparsest!.position[2],
    )
    const midRadius = Math.hypot(mx, mz)
    // Degenerate case (the pair's midpoint lands exactly on the grid centre,
    // e.g. a tiny seed): fall back to a fixed +Z outward direction rather
    // than dividing by zero.
    const [ux, uz] = midRadius > 1e-6 ? [mx / midRadius, mz / midRadius] : [0, -1]
    const push = Math.max(spread * 1.8, height * 1.6)
    await flyTo(page, {
      position: [mx + ux * push, height * 0.85, mz + uz * push],
      target: [mx, height * 0.45, mz],
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
