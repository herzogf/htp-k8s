import { describe, expect, it } from 'vitest'
import {
  ColorCrashLoopBackOff,
  ColorPending,
  PodPhaseCrashLoopBackOff,
  PodPhasePending,
  type SceneState,
  ViewModeNode,
} from '../generated/scenestate'
import { makePanel, makeSceneState, makeTower } from '../test-support/sceneFixtures'
import { reduceScene } from './reduceScene'
import type { SceneDelta } from './sceneDelta'

/** Applies a whole sequence of deltas in order, as the hook does frame by frame. */
const applyAll = (state: SceneState, deltas: SceneDelta[]): SceneState =>
  deltas.reduce(reduceScene, state)

describe('reduceScene — towerAdded', () => {
  it('adds a brand-new Tower with its Panels', () => {
    const initial = makeSceneState({ towers: [] })
    const tower = makeTower({
      name: 'node-a',
      grid: { col: 1, row: 0 },
      panels: [makePanel({ namespace: 'team', pod: 'web-1' })],
    })

    const next = reduceScene(initial, { type: 'towerAdded', tower })

    expect(next).toEqual(makeSceneState({ towers: [tower] }))
  })

  it('replaces (does not duplicate) a Tower re-added under the same name', () => {
    const first = makeTower({ name: 'node-a', panels: [] })
    const second = makeTower({ name: 'node-a', panels: [makePanel({ pod: 'p1' })] })
    const initial = makeSceneState({ towers: [first] })

    const next = reduceScene(initial, { type: 'towerAdded', tower: second })

    expect(next.towers).toEqual([second])
  })
})

describe('reduceScene — towerRemoved', () => {
  it('removes the Tower and all its Panels, leaving nothing stale', () => {
    const doomed = makeTower({ name: 'node-a', panels: [makePanel({ pod: 'p1' })] })
    const kept = makeTower({ name: 'node-b', panels: [makePanel({ pod: 'p2' })] })
    const initial = makeSceneState({ towers: [doomed, kept] })

    const next = reduceScene(initial, { type: 'towerRemoved', towerName: 'node-a' })

    expect(next.towers).toEqual([kept])
    expect(next.towers.some((t) => t.name === 'node-a')).toBe(false)
  })

  it('is a no-op when the Tower is already gone', () => {
    const initial = makeSceneState({ towers: [makeTower({ name: 'node-b' })] })

    const next = reduceScene(initial, { type: 'towerRemoved', towerName: 'ghost' })

    expect(next.towers).toEqual(initial.towers)
  })
})

describe('reduceScene — towerMoved', () => {
  it('updates the grid of a surviving Tower', () => {
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', grid: { col: 0, row: 0 } })],
    })

    const next = reduceScene(initial, {
      type: 'towerMoved',
      towerName: 'node-a',
      grid: { col: 3, row: 2 },
    })

    expect(next.towers[0].grid).toEqual({ col: 3, row: 2 })
  })

  it('is a no-op when the Tower is absent', () => {
    const initial = makeSceneState({ towers: [makeTower({ name: 'node-a' })] })

    const next = reduceScene(initial, {
      type: 'towerMoved',
      towerName: 'ghost',
      grid: { col: 9, row: 9 },
    })

    expect(next).toEqual(initial)
  })
})

describe('reduceScene — panelAdded', () => {
  it('adds a Panel to the named existing Tower', () => {
    const initial = makeSceneState({ towers: [makeTower({ name: 'node-a', panels: [] })] })
    const panel = makePanel({ namespace: 'team', pod: 'web-1' })

    const next = reduceScene(initial, { type: 'panelAdded', towerName: 'node-a', panel })

    expect(next.towers[0].panels).toEqual([panel])
  })

  it('does not touch other Towers', () => {
    const other = makeTower({ name: 'node-b', panels: [makePanel({ pod: 'b1' })] })
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [] }), other],
    })

    const next = reduceScene(initial, {
      type: 'panelAdded',
      towerName: 'node-a',
      panel: makePanel({ pod: 'a1' }),
    })

    expect(next.towers[1]).toBe(other)
  })

  it('upserts (does not duplicate) a Panel re-added with the same identity', () => {
    const existing = makePanel({ namespace: 'team', pod: 'web-1', phase: PodPhasePending })
    const refreshed = makePanel({
      namespace: 'team',
      pod: 'web-1',
      phase: PodPhaseCrashLoopBackOff,
    })
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [existing] })],
    })

    const next = reduceScene(initial, {
      type: 'panelAdded',
      towerName: 'node-a',
      panel: refreshed,
    })

    expect(next.towers[0].panels).toEqual([refreshed])
  })

  it('is a no-op when the target Tower is absent', () => {
    const initial = makeSceneState({ towers: [makeTower({ name: 'node-a' })] })

    const next = reduceScene(initial, {
      type: 'panelAdded',
      towerName: 'ghost',
      panel: makePanel(),
    })

    expect(next).toEqual(initial)
  })
})

