import { describe, expect, it } from 'vitest'
import { type Tower } from '../generated/scenestate'
import { makeTower } from '../test-support/sceneFixtures'
import { LANE_HEIGHT, laneRoutes } from './laneLayout'
import { TOWER_FOOTPRINT, TOWER_SPACING, towerPlacements } from './towerLayout'

/** Builds a Tower at a grid slot — mirrors the sibling helper in towerLayout.test.ts. */
const tower = (name: string, col: number, row: number): Tower =>
  makeTower({ name, grid: { col, row } })

describe('laneRoutes', () => {
  it('routes no lanes for an empty scene', () => {
    expect(laneRoutes([])).toEqual([])
  })

  it('routes no lanes for a single, isolated Tower', () => {
    expect(laneRoutes([tower('solo', 0, 0)])).toEqual([])
  })

  it('routes no lane between Towers that are not grid-adjacent', () => {
    // A gap at column 1 means 'left' and 'right' are not neighbours, even
    // though they are the only two Towers in the scene.
    const lanes = laneRoutes([tower('left', 0, 0), tower('right', 2, 0)])
    expect(lanes).toEqual([])
  })

  it('routes one x-axis lane between horizontally adjacent Towers', () => {
    const towers = [tower('left', 0, 0), tower('right', 1, 0)]
    const [lane] = laneRoutes(towers)

    expect(lane.id).toBe('left->right')
    expect(lane.from).toBe('left')
    expect(lane.to).toBe('right')
    expect(lane.axis).toBe('x')
  })

  it('routes one z-axis lane between vertically adjacent Towers', () => {
    const towers = [tower('near', 0, 0), tower('far', 0, 1)]
    const [lane] = laneRoutes(towers)

    expect(lane.id).toBe('near->far')
    expect(lane.axis).toBe('z')
  })

  it('trims the segment back from each Tower centre by half a footprint', () => {
    const towers = [tower('left', 0, 0), tower('right', 1, 0)]
    const [placementLeft, placementRight] = towerPlacements(towers)
    const [lane] = laneRoutes(towers)

    const trim = TOWER_FOOTPRINT / 2
    expect(lane.start).toEqual([
      placementLeft.position[0] + trim,
      LANE_HEIGHT,
      placementLeft.position[2],
    ])
    expect(lane.end).toEqual([
      placementRight.position[0] - trim,
      LANE_HEIGHT,
      placementRight.position[2],
    ])
    expect(lane.length).toBeCloseTo(TOWER_SPACING - TOWER_FOOTPRINT)
  })

  it('lifts every lane clear of the floor at LANE_HEIGHT', () => {
    const towers = [tower('left', 0, 0), tower('right', 1, 0)]
    const [lane] = laneRoutes(towers)

    expect(lane.start[1]).toBe(LANE_HEIGHT)
    expect(lane.end[1]).toBe(LANE_HEIGHT)
    expect(lane.midpoint[1]).toBe(LANE_HEIGHT)
  })

  it('centres the midpoint between the trimmed endpoints', () => {
    const towers = [tower('left', 0, 0), tower('right', 1, 0)]
    const [lane] = laneRoutes(towers)

    expect(lane.midpoint[0]).toBeCloseTo((lane.start[0] + lane.end[0]) / 2)
    expect(lane.midpoint[2]).toBeCloseTo((lane.start[2] + lane.end[2]) / 2)
  })

  it('routes exactly one lane per adjacent pair in a row, never doubling an edge', () => {
    // Three Towers in a row have two adjacent pairs (a-b, b-c), not three: a and
    // c are not adjacent, and a-b must not be emitted from both sides.
    const towers = [tower('a', 0, 0), tower('b', 1, 0), tower('c', 2, 0)]
    const lanes = laneRoutes(towers)

    expect(lanes.map((l) => l.id)).toEqual(['a->b', 'b->c'])
  })

  it('routes both a right and a below lane from a corner Tower in an L-shaped grid', () => {
    const towers = [tower('corner', 0, 0), tower('right', 1, 0), tower('below', 0, 1)]
    const lanes = laneRoutes(towers)

    expect(lanes.map((l) => l.id).sort()).toEqual(['corner->below', 'corner->right'])
    // 'right' and 'below' are diagonal to each other, not grid-adjacent.
    expect(lanes.some((l) => l.id === 'right->below' || l.id === 'below->right')).toBe(false)
  })

  it('is stable under Tower order — grid position, not array order, decides adjacency', () => {
    const forward = laneRoutes([tower('a', 0, 0), tower('b', 1, 0)])
    const reversed = laneRoutes([tower('b', 1, 0), tower('a', 0, 0)])

    expect(forward.map((l) => l.id)).toEqual(['a->b'])
    expect(reversed.map((l) => l.id)).toEqual(['a->b'])
  })
})
