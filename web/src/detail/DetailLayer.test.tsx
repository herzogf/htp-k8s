import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DetailLayer } from './DetailLayer'
import { type Selection } from './selection'
import { SelectionContext, type SelectionApi } from './selectionContext'

// drei's Html needs R3F/WebGL context; stand it in with a passthrough that just
// renders its children so DetailLayer's selection→popup routing is assertable.
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div data-testid="html">{children}</div>,
}))

// The popup bodies fetch/stream; here we only care that DetailLayer picks the
// right one for the selection, so stand them in with markers echoing their props.
vi.mock('./TowerDetailPopup', () => ({
  TowerDetailPopup: ({ name }: { name: string }) => <div data-testid="tower-popup">{name}</div>,
}))
vi.mock('./PodDetailPopup', () => ({
  PodDetailPopup: ({ namespace, pod }: { namespace: string; pod: string }) => (
    <div data-testid="pod-popup">{`${namespace}/${pod}`}</div>
  ),
}))

function renderLayer(selection: Selection | null, clear = vi.fn()) {
  const api: SelectionApi = { selection, select: vi.fn(), clear }
  render(
    <SelectionContext.Provider value={api}>
      <DetailLayer />
    </SelectionContext.Provider>,
  )
  return { clear }
}

describe('DetailLayer', () => {
  it('renders nothing when no selection is open', () => {
    renderLayer(null)

    expect(screen.queryByTestId('html')).not.toBeInTheDocument()
  })

  it('renders the Tower popup for a tower selection', () => {
    renderLayer({ kind: 'tower', name: 'node-a', anchor: [0, 0, 0] })

    expect(screen.getByTestId('tower-popup')).toHaveTextContent('node-a')
    expect(screen.queryByTestId('pod-popup')).not.toBeInTheDocument()
  })

  it('renders the Pod popup for a pod selection', () => {
    renderLayer({ kind: 'pod', namespace: 'team', pod: 'web-1', anchor: [1, 2, 3] })

    expect(screen.getByTestId('pod-popup')).toHaveTextContent('team/web-1')
    expect(screen.queryByTestId('tower-popup')).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    const { clear } = renderLayer({ kind: 'tower', name: 'node-a', anchor: [0, 0, 0] })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('does not listen for Escape when nothing is open', () => {
    const { clear } = renderLayer(null)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(clear).not.toHaveBeenCalled()
  })
})
