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
 * Clicks the canvas until a Focus fly-to starts, returning that fly-to's goal
 * pose. The scene fills the middle of the frame (the default camera looks at the
 * tower grid's centre), so the centre almost always lands on a Tower/Panel; a
 * small ring of fallback offsets makes this robust to the exact framing (a click
 * into empty space simply focuses nothing and we try the next point) without
 * depending on any single pixel being a mesh.
 *
 * The goal is read *inside* the wait predicate, at the frame Focus becomes
 * active, so it's captured atomically — no race against a fly-to that settles
 * before a separate read runs.
 */
async function clickUntilFocusing(page: Page): Promise<Vec3Pose> {
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
    // Resolve with the fly-to's goal the moment one is active; keep polling (up
    // to the timeout) while no fly-to has started, then try the next point.
    const handle = await page
      .waitForFunction(
        () => {
          const hook = window.__htpCameraTest
          return hook && hook.isFocusing() ? hook.getFocusGoal() : null
        },
        undefined,
        { timeout: 1000 },
      )
      .catch(() => null)
    if (handle) {
      const goal = (await handle.jsonValue()) as Vec3Pose | null
      if (goal) return goal
    }
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

  // Click a Tower/Panel — this is the interaction under test — and capture where
  // the resulting fly-to is headed (the clicked subject's viewing pose). That a
  // goal comes back proves the click resolved to a scene object, not empty space.
  const target = await clickUntilFocusing(page)
  // There is somewhere to fly: the goal camera pose differs from where we started.
  expect(distance(before, target.position)).toBeGreaterThan(0.5)

  // Sample the camera as the fly-to runs, until it settles. Reading whether it's
  // still focusing each step, then its position, lets us prove the motion was a
  // smooth animation rather than a teleport — independent of the headless frame
  // rate, which the fixed-timing approach can't be. Bounded so a stuck fly-to
  // fails loudly instead of hanging.
  const samples: Array<[number, number, number]> = [before]
  const deadline = Date.now() + 6000
  let focusing = true
  while (focusing && Date.now() < deadline) {
    focusing = await page.evaluate(() => window.__htpCameraTest?.isFocusing() === true)
    samples.push(await cameraPosition(page))
    if (focusing) await page.waitForTimeout(40)
  }
  // The fly-to actually ended (didn't run past the deadline still animating).
  await page.waitForFunction(() => window.__htpCameraTest?.isFocusing() === false, undefined, {
    timeout: 2000,
  })

  // Smooth, not a teleport: at least one sample sat strictly between the start
  // and the goal — the camera passed *through* the space rather than jumping. A
  // single-frame teleport would leave every sample either at the start or the goal.
  const sawIntermediate = samples.some(
    (p) => distance(before, p) > 0.05 && distance(p, target.position) > 0.05,
  )
  expect(sawIntermediate).toBe(true)

  // It arrived: the camera has come to rest at the clicked subject's viewing
  // pose, a clearly different place from the start.
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
