import { expect, type Page, test } from '@playwright/test'

// The degenerate/small-cluster fallback of the Canyon tour (#91, ADR-0010): a
// single Tower (or an empty scene) has no canyon at all, so Demo Mode instead
// gently orbits the lone Tower (or the origin) with a slow vertical bob,
// rather than reading as "frozen/broken" on an unattended wall display. This
// e2e captures that fallback on video so a human can confirm it looks alive,
// not static — the same "the project's e2e exists to give visual proof"
// standard as demo-canyon-tour.spec.ts, just for the small-cluster case that
// test can't exercise (it requires >= 2 Towers).
//
// This test needs a genuinely single-Tower cluster to exercise the fallback
// at all — the standard e2e job seeds 7 Towers via test/e2e/kwok/seed.sh
// (ADR-0004's "modest" tier) for every test's *shared* webServer instance, so
// under that seeding this scenario simply doesn't arise. Rather than
// requiring a second, differently-provisioned CI job just for this one test,
// it inspects the real /ws SceneState snapshot and skips itself with a clear
// reason when more than one Tower is present — it still runs for real (and is
// the source of this ticket's degenerate-case artifact) against a bare
// single-node kind cluster with no KWOK seeding, e.g. by running this file
// alone before the seed step.

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx — see
// demo-canyon-tour.spec.ts's doc comment for why this is restated rather than
// imported across the e2e/app compilation boundary.
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

interface TowerFrame {
  name: string
  grid: { col: number; row: number }
}

// Mirrors of the orbit-and-bob fallback's tuning constants in
// src/scene/demoMode.ts (restated here — see demo-canyon-tour.spec.ts).
const TOWER_SPACING = 4
const TOWER_HEIGHT = 6
const ORBIT_RADIUS = TOWER_SPACING * 2.2
const ORBIT_BOB_PERIOD_SECONDS = 14

/** Long enough to show sustained motion and a couple of bob cycles, well under one full 50s orbit revolution. */
const FLIGHT_DURATION_MS = 32_000
const POLL_INTERVAL_MS = 400

async function cameraPosition(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getPosition()
  })
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

test('demo mode degenerate fallback: a single-Tower cluster orbits and bobs instead of freezing', async ({
  page,
}, testInfo) => {
  test.setTimeout(FLIGHT_DURATION_MS + 60_000)

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

  // The orbit-and-bob fallback only kicks in for 0 or 1 Towers
  // (buildCanyonGraph returns null — see demoMode.ts). Skip cleanly rather
  // than failing when this run's cluster has the standard multi-Tower KWOK
  // seeding.
  test.skip(
    frame.towers.length > 1,
    `requires a single-Tower (or empty) cluster to exercise the degenerate fallback; this cluster currently has ${frame.towers.length} Towers`,
  )

  await waitForScene(page)

  // The lone Tower's world-space centre (or the origin if the scene is
  // entirely empty) — the orbit fallback's centre, mirroring
  // towerPlacements()'s "a single Tower lands exactly at the origin".
  const center: [number, number, number] =
    frame.towers.length === 1 ? [0, TOWER_HEIGHT / 2, 0] : [0, 0, 0]

  const toggle = page.getByRole('button', { name: /demo mode/i })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === true)

  const samples: Array<{ elapsedMs: number; pos: [number, number, number] }> = []
  let shotCount = 0
  const start = Date.now()
  while (Date.now() - start < FLIGHT_DURATION_MS) {
    const elapsedMs = Date.now() - start
    const pos = await cameraPosition(page)
    expect(pos.every((v) => Number.isFinite(v))).toBe(true)
    samples.push({ elapsedMs, pos })

    // A handful of evenly-spaced screenshots across the arc, so the artifact
    // shows the orbit actually sweeping around the Tower over time.
    const targetShot = Math.floor((elapsedMs / FLIGHT_DURATION_MS) * 4)
    if (targetShot > shotCount) {
      shotCount = targetShot
      await page.screenshot({ path: testInfo.outputPath(`orbit-bob-${shotCount}.png`) })
    }

    await page.waitForTimeout(POLL_INTERVAL_MS)
  }
  await page.screenshot({ path: testInfo.outputPath('orbit-bob-final.png') })

  // --- Sanity: alive, not frozen (the whole point of this fallback) ---

  // Continuous motion throughout — not a single jump then a freeze.
  const first = samples[0].pos
  const last = samples[samples.length - 1].pos
  expect(distance(first, last)).toBeGreaterThan(0.5)
  const keepsMoving = samples.slice(1).some((s, i) => distance(samples[i].pos, s.pos) > 0.02)
  expect(keepsMoving).toBe(true)

  // Roughly orbits at ORBIT_RADIUS around the Tower (a generous band, since
  // the bob affects altitude, not the orbit radius, and this is a visual
  // sanity check, not a precision one) rather than wandering off or standing
  // still at one spot. Excludes the brief activation intro (DEMO_TRANSITION_
  // SECONDS, mirrored below): activation eases the camera from wherever it
  // was (the scene's default framed pose here, far outside the orbit band)
  // onto the flight path, so only the settled, post-intro samples are
  // representative of the steady-state orbit.
  const DEMO_TRANSITION_SECONDS = 0.9
  const settled = samples.filter((s) => s.elapsedMs > DEMO_TRANSITION_SECONDS * 1000 * 1.5)
  const radii = settled.map((s) => Math.hypot(s.pos[0] - center[0], s.pos[2] - center[2]))
  for (const r of radii) {
    expect(r).toBeGreaterThan(ORBIT_RADIUS * 0.5)
    expect(r).toBeLessThan(ORBIT_RADIUS * 1.5)
  }

  // The vertical bob is visible: altitude isn't constant across the capture
  // window, which spans more than two bob periods (ORBIT_BOB_PERIOD_SECONDS).
  expect(FLIGHT_DURATION_MS / 1000).toBeGreaterThan(ORBIT_BOB_PERIOD_SECONDS * 2)
  const altitudes = settled.map((s) => s.pos[1])
  expect(Math.max(...altitudes) - Math.min(...altitudes)).toBeGreaterThan(0.3)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === false)
})
