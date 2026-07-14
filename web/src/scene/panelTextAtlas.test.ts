import { describe, expect, it } from 'vitest'
import { atlasGrid } from './panelTextAtlas'

// buildPanelTextAtlas is renderer glue (it rasterizes to a canvas + uploads a
// GPU texture) and is validated by the Playwright screenshot (ADR-0004); only
// its pure grid-shape math is unit-tested here.
describe('atlasGrid', () => {
  it('has zero capacity for an empty scene', () => {
    expect(atlasGrid(0)).toEqual({ cols: 1, rows: 1, capacity: 0 })
  })

  it('lays a small count out in a roughly-square grid that covers it', () => {
    const { cols, rows, capacity } = atlasGrid(30)
    // cols ≈ √30 ≈ 6, and the grid must have room for every Pod.
    expect(cols).toBe(6)
    expect(capacity).toBeGreaterThanOrEqual(30)
    expect(cols * rows).toBe(capacity)
  })

  it('always covers the count when within the texture-size capacity', () => {
    for (const count of [1, 5, 49, 100, 500]) {
      const { capacity } = atlasGrid(count)
      expect(capacity).toBeGreaterThanOrEqual(count)
    }
  })

  it('never exceeds a portable max texture size in either dimension', () => {
    // cols * CELL_W (256) and rows * CELL_H (72) must both fit 4096.
    const { cols, rows } = atlasGrid(1_000_000)
    expect(cols * 256).toBeLessThanOrEqual(4096)
    expect(rows * 72).toBeLessThanOrEqual(4096)
  })
})
