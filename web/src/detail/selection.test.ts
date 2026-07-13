import { describe, expect, it } from 'vitest'
import { type Selection, sameSelection } from './selection'

const tower = (name: string): Selection => ({ kind: 'tower', name, anchor: [0, 0, 0] })
const pod = (namespace: string, name: string): Selection => ({
  kind: 'pod',
  namespace,
  pod: name,
  anchor: [1, 2, 3],
})

describe('sameSelection', () => {
  it('treats two null selections as the same', () => {
    expect(sameSelection(null, null)).toBe(true)
  })

  it('treats a selection and null as different', () => {
    expect(sameSelection(tower('a'), null)).toBe(false)
    expect(sameSelection(null, pod('team', 'web-1'))).toBe(false)
  })

  it('matches towers by name, ignoring the anchor', () => {
    expect(sameSelection(tower('a'), { kind: 'tower', name: 'a', anchor: [9, 9, 9] })).toBe(true)
    expect(sameSelection(tower('a'), tower('b'))).toBe(false)
  })

  it('matches pods by namespace and name', () => {
    expect(sameSelection(pod('team', 'web-1'), pod('team', 'web-1'))).toBe(true)
    expect(sameSelection(pod('team', 'web-1'), pod('team', 'web-2'))).toBe(false)
    expect(sameSelection(pod('team', 'web-1'), pod('other', 'web-1'))).toBe(false)
  })

  it('treats different kinds as different', () => {
    expect(sameSelection(tower('a'), pod('a', 'a'))).toBe(false)
  })
})
