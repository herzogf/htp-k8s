import { expect, type Page, test } from '@playwright/test'

// Click-to-Focus (#21) flies the three.js camera to a clicked Tower/Panel. Like
// the free-fly test (#20), the camera renders into a WebGL canvas with nothing
// in the DOM to assert on, so FreeFlyControls exposes the live camera — and, for
// Focus, whether a fly-to is animating and where it's headed — on
// `window.__htpCameraTest`. This test clicks the populated (KWOK-seeded) scene
// and reads that hook to prove a click smoothly animates the camera toward the
// thing clicked, rather than teleporting or doing nothing. The pose/tween maths
// itself is unit-tested WebGL-free in src/scene/focus.test.ts; this is the
// end-to-end proof the click → raycast → fly-to wiring works against a real scene.

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx (its single source of
// truth). The e2e is a separate compilation domain from the app bundle, so the
// shape is restated here rather than imported across that boundary; keep the two
// in step.
interface Vec3Pose {
  position: [number, number, number]
  target: [number, number, number]
}
interface CameraTestHook {
  getPosition: () => [number, number, number]
  getQuaternion: () => [number, number, number, number]
  isFocusing: () => boolean
  getFocusGoal: () => Vec3Pose | null
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

async function focusGoal(page: Page): Promise<Vec3Pose | null> {
  return page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getFocusGoal()
  })
}

/** The camera's forward (look) direction, from its orientation quaternion. */
async function cameraForward(page: Page): Promise<[number, number, number]> {
  const [x, y, z, w] = await page.evaluate(() => {
    const hook = window.__htpCameraTest
    if (!hook) throw new Error('camera test hook not present')
    return hook.getQuaternion()
  })
  // Rotate the camera-space forward axis (0, 0, -1) by the quaternion.
  const vx = 0,
    vy = 0,
    vz = -1
  const ix = w * vx + y * vz - z * vy
  const iy = w * vy + z * vx - x * vz
  const iz = w * vz + x * vy - y * vx
  const iw = -x * vx - y * vy - z * vz
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ]
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

function normalize(v: readonly number[]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/**
 * Clicks the canvas until a Focus fly-to starts, returning the moment it does.
 * The scene fills the middle of the frame, so the centre almost always lands on
 * a Tower/Panel; a small ring of fallback offsets makes the test robust to the
 * exact framing (a click into empty space simply focuses nothing and we try the
 * next point) without depending on any single pixel being a mesh.
 */
async function clickUntilFocusing(page: Page): Promise<void> {
  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas has no bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0, 40],
    [40, 0],
    [-40, 0],
    [0, -40],
    [60, 60],
    [-60, 60],
    [60, -60],
    [-60, -60],
  ]
  for (const [dx, dy] of offsets) {
    await page.mouse.click(cx + dx, cy + dy)
    // Give the click's raycast + the next animation frame time to start a tween.
    const started = await page
      .waitForFunction(() => window.__htpCameraTest?.isFocusing() === true, undefined, {
        timeout: 1000,
      })
      .then(() => true)
      .catch(() => false)
    if (started) return
  }
  throw new Error('no click on the scene started a Focus fly-to')
}

test('focus: clicking the scene smoothly animates the camera to face what was clicked', async ({
  page,
}) => {
  await page.goto('/')
  await waitForScene(page)

  // The default framed view is at rest and nothing is focused yet — the same
  // no-drift guarantee the free-fly test relies on, now also covering Focus.
  expect(await focusGoal(page)).toBeNull()
  const atRestStart = await cameraPosition(page)
  await page.waitForTimeout(300)
  const atRestEnd = await cameraPosition(page)
  expect(distance(atRestStart, atRestEnd)).toBeLessThan(1e-6)

  const before = await cameraPosition(page)
  const forwardBefore = normalize(await cameraForward(page))

  // Click a Tower/Panel — this is the interaction under test.
  await clickUntilFocusing(page)

  // A fly-to is now animating: capture where it's headed (the clicked subject's
  // viewing pose). The click actually resolved to a scene object, not empty space.
  const goal = await focusGoal(page)
  expect(goal).not.toBeNull()
  const target = goal as Vec3Pose
  // There is somewhere to fly: the goal camera pose differs from where we started.
  expect(distance(before, target.position)).toBeGreaterThan(0.5)

  // Smooth, not a teleport: mid-flight the camera sits strictly between its start
  // and its destination — it has left the start but not yet arrived.
  await page.waitForTimeout(200)
  const midFlight = await cameraPosition(page)
  expect(distance(before, midFlight)).toBeGreaterThan(0.05)
  expect(distance(midFlight, target.position)).toBeGreaterThan(0.05)

  // Let the fly-to settle.
  await page.waitForFunction(() => window.__htpCameraTest?.isFocusing() === false, undefined, {
    timeout: 5000,
  })

  // It arrived: the camera has come to rest at the clicked subject's viewing
  // pose (position and target both), a clearly different place from the start.
  const settled = await cameraPosition(page)
  expect(distance(settled, target.position)).toBeLessThan(0.5)
  expect(distance(settled, before)).toBeGreaterThan(0.5)

  // And it faces the subject: the camera's forward axis points from its resting
  // position toward the focused target — "changes appropriately", not just moved.
  const forwardAfter = normalize(await cameraForward(page))
  const toTarget = normalize([
    target.target[0] - settled[0],
    target.target[1] - settled[1],
    target.target[2] - settled[2],
  ])
  expect(dot(forwardAfter, toTarget)).toBeGreaterThan(0.9)

  // The *target* changed too, not only the position: the aim swung from where it
  // pointed before the click to now face the subject — so this passes because the
  // click re-aimed the camera, not because it happened to already look there.
  expect(dot(forwardAfter, forwardBefore)).toBeLessThan(0.999)
})
