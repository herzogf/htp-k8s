import { useEffect, useState } from 'react'
import { type SceneState } from '../generated/scenestate'
import { parseSceneState } from '../scene/sceneState'

/**
 * Opens a WebSocket connection to `url` and returns the most recent
 * {@link SceneState} snapshot received over it (or `null` before a valid
 * snapshot arrives).
 *
 * The backend sends a full `SceneState` JSON snapshot on connect, followed by
 * incremental Scene Deltas in a later ticket (ADR-0007). Text frames are
 * parsed with {@link parseSceneState}; non-text payloads (Blob/ArrayBuffer)
 * and frames that don't parse as a well-formed snapshot are ignored, leaving
 * the last good state in place.
 *
 * The socket is reopened whenever `url` changes, and closed on unmount.
 */
export function useSceneState(url: string): SceneState | null {
  const [sceneState, setSceneState] = useState<SceneState | null>(null)

  useEffect(() => {
    const socket = new WebSocket(url)

    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        return
      }
      const parsed = parseSceneState(event.data)
      if (parsed !== null) {
        setSceneState(parsed)
      }
    }

    socket.addEventListener('message', handleMessage)

    return () => {
      socket.removeEventListener('message', handleMessage)
      socket.close()
    }
  }, [url])

  return sceneState
}
