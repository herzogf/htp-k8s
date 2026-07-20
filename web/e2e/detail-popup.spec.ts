import { expect, type Page, test } from '@playwright/test'

// The Detail Popup (#24) is the one piece of the 3D scene that renders real,
// queryable DOM: clicking a Tower or Panel opens an in-world popup through drei's
// `Html` (unlike the WebGL canvas, which has nothing in the DOM to assert on —
// see focus.spec.ts). This test asserts on that popup's DOM content against the
// live KWOK-seeded cluster and the real backend detail endpoints (ADR-0009).
//
// It does NOT click the canvas to open the popup: synthetic pointer input does
// not reliably raycast onto an instanced Panel / Tower in headless Chromium (the
// same flakiness #20/#74 hit). Instead it drives the popup through the stable
// `window.__htpDetailTest` hook, which opens a given Tower/Panel's popup via the
// *same* `select` a real click calls (the click→selection mapping is unit-tested
// in src/detail/selection.test.ts). What matters here — the popup renders real,
// deterministic DOM with the pod's details and a live, height-limited log tail —
// is what this asserts, end to end against the real backend.

// Mirror of DetailTestHook in src/detail/useDetailTestHook.ts (its single source
// of truth). The e2e is a separate compilation domain from the app bundle, so
// the shape is restated here rather than imported; keep the two in step.
interface DetailTestHook {
  towers: () => { name: string; panelCount: number }[]
  pods: () => { namespace: string; pod: string }[]
  selectTower: (name: string) => boolean
  selectPod: (namespace: string, pod: string) => boolean
  clear: () => void
}

// Mirror of CameraTestHook in src/scene/FreeFlyControls.tsx (its single source of
// truth), kept identical to the declaration in focus.spec.ts / freefly.spec.ts so
// the shared `window.__htpCameraTest` augmentation agrees across specs. The visual
// tour only needs `isFocusing()` — to know the Focus fly-to has settled before it
// captures the hero screenshot, so the frame isn't a mid-flight blur.
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
    __htpDetailTest?: DetailTestHook
    __htpCameraTest?: CameraTestHook
  }
}

/**
 * Waits for the scene to be live and populated: the canvas mounted, the detail
 * hook published, and the KWOK-seeded snapshot delivered so at least one Tower
 * and one Pod are present to open a popup for.
 */
async function waitForPopulatedScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await page.waitForFunction(
    () => {
      const hook = window.__htpDetailTest
      return !!hook && hook.towers().length > 0 && hook.pods().length > 0
    },
    undefined,
    { timeout: 30_000 },
  )
}

test('detail popup: a Panel opens a read-only pod popup with a live log tail', async ({ page }) => {
  await page.goto('/')
  await waitForPopulatedScene(page)

  // Open the first Pod's popup through the same selection a click would set.
  const pod = await page.evaluate(() => window.__htpDetailTest!.pods()[0])
  const opened = await page.evaluate(
    (p) => window.__htpDetailTest!.selectPod(p.namespace, p.pod),
    pod,
  )
  expect(opened).toBe(true)

  const popup = page.getByTestId('detail-popup')
  await expect(popup).toBeVisible()
  await expect(popup).toHaveAttribute('data-detail-kind', 'pod')
  await expect(popup.locator('.detail-card__kind')).toHaveText('Pod')
  await expect(popup.locator('.detail-card__title')).toHaveText(pod.pod)

  // Real pod detail from GET /api/pods/{ns}/{name} (ADR-0009) has loaded.
  await expect(popup.locator('.detail-rows__label', { hasText: 'Namespace' })).toBeVisible()
  await expect(popup.locator('.detail-rows__label', { hasText: 'Phase' })).toBeVisible()
  await expect(popup.locator('.detail-rows__label', { hasText: 'Restarts' })).toBeVisible()
  await expect(popup.locator('.detail-rows__value', { hasText: pod.namespace })).toBeVisible()

  // The marquee: a live, height-limited (~3 row) log tail streamed over SSE. The
  // element is present regardless of whether the simulated pod emits lines; when
  // it does, the window is capped at LogTailMaxLines (3).
  const logTail = popup.getByTestId('log-tail')
  await expect(logTail).toBeVisible()
  const lineCount = Number(await logTail.getAttribute('data-line-count'))
  expect(lineCount).toBeLessThanOrEqual(3)

  // Read-only (ADR-0003): the popup's only control is Close — no action buttons,
  // no full log viewer.
  await expect(popup.getByRole('button')).toHaveCount(1)
  await expect(popup.getByRole('button')).toHaveAttribute('aria-label', 'Close details')

  // Closing works: the close affordance dismisses the popup.
  await popup.getByRole('button').click()
  await expect(popup).toHaveCount(0)
})

