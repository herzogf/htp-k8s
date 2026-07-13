import { describe, expect, it } from 'vitest'
import { ColorFailed, ColorRunning, PodPhaseFailed } from '../generated/scenestate'
import { makePanel, makeSceneState, makeTower } from '../test-support/sceneFixtures'
import {
  PANELS_PER_ROW,
  PANEL_SIZE,
  panelInstanceIndex,
  panelInstances,
  resolvePanel,
} from './panelLayout'
import { TOWER_FOOTPRINT, towerPlacements } from './towerLayout'

describe('panelInstances', () => {
  it('maps an empty scene to no instances', () => {
    expect(panelInstances([])).toEqual([])
  })

  it('emits nothing for a Tower with no Panels', () => {
    expect(panelInstances([makeTower({ name: 'idle', panels: [] })])).toEqual([])
  })

  it('emits one instance per Panel, flattened across all Towers in order', () => {
    // Two towers, differing panel counts: the flat instance list is the
    // concatenation of each tower's panels, tower order then panel order. This
    // is the ordering the InstancedMesh writes its matrices/colors in, so the
    // instance index is a stable handle onto (tower, pod).
    const scene = makeSceneState({
      towers: [
        makeTower({
          name: 'node-a',
          grid: { col: 0, row: 0 },
          panels: [
            makePanel({ namespace: 'ns1', pod: 'a-0' }),
            makePanel({ namespace: 'ns1', pod: 'a-1' }),
          ],
        }),
        makeTower({
          name: 'node-b',
          grid: { col: 1, row: 0 },
          panels: [makePanel({ namespace: 'ns2', pod: 'b-0' })],
        }),
      ],
    })

    const instances = panelInstances(scene.towers)

    expect(instances).toHaveLength(3)
    expect(instances.map((p) => [p.tower, p.pod])).toEqual([
      ['node-a', 'a-0'],
      ['node-a', 'a-1'],
      ['node-b', 'b-0'],
    ])
  })

  it('carries each Panel color straight through (no re-derivation)', () => {
    const instances = panelInstances([
      makeTower({
        panels: [
          makePanel({ pod: 'ok', phase: 'Running', color: ColorRunning }),
          makePanel({ pod: 'bad', phase: PodPhaseFailed, color: ColorFailed }),
        ],
      }),
    ])

    expect(instances.map((p) => p.color)).toEqual([ColorRunning, ColorFailed])
  })

  it('records each instance back to its originating Pod for picking', () => {
    const [instance] = panelInstances([
      makeTower({ name: 'the-node', panels: [makePanel({ namespace: 'prod', pod: 'web-7' })] }),
    ])

    expect(instance).toMatchObject({ tower: 'the-node', namespace: 'prod', pod: 'web-7' })
  })

  it('places Panels on the front (+Z) face of their Tower, standing proud of it', () => {
    const [tower] = towerPlacements([makeTower({ name: 'solo', grid: { col: 3, row: 2 } })])
    const [instance] = panelInstances([
      makeTower({ name: 'solo', grid: { col: 3, row: 2 }, panels: [makePanel()] }),
    ])

    const [, , z] = instance.position
    // In front of the tower centre, just past its face half-depth.
    expect(z).toBeGreaterThan(tower.position[2] + TOWER_FOOTPRINT / 2)
  })

  it('centres a row of Panels on the Tower and fills rows downward from the top', () => {
    // One full row plus one: cols within a row are symmetric about the tower X,
    // and the wrapped panel starts a new row below the first (top-down fill).
    const panels = Array.from({ length: PANELS_PER_ROW + 1 }, (_, i) =>
      makePanel({ pod: `p-${i}` }),
    )
    const instances = panelInstances([makeTower({ name: 'solo', panels })])

    const firstRow = instances.slice(0, PANELS_PER_ROW)
    const xs = firstRow.map((p) => p.position[0])
    // Symmetric about the tower centre (x = 0 for a lone tower).
    expect(xs[0]).toBeCloseTo(-xs[xs.length - 1])
    expect(xs).toEqual([...xs].sort((a, b) => a - b))

    // The first Pod's row is the highest; the wrapped panel sits directly below
    // the first column, a row lower.
    const wrapped = instances[PANELS_PER_ROW]
    expect(wrapped.position[0]).toBeCloseTo(firstRow[0].position[0])
    expect(wrapped.position[1]).toBeLessThan(firstRow[0].position[1])
  })

  it('places the first Pod at the top of the face and fills downward', () => {
    // Two rows' worth of Pods: every panel in an earlier row sits strictly
    // higher than every panel in a later row, so the grid grows top-down.
    const panels = Array.from({ length: PANELS_PER_ROW * 2 }, (_, i) =>
      makePanel({ pod: `p-${i}` }),
    )
    const instances = panelInstances([makeTower({ name: 'solo', panels })])

    const topRowMinY = Math.min(...instances.slice(0, PANELS_PER_ROW).map((p) => p.position[1]))
    const nextRowMaxY = Math.max(
      ...instances.slice(PANELS_PER_ROW, PANELS_PER_ROW * 2).map((p) => p.position[1]),
    )
    expect(topRowMinY).toBeGreaterThan(nextRowMaxY)
  })

  it('keeps every Panel off the floor', () => {
    const instances = panelInstances([
      makeTower({ panels: [makePanel(), makePanel(), makePanel(), makePanel()] }),
    ])

    expect(instances.every((p) => p.position[1] >= PANEL_SIZE / 2)).toBe(true)
  })

  it('follows its Tower to the Tower placement in X', () => {
    // Two towers a column apart, each with a full centred row: the row's centre
    // of mass sits at its own tower's X, so panels ride along with the layout
    // maths in towerLayout and each tower's panels stay clustered over it.
    const row = () => Array.from({ length: PANELS_PER_ROW }, (_, i) => makePanel({ pod: `p-${i}` }))
    const [left, right] = [
      makeTower({ name: 'l', grid: { col: 0, row: 0 }, panels: row() }),
      makeTower({ name: 'r', grid: { col: 1, row: 0 }, panels: row() }),
    ]
    const placements = towerPlacements([left, right])
    const instances = panelInstances([left, right])

    const meanX = (from: number) =>
      instances.slice(from, from + PANELS_PER_ROW).reduce((sum, p) => sum + p.position[0], 0) /
      PANELS_PER_ROW

    expect(meanX(0)).toBeCloseTo(placements[0].position[0])
    expect(meanX(PANELS_PER_ROW)).toBeCloseTo(placements[1].position[0])
    expect(meanX(PANELS_PER_ROW)).toBeGreaterThan(meanX(0))
  })
})

