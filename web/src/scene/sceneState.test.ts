import { describe, expect, it } from 'vitest'
import { type SceneState, ViewModeNamespace, ViewModeNode } from '../generated/scenestate'
import { parseSceneState, viewModeLabel } from './sceneState'

describe('parseSceneState', () => {
  it('parses a well-formed Node-mode snapshot', () => {
    const state = parseSceneState(JSON.stringify({ viewMode: ViewModeNode }))

    expect(state).toEqual({ viewMode: 'node' })
  })

  it('parses a well-formed Namespace-mode snapshot', () => {
    const state = parseSceneState(JSON.stringify({ viewMode: ViewModeNamespace }))

    expect(state).toEqual({ viewMode: 'namespace' })
  })

  it('preserves unknown fields so a grown snapshot still parses', () => {
    // Issue #12 adds `towers` to SceneState; a frame carrying it must still
    // parse, and the extra field is kept (this code just ignores it).
    const raw = JSON.stringify({ viewMode: ViewModeNode, towers: [{ id: 'a' }] })

    const state = parseSceneState(raw)

    expect(state).toMatchObject({ viewMode: 'node', towers: [{ id: 'a' }] })
  })

  it('returns null for a non-JSON frame', () => {
    expect(parseSceneState('not json')).toBeNull()
  })

  it('returns null when viewMode is missing', () => {
    expect(parseSceneState(JSON.stringify({ something: 'else' }))).toBeNull()
  })

  it('returns null when viewMode is not a string', () => {
    expect(parseSceneState(JSON.stringify({ viewMode: 42 }))).toBeNull()
  })

  it('returns null when viewMode is an empty string', () => {
    expect(parseSceneState(JSON.stringify({ viewMode: '' }))).toBeNull()
  })

  it('returns null for a JSON payload that is not an object', () => {
    expect(parseSceneState(JSON.stringify('node'))).toBeNull()
  })
})

describe('viewModeLabel', () => {
  it('labels Node mode', () => {
    const state: SceneState = { viewMode: ViewModeNode }

    expect(viewModeLabel(state.viewMode)).toBe('Node view')
  })

  it('labels Namespace/Project mode', () => {
    const state: SceneState = { viewMode: ViewModeNamespace }

    expect(viewModeLabel(state.viewMode)).toBe('Namespace / Project view')
  })

  it('falls back to a self-describing label for an unrecognized mode', () => {
    expect(viewModeLabel('warp' as SceneState['viewMode'])).toBe('Unknown view mode (warp)')
  })
})
