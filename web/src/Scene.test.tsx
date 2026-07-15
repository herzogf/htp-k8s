import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_CONFIG } from './appConfig'
import { type Tower, type ViewMode, ViewModeNamespace, ViewModeNode } from './generated/scenestate'
import { useAppConfig } from './hooks/useAppConfig'
import { Scene } from './Scene'
import { type TowerPlacement } from './scene/towerLayout'
import { makeSceneState, makeTower } from './test-support/sceneFixtures'

// Scene fetches the backend's startup config once at bootstrap (#91) through
// this hook; stand it in so no test here makes a real network call, defaulting
// to Demo Mode off/an arbitrary seed (mirroring the hook's own pre-fetch
// default) unless a test overrides it via `vi.mocked(useAppConfig)`.
vi.mock('./hooks/useAppConfig', () => ({ useAppConfig: vi.fn() }))

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

// FreeFlyControls (#20) drives the live camera via useThree/useFrame, which have
// no WebGL context under jsdom. Its movement/look maths is unit-tested in
// scene/freeFly.test.ts, Demo Mode's Canyon-tour/hand-off maths in
// scene/demoMode.test.ts, and the rig's wiring by the Playwright interaction/
// demo e2e tests, so here it's a stand-in that just surfaces the props Scene
// passes it (as data attributes), so this file can assert the HUD toggle
// (#22) and the Canyon tour's placements/seed (#91) actually reach the rig
// without a renderer.
vi.mock('./scene/FreeFlyControls', () => ({
  FreeFlyControls: ({
    demoActive,
    placements,
    demoSeed,
  }: {
    demoActive?: boolean
    placements?: readonly TowerPlacement[]
    demoSeed?: number
  }) => (
    <div
      data-testid="free-fly-controls"
      data-demo-active={demoActive ?? false}
      data-placements-count={placements?.length ?? 0}
      data-demo-seed={demoSeed ?? ''}
    />
  ),
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

// The Panels InstancedMesh is WebGL (it writes instance matrix/color buffers on
// a real three.js mesh), so stand it in here and just assert Scene wires the
// snapshot's Towers through to it; the instancing itself is covered by
// scene/panelLayout.test.ts and the Playwright e2e screenshot.
vi.mock('./scene/Panels', () => ({
  Panels: ({ towers }: { towers: Tower[] }) => (
    <div data-testid="panels" data-tower-count={towers.length} />
  ),
}))

// FloorLanes (#28) is likewise WebGL (two InstancedMeshes it drives via
// useFrame), so stand it in here and just assert Scene wires the snapshot's
// Towers through to it; the lane routing/pulse maths are covered by
// scene/laneLayout.test.ts and scene/laneActivity.test.ts, and the rendered
// result by the Playwright e2e screenshot/video.
vi.mock('./scene/FloorLanes', () => ({
  FloorLanes: ({ towers }: { towers: Tower[] }) => (
    <div data-testid="floor-lanes" data-tower-count={towers.length} />
  ),
}))

// DetailLayer (#24) renders the Detail Popup through drei's `Html`, which needs
// R3F/WebGL context absent under jsdom. Its selection→popup wiring is unit-tested
// in detail/ and end-to-end by the Playwright popup test; here it's a no-op
// stand-in so Scene only mounts it inside the Canvas.
vi.mock('./detail/DetailLayer', () => ({
  DetailLayer: () => <div data-testid="detail-layer" />,
}))

const tower = (name: string, col: number, row: number): Tower =>
  makeTower({ name, grid: { col, row } })

const sceneState = (viewMode: ViewMode, towers: Tower[] = []) =>
  makeSceneState({ viewMode, towers })

describe('Scene', () => {
  beforeEach(() => {
    vi.mocked(useAppConfig).mockReturnValue(DEFAULT_APP_CONFIG)
  })

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

  it("renders the instanced Panels, handing them the snapshot's Towers", () => {
    const towers = [tower('alpha', 0, 0), tower('bravo', 1, 0)]

    render(<Scene sceneState={sceneState(ViewModeNode, towers)} />)

    const panels = screen.getByTestId('panels')
    expect(panels).toHaveAttribute('data-tower-count', '2')
  })

  it("renders FloorLanes, handing them the snapshot's Towers", () => {
    const towers = [tower('alpha', 0, 0), tower('bravo', 1, 0)]

    render(<Scene sceneState={sceneState(ViewModeNode, towers)} />)

    const floorLanes = screen.getByTestId('floor-lanes')
    expect(floorLanes).toHaveAttribute('data-tower-count', '2')
  })

  it('renders no FloorLanes before a snapshot arrives', () => {
    render(<Scene sceneState={null} />)

    expect(screen.queryByTestId('floor-lanes')).not.toBeInTheDocument()
  })

  it('renders no Towers for an empty scene, but still shows the indicator', () => {
    render(<Scene sceneState={sceneState(ViewModeNode, [])} />)

    expect(screen.queryAllByTestId('tower')).toHaveLength(0)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  // Demo Mode's HUD toggle (#22): the flight/hand-off maths itself is
  // unit-tested in scene/demoMode.test.ts and proven live by the Playwright
  // demo e2e; this just proves the toggle exists, is off by default, flips on
  // click, and that its state actually reaches FreeFlyControls (the rig that
  // drives the camera) rather than only updating its own label.
  describe('Demo Mode toggle', () => {
    it('is available even before any snapshot has arrived, starting off', () => {
      render(<Scene sceneState={null} />)

      const toggle = screen.getByRole('button', { name: /demo mode/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect(toggle).toHaveTextContent(/off/i)
      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-demo-active', 'false')
    })

    it('switches on when clicked, handing demoActive through to FreeFlyControls', () => {
      render(<Scene sceneState={sceneState(ViewModeNode)} />)

      fireEvent.click(screen.getByRole('button', { name: /demo mode/i }))

      const toggle = screen.getByRole('button', { name: /demo mode/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(toggle).toHaveTextContent(/on/i)
      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-demo-active', 'true')
    })

    it('switches back off on a second click', () => {
      render(<Scene sceneState={sceneState(ViewModeNode)} />)

      const toggle = screen.getByRole('button', { name: /demo mode/i })
      fireEvent.click(toggle)
      fireEvent.click(toggle)

      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-demo-active', 'false')
    })

    it("seeds demoActive from the backend's demoAutostart config on bootstrap (#91)", () => {
      vi.mocked(useAppConfig).mockReturnValue({ demoSeed: 1, demoAutostart: true })

      render(<Scene sceneState={sceneState(ViewModeNode)} />)

      const toggle = screen.getByRole('button', { name: /demo mode/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-demo-active', 'true')
    })

    it('does not autostart when the backend config leaves demoAutostart off', () => {
      vi.mocked(useAppConfig).mockReturnValue({ demoSeed: 1, demoAutostart: false })

      render(<Scene sceneState={sceneState(ViewModeNode)} />)

      expect(screen.getByRole('button', { name: /demo mode/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
    })
  })

  // The Canyon tour (#91) is built from the scene's actual Tower placements
  // and the backend-resolved seed; this proves Scene threads both through to
  // FreeFlyControls rather than the rig inventing its own.
  describe('Canyon tour wiring (#91)', () => {
    it("hands FreeFlyControls the scene's Tower placements", () => {
      const towers = [tower('alpha', 0, 0), tower('bravo', 1, 0), tower('charlie', 0, 1)]

      render(<Scene sceneState={sceneState(ViewModeNode, towers)} />)

      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-placements-count', '3')
    })

    it('hands FreeFlyControls no placements before any snapshot has arrived', () => {
      render(<Scene sceneState={null} />)

      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-placements-count', '0')
    })

    it('hands FreeFlyControls the backend-resolved demo seed from GET /api/config', () => {
      vi.mocked(useAppConfig).mockReturnValue({ demoSeed: 12345, demoAutostart: false })

      render(<Scene sceneState={null} />)

      expect(screen.getByTestId('free-fly-controls')).toHaveAttribute('data-demo-seed', '12345')
    })
  })
})
