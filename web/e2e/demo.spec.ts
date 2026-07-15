import { expect, type Page, test } from '@playwright/test'

// Demo Mode (#22): an optional, user-toggleable automated cinematic camera
// flight through the tower landscape with a visible banking/swinging motion,
// for unattended/showcase viewing (CONTEXT.md's Demo Mode). Like free-fly
// (#20) and Focus (#21), there is nothing in the DOM to assert camera motion
// on, so FreeFlyControls exposes the live camera — now extended with
// `isDemoActive` — on `window.__htpCameraTest`. This test proves the three
// acceptance criteria end-to-end against a real, populated scene: (1) the HUD
// toggle switches Demo Mode on/off, (2) while active the camera flies on its
// own with a visible bank, no user input, and (3) switching it off hands
// control back to free-fly without a teleport (and the bank eases back to
// level rather than snapping). The flight-path/bank/hand-off maths itself is
// unit-tested WebGL-free in src/scene/demoMode.test.ts; this is the
// end-to-end proof of the toggle → rig wiring.

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx (its single source
// of truth). The e2e is a separate compilation domain from the app bundle, so
// the shape is restated here rather than imported across that boundary; keep
// the two in step.
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

async function cameraPosition(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getPosition()
  })
}

async function isDemoActive(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__htpCameraTest?.isDemoActive() ?? false)
}

/**
 * The vertical (y) component of the camera's local "right" (+X) axis, rotated
 * into world space by its orientation quaternion — a closed-form reduction of
 * the standard quaternion-to-rotation-matrix first column (`2*(x*y + w*z)`).
 * It is exactly 0 whenever the camera has no roll (pure yaw/pitch, as
 * free-fly and Focus always are — the "right" direction stays perfectly
 * horizontal), and departs from 0 the moment the camera banks. This is how
 * the test observes Demo Mode's swinging/banking motion without depending on
 * which exact yaw/pitch axis convention the rig happens to use internally.
 */
async function rightVectorY(page: Page): Promise<number> {
  const [x, y, z, w] = await page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getQuaternion()
  })
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

// Mirror of TOWER_SPACING (src/scene/towerLayout.ts), restated per this
// suite's cross-compilation-boundary convention (see the CameraTestHook
// comment above) — used only to calibrate the hand-off threshold below
// against real scene geometry, never to duplicate production logic.
const TOWER_SPACING = 4

test('demo mode: the HUD toggle flies the camera on its own with a visible bank, then hands back smoothly', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await waitForScene(page)

  const toggle = page.getByRole('button', { name: /demo mode/i })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await isDemoActive(page)).toBe(false)

  // Before Demo Mode, the default framed view is at rest — the same no-drift
  // guarantee the free-fly/Focus tests rely on, so this test's later motion
  // assertions are attributable to Demo Mode, not ambient drift.
  const atRestStart = await cameraPosition(page)
  await page.waitForTimeout(300)
  const atRestEnd = await cameraPosition(page)
  expect(distance(atRestStart, atRestEnd)).toBeLessThan(1e-6)

  // Toggle Demo Mode on (acceptance criterion 1: the HUD control).
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toContainText(/on/i)
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === true)

  // Acceptance criterion 2: while active, the camera flies through the scene
  // on its own — sampled with no keyboard/mouse input at all — with a visible
  // banking/swinging motion.
  const before = await cameraPosition(page)
  const samples: Array<[number, number, number]> = [before]
  const rolls: number[] = [Math.abs(await rightVectorY(page))]
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250)
    samples.push(await cameraPosition(page))
    rolls.push(Math.abs(await rightVectorY(page)))
  }
  const afterFlying = samples[samples.length - 1]

  // It actually moved, and kept moving continuously (not one jump then rest).
  expect(distance(before, afterFlying)).toBeGreaterThan(0.5)
  const keepsMoving = samples.slice(1).some((p, i) => distance(samples[i], p) > 0.02)
  expect(keepsMoving).toBe(true)

  // It visibly banked at some point during the flight.
  expect(Math.max(...rolls)).toBeGreaterThan(0.02)

  // Acceptance criterion 3: toggling off hands control back to free-fly from
  // the camera's current pose, without a jarring jump.
  const justBeforeOff = await cameraPosition(page)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toContainText(/off/i)
  await page.waitForFunction(() => window.__htpCameraTest?.isDemoActive() === false)
  const justAfterOff = await cameraPosition(page)

  // No teleport: the camera's position is continuous across the toggle.
  // FreeFlyControls' deactivation path leaves the camera exactly where Demo
  // Mode's flight left it — it does not snap to some stale pre-demo pose —
  // so `justBeforeOff` and `justAfterOff` are not simultaneous: the Canyon
  // tour (#91) keeps flying smoothly through the async settle window between
  // them (`toggle.click()` + the `aria-pressed`/text assertions + the
  // `waitForFunction(isDemoActive === false)` await), at up to
  // CANYON_TRAVEL_SPEED (TOWER_SPACING * 1.1 world units/second). Over that
  // settle window this can plausibly cover on the order of one Tower spacing
  // — smooth continued flight, not a jump. A genuine stale-pose teleport
  // would be much larger: the pre-demo default camera pose ([10, 9, 15]) is
  // many Tower-spacings from mid-flight. So "no teleport" here means "no
  // multi-Tower-spacing jump", not "sub-unit stillness" — TOWER_SPACING
  // itself is comfortably above the smooth-flight distance this settle
  // window produces, and comfortably below what a real teleport would be.
  expect(distance(justBeforeOff, justAfterOff)).toBeLessThan(TOWER_SPACING)

  // Free-fly has genuinely resumed: with no input and Demo Mode off, the
  // camera now holds still (once any brief roll-recovery — at most a second —
  // has settled), rather than continuing to fly the demo path unattended.
  await page.waitForTimeout(1200)
  const settledA = await cameraPosition(page)
  await page.waitForTimeout(300)
  const settledB = await cameraPosition(page)
  expect(distance(settledA, settledB)).toBeLessThan(1e-6)

  // And the bank has eased back to level — not left banked, not snapped
  // instantly the frame Demo Mode switched off (the roll-recovery ease).
  expect(Math.abs(await rightVectorY(page))).toBeLessThan(0.02)

  // The visual proof (this project's e2e artifact, ADR-0004): the settled,
  // level, free-fly view after Demo Mode has handed control back.
  await page.screenshot({ path: testInfo.outputPath('demo.png') })
})
