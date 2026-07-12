import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Scene } from './Scene'

// jsdom has no WebGL context, so the real @react-three/fiber Canvas can't
// mount here. Full 3D rendering correctness is covered by the Playwright
// e2e suite (frontend-tester) against a real browser instead; this test
// only verifies the placeholder scene wires a Canvas up and displays the
// right text, via a lightweight stand-in for the R3F/drei primitives.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <div data-testid="canvas">{children}</div>,
}))

vi.mock('@react-three/drei', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

describe('Scene', () => {
  it('renders an R3F canvas', () => {
    render(<Scene message={null} />)

    expect(screen.getByTestId('canvas')).toBeInTheDocument()
  })

  it('shows a waiting placeholder before any message has arrived', () => {
    render(<Scene message={null} />)

    expect(screen.getByText(/waiting for connection/i)).toBeInTheDocument()
  })

  it('displays the raw content of the last received message', () => {
    render(<Scene message="hello from the cluster" />)

    expect(screen.getByText('hello from the cluster')).toBeInTheDocument()
  })
})
