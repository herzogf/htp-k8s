import { describe, expect, it, vi } from 'vitest'
import { type SceneState, ViewModeNamespace, ViewModeNode } from '../generated/scenestate'
import { makePanel, makeSceneState, makeTower } from '../test-support/sceneFixtures'
import { parseSceneFrame, viewModeLabel } from './sceneState'

describe('parseSceneFrame', () => {
  it('routes a snapshot frame (has viewMode, no type) to kind "snapshot"', () => {
    const snapshot = makeSceneState({
      viewMode: ViewModeNode,
      towers: [makeTower({ name: 'node-a', panels: [makePanel({ pod: 'p1' })] })],
    })

    expect(parseSceneFrame(JSON.stringify(snapshot))).toEqual({ kind: 'snapshot', snapshot })
  })

  it('routes a Namespace-mode snapshot', () => {
    const frame = parseSceneFrame(JSON.stringify({ viewMode: ViewModeNamespace, towers: [] }))

    expect(frame).toEqual({ kind: 'snapshot', snapshot: { viewMode: 'namespace', towers: [] } })
  })

  it('preserves unknown snapshot fields (a grown snapshot still parses)', () => {
    const frame = parseSceneFrame(JSON.stringify({ viewMode: ViewModeNode, extra: 'kept' }))

    expect(frame).toMatchObject({ kind: 'snapshot', snapshot: { viewMode: 'node', extra: 'kept' } })
  })

  it('returns null when a snapshot-shaped frame has a non-string viewMode', () => {
    expect(parseSceneFrame(JSON.stringify({ viewMode: 42 }))).toBeNull()
  })

  it('returns null when a snapshot-shaped frame has an empty-string viewMode', () => {
    expect(parseSceneFrame(JSON.stringify({ viewMode: '' }))).toBeNull()
  })

  it('routes a delta frame (has a type discriminant) to kind "delta"', () => {
    const frame = parseSceneFrame(JSON.stringify({ type: 'towerRemoved', towerName: 'node-a' }))

    expect(frame).toEqual({ kind: 'delta', delta: { type: 'towerRemoved', towerName: 'node-a' } })
  })

  it('narrows a towerAdded delta with its full Tower', () => {
    const tower = makeTower({ name: 'node-a', grid: { col: 1, row: 2 }, panels: [makePanel()] })

    const frame = parseSceneFrame(JSON.stringify({ type: 'towerAdded', tower }))

    expect(frame).toEqual({ kind: 'delta', delta: { type: 'towerAdded', tower } })
  })

  it('returns null for a non-JSON frame', () => {
    expect(parseSceneFrame('not json')).toBeNull()
  })

  it('returns null for a JSON payload that is not an object', () => {
    expect(parseSceneFrame(JSON.stringify('node'))).toBeNull()
  })

  it('returns null for a snapshot-shaped frame missing viewMode', () => {
    expect(parseSceneFrame(JSON.stringify({ towers: [] }))).toBeNull()
  })

  it('returns null (not a snapshot) for an unknown delta type', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseSceneFrame(JSON.stringify({ type: 'somethingNew', towerName: 'x' }))).toBeNull()
  })

  it('returns null for a malformed delta of a known type', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // towerMoved requires a grid; without it the delta is unusable.
    expect(parseSceneFrame(JSON.stringify({ type: 'towerMoved', towerName: 'node-a' }))).toBeNull()
  })
})

describe('viewModeLabel', () => {
  it('labels Node mode', () => {
    const state = makeSceneState({ viewMode: ViewModeNode })

    expect(viewModeLabel(state.viewMode)).toBe('Node view')
  })

  it('labels Namespace/Project mode', () => {
    const state = makeSceneState({ viewMode: ViewModeNamespace })

    expect(viewModeLabel(state.viewMode)).toBe('Namespace / Project view')
  })

  it('falls back to a self-describing label for an unrecognized mode', () => {
    expect(viewModeLabel('warp' as SceneState['viewMode'])).toBe('Unknown view mode (warp)')
  })
})
