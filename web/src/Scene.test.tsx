import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  type SceneState,
  type Tower,
  ViewModeNamespace,
  ViewModeNode,
} from './generated/scenestate'
import { Scene } from './Scene'
import { type TowerPlacement } from './scene/towerLayout'

// jsdom has no WebGL context, so the real @react-three/fiber Canvas can't
// mount here. Full 3D rendering correctness is covered by the Playwright
// e2e suite (frontend-tester) against a real browser instead; this test
// only verifies the scene wires a Canvas up, shows the right View Mode
// indicator, and renders one Tower per Tower in the snapshot, via lightweight
// stand-ins for the R3F/drei primitives and the WebGL Tower component.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <div data-testid="canvas">{children}</div>,
}))

vi.mock('@react-three/drei', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

// Stand in for the WebGL Tower so we can assert the Scene -> Tower wiring
// (count and identity) without a renderer; the placement maths itself is
// covered by scene/towerLayout.test.ts.
vi.mock('./scene/Tower', () => ({
  TOWER_COLOR: '#39d3ff',
  Tower: ({ placement }: { placement: TowerPlacement }) => (
    <div data-testid="tower" data-name={placement.name} />
  ),
}))

const tower = (name: string, col: number, row: number): Tower => ({ name, grid: { col, row } })

const sceneState = (viewMode: SceneState['viewMode'], towers: Tower[] = []): SceneState => ({
  viewMode,
  towers,
  panels: [],
})

describe('Scene', () => {
  it('renders an R3F canvas', () => {
    render(<Scene sceneState={null} />)

    expect(screen.getByTestId('canvas')).toBeInTheDocument()
  })

  it('shows a waiting placeholder before any snapshot has arrived', () => {
    render(<Scene sceneState={null} />)

    expect(screen.getByText(/waiting for connection/i)).toBeInTheDocument()
  })

  it('does not show the View Mode indicator before a snapshot arrives', () => {
    render(<Scene sceneState={null} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders no Towers before a snapshot arrives', () => {
    render(<Scene sceneState={null} />)

    expect(screen.queryAllByTestId('tower')).toHaveLength(0)
  })

  it('shows the Node-mode indicator when the snapshot is Node view', () => {
    render(<Scene sceneState={sceneState(ViewModeNode)} />)

    const indicator = screen.getByRole('status')
    expect(indicator).toHaveTextContent('Node view')
    expect(indicator).toHaveAttribute('data-view-mode', 'node')
  })

  it('shows the Namespace/Project-mode indicator when the snapshot is Namespace view', () => {
    render(<Scene sceneState={sceneState(ViewModeNamespace)} />)

    const indicator = screen.getByRole('status')
    expect(indicator).toHaveTextContent('Namespace / Project view')
    expect(indicator).toHaveAttribute('data-view-mode', 'namespace')
  })

  it('renders one Tower per Tower in the snapshot, by name', () => {
    const towers = [tower('alpha', 0, 0), tower('bravo', 1, 0), tower('charlie', 0, 1)]

    render(<Scene sceneState={sceneState(ViewModeNode, towers)} />)

    const rendered = screen.getAllByTestId('tower')
    expect(rendered).toHaveLength(3)
    expect(rendered.map((el) => el.getAttribute('data-name'))).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ])
  })

  it('renders no Towers for an empty scene, but still shows the indicator', () => {
    render(<Scene sceneState={sceneState(ViewModeNode, [])} />)

    expect(screen.queryAllByTestId('tower')).toHaveLength(0)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
