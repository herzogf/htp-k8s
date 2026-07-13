import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Panel, SceneDelta as WireSceneDelta, Tower } from '../generated/scenestate'
import { makePanel, makeTower } from '../test-support/sceneFixtures'
import { parseSceneDelta } from './sceneDelta'

// Complete, valid wire shapes via the shared factories, so these tests don't
// break when a wire type grows a required field (see sceneFixtures).
const panel = makePanel({ namespace: 'team', pod: 'web-1' })
const tower = makeTower({ name: 'node-a', grid: { col: 1, row: 2 }, panels: [panel] })

/** wireDelta builds a raw wire delta (all fields optional) for a test. */
function wireDelta(fields: Partial<WireSceneDelta> & { type: string }): WireSceneDelta {
  return fields as WireSceneDelta
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseSceneDelta narrows each kind', () => {
  it('towerAdded → carries the full tower', () => {
    expect(parseSceneDelta(wireDelta({ type: 'towerAdded', tower }))).toEqual({
      type: 'towerAdded',
      tower,
    })
  })

  it('towerRemoved → carries the tower name', () => {
    expect(parseSceneDelta(wireDelta({ type: 'towerRemoved', towerName: 'node-a' }))).toEqual({
      type: 'towerRemoved',
      towerName: 'node-a',
    })
  })

  it('towerMoved → carries the tower name and new grid', () => {
    const grid = { col: 0, row: 3 }
    expect(parseSceneDelta(wireDelta({ type: 'towerMoved', towerName: 'node-a', grid }))).toEqual({
      type: 'towerMoved',
      towerName: 'node-a',
      grid,
    })
  })

  it('panelAdded → carries the tower name and panel', () => {
    expect(parseSceneDelta(wireDelta({ type: 'panelAdded', towerName: 'node-a', panel }))).toEqual({
      type: 'panelAdded',
      towerName: 'node-a',
      panel,
    })
  })

  it('panelUpdated → carries the tower name and panel', () => {
    expect(
      parseSceneDelta(wireDelta({ type: 'panelUpdated', towerName: 'node-a', panel })),
    ).toEqual({ type: 'panelUpdated', towerName: 'node-a', panel })
  })

  it('panelRemoved → carries the tower name and pod identity', () => {
    expect(
      parseSceneDelta(
        wireDelta({ type: 'panelRemoved', towerName: 'node-a', namespace: 'team', pod: 'web-1' }),
      ),
    ).toEqual({ type: 'panelRemoved', towerName: 'node-a', namespace: 'team', pod: 'web-1' })
  })

  it('panelBlink → carries the tower name, pod identity, and activity', () => {
    expect(
      parseSceneDelta(
        wireDelta({
          type: 'panelBlink',
          towerName: 'node-a',
          namespace: 'team',
          pod: 'web-1',
          activity: 'restart',
        }),
      ),
    ).toEqual({
      type: 'panelBlink',
      towerName: 'node-a',
      namespace: 'team',
      pod: 'web-1',
      activity: 'restart',
    })
  })
})

describe('parseSceneDelta rejects malformed payloads', () => {
  it('towerAdded missing the tower → null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSceneDelta(wireDelta({ type: 'towerAdded' }))).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('towerAdded with a tower missing panels → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const badTower: Partial<Tower> = makeTower()
    delete badTower.panels
    expect(parseSceneDelta(wireDelta({ type: 'towerAdded', tower: badTower as Tower }))).toBeNull()
  })

  it('towerRemoved missing the tower name → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSceneDelta(wireDelta({ type: 'towerRemoved' }))).toBeNull()
  })

  it('towerMoved missing the grid → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSceneDelta(wireDelta({ type: 'towerMoved', towerName: 'node-a' }))).toBeNull()
  })

  it('towerMoved with a non-numeric grid → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const grid = { col: '0', row: 0 } as unknown as Tower['grid']
    expect(parseSceneDelta(wireDelta({ type: 'towerMoved', towerName: 'node-a', grid }))).toBeNull()
  })

  it('panelAdded missing the panel → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSceneDelta(wireDelta({ type: 'panelAdded', towerName: 'node-a' }))).toBeNull()
  })

  it('panelAdded with a panel missing its color → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const badPanel: Partial<Panel> = makePanel()
    delete badPanel.color
    expect(
      parseSceneDelta(
        wireDelta({ type: 'panelAdded', towerName: 'node-a', panel: badPanel as Panel }),
      ),
    ).toBeNull()
  })

  it('panelRemoved missing the pod → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      parseSceneDelta(wireDelta({ type: 'panelRemoved', towerName: 'node-a', namespace: 'team' })),
    ).toBeNull()
  })

  it('panelBlink missing the activity → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      parseSceneDelta(
        wireDelta({ type: 'panelBlink', towerName: 'node-a', namespace: 'team', pod: 'web-1' }),
      ),
    ).toBeNull()
  })

  it('panelBlink missing the pod → null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      parseSceneDelta(
        wireDelta({
          type: 'panelBlink',
          towerName: 'node-a',
          namespace: 'team',
          activity: 'event',
        }),
      ),
    ).toBeNull()
  })
})

describe('parseSceneDelta ignores unknown kinds', () => {
  it('an unknown/future type → null (graceful degradation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSceneDelta(wireDelta({ type: 'blinkTriggered', towerName: 'node-a' }))).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown type'))
  })
})