describe('reduceScene — panelUpdated', () => {
  it('replaces the matching Panel in place, keeping others', () => {
    const stable = makePanel({ namespace: 'team', pod: 'db-1' })
    const before = makePanel({
      namespace: 'team',
      pod: 'web-1',
      phase: PodPhasePending,
      color: ColorPending,
    })
    const after = makePanel({
      namespace: 'team',
      pod: 'web-1',
      phase: PodPhaseCrashLoopBackOff,
      color: ColorCrashLoopBackOff,
    })
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [stable, before] })],
    })

    const next = reduceScene(initial, { type: 'panelUpdated', towerName: 'node-a', panel: after })

    expect(next.towers[0].panels).toEqual([stable, after])
  })

  it('is a no-op when the Panel is not present on the Tower', () => {
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [makePanel({ pod: 'db-1' })] })],
    })

    const next = reduceScene(initial, {
      type: 'panelUpdated',
      towerName: 'node-a',
      panel: makePanel({ pod: 'not-here' }),
    })

    expect(next).toEqual(initial)
  })
})

describe('reduceScene — panelRemoved', () => {
  it('removes the identified Panel, leaving nothing stale', () => {
    const kept = makePanel({ namespace: 'team', pod: 'db-1' })
    const doomed = makePanel({ namespace: 'team', pod: 'web-1' })
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [kept, doomed] })],
    })

    const next = reduceScene(initial, {
      type: 'panelRemoved',
      towerName: 'node-a',
      namespace: 'team',
      pod: 'web-1',
    })

    expect(next.towers[0].panels).toEqual([kept])
  })

  it('removes only the Panel whose namespace AND pod both match', () => {
    // Same pod name in two namespaces — identity is the pair, not the pod alone.
    const a = makePanel({ namespace: 'ns-a', pod: 'web' })
    const b = makePanel({ namespace: 'ns-b', pod: 'web' })
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [a, b] })],
    })

    const next = reduceScene(initial, {
      type: 'panelRemoved',
      towerName: 'node-a',
      namespace: 'ns-b',
      pod: 'web',
    })

    expect(next.towers[0].panels).toEqual([a])
  })

  it('is a no-op when the Panel is absent', () => {
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [makePanel({ pod: 'db-1' })] })],
    })

    const next = reduceScene(initial, {
      type: 'panelRemoved',
      towerName: 'node-a',
      namespace: 'default',
      pod: 'gone',
    })

    expect(next).toEqual(initial)
  })
})

describe('reduceScene — panelBlink (transient, no state change)', () => {
  it('is a no-op: a blink never changes the scene (same reference back)', () => {
    // A blink is a transient activity pulse, not scene state (ADR-0007). The
    // reducer must leave the scene exactly as it was — the same state reference,
    // so no React re-render is provoked by a signal the renderer handles itself.
    const initial = makeSceneState({
      towers: [
        makeTower({ name: 'node-a', panels: [makePanel({ namespace: 'team', pod: 'web-1' })] }),
      ],
    })

    const next = reduceScene(initial, {
      type: 'panelBlink',
      towerName: 'node-a',
      namespace: 'team',
      pod: 'web-1',
      activity: 'restart',
    })

    expect(next).toBe(initial)
  })

  it('does not perturb structural deltas applied around it', () => {
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [makePanel({ pod: 'p1' })] })],
    })

    const final = applyAll(initial, [
      {
        type: 'panelBlink',
        towerName: 'node-a',
        namespace: 'default',
        pod: 'p1',
        activity: 'event',
      },
      { type: 'panelAdded', towerName: 'node-a', panel: makePanel({ pod: 'p2' }) },
      {
        type: 'panelBlink',
        towerName: 'node-a',
        namespace: 'default',
        pod: 'p2',
        activity: 'phaseChange',
      },
    ])

    expect(final.towers[0].panels.map((p) => p.pod)).toEqual(['p1', 'p2'])
  })
})

