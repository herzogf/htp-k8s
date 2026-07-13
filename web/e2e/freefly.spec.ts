import { expect, type Page, test } from '@playwright/test'

// The free-fly camera (#20) drives a three.js camera that renders into a WebGL
// canvas — there's nothing in the DOM to assert position on. FreeFlyControls
// therefore exposes the live camera on `window.__htpCameraTest`, and this test
// reads it before/after simulated input to prove WASD actually moves the camera
// through 3D space. The movement/look maths itself is unit-tested in
// scene/freeFly.test.ts; this is the end-to-end proof the rig is wired to real
// keyboard input against the populated scene.

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx (its single source of
// truth). The e2e is a separate compilation domain from the app bundle, so the
// shape is restated here rather than imported across that boundary; keep the two
// in step.
interface CameraTestHook {
  getPosition: () => [number, number, number]
  getQuaternion: () => [number, number, number, number]
}

declare global {
  interface Window {
    __htpCameraTest?: CameraTestHook
  }
}

/** Reads the live camera world position through the test hook. */
async function cameraPosition(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getPosition()
  })
}

/** Reads the live camera orientation quaternion through the test hook. */
async function cameraQuaternion(page: Page): Promise<[number, number, number, number]> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getQuaternion()
  })
}

/** The largest absolute component-wise difference between two quaternions. */
function maxDelta(a: readonly number[], b: readonly number[]): number {
  return Math.max(...a.map((value, i) => Math.abs(value - b[i])))
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

test('free-fly: WASD keys move the camera through the scene', async ({ page }) => {
  await page.goto('/')

  // Wait for the scene to render (a lit canvas) and the camera hook to be
  // installed, so we read a real, settled camera rather than a mid-mount one.
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(() => window.__htpCameraTest !== undefined, undefined, {
    timeout: 20_000,
  })

  // Let the scene settle for a couple of frames, then capture the resting camera
  // position. Nothing has been pressed, so the default framed view must be
  // untouched — we assert that by confirming the camera doesn't drift on its own.
  const atRestStart = await cameraPosition(page)
  await page.waitForTimeout(300)
  const atRestEnd = await cameraPosition(page)
  expect(distance(atRestStart, atRestEnd)).toBeLessThan(1e-6)

  // Hold W: fly forward. Holding across several animation frames accumulates a
  // clearly-observable translation at the default tower-grid speed.
  const before = await cameraPosition(page)
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(400)
  await page.keyboard.up('KeyW')
  const afterForward = await cameraPosition(page)
  const forwardTravel = distance(before, afterForward)
  expect(forwardTravel).toBeGreaterThan(0.5)

  // Once released, the camera holds its new position — no runaway drift.
  await page.waitForTimeout(300)
  const settled = await cameraPosition(page)
  expect(distance(afterForward, settled)).toBeLessThan(1e-6)

  // A different key (A: strafe left) moves the camera a different way, proving
  // more than one binding is wired — not just that "some key does something".
  const beforeStrafe = await cameraPosition(page)
  await page.keyboard.down('KeyA')
  await page.waitForTimeout(400)
  await page.keyboard.up('KeyA')
  const afterStrafe = await cameraPosition(page)
  expect(distance(beforeStrafe, afterStrafe)).toBeGreaterThan(0.5)

  // Forward and strafe are not collinear, so their displacement directions
  // differ — a sanity check that A isn't just re-triggering the W movement.
  const forwardDir = normalize(sub(afterForward, before))
  const strafeDir = normalize(sub(afterStrafe, beforeStrafe))
  const alignment = Math.abs(dot(forwardDir, strafeDir))
  expect(alignment).toBeLessThan(0.99)

  // Mouse-look: click the canvas to enter pointer lock, then a horizontal mouse
  // move must rotate the camera (change its orientation) — the other half of the
  // acceptance criteria ("mouse-look rotates it"). Keyboard input above left the
  // orientation untouched (pointer wasn't locked), so any change here is the
  // mouse-look wiring. Done last so pointer lock can't interfere with the
  // keyboard-translation assertions.
  const box = await page.locator('canvas').boundingBox()
  if (!box) throw new Error('canvas has no bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const orientationBefore = await cameraQuaternion(page)
  await page.mouse.click(cx, cy)
  await page.waitForFunction(() => document.pointerLockElement !== null, undefined, {
    timeout: 5_000,
  })
  await page.mouse.move(cx + 200, cy)
  await expect
    .poll(async () => maxDelta(orientationBefore, await cameraQuaternion(page)))
    .toBeGreaterThan(1e-3)
})

function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function normalize(v: readonly number[]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
