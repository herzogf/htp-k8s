import { describe, expect, it } from 'vitest'
import { type PanelInstance } from '../scene/panelLayout'
import { type TowerPlacement } from '../scene/towerLayout'
import { panelSelection, towerSelection } from './selection'

describe('towerSelection', () => {
  it('maps a resolved Tower placement to a tower selection anchored at the prism', () => {
    const placement: TowerPlacement = { name: 'node-a', position: [4, 3, -2] }

    expect(towerSelection(placement)).toEqual({
      kind: 'tower',
      name: 'node-a',
      anchor: [4, 3, -2],
    })
  })
})

describe('panelSelection', () => {
  it("maps a resolved Panel instance to a pod selection with the pod's identity and centre", () => {
    const instance: PanelInstance = {
      tower: 'node-a',
      namespace: 'team',
      pod: 'web-1',
      color: '#39ff14',
      position: [1, 2, 3],
    }

    expect(panelSelection(instance)).toEqual({
      kind: 'pod',
      namespace: 'team',
      pod: 'web-1',
      anchor: [1, 2, 3],
    })
  })
})
