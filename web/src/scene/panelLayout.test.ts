import { describe, expect, it } from 'vitest'
import { ColorFailed, ColorRunning, PodPhaseFailed } from '../generated/scenestate'
import { makePanel, makeSceneState, makeTower } from '../test-support/sceneFixtures'
import {
  PANEL_FACES_PER_TOWER,
  PANELS_PER_ROW,
  PANEL_SIZE,
  panelInstanceIndex,
  panelInstances,
  panelRowsPerFace,
  resolvePanel,
  sceneRowsPerFace,
  sceneTowerHeight,
} from './panelLayout'
import { TOWER_FOOTPRINT, TOWER_HEIGHT, towerPlacements } from './towerLayout'

/** The number of Pods that fit across all four faces of a Tower at the
 * resting {@link TOWER_HEIGHT} — the "fill all four sides first" capacity
 * {@link sceneTowerHeight} only grows the scene past. */
const BASE_FACE_CAPACITY = panelRowsPerFace(TOWER_HEIGHT) * PANELS_PER_ROW
const BASE_TOWER_CAPACITY = BASE_FACE_CAPACITY * PANEL_FACES_PER_TOWER

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

  it('gives every front-face (pre-#59) Panel rotationY 0 — a no-op rotation', () => {
    const instances = panelInstances([
      makeTower({ panels: [makePanel(), makePanel(), makePanel()] }),
    ])

    expect(instances.every((p) => p.rotationY === 0)).toBe(true)
  })
})

describe('panelInstances: four-face wrap (#59)', () => {
  it('fills the front face completely before wrapping to the right face', () => {
    // One more Pod than the front face holds at the resting height: the first
    // BASE_FACE_CAPACITY stay on the front (+Z) face, the wrapped Pod starts a
    // fresh top-down grid on the right (+X) face.
    const panels = Array.from({ length: BASE_FACE_CAPACITY + 1 }, (_, i) =>
      makePanel({ pod: `p-${i}` }),
    )
    const [placement] = towerPlacements([makeTower({ name: 'solo' })])
    const instances = panelInstances([makeTower({ name: 'solo', panels })])

    const frontFace = instances.slice(0, BASE_FACE_CAPACITY)
    expect(frontFace.every((p) => p.rotationY === 0)).toBe(true)
    expect(frontFace.every((p) => p.position[2] > placement.position[2])).toBe(true)

    const wrapped = instances[BASE_FACE_CAPACITY]
    // A quarter turn onto the right (+X) face, standing proud of THAT edge.
    expect(wrapped.rotationY).toBeCloseTo(Math.PI / 2)
    expect(wrapped.position[0]).toBeGreaterThan(placement.position[0])
    // The wrapped face restarts its own grid at the top — same row-0 height as
    // the front face's own first Pod (top-down fill, carried over from #15,
    // applies per-face).
    expect(wrapped.position[1]).toBeCloseTo(frontFace[0].position[1])

    // No height growth yet: a single face's overflow is absorbed by the next
    // face, not by growing the scene.
    expect(sceneTowerHeight([makeTower({ panels })])).toBe(TOWER_HEIGHT)
  })

  it('wraps through all four faces (front, right, back, left) in order', () => {
    const panels = Array.from({ length: BASE_TOWER_CAPACITY }, (_, i) =>
      makePanel({ pod: `p-${i}` }),
    )
    const instances = panelInstances([makeTower({ panels })])

    // One instance from the middle of each face, by construction (indices are
    // 0-based multiples of BASE_FACE_CAPACITY plus a fixed intra-face offset).
    const faceStart = (face: number) => instances[face * BASE_FACE_CAPACITY]
    expect(faceStart(0).rotationY).toBeCloseTo(0)
    expect(faceStart(1).rotationY).toBeCloseTo(Math.PI / 2)
    expect(faceStart(2).rotationY).toBeCloseTo(Math.PI)
    expect(faceStart(3).rotationY).toBeCloseTo(-Math.PI / 2)

    // Every face's own first Pod lands at the same top-down row-0 height.
    const topRowY = faceStart(0).position[1]
    expect(faceStart(1).position[1]).toBeCloseTo(topRowY)
    expect(faceStart(2).position[1]).toBeCloseTo(topRowY)
    expect(faceStart(3).position[1]).toBeCloseTo(topRowY)
  })

  it('renders a 100+ Pod Tower across multiple faces without exceeding four or overflowing the prism', () => {
    // Comfortably past 100, still inside the four-face capacity at the resting
    // height — the acceptance criterion's "busy tower renders without
    // overflowing the tower geometry", satisfied purely by wrapping (no height
    // growth needed).
    const podCount = 120
    expect(podCount).toBeLessThanOrEqual(BASE_TOWER_CAPACITY)
    expect(podCount).toBeGreaterThan(BASE_FACE_CAPACITY) // needs more than one face

    const panels = Array.from({ length: podCount }, (_, i) => makePanel({ pod: `p-${i}` }))
    const instances = panelInstances([makeTower({ panels })])

    expect(sceneTowerHeight([makeTower({ panels })])).toBe(TOWER_HEIGHT)
    // Uses every one of the four faces (not stuck on one, not overflowing a fifth).
    const rotations = new Set(instances.map((p) => Math.round(p.rotationY * 1000)))
    expect(rotations.size).toBe(PANEL_FACES_PER_TOWER)
    // Every Panel stays within the resting Tower's vertical extent: never below
    // the floor, never above the cap.
    expect(instances.every((p) => p.position[1] >= PANEL_SIZE / 2)).toBe(true)
    expect(instances.every((p) => p.position[1] <= TOWER_HEIGHT - PANEL_SIZE / 2)).toBe(true)
  })
})