describe('reduceScene — purity', () => {
  it('does not mutate the input state or its nested Towers/Panels', () => {
    const panel = makePanel({ namespace: 'team', pod: 'web-1' })
    const tower = makeTower({ name: 'node-a', panels: [panel] })
    const initial = makeSceneState({ towers: [tower] })
    const snapshot = structuredClone(initial)

    reduceScene(initial, {
      type: 'panelUpdated',
      towerName: 'node-a',
      panel: makePanel({ namespace: 'team', pod: 'web-1', phase: PodPhaseCrashLoopBackOff }),
    })

    expect(initial).toEqual(snapshot)
  })

  it('returns a new towers array reference on a change (so React re-renders)', () => {
    const initial = makeSceneState({ towers: [makeTower({ name: 'node-a' })] })

    const next = reduceScene(initial, {
      type: 'towerAdded',
      tower: makeTower({ name: 'node-b' }),
    })

    expect(next.towers).not.toBe(initial.towers)
  })
})

describe('reduceScene — sequences (rapid-fire and interleaved)', () => {
  it('applies a full life-cycle sequence to the correct final SceneState', () => {
    const initial = makeSceneState({ viewMode: ViewModeNode, towers: [] })

    const deltas: SceneDelta[] = [
      // Two Towers appear.
      {
        type: 'towerAdded',
        tower: makeTower({ name: 'node-a', grid: { col: 0, row: 0 }, panels: [] }),
      },
      {
        type: 'towerAdded',
        tower: makeTower({ name: 'node-b', grid: { col: 1, row: 0 }, panels: [] }),
      },
      // Pods land on them.
      {
        type: 'panelAdded',
        towerName: 'node-a',
        panel: makePanel({
          namespace: 'team',
          pod: 'web-1',
          phase: PodPhasePending,
          color: ColorPending,
        }),
      },
      {
        type: 'panelAdded',
        towerName: 'node-a',
        panel: makePanel({ namespace: 'team', pod: 'web-2' }),
      },
      {
        type: 'panelAdded',
        towerName: 'node-b',
        panel: makePanel({ namespace: 'team', pod: 'db-1' }),
      },
      // web-1 goes into a crash loop.
      {
        type: 'panelUpdated',
        towerName: 'node-a',
        panel: makePanel({
          namespace: 'team',
          pod: 'web-1',
          phase: PodPhaseCrashLoopBackOff,
          color: ColorCrashLoopBackOff,
        }),
      },
      // web-2 dies.
      { type: 'panelRemoved', towerName: 'node-a', namespace: 'team', pod: 'web-2' },
      // node-b drains and leaves; node-a shifts to fill the gap.
      { type: 'towerRemoved', towerName: 'node-b' },
      { type: 'towerMoved', towerName: 'node-a', grid: { col: 0, row: 0 } },
    ]

    const final = applyAll(initial, deltas)

    expect(final).toEqual(
      makeSceneState({
        viewMode: ViewModeNode,
        towers: [
          makeTower({
            name: 'node-a',
            grid: { col: 0, row: 0 },
            panels: [
              makePanel({
                namespace: 'team',
                pod: 'web-1',
                phase: PodPhaseCrashLoopBackOff,
                color: ColorCrashLoopBackOff,
              }),
            ],
          }),
        ],
      }),
    )
  })

  it('reproduces a later snapshot: applying add-then-remove of the same Tower nets out', () => {
    // Rapid-fire churn: a Tower flickers in and out; the net state is unchanged.
    const initial = makeSceneState({ towers: [makeTower({ name: 'node-a' })] })

    const final = applyAll(initial, [
      {
        type: 'towerAdded',
        tower: makeTower({ name: 'node-tmp', panels: [makePanel({ pod: 'x' })] }),
      },
      { type: 'panelAdded', towerName: 'node-tmp', panel: makePanel({ pod: 'y' }) },
      { type: 'towerRemoved', towerName: 'node-tmp' },
    ])

    expect(final).toEqual(initial)
  })

  it('tolerates deltas whose targets are missing without corrupting valid state', () => {
    // Stray / already-superseded deltas (the "out-of-order arrival" robustness
    // case): each is a no-op, and a valid delta in the same batch still applies.
    const initial = makeSceneState({
      towers: [makeTower({ name: 'node-a', panels: [makePanel({ pod: 'p1' })] })],
    })

    const final = applyAll(initial, [
      { type: 'panelUpdated', towerName: 'ghost', panel: makePanel({ pod: 'p1' }) },
      { type: 'panelRemoved', towerName: 'node-a', namespace: 'default', pod: 'not-here' },
      { type: 'towerMoved', towerName: 'ghost', grid: { col: 5, row: 5 } },
      { type: 'panelAdded', towerName: 'node-a', panel: makePanel({ pod: 'p2' }) },
    ])

    expect(final.towers[0].panels.map((p) => p.pod)).toEqual(['p1', 'p2'])
    expect(final.towers).toHaveLength(1)
  })
})
