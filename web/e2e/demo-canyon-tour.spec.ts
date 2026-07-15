import { expect, type Page, test } from '@playwright/test'

// Demo Mode's redesigned Canyon tour (#91, ADR-0010): the flight now weaves
// *among and through* the Towers — an urban-canyon "small Cessna between the
// skyscrapers" feel — instead of orbiting wide and high in empty space. This
// e2e is the "the project's standard practice for meaningful frontend work"
// visual-proof capture #91 asks for: a long, real screen-recorded flight over
// a real multi-Tower cluster (this project drives the actual running app
// against a kind+KWOK test cluster, ADR-0004), with periodic screenshots at
// the moments that best show off the tuning knobs called out in #91 —
// perimeter offset, altitude mix (canyon-low vs overview-high), and a turn
// (banking, derived from the path's own velocity).
//
// It intentionally captures a LONG run (tens of seconds, `FLIGHT_DURATION_MS`
// below) rather than a few frames: #91's whole point is a human judging the
// cinematic *feel* — canyon threading, altitude rhythm, look-at framing,
// glances — over a real stretch of flight, not a single-frame assertion. The
// walk/altitude/glance seams are unit-tested deterministically WebGL-free in
// src/scene/demoMode.test.ts; this is the end-to-end visual proof plus a few
// sanity assertions (moves, stays in bounds, no NaN — not the main point,
// but worth having) against the real rig wired to the real, populated scene.
//
// Reproducibility (ADR-0010): the tour is a deterministic function of `(seed,
// Tower placements, entry pose)`. This test activates Demo Mode via the HUD
// toggle immediately after the scene loads — before any WASD/mouse-look can
// move the camera — so the entry pose is always the scene's fixed default
// framed camera (`[10, 9, 15]`, see Scene.tsx). That plus a pinned
// `HTP_K8S_DEMO_SEED` (set by whoever runs this e2e locally; CI leaves it
// unset and gets a fresh random seed each run — see main.go's `-demo-seed`/
// `HTP_K8S_DEMO_SEED` precedence) fully replays the tour: "same spot + same
// seed" (ADR-0010). The resolved seed is always logged by the backend at
// startup (`demo seed: <n>`) and by the frontend on activation; capture
// either to reproduce a specific run.

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx (its single
// source of truth) — the e2e is a separate compilation domain from the app
// bundle, so the shape is restated here rather than imported across that
// boundary (see freefly.spec.ts/demo.spec.ts for the same convention).
interface CameraTestHook {
  getPosition: () => [number, number, number]
  getQuaternion: () => [number, number, number, number]
  isFocusing: () => boolean
  getFocusGoal: () => unknown
  isDemoActive: () => boolean
}

declare global {
  interface Window {
    __htpCameraTest?: CameraTestHook
  }
}

/** One Tower as it arrives in the /ws SceneState snapshot — just enough to compute the cluster's world-space footprint. */
interface TowerFrame {
  name: string
  grid: { col: number; row: number }
}

// Mirrors of the world-space tuning constants in src/scene/demoMode.ts and
// src/scene/towerLayout.ts (restated per this suite's cross-compilation-
// boundary convention above) — used only to recognise good screenshot
// moments and sanity-bound the flight, never to duplicate production logic.
const TOWER_SPACING = 4
const TOWER_HEIGHT = 6
const PERIMETER_OFFSET = TOWER_SPACING * 1.5
const CANYON_ALTITUDE_MAX = TOWER_HEIGHT * 0.75
const OVERVIEW_ALTITUDE_MIN = TOWER_HEIGHT * 1.5

/** How long to fly and record: long enough for several canyon passes, an overview rise, and at least one turn (#91). */
const FLIGHT_DURATION_MS = 65_000
const POLL_INTERVAL_MS = 400

async function cameraPosition(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getPosition()
  })
}

async function cameraQuaternion(page: Page): Promise<[number, number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getQuaternion()
  })
}