/**
 * Measures the two horizontal geometry constants {@link facePlacement} bakes
 * in (the standoff distance off a face and half a row's width) empirically,
 * from a single centred row of Panels on the front face — rather than
 * importing the private PANEL_STANDOFF/PANEL_PITCH constants — so the real
 * containment tests below can assert an ACTUAL horizontal bound per Panel,
 * not just a vertical (Y) one. This is what review finding #4 asked for:
 * "the containment test doesn't test containment" — the previous 100+-Pod
 * test only ever checked Y.
 */
function measureFaceGeometry(): { standoff: number; halfRowWidth: number } {
  const panels = Array.from({ length: PANELS_PER_ROW }, (_, i) => makePanel({ pod: `ref-${i}` }))
  const [placement] = towerPlacements([makeTower({ name: 'ref' })])
  const instances = panelInstances([makeTower({ name: 'ref', panels })])
  const standoff = instances[0].position[2] - placement.position[2]
  const halfRowWidth = Math.max(
    ...instances.map((p) => Math.abs(p.position[0] - placement.position[0])),
  )
  return { standoff, halfRowWidth }
}

/**
 * Asserts every one of `instances` is ACTUALLY contained within its Tower's
 * geometry at `height`: exactly one horizontal axis pinned to the face
 * standoff (front/back = ±Z, right/left = ±X — {@link facePlacement}'s four
 * faces), the other horizontal axis within the row's half-width, and Y within
 * the Tower's vertical span. A real footprint/height containment check, not
 * just the old test's Y-only bound.
 */
function assertContained(
  instances: ReturnType<typeof panelInstances>,
  placement: { position: readonly [number, number, number] },
  height: number,
  geometry: { standoff: number; halfRowWidth: number },
): void {
  const EPS = 1e-6
  for (const instance of instances) {
    const dx = instance.position[0] - placement.position[0]
    const dz = instance.position[2] - placement.position[2]
    const onZFace = Math.abs(Math.abs(dz) - geometry.standoff) < EPS
    const onXFace = Math.abs(Math.abs(dx) - geometry.standoff) < EPS
    expect(onZFace || onXFace).toBe(true)
    if (onZFace) {
      expect(Math.abs(dx)).toBeLessThanOrEqual(geometry.halfRowWidth + EPS)
    } else {
      expect(Math.abs(dz)).toBeLessThanOrEqual(geometry.halfRowWidth + EPS)
    }
    expect(instance.position[1]).toBeGreaterThanOrEqual(PANEL_SIZE / 2 - EPS)
    expect(instance.position[1]).toBeLessThanOrEqual(height - PANEL_SIZE / 2 + EPS)
  }
}

