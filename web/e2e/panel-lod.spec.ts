import { expect, type Locator, type Page, test } from '@playwright/test'

// Panel text LOD (#25): close/mid Panels show the Pod's actual (truncated) name
// as readable text across the top plus a "hinted, illegible scrolling text"
// glyph fill below; beyond a far threshold they fall back to a flat color blob
// for render cost (CONTEXT.md's Panel, ADR-0004). The distance → detail curve,
// the name truncation rule, and the look constants are unit-tested WebGL-free in
// src/scene/panelLOD.test.ts; this is the end-to-end proof the *rendered pixels*
// actually change — the LOD swap and the atlas-sampled names happen entirely
// inside a fragment shader (src/scene/Panels.tsx's `patchPanelMaterial`), so
// nothing about it is observable from a `window` test hook the way the
// instance-color buffer is for blinks (see blink.spec.ts). Instead this samples
// the real screenshot pixels, the way smoke.spec.ts already does for "did
// anything render" — but cropped to exactly one Panel's own on-screen rect (via
// `window.__htpPanelLodTest`, #25's Panels.tsx projection hook), so the sample
// can never accidentally span a neighbouring Panel or Tower edge and confound
// "this one Panel has internal texture" with "there are several different flat
// colors near each other". The close screenshot is the readable-name proof
// artifact; the name-band variance check is the automated assertion.
//
// Both camera distances are driven deterministically, without relying on a
// headless canvas raycast landing on a specific instance (the #20/#74
// flakiness): `window.__htpDetailTest.selectPod` (added for #24) flies the
// camera to a *named* Pod's Panel via the same `panelFocusPose` a real click
// uses (close range, well inside the near threshold), and then holding the
// existing free-fly "S" (backward) key for several seconds retreats straight
// back along that same view axis to comfortably beyond the far threshold —
// reusing #20's real keyboard-driven flight rather than adding a new hook.

// Mirror of DetailTestHook in src/detail/useDetailTestHook.ts (its single source
// of truth). The e2e is a separate compilation domain from the app bundle, so
// the shape is restated here rather than imported; keep the two in step.
interface DetailTestHook {
  towers: () => { name: string }[]
  pods: () => { namespace: string; pod: string }[]
  selectTower: (name: string) => boolean
  selectPod: (namespace: string, pod: string) => boolean
  clear: () => void
}

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx (its single source of
// truth), matching the restatement in the other camera-driving specs.
interface CameraTestHook {
  isFocusing: () => boolean
}

// Mirror of ScreenRect/PanelLodTestHook in src/scene/Panels.tsx (its single
// source of truth).
interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}
interface PanelLodTestHook {
  getPanelScreenRect: (namespace: string, pod: string) => ScreenRect | null
}

declare global {
  interface Window {
    __htpDetailTest?: DetailTestHook
    __htpCameraTest?: CameraTestHook
    __htpPanelLodTest?: PanelLodTestHook
  }
}

async function waitForPopulatedScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(
    () => {
      const hook = window.__htpDetailTest
      return !!hook && hook.pods().length > 0
    },
    undefined,
    { timeout: 30_000 },
  )
}

/** Waits for an in-flight Focus fly-to (if any) to settle. */
async function waitForFocusSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__htpCameraTest?.isFocusing() === false, undefined, {
    timeout: 10_000,
  })
}

/**
 * The luminance variance inside a Pod's own Panel, projected fresh (via
 * `__htpPanelLodTest`) for wherever the camera currently is — near zero for a
 * genuinely flat color (the far LOD blob), and clearly positive where a fine
 * light/dark glyph pattern is actually drawn (the near/mid LOD's text detail).
 * The rect is shrunk inward by `inset` (a fraction of its own size) before
 * sampling, so the crop never includes the Panel's own silhouette edge — an
 * antialiased blend into whatever is behind it, which would read as "texture"
 * on a flat blob too and defeat the point of the measurement.
 *
 * Measured from a real screenshot: three.js doesn't `preserveDrawingBuffer`, so
 * an in-page `drawImage` of the live canvas comes back blank (same reasoning
 * as smoke.spec.ts's `litPixelCount`), so this decodes a real PNG screenshot
 * back in the page instead.
 */