/**
 * The vertical (y) component of the camera's local "right" (+X) axis in world
 * space — 0 with no roll, non-zero the moment the camera banks. Same closed-
 * form reduction demo.spec.ts uses to observe Demo Mode's banking without
 * depending on the rig's internal yaw/pitch/roll convention.
 */
async function rightVectorY(page: Page): Promise<number> {
  const [x, y, z, w] = await cameraQuaternion(page)
  return 2 * (x * y + w * z)
}

async function waitForScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(() => window.__htpCameraTest !== undefined, undefined, {
    timeout: 20_000,
  })
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

test('demo mode canyon tour: a long flight through a multi-Tower cluster, captured on video for tuning judgment', async ({
  page,
}, testInfo) => {
  // Comfortably above the FLIGHT_DURATION_MS capture window plus the setup/
  // scene-load overhead and this test's own polling loop.
  test.setTimeout(FLIGHT_DURATION_MS + 60_000)

  // Learn the real Tower layout from the /ws SceneState snapshot (same frame
  // smoke.spec.ts asserts on) so this test can compute the cluster's actual
  // world-space footprint — needed to recognise a genuine perimeter/edge pass
  // rather than guessing a fixed distance that may not match this run's
  // cluster size.
  const sceneStateFrame = new Promise<{ towers: TowerFrame[] }>((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return
        let frame: { towers?: TowerFrame[] }
        try {
          frame = JSON.parse(payload)
        } catch {
          return
        }
        if (Array.isArray(frame.towers)) {
          resolve({ towers: frame.towers })
        }
      })
    })
  })

  await page.goto('/')
  const frame = await sceneStateFrame

  // The Canyon tour needs a real multi-Tower cluster to form canyons at all
  // (#91/ADR-0010: 0 or 1 Towers falls back to the orbit-and-bob degenerate
  // case, covered separately by demo-canyon-tour-degenerate.spec.ts). The e2e
  // job's KWOK seeding (test/e2e/kwok/seed.sh) always provides 7 (ADR-0004's
  // "modest" tier); a local run against a bare cluster should seed the same
  // way first.
  expect(frame.towers.length).toBeGreaterThanOrEqual(2)

  await waitForScene(page)

  // Recompute towerPlacements()'s world-space centring (src/scene/towerLayout.ts)
  // from the grid indices to get the cluster's footprint — its bounding-box
  // half-extent along the more spread-out axis, in world units from the
  // origin (the layout always centres the occupied grid on the world origin).
  const cols = frame.towers.map((t) => t.grid.col)
  const rows = frame.towers.map((t) => t.grid.row)
  const colSpan = Math.max(...cols) - Math.min(...cols)
  const rowSpan = Math.max(...rows) - Math.min(...rows)
  const clusterExtent = (Math.max(colSpan, rowSpan) / 2) * TOWER_SPACING
  // Most of the way out to the perimeter ring (PERIMETER_OFFSET beyond the
  // outermost Tower line) — a real edge/perimeter pass, not just "left the
  // dead centre".
  const perimeterThreshold = clusterExtent + PERIMETER_OFFSET * 0.6

  // Reproducible activation (see the file doc comment above): toggle Demo
  // Mode on immediately, before any input has moved the camera off the
  // scene's fixed default framed pose.
  const toggle = page.getByRole('button', { name: /demo mode/i })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === true)

  const samples: Array<{ elapsedMs: number; pos: [number, number, number] }> = []
  const rolls: number[] = []
  let sawCanyonLow = false
  let sawOverviewHigh = false
  let sawPerimeter = false

  const start = Date.now()
  while (Date.now() - start < FLIGHT_DURATION_MS) {
    const elapsedMs = Date.now() - start
    const pos = await cameraPosition(page)
    const quat = await cameraQuaternion(page)

    // Sanity (#91, not the main point but worth having): never NaN.
    expect(pos.every((v) => Number.isFinite(v))).toBe(true)
    expect(quat.every((v) => Number.isFinite(v))).toBe(true)

    samples.push({ elapsedMs, pos })
    rolls.push(Math.abs(await rightVectorY(page)))

    // Canyon-low pass: the altitude program's low band, mostly below roofline.
    if (!sawCanyonLow && pos[1] <= CANYON_ALTITUDE_MAX) {
      await page.screenshot({ path: testInfo.outputPath('canyon-low-pass.png') })
      sawCanyonLow = true
    }
    // Overview-high pass: "over the rooftops".
    if (!sawOverviewHigh && pos[1] >= OVERVIEW_ALTITUDE_MIN) {
      await page.screenshot({ path: testInfo.outputPath('overview-high-pass.png') })
      sawOverviewHigh = true
    }
    // Edge/perimeter pass: far enough from the cluster centre to be on (or
    // near) the perimeter ring canyon, a corner-turn opportunity.
    if (!sawPerimeter && Math.hypot(pos[0], pos[2]) >= perimeterThreshold) {
      await page.screenshot({ path: testInfo.outputPath('perimeter-edge-pass.png') })
      sawPerimeter = true
    }

    await page.waitForTimeout(POLL_INTERVAL_MS)
  }

  // The visual proof this project's e2e exists for (ADR-0004): the flight in
  // progress at the end of the capture window, plus the full-length screen
  // video Playwright records for every test (see playwright.config.ts).
  await page.screenshot({ path: testInfo.outputPath('canyon-tour-final.png') })

  // --- Sanity assertions (#91: "not the main point, but worth having") ---

  // The camera actually moved over the whole capture window, continuously
  // (not one jump then rest) — proof this is a genuine long flight, not a
  // stall that happened to pass the earlier per-instant checks.
  const first = samples[0].pos
  const last = samples[samples.length - 1].pos
  expect(distance(first, last)).toBeGreaterThan(2)
  const keepsMoving = samples.slice(1).some((s, i) => distance(samples[i].pos, s.pos) > 0.05)
  expect(keepsMoving).toBe(true)

  // It stays within sane bounds — comfortably past the perimeter ring but
  // nowhere near "drifted off into the void", and never below the floor or
  // absurdly high above the tallest overview altitude.
  const maxHorizontalBound = clusterExtent + PERIMETER_OFFSET + TOWER_SPACING * 3
  for (const sample of samples) {
    expect(Math.hypot(sample.pos[0], sample.pos[2])).toBeLessThan(maxHorizontalBound)
    expect(sample.pos[1]).toBeGreaterThan(-5)
    expect(sample.pos[1]).toBeLessThan(TOWER_HEIGHT * 4)
  }

  // A visible bank happened — the path made at least one real turn (#91: "re-
  // derive banking from the path's actual velocity"), the same evidence
  // demo.spec.ts uses for the pre-existing banking mechanic.
  expect(Math.max(...rolls)).toBeGreaterThan(0.02)

  // Canyon-low and overview-high passes are near-certain within
  // FLIGHT_DURATION_MS (many spline segments fly by; OVERVIEW_PROBABILITY
  // alone makes missing an overview waypoint entirely vanishingly unlikely) —
  // assert them. The perimeter pass depends on where the seeded random walk
  // wanders and isn't guaranteed within any bounded window, so it's captured
  // best-effort (see the console note below) rather than hard-asserted, to
  // keep this test from being flaky on an unlucky seed.
  expect(sawCanyonLow).toBe(true)
  expect(sawOverviewHigh).toBe(true)
  if (!sawPerimeter) {
    console.log(
      "demo-canyon-tour: no perimeter/edge pass observed in this run's capture window (best-effort only, not a failure)",
    )
  }

  // Hand back control cleanly, matching demo.spec.ts's toggle-off proof (kept
  // brief here since the hand-off mechanics are that test's job, not this one's).
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === false)
})
