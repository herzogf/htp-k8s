import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type SceneState, ViewModeNamespace, ViewModeNode } from './generated/scenestate'
import { Scene } from './Scene'

// jsdom has no WebGL context, so the real @react-three/fiber Canvas can't
// mount here. Full 3D rendering correctness is covered by the Playwright
// e2e suite (frontend-tester) against a real browser instead; this test
// only verifies the scene wires a Canvas up and displays the right View Mode
// indicator, via a lightweight stand-in for the R3F/drei primitives.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <div data-testid="canvas">{children}</div>,
}))

vi.mock('@react-three/drei', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

const sceneState = (viewMode: SceneState['viewMode']): SceneState => ({ viewMode })

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
})