test('detail popup: a Tower opens a read-only Node/Namespace summary popup', async ({ page }) => {
  await page.goto('/')
  await waitForPopulatedScene(page)

  const tower = await page.evaluate(() => window.__htpDetailTest!.towers()[0])
  const opened = await page.evaluate(
    (name) => window.__htpDetailTest!.selectTower(name),
    tower.name,
  )
  expect(opened).toBe(true)

  const popup = page.getByTestId('detail-popup')
  await expect(popup).toBeVisible()
  await expect(popup).toHaveAttribute('data-detail-kind', 'tower')
  await expect(popup.locator('.detail-card__title')).toHaveText(tower.name)

  // The summary from GET /api/towers/{name} (ADR-0009) resolves to a Node or a
  // Namespace/Project popup once loaded (the "Tower" placeholder is the pre-load
  // label only).
  await expect(popup.locator('.detail-card__kind')).toHaveText(/Node|Namespace/)

  // Read-only: only the Close control, no actions.
  await expect(popup.getByRole('button')).toHaveCount(1)

  // Escape closes it — the keyboard dismiss affordance.
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
})

test('detail popup: towers() panelCount stays paired with the right Tower (the towers[i]/placements[i] zip)', async ({
  page,
}) => {
  await page.goto('/')
  await waitForPopulatedScene(page)

  const towers = await page.evaluate(() => window.__htpDetailTest!.towers())
  const pods = await page.evaluate(() => window.__htpDetailTest!.pods())

  // useDetailTestHook.ts pairs each Tower's Pod count with its placement by
  // INDEX (`towers[i]` <-> `placements[i]`), asserted nowhere but a doc
  // comment — a regression there would only be caught by the unwatched
  // nightly tier (issue #29's panel-wrap.spec.ts) otherwise. seed.sh's fake
  // nodes are a known, deterministic fixture (30 pods round-robin over 6
  // nodes — exactly 5 each), so a specific one's panelCount is a real,
  // PR-time-watched regression signal for that pairing.
  const fakeNodeTower = towers.find((t) => t.name === 'kwok-node-0')
  expect(fakeNodeTower?.panelCount).toBe(5)

  // Every Pod is accounted for exactly once across all Towers — the zip
  // can't silently drop or double-count an entry either.
  const totalPanelCount = towers.reduce((sum, t) => sum + t.panelCount, 0)
  expect(totalPanelCount).toBe(pods.length)
})

/**
 * Waits for the Focus fly-to opened by the detail hook to settle (so the shot
 * isn't a mid-flight blur), then lets the framed popup linger a beat — both so
 * the single recorded video shows each popup clearly, one after the other, and
 * so the captured PNG is a clean hero frame of the popup on screen.
 */
async function settleAndLinger(page: Page): Promise<void> {
  await page
    .waitForFunction(() => window.__htpCameraTest?.isFocusing() === false, undefined, {
      timeout: 10_000,
    })
    .catch(() => {
      // A camera hook is always present in this build, but never let a missing
      // fly-to signal fail the capture — fall through to the fixed linger.
    })
  await page.waitForTimeout(1_500)
}

// A visual walk-through that captures the two Detail Popups the way a viewer
// sees them: it opens the Tower popup (camera framed on the Tower), captures it,
// dismisses it, then opens the Pod popup (camera framed on the Panel) and
// captures that — one popup on screen at a time, in sequence. Its two named
// screenshots and its single recorded video (Playwright records one video per
// test) are the deliverable artifacts for reviewing the popup visuals without a
// local run; the two tests above are the rigorous DOM assertions. Because the
// detail hook now mirrors the full click (Focus fly-to + selection), each popup
// is framed on screen rather than pinned to an off-camera anchor.
test('detail popup: a visual tour of the Tower then the Pod popup', async ({ page }, testInfo) => {
  await page.goto('/')
  await waitForPopulatedScene(page)
  const popup = page.getByTestId('detail-popup')

  // 1) The Tower (Node/Namespace summary) popup, framed and captured.
  const tower = await page.evaluate(() => window.__htpDetailTest!.towers()[0])
  await page.evaluate((name) => window.__htpDetailTest!.selectTower(name), tower.name)
  await expect(popup).toHaveAttribute('data-detail-kind', 'tower')
  await expect(popup.locator('.detail-card__kind')).toHaveText(/Node|Namespace/)
  await settleAndLinger(page)
  await page.screenshot({ path: testInfo.outputPath('tower-detail-popup.png') })

  // Dismiss it so only one popup is ever on screen at a time.
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)

  // 2) The Pod (detail + live log tail) popup, framed and captured.
  const pod = await page.evaluate(() => window.__htpDetailTest!.pods()[0])
  await page.evaluate((p) => window.__htpDetailTest!.selectPod(p.namespace, p.pod), pod)
  await expect(popup).toHaveAttribute('data-detail-kind', 'pod')
  await expect(popup.locator('.detail-card__title')).toHaveText(pod.pod)
  // Wait for the real pod detail (ADR-0009) to load so the shot isn't a spinner.
  await expect(popup.locator('.detail-rows__value', { hasText: pod.namespace })).toBeVisible()
  await expect(popup.getByTestId('log-tail')).toBeVisible()
  await settleAndLinger(page)
  await page.screenshot({ path: testInfo.outputPath('pod-detail-popup.png') })
})
