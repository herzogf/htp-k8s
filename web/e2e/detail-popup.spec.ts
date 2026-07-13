import { expect, type Locator, type Page, test } from '@playwright/test'

// The Detail Popup (#24) is the one piece of the 3D scene that renders real,
// queryable DOM: clicking a Tower or Panel opens an in-world popup through drei's
// `Html` (unlike the WebGL canvas, which has nothing in the DOM to assert on —
// see focus.spec.ts). This test drives the same stable click path the Focus test
// uses and asserts on that popup's DOM content against the live KWOK-seeded
// cluster and the real backend detail endpoints (ADR-0009), proving the whole
// click → detail-fetch → popup-render path end to end.
//
// Both AC targets are exercised: a Panel click yields a Pod popup with a live,
// height-limited log tail, and a Tower click yields a Node/Namespace summary.
// Because a headless click lands on whatever mesh is under the point, each test
// scans a grid of click points until it finds the popup kind it needs — the
// scene is densely populated, so both kinds are reliably reachable.

async function waitForScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  // The camera hook is published once the R3F scene is live (see focus.spec.ts);
  // reuse it as the "scene is interactive" signal before we start clicking. Read
  // it via a cast so this file needn't redeclare the global focus.spec.ts owns.
  await page.waitForFunction(
    () => (window as unknown as { __htpCameraTest?: unknown }).__htpCameraTest !== undefined,
    undefined,
    { timeout: 20_000 },
  )
}

/**
 * Clicks across a grid of points over the canvas until the open Detail Popup is
 * of `kind` ('tower' or 'pod'), returning its locator. Presses Escape before
 * each attempt so a previously-open popup can't sit over the canvas and swallow
 * the next click. Throws if no point yields the wanted kind.
 */
async function openPopupOfKind(page: Page, kind: 'tower' | 'pod'): Promise<Locator> {
  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas has no bounding box')

  const popup = page.getByTestId('detail-popup')
  const cols = 7
  const rows = 5
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      // Close any popup from the previous attempt so it doesn't intercept clicks.
      await page.keyboard.press('Escape')
      const x = box.x + (box.width * c) / (cols + 1)
      const y = box.y + (box.height * r) / (rows + 1)
      await page.mouse.click(x, y)

      // A click either opens a popup (hit a mesh — the card renders immediately,
      // with data-detail-kind set from the selection before its detail loads) or
      // clears it (empty space). A short window is enough to tell which happened.
      const appeared = await popup
        .waitFor({ state: 'visible', timeout: 500 })
        .then(() => true)
        .catch(() => false)
      if (!appeared) continue

      if ((await popup.getAttribute('data-detail-kind')) === kind) {
        return popup
      }
    }
  }
  throw new Error(`no click opened a Detail Popup of kind "${kind}"`)
}

test('detail popup: clicking a Panel opens a read-only pod popup with a live log tail', async ({
  page,
}) => {
  // Scanning a grid of click points for a specific popup kind can take many
  // attempts against a live scene; give it headroom over the default 30s.
  test.setTimeout(120_000)
  await page.goto('/')
  await waitForScene(page)

  const popup = await openPopupOfKind(page, 'pod')

  // The popup carries real pod detail from GET /api/pods/{ns}/{name} (ADR-0009).
  await expect(popup).toContainText('Pod')
  await expect(popup.locator('.detail-rows__label', { hasText: 'Namespace' })).toBeVisible()
  await expect(popup.locator('.detail-rows__label', { hasText: 'Phase' })).toBeVisible()
  await expect(popup.locator('.detail-rows__label', { hasText: 'Restarts' })).toBeVisible()

  // The marquee: a live, height-limited (~3 row) log tail streamed over SSE. The
  // element is present regardless of whether the simulated pod emits log lines;
  // when it does, the window is capped at LogTailMaxLines (3).
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

test('detail popup: clicking a Tower opens a read-only summary popup at that tower', async ({
  page,
}) => {
  // Scanning a grid of click points for a specific popup kind can take many
  // attempts against a live scene; give it headroom over the default 30s.
  test.setTimeout(120_000)
  await page.goto('/')
  await waitForScene(page)

  const popup = await openPopupOfKind(page, 'tower')

  // A Tower popup carries the Node or Namespace/Project summary from
  // GET /api/towers/{name} (ADR-0009) — its kind label is one of the two.
  await expect(popup.locator('.detail-card__kind')).toHaveText(/Node|Namespace/)
  await expect(popup.locator('.detail-card__title')).not.toBeEmpty()

  // Read-only: only the Close control, no actions.
  await expect(popup.getByRole('button')).toHaveCount(1)

  // Escape closes it — the keyboard dismiss affordance.
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
})