async function panelLuminanceVariance(
  page: Page,
  canvas: Locator,
  pod: { namespace: string; pod: string },
  opts: { band?: 'full' | 'name'; inset?: number } = {},
): Promise<number> {
  const { band = 'full', inset = 0.2 } = opts
  const rect = await page.evaluate(
    (p) => window.__htpPanelLodTest!.getPanelScreenRect(p.namespace, p.pod),
    pod,
  )
  if (!rect) {
    throw new Error(`Panel not projectable for ${pod.namespace}/${pod.pod}`)
  }

  const png = await canvas.screenshot()
  return page.evaluate(
    async ({ dataUrl, rect, inset, band }) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const off = document.createElement('canvas')
      off.width = img.width
      off.height = img.height
      const ctx = off.getContext('2d')
      if (!ctx) return 0

      // For the 'name' band, restrict sampling to the top strip of the Panel
      // where the readable Pod name is drawn (PANEL_NAME_BAND = 0.28 of the
      // Panel height, from the top), so the measurement is specifically "is
      // there legible text here" and not the glyph fill below it. `y` grows
      // downward, so the top strip is the low-`y` portion of the rect.
      const NAME_BAND = 0.28
      const top = rect.y
      const height = band === 'name' ? rect.height * NAME_BAND : rect.height

      const insetX = rect.width * inset
      const insetY = height * inset
      const x = Math.round((rect.x + insetX) * img.width)
      const y = Math.round((top + insetY) * img.height)
      const w = Math.max(1, Math.round((rect.width - 2 * insetX) * img.width))
      const h = Math.max(1, Math.round((height - 2 * insetY) * img.height))
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(x, y, w, h)

      let sum = 0
      let sumSq = 0
      const n = w * h
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        sum += lum
        sumSq += lum * lum
      }
      const mean = sum / n
      return sumSq / n - mean * mean
    },
    { dataUrl: `data:image/png;base64,${png.toString('base64')}`, rect, inset, band },
  )
}

test('panel LOD: close/mid Panels show scrolling text detail, far Panels are flat blobs', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await waitForPopulatedScene(page)
  const canvas = page.locator('canvas')

  // Fly to and centre a real Pod's Panel — the same Focus a click would trigger
  // (#21/#24), landing well inside PANEL_LOD_NEAR_DISTANCE (close range).
  const pod = await page.evaluate(() => window.__htpDetailTest!.pods()[0])
  const opened = await page.evaluate(
    (p) => window.__htpDetailTest!.selectPod(p.namespace, p.pod),
    pod,
  )
  expect(opened).toBe(true)
  await waitForFocusSettled(page)
  // The Focus hook also opens the Detail Popup (mirroring a real click); close
  // it so the in-world DOM overlay doesn't cover the Panel pixels we're about
  // to sample — the camera stays exactly where Focus left it.
  await page.evaluate(() => window.__htpDetailTest!.clear())
  // Let a few animation frames of the scrolling glyph pattern draw.
  await page.waitForTimeout(500)

  const closeVariance = await panelLuminanceVariance(page, canvas, pod)
  // The readable-name proof (#25 follow-up): the top strip of the Panel carries
  // the Pod's actual name as text, so it must have real structure (bright glyph
  // strokes on a dark background) — clearly non-flat luminance variance.
  const closeNameVariance = await panelLuminanceVariance(page, canvas, pod, { band: 'name' })
  await page.screenshot({ path: testInfo.outputPath('panel-lod-close.png') })

  // Retreat straight back along the same view axis the Focus settled on (S =
  // backward in FreeFlyControls' WASD scheme, #20). FLY_SPEED is 3x the
  // tower-grid spacing per second, so even a generously slow/headless frame
  // rate comfortably clears PANEL_LOD_FAR_DISTANCE (a small multiple of that
  // same spacing) well within this hold — the Panel ends up far beyond the
  // threshold, still on the same view axis (just smaller), so re-projecting
  // its rect afterward still finds it.
  await page.keyboard.down('KeyS')
  await page.waitForTimeout(3_000)
  await page.keyboard.up('KeyS')
  // Let the now-far scene settle and draw a few frames.
  await page.waitForTimeout(500)

  const farVariance = await panelLuminanceVariance(page, canvas, pod)
  const farNameVariance = await panelLuminanceVariance(page, canvas, pod, { band: 'name' })
  await page.screenshot({ path: testInfo.outputPath('panel-lod-far.png') })

  // Close range: a real glyph/name texture is actually drawn inside the Panel —
  // meaningfully more local luminance variance than a flat color's noise floor.
  expect(closeVariance).toBeGreaterThan(50)
  // Close range: the top name strip specifically shows legible text structure.
  expect(closeNameVariance).toBeGreaterThan(50)
  // Far range: the flat blob path — variance collapses back down, and by a
  // clear margin versus the close/mid detail view (not just "a bit less").
  expect(farVariance).toBeLessThan(closeVariance / 3)
  // Far range: the name strip flattens too — the label is gone, not just dimmer.
  expect(farNameVariance).toBeLessThan(closeNameVariance / 3)
})