describe('resolvePanel', () => {
  it('resolves an instance index back to its Panel', () => {
    const instances = panelInstances([
      makeTower({ name: 'n', panels: [makePanel({ pod: 'first' }), makePanel({ pod: 'second' })] }),
    ])

    expect(resolvePanel(instances, 1)).toMatchObject({ tower: 'n', pod: 'second' })
  })

  it('returns undefined for an out-of-range index', () => {
    expect(resolvePanel([], 0)).toBeUndefined()
  })
})

describe('panelInstanceIndex', () => {
  const instances = panelInstances([
    makeTower({
      name: 'node-a',
      grid: { col: 0, row: 0 },
      panels: [
        makePanel({ namespace: 'ns1', pod: 'a-0' }),
        makePanel({ namespace: 'ns1', pod: 'a-1' }),
      ],
    }),
    makeTower({
      name: 'node-b',
      grid: { col: 1, row: 0 },
      panels: [makePanel({ namespace: 'ns2', pod: 'a-0' })],
    }),
  ])

  it('finds the instance index for a Pod identity, the inverse of resolvePanel', () => {
    const index = panelInstanceIndex(instances, 'ns1', 'a-1')
    expect(index).toBe(1)
    expect(resolvePanel(instances, index!)).toMatchObject({ namespace: 'ns1', pod: 'a-1' })
  })

  it('keys on the full (namespace, pod) pair, not the pod name alone', () => {
    // Two Pods share the name "a-0" across namespaces; each resolves to its own
    // instance, so a blink hits exactly the right one.
    expect(panelInstanceIndex(instances, 'ns1', 'a-0')).toBe(0)
    expect(panelInstanceIndex(instances, 'ns2', 'a-0')).toBe(2)
  })

  it('returns undefined for a Pod not in the scene', () => {
    expect(panelInstanceIndex(instances, 'ns1', 'ghost')).toBeUndefined()
    expect(panelInstanceIndex([], 'ns1', 'a-0')).toBeUndefined()
  })
})
