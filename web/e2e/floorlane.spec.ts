import { expect, type Page, test } from '@playwright/test'

// Floor Lanes (#28): decorative traveling light pulses connecting grid-adjacent
// Towers. The lane routing (src/scene/laneLayout.ts) and pulse envelope
// (src/scene/laneActivity.ts) are unit-tested WebGL-free; this is the
// end-to-end proof that FloorLanes actually renders lanes between the real
// Towers of a live scene and that its pulses are genuinely animating — not
// just a single static frame — against a real WebGL canvas. Exactly like the
// blink/free-fly/focus e2e tests, a window test hook
// (`window.__htpFloorLaneTest`) reads state straight back out of the
// InstancedMeshes, since there's nothing in the DOM to assert a 3D position on.

// Mirror of FloorLaneTestHook in src/scene/FloorLanes.tsx (its single source of
// truth). The e2e is a separate compilation domain from the app bundle, so the
// shape is restated here rather than imported across that boundary; keep the
// two in step.
interface FloorLaneTestHook {
  listLanes: () => Array<{ id: string; from: string; to: string }>
  readPulsePositions: () => Array<[number, number, number]>
}

declare global {
  interface Window {
    __htpFloorLaneTest?: FloorLaneTestHook
  }
}

async function waitForScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  // The hook is mounted by FloorLanes as soon as it renders (even with zero
  // lanes it sets window.__htpFloorLaneTest), but we want an actually
  // populated grid — the e2e's KWOK scene has several Nodes (ADR-0004), so
  // grid-adjacent lanes must exist once the scene has loaded.
  await page.waitForFunction(
    () => (window.__htpFloorLaneTest?.listLanes().length ?? 0) > 0,
    undefined,
    { timeout: 20_000 },
  )
}

test('floor lanes: render between real Towers and carry visibly traveling pulses', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await waitForScene(page)

  // Lanes connect real Towers from the live scene, each with a well-formed
  // "<from>->to" identity — the routing wiring actually reached a populated
  // grid, not an empty/placeholder one.
  const lanes = await page.evaluate(() => window.__htpFloorLaneTest!.listLanes())
  expect(lanes.length).toBeGreaterThan(0)
  for (const lane of lanes) {
    expect(lane.id).toBe(`${lane.from}->${lane.to}`)
    expect(lane.from).not.toBe(lane.to)
  }

  // At least one pulse is currently drawn: the decorative activity source
  // (src/scene/laneActivity.ts) keeps pulses in flight continuously, so the
  // pulse InstancedMesh should never be empty once the scene has settled.
  await expect
    .poll(async () => {
      const positions = await page.evaluate(() => window.__htpFloorLaneTest!.readPulsePositions())
      return positions.length
    })
    .toBeGreaterThan(0)

  // The core animation proof: a pulse's world position genuinely changes over
  // time (it is traveling, not a static light fixed to the lane). Track the
  // first pulse position across a short wait.
  const before = await page.evaluate(() => window.__htpFloorLaneTest!.readPulsePositions())
  expect(before.length).toBeGreaterThan(0)

  await page.waitForTimeout(500)

  const after = await page.evaluate(() => window.__htpFloorLaneTest!.readPulsePositions())
  expect(after.length).toBeGreaterThan(0)

  // Compare corresponding pulse slots (mesh order is stable frame to frame for
  // a static lane list): at least one pulse instance must have moved.
  const moved = before.some((position, i) => {
    const other = after[i]
    if (!other) return true
    const dx = position[0] - other[0]
    const dz = position[2] - other[2]
    return Math.hypot(dx, dz) > 1e-4
  })
  expect(moved).toBe(true)

  // A short visible sequence for the captured video (this project's e2e proof
  // is the recording, ADR-0004): give Playwright a few seconds of a populated,
  // pulsing scene before the screenshot/video conclude.
  await page.waitForTimeout(2000)

  await page.screenshot({ path: testInfo.outputPath('floorlane.png') })
})
