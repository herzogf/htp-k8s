import { type Locator, type Page, expect, test } from '@playwright/test'

// The e2e job runs the app against a real single-node kind cluster (ADR-0004),
// so on connect /ws sends a SceneState snapshot (issue #10) — the generated
// wire contract, currently carrying the detected View Mode (issue #9) — not the
// old clusterless placeholder string. We assert a *well-formed* snapshot arrives
// rather than a frozen payload, so this survives SceneState growing (Towers and
// Panels in later tickets): the frame must be valid JSON with a `viewMode` of
// "node" or "namespace", and we don't over-constrain the rest of the object.
const VIEW_MODES = ['node', 'namespace'] as const

/**
 * Counts the "lit" pixels in the canvas — pixels brighter than the near-black
 * scene background. The scene text is drawn inside the WebGL canvas (not the
 * DOM), so this is how we detect that something actually rendered.
 *
 * We measure it from a Playwright screenshot (the composited frame the browser
 * presents) rather than reading the WebGL canvas directly: three.js runs
 * without `preserveDrawingBuffer`, so an in-page drawImage of the live canvas
 * comes back blank. The PNG is decoded and downsampled back in the page, so the
 * check stays cheap while still catching the thin text strokes.
 */
async function litPixelCount(page: Page, canvas: Locator): Promise<number> {
  const png = await canvas.screenshot()
  return page.evaluate(
    async (dataUrl) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const w = 160
      const h = 90
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const ctx = off.getContext('2d')
      if (!ctx) return 0
      ctx.drawImage(img, 0, 0, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      let lit = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) lit++
      }
      return lit
    },
    `data:image/png;base64,${png.toString('base64')}`,
  )
}

test('smoke: page loads, the canvas renders, and a well-formed /ws SceneState arrives', async ({
  page,
}, testInfo) => {
  // Start listening for /ws frames before navigating, so the SceneState snapshot
  // the backend sends immediately on connect can't be missed. Resolve on the
  // first frame that parses as JSON and carries a valid `viewMode`, rather than
  // on the first frame of any kind: that keeps the assertion resilient to future
  // Scene Delta frames (ADR-0007) arriving alongside or after the snapshot,
  // without freezing an ordering assumption. The received frame is how we assert
  // the message actually reached the browser.
  const sceneStateFrame = new Promise<{ viewMode: unknown }>((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return
        let frame: { viewMode?: unknown }
        try {
          frame = JSON.parse(payload)
        } catch {
          return
        }
        if (VIEW_MODES.includes(frame.viewMode as (typeof VIEW_MODES)[number])) {
          resolve({ viewMode: frame.viewMode })
        }
      })
    })
  })

  await page.goto('/')

  // The R3F <Canvas> mounts a single <canvas>.
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()

  // A well-formed SceneState snapshot reached the browser over /ws. We assert
  // its `viewMode` is one of the valid values rather than a frozen payload, and
  // don't over-constrain the rest of the object, so this stays green as
  // SceneState grows (Towers/Panels in later tickets). The app connects to a
  // real kind cluster in CI (ADR-0004), so a valid frame arriving is also proof
  // the binary started against the cluster.
  const frame = await sceneStateFrame
  expect(VIEW_MODES).toContain(frame.viewMode)

  // "The canvas renders": wait until it has lit pixels above the near-black
  // background. drei's SDF text loads its font and draws a frame or two after
  // the message arrives, so poll rather than sampling once. This confirms the
  // WebGL scene actually drew (not a blank/crashed context) without the fragile
  // in-canvas pixel-diffing the frontend-tester persona warns against, and it
  // gates the screenshot below so the artifact is never a blank frame. It does
  // not by itself distinguish the message from Scene's "Waiting…" fallback —
  // the /ws assertion above and the screenshot below cover that.
  await expect.poll(() => litPixelCount(page, canvas), { timeout: 20_000 }).toBeGreaterThan(0)

  // The visual proof the scene rendered against the real cluster (ADR-0004:
  // this project's e2e exists to give that proof without a local run). Taken
  // after the /ws frame has arrived and the scene has drawn, so it captures the
  // rendered scene rather than the waiting fallback. A composed, predictably-
  // named file for the CI job (issue #8) to upload, alongside Playwright's own
  // per-test video in outputDir.
  await page.screenshot({ path: testInfo.outputPath('smoke.png') })
})
