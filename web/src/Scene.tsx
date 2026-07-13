import { Canvas } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { useCallback, useMemo, useState } from 'react'
import { type SceneState } from './generated/scenestate'
import { viewModeLabel } from './scene/sceneState'
import { towerPlacements } from './scene/towerLayout'
import { Tower, TOWER_COLOR } from './scene/Tower'
import { Panels } from './scene/Panels'
import { FreeFlyControls } from './scene/FreeFlyControls'
import { createFocusController } from './scene/focus'
import { FocusContext } from './scene/focusContext'
import { DetailLayer } from './detail/DetailLayer'
import { type Selection } from './detail/selection'
import { SelectionContext, type SelectionApi } from './detail/selectionContext'

const WAITING_TEXT = 'Waiting for connection…'

export interface SceneProps {
  /** Latest scene snapshot received over the WebSocket, or `null` before one arrives. */
  sceneState: SceneState | null
}

/**
 * The 3D scene. Until a snapshot arrives it shows an in-world waiting message;
 * once the backend's `SceneState` snapshot is received it renders the Towers at
 * their grid positions in the cinematic *Hackers* data-center look (glowing,
 * semi-transparent prisms on a dark circuit-board floor), and keeps the View
 * Mode indicator from #11 as a HUD badge over the canvas.
 *
 * Towers are placed by {@link towerPlacements} (unit-tested independently of
 * WebGL) and drawn by {@link Tower}; each Tower's Pods are rendered as glowing
 * Panels by {@link Panels} (a single InstancedMesh over the whole scene). Floor
 * Lanes are a later ticket built on top of this seam.
 */
export function Scene({ sceneState }: SceneProps) {
  const label = sceneState ? viewModeLabel(sceneState.viewMode) : WAITING_TEXT
  const placements = sceneState ? towerPlacements(sceneState.towers) : []
  // One Focus hand-off shared for the scene's lifetime (#21): Tower/Panel clicks
  // push a target pose into it and FreeFlyControls pulls that pose to fly to.
  const focusController = useMemo(() => createFocusController(), [])

  // The open Detail Popup (#24): a Tower/Panel click sets the selection (beside
  // flying the camera to it), which the in-world DetailLayer renders a popup for.
  const [selection, setSelection] = useState<Selection | null>(null)
  const select = useCallback((next: Selection) => setSelection(next), [])
  const clear = useCallback(() => setSelection(null), [])
  const selectionApi = useMemo<SelectionApi>(
    () => ({ selection, select, clear }),
    [selection, select, clear],
  )

  return (
    <div className="scene-root">
      <Canvas
        camera={{ position: [10, 9, 15], fov: 50 }}
        // A click that hits no Tower/Panel (empty space) closes the Detail Popup —
        // one of its three read-only dismiss affordances (with the close button
        // and Escape). R3F fires onPointerMissed only when a click hit nothing.
        onPointerMissed={clear}
      >
        {/* Both Providers live inside <Canvas> so the shared FocusController and
            the Detail Popup selection reach the 3D children: the clickable
            Towers/Panels, the camera rig that consumes their clicks, and the
            in-world DetailLayer that renders the popup — all in R3F's own tree. */}
        <FocusContext.Provider value={focusController}>
          <SelectionContext.Provider value={selectionApi}>
            {/* Manual free-fly navigation (#20): WASD + pointer-lock mouse-look. It
              stays dormant on load — seeding its aim from the camera's initial
              orientation — so the default framed skyline is unchanged until the
              user flies. A click-to-Focus fly-to (#21) coexists in the same rig.
              Automated Demo Mode flight is a separate later ticket. */}
            <FreeFlyControls />
            <color attach="background" args={['#05050a']} />
            {/* Dim ambient plus a key light: enough to read the prisms' faces while
              keeping the dark, high-contrast data-center mood. The Towers are
              emissive, so most of their glow is self-lit rather than from these. */}
            <ambientLight intensity={0.35} />
            <directionalLight position={[8, 16, 10]} intensity={0.5} />
            {/* The scene floor: a faint cyan grid on near-black, echoing the film's
              circuit-board plane. Real Floor Lanes are a later, decorative ticket. */}
            <gridHelper args={[120, 60, TOWER_COLOR, '#0d2630']} />
            {sceneState ? (
              <>
                {placements.map((placement) => (
                  <Tower key={placement.name} placement={placement} />
                ))}
                {/* Every Pod as a glowing Panel, drawn as one InstancedMesh over all
                  Towers (the scale decision — see {@link Panels}). */}
                <Panels towers={sceneState.towers} />
                {/* The in-world Detail Popup for the clicked Tower/Panel (#24). */}
                <DetailLayer />
              </>
            ) : (
              <Text
                color="white"
                fontSize={0.4}
                maxWidth={6}
                textAlign="center"
                anchorX="center"
                anchorY="middle"
              >
                {WAITING_TEXT}
              </Text>
            )}
          </SelectionContext.Provider>
        </FocusContext.Provider>
      </Canvas>
      {sceneState && (
        <div className="view-mode-indicator" data-view-mode={sceneState.viewMode} role="status">
          <span className="view-mode-indicator__caption">View Mode</span>
          <span className="view-mode-indicator__label">{label}</span>
        </div>
      )}
    </div>
  )
}
