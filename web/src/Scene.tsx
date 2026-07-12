import { Canvas } from '@react-three/fiber'
import { Text } from '@react-three/drei'

const WAITING_TEXT = 'Waiting for connection…'

export interface SceneProps {
  /** Raw text of the last message received over the scene's WebSocket, or `null` before one arrives. */
  message: string | null
}

/**
 * Placeholder scene (issue #3): just an empty canvas that renders whatever
 * text the WebSocket connection last delivered. Towers, Panels, and Floor
 * Lanes are built in later tickets on top of this seam.
 */
export function Scene({ message }: SceneProps) {
  return (
    <Canvas camera={{ position: [0, 0, 5] }}>
      <Text
        color="white"
        fontSize={0.4}
        maxWidth={6}
        textAlign="center"
        anchorX="center"
        anchorY="middle"
      >
        {message ?? WAITING_TEXT}
      </Text>
    </Canvas>
  )
}
