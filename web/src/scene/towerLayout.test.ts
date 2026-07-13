import { describe, expect, it } from 'vitest'
import { type SceneState, type Tower, ViewModeNode } from '../generated/scenestate'
import { TOWER_HEIGHT, TOWER_SPACING, towerPlacements } from './towerLayout'

/**
 * Builds a Tower at a grid slot. Argument order matches the sibling factory in
 * Scene.test.tsx so the two read the same way.
 */
const tower = (name: string, col: number, row: number): Tower => ({ name, grid: { col, row } })

describe('towerPlacements', () => {
  it('maps an empty scene to no placements', () => {
    expect(towerPlacements([])).toEqual([])
  })

  it("is driven by a SceneState's towers", () => {
    // The app calls towerPlacements(sceneState.towers); thread a full SceneState
    // through once to pin that call path (the rest pass the Tower array directly).
    const sceneState: SceneState = { viewMode: ViewModeNode, towers: [tower('only', 4, 4)] }

    expect(towerPlacements(sceneState.towers)).toEqual([
      { name: 'only', position: [0, TOWER_HEIGHT / 2, 0] },
    ])
  })

  it('produces one placement per Tower, preserving order and names', () => {
    const placements = towerPlacements([
      tower('alpha', 0, 0),
      tower('bravo', 1, 0),
      tower('charlie', 0, 1),
    ])

    expect(placements).toHaveLength(3)
    expect(placements.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('places a lone Tower at the world origin, resting on the floor', () => {
    // Centring is on the occupied grid's midpoint, so absolute indices do not
    // matter: a single Tower always lands at x = z = 0 regardless of its slot.
    const [placement] = towerPlacements([tower('solo', 7, 3)])

    expect(placement.position).toEqual([0, TOWER_HEIGHT / 2, 0])
  })

  it('spaces neighbouring columns by TOWER_SPACING along X', () => {
    const [left, right] = towerPlacements([tower('left', 0, 0), tower('right', 1, 0)])

    expect(right.position[0] - left.position[0]).toBe(TOWER_SPACING)
    // Same row -> same Z.
    expect(left.position[2]).toBe(right.position[2])
  })

  it('spaces neighbouring rows by TOWER_SPACING along Z', () => {
    const [near, far] = towerPlacements([tower('near', 0, 0), tower('far', 0, 1)])

    expect(far.position[2] - near.position[2]).toBe(TOWER_SPACING)
    // Same column -> same X.
    expect(near.position[0]).toBe(far.position[0])
  })

  it('centres the occupied grid on the origin', () => {
    // Columns 0..2 -> centred so the middle column sits at x = 0 and the flanks
    // are symmetric about it; the row is constant so every Z is equal.
    const placements = towerPlacements([tower('a', 0, 0), tower('b', 1, 0), tower('c', 2, 0)])

    const xs = placements.map((p) => p.position[0])
    expect(xs).toEqual([-TOWER_SPACING, 0, TOWER_SPACING])
    expect(placements.every((p) => p.position[1] === TOWER_HEIGHT / 2)).toBe(true)
  })

  it('lifts every Tower so its prism rests on the floor', () => {
    const placements = towerPlacements([tower('a', 0, 0), tower('b', 2, 4)])

    expect(placements.every((p) => p.position[1] === TOWER_HEIGHT / 2)).toBe(true)
  })
})
