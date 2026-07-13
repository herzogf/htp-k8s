import { useEffect, useState } from 'react'
import { type SceneState } from '../generated/scenestate'
import { reduceScene } from '../scene/reduceScene'
import { parseSceneFrame } from '../scene/sceneState'

/**
 * Opens a WebSocket connection to `url` and returns the current reconciled
 * {@link SceneState} (or `null` before the first snapshot arrives).
 *
 * Per ADR-0007 the backend sends a full `SceneState` snapshot on connect, then a
 * stream of incremental Scene Deltas. Each text frame is routed by
 * {@link parseSceneFrame}: a snapshot establishes (or, on reconnect, replaces)
 * the state; a delta is applied to the current state with {@link reduceScene},
 * so the scene live-updates (Towers/Panels appear, disappear, recolor) without
 * re-parsing raw messages in the rendering components. A delta arriving before
 * any snapshot has nothing to reconcile against and is ignored until the
 * snapshot arrives.
 *
 * Non-text payloads (Blob/ArrayBuffer) and frames that route to nothing (bad
 * JSON, an unknown delta kind, a snapshot without `viewMode`) are ignored,
 * leaving the last good state in place. The socket is reopened whenever `url`
 * changes, and closed on unmount.
 */
export function useSceneState(url: string): SceneState | null {
  const [sceneState, setSceneState] = useState<SceneState | null>(null)

  useEffect(() => {
    const socket = new WebSocket(url)

    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        return
      }
      const frame = parseSceneFrame(event.data)
      if (frame === null) {
        return
      }
      if (frame.kind === 'snapshot') {
        setSceneState(frame.snapshot)
        return
      }
      // A delta reconciles against the current snapshot; drop it if none yet.
      setSceneState((prev) => (prev === null ? null : reduceScene(prev, frame.delta)))
    }

    socket.addEventListener('message', handleMessage)

    return () => {
      socket.removeEventListener('message', handleMessage)
      socket.close()
    }
  }, [url])

  return sceneState
}
