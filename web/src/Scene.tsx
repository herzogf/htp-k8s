import { Canvas } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { type SceneState } from './generated/scenestate'
import { viewModeLabel } from './scene/sceneState'

const WAITING_TEXT = 'Waiting for connection…'

export interface SceneProps {
  /** Latest scene snapshot received over the WebSocket, or `null` before one arrives. */
  sceneState: SceneState | null
}

/**
 * The 3D scene. Until a snapshot arrives it shows a waiting message; once the
 * backend's `SceneState` snapshot is received it renders the detected View
 * Mode as an on-screen indicator — both as in-world text in the canvas and a
 * HUD badge over it. Towers, Panels, and Floor Lanes are built in later
 * tickets on top of this seam (no towers yet, per issue #11).
 */
export function Scene({ sceneState }: SceneProps) {
  const label = sceneState ? viewModeLabel(sceneState.viewMode) : WAITING_TEXT

  return (
    <div className="scene-root">
      <Canvas camera={{ position: [0, 0, 5] }}>
        <Text
          color="white"
          fontSize={0.4}
          maxWidth={6}
          textAlign="center"
          anchorX="center"
          anchorY="middle"
        >
          {label}
        </Text>
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
