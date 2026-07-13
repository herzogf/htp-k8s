import { expect, type Page, test } from '@playwright/test'

// Panel blink (#19): a `panelBlink` activity signal makes one Pod's Panel flash
// brighter and settle back. A real blink is driven by transient cluster activity
// (a pod restart / phase change / Event) that can't be reproduced deterministically
// in the static KWOK e2e scene, so — exactly as the free-fly and focus tests read
// the WebGL camera through a window hook — the Panels renderer exposes
// `window.__htpBlinkTest`: it injects a blink for a real Pod (as a panelBlink delta
// would) and reads that instance's color straight from the InstancedMesh color
// buffer. This is the end-to-end proof the trigger → per-instance animation wiring
// works against a real scene; the envelope/mapping maths itself is unit-tested
// WebGL-free in src/scene/blinks.test.ts and src/scene/Panels' inputs.

// Mirror of BlinkTestHook in src/scene/Panels.tsx (its single source of truth).
// The e2e is a separate compilation domain from the app bundle, so the shape is
// restated here rather than imported across that boundary; keep the two in step.
interface BlinkTestHook {
  listPanels: () => Array<{ namespace: string; pod: string }>
  triggerBlink: (namespace: string, pod: string, activity: string) => void
  readColor: (namespace: string, pod: string) => [number, number, number] | null
}

declare global {
  interface Window {
    __htpBlinkTest?: BlinkTestHook
  }
}

async function waitForScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  // The blink hook is only mounted once Panels has instances to draw — i.e. the
  // KWOK scene's Pods have arrived — so waiting on it also waits for a populated scene.
  await page.waitForFunction(
    () => (window.__htpBlinkTest?.listPanels().length ?? 0) > 0,
    undefined,
    { timeout: 20_000 },
  )
}

/** Sum of a Panel instance's RGB channels — its rough brightness, which a blink lifts. */
async function brightness(page: Page, panel: { namespace: string; pod: string }): Promise<number> {
  const color = await page.evaluate((p) => {
    const hook = window.__htpBlinkTest
    if (!hook) throw new Error('blink test hook not present')
    return hook.readColor(p.namespace, p.pod)
  }, panel)
  if (!color) throw new Error(`no rendered color for ${panel.namespace}/${panel.pod}`)
  return color[0] + color[1] + color[2]
}

test('blink: an injected panelBlink flashes exactly that Panel brighter, then it settles back', async ({
  page,
}) => {
  await page.goto('/')
  await waitForScene(page)

  // Pick a real Pod from the live scene — a concrete instance the blink must animate.
  const panels = await page.evaluate(() => window.__htpBlinkTest!.listPanels())
  expect(panels.length).toBeGreaterThan(0)
  const target = panels[0]

  // Its resting brightness (the phase color the layout pass wrote), before any blink.
  const baseline = await brightness(page, target)

  // Trigger a blink and prove the instance visibly brightens. The pulse decays
  // over ~0.7s, so we re-arm it each poll to hold it lit until Playwright observes
  // the brighter buffer — the trigger → animation path firing on a real instance.
  await page.waitForFunction(
    ({ panel, base }) => {
      const hook = window.__htpBlinkTest
      if (!hook) return false
      hook.triggerBlink(panel.namespace, panel.pod, 'restart')
      const color = hook.readColor(panel.namespace, panel.pod)
      if (!color) return false
      return color[0] + color[1] + color[2] > base + 0.1
    },
    { panel: target, base: baseline },
    { timeout: 5000 },
  )

  const litUp = await brightness(page, target)
  expect(litUp).toBeGreaterThan(baseline + 0.1)

  // Stop triggering and let the envelope run out: the blink is transient, so the
  // Panel must settle back to its original phase-color brightness (not stay lit).
  await page.waitForTimeout(1000)
  const settled = await brightness(page, target)
  expect(settled).toBeCloseTo(baseline, 1)

  // A second, distinct Pod (if the scene has one) is never disturbed by the blink
  // above — the animation is instance-aware. (Isolation is exhaustively covered in
  // the unit tests; this is the end-to-end sanity check on a real scene.)
  if (panels.length > 1) {
    const other = panels[1]
    const otherBase = await brightness(page, other)
    await page.evaluate(
      (p) => window.__htpBlinkTest!.triggerBlink(p.namespace, p.pod, 'restart'),
      target,
    )
    // Immediately after firing the target's blink, the other Panel is unchanged.
    expect(await brightness(page, other)).toBeCloseTo(otherBase, 2)
  }

  // A short, clearly visible sequence of pulses for the captured video (this
  // project's e2e proof is the recording, ADR-0004): flash the Panel a few times
  // with gaps so the maintainer sees the blink, not just a single frame's blip.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(
      (p) => window.__htpBlinkTest!.triggerBlink(p.namespace, p.pod, 'restart'),
      target,
    )
    await page.waitForTimeout(400)
  }
})