describe('panelInstances: growth-path containment (#59 review findings 3 & 4)', () => {
  const geometry = measureFaceGeometry()

  it('stays contained (real X/Y/Z bounds, not just Y) for a busy Tower in the non-growing regime', () => {
    const podCount = 120
    const towers = [
      makeTower({
        panels: Array.from({ length: podCount }, (_, i) => makePanel({ pod: `p-${i}` })),
      }),
    ]
    const height = sceneTowerHeight(towers)
    const [placement] = towerPlacements(towers, height)

    assertContained(panelInstances(towers), placement, height, geometry)
  })

  it('stays contained AND collision-free once the scene has grown past the resting height', () => {
    // Several pod counts spanning multiple row-boundary crossings well past
    // where sceneTowerHeight must grow — including 373, the exact count the
    // review's floating-point round-trip finding was reproduced against.
    for (const podCount of [BASE_TOWER_CAPACITY + 1, 200, 373, 500, 1000]) {
      const towers = [
        makeTower({
          panels: Array.from({ length: podCount }, (_, i) => makePanel({ pod: `p-${i}` })),
        }),
      ]
      const height = sceneTowerHeight(towers)
      expect(height).toBeGreaterThan(TOWER_HEIGHT)
      const [placement] = towerPlacements(towers, height)
      const instances = panelInstances(towers)

      assertContained(instances, placement, height, geometry)

      // The real regression a lost row causes: the last Panel silently
      // wraps back onto an earlier one (identical rendered position) instead
      // of visibly overflowing — assert every rendered position is unique.
      const positions = new Set(instances.map((p) => p.position.join(',')))
      expect(positions.size).toBe(podCount)
    }
  })

  it('panelRowsPerFace(sceneTowerHeight(towers)) matches sceneRowsPerFace(towers) at every row boundary (ROW_EPSILON regression guard)', () => {
    // The exact composition the review found losing a row to floating-point
    // rounding: re-deriving row count by flooring the already-rounded height
    // back down. panelInstances itself no longer does this (it calls
    // sceneRowsPerFace directly — see its own comment), but this pins the
    // composition safe anyway, in case anything else ever does it.
    for (let rows = 12; rows <= 100; rows++) {
      const podCount = rows * PANELS_PER_ROW * PANEL_FACES_PER_TOWER
      const towers = [
        makeTower({
          panels: Array.from({ length: podCount }, (_, i) => makePanel({ pod: `p-${i}` })),
        }),
      ]
      const height = sceneTowerHeight(towers)
      expect(panelRowsPerFace(height)).toBe(sceneRowsPerFace(towers))
    }
  })
})

describe('sceneTowerHeight (#59)', () => {
  it('is the resting TOWER_HEIGHT for an empty scene', () => {
    expect(sceneTowerHeight([])).toBe(TOWER_HEIGHT)
  })

  it('stays at TOWER_HEIGHT while the busiest Tower fits across its four faces', () => {
    const panels = Array.from({ length: BASE_TOWER_CAPACITY }, (_, i) =>
      makePanel({ pod: `p-${i}` }),
    )
    expect(sceneTowerHeight([makeTower({ panels })])).toBe(TOWER_HEIGHT)
  })

  it('grows past TOWER_HEIGHT once the busiest Tower overflows all four faces', () => {
    const panels = Array.from({ length: BASE_TOWER_CAPACITY + 1 }, (_, i) =>
      makePanel({ pod: `p-${i}` }),
    )
    expect(sceneTowerHeight([makeTower({ panels })])).toBeGreaterThan(TOWER_HEIGHT)
  })

  it('is driven by the busiest Tower, not the scene-wide total Pod count', () => {
    // Three Towers, each comfortably under BASE_TOWER_CAPACITY on its own, whose
    // SUM exceeds it — the scene must stay at the resting height, because no
    // single Tower needs more than its own four faces hold.
    const perTower = Math.floor(BASE_TOWER_CAPACITY * 0.6)
    const towers = ['a', 'b', 'c'].map((name) =>
      makeTower({
        name,
        panels: Array.from({ length: perTower }, (_, i) => makePanel({ pod: `${name}-${i}` })),
      }),
    )

    expect(perTower * 3).toBeGreaterThan(BASE_TOWER_CAPACITY)
    expect(sceneTowerHeight(towers)).toBe(TOWER_HEIGHT)
  })

  it('applies the SAME grown height to every Tower — a quiet Tower is not shorter', () => {
    const busyPanels = Array.from({ length: BASE_TOWER_CAPACITY + PANELS_PER_ROW * 4 }, (_, i) =>
      makePanel({ pod: `busy-${i}` }),
    )
    const busy = makeTower({ name: 'busy', grid: { col: 0, row: 0 }, panels: busyPanels })
    const quiet = makeTower({
      name: 'quiet',
      grid: { col: 1, row: 0 },
      panels: [makePanel({ pod: 'lonely' })],
    })

    const height = sceneTowerHeight([busy, quiet])
    expect(height).toBeGreaterThan(TOWER_HEIGHT)

    const instances = panelInstances([busy, quiet])
    const busyTopRowY = instances[0].position[1] // busy's first Pod: face 0, row 0
    const quietInstance = instances.find((p) => p.pod === 'lonely')!
    // Both are row-0-of-face-0 Panels, so at a genuinely uniform scene height
    // they land at the exact same Y — the quiet Tower's face just has the rest
    // of its rows empty, it isn't a shorter prism.
    expect(quietInstance.position[1]).toBeCloseTo(busyTopRowY)

    // And the placements (the Tower prisms themselves) share that same height.
    const placements = towerPlacements([busy, quiet], height)
    expect(placements[0].position[1]).toBe(height / 2)
    expect(placements[1].position[1]).toBe(height / 2)
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
