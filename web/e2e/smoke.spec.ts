import { type Locator, type Page, expect, test } from '@playwright/test'

// The backend's hardcoded placeholder (internal/server/server.go). Until a
// later ticket wires real cluster state, /ws sends exactly this once on
// connect, and the frontend renders it inside the R3F canvas.
const PLACEHOLDER_MESSAGE = 'htp-k8s backend placeholder - no cluster connectivity yet'

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

test('smoke: page loads, the canvas renders, and the backend WS message arrives', async ({
  page,
}, testInfo) => {
  // Start listening for /ws frames before navigating, so the message the
  // backend sends immediately on connect can't be missed. The received frame
  // is how we assert the message actually reached the browser.
  const wsMessage = new Promise<string>((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') resolve(payload)
      })
    })
  })

  await page.goto('/')

  // The R3F <Canvas> mounts a single <canvas>.
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()

  // The backend's placeholder message — this exact string, not just any frame —
  // reached the browser over /ws. This is the machine-checkable half of "the
  // placeholder message is displayed": the frontend renders whatever /ws last
  // delivered (src/App.tsx -> Scene), so once this arrives it is the scene text.
  await expect(wsMessage).resolves.toBe(PLACEHOLDER_MESSAGE)

  // "The canvas renders": wait until it has lit pixels above the near-black
  // background. drei's SDF text loads its font and draws a frame or two after
  // the message arrives, so poll rather than sampling once. This confirms the
  // WebGL scene actually drew (not a blank/crashed context) without the fragile
  // in-canvas pixel-diffing the frontend-tester persona warns against, and it
  // gates the screenshot below so the artifact is never a blank frame. It does
  // not by itself distinguish the message from Scene's "Waiting…" fallback —
  // the /ws assertion above and the screenshot below cover that.
  await expect.poll(() => litPixelCount(page, canvas), { timeout: 20_000 }).toBeGreaterThan(0)

  // The visual proof the placeholder message is displayed (ADR-0004: this
  // project's e2e exists to give that proof without a local run). Taken after
  // the /ws frame has arrived and the scene has drawn, so it captures the
  // message rather than the waiting fallback. A composed, predictably-named
  // file for a future CI job (issue #8) to upload, alongside Playwright's own
  // per-test video in outputDir.
  await page.screenshot({ path: testInfo.outputPath('smoke.png') })
})
