import { useEffect, useState } from 'react'
import { type SceneState } from '../generated/scenestate'
import { blinkStore } from '../scene/blinks'
import { reduceScene } from '../scene/reduceScene'
import { parseSceneFrame } from '../scene/sceneState'

/**
 * Opens a WebSocket connection to `url` and returns the current reconciled
 * {@link SceneState} (or `null` before the first snapshot arrives).
 *
 * Per ADR-0007 the backend sends a full `SceneState` snapshot on connect, then a
 * stream of incremental Scene Deltas. Each text frame is routed by
 * {@link parseSceneFrame}: a snapshot establishes (or, on reconnect, replaces)
 * the state; a structural delta is applied to the current state with
 * {@link reduceScene}, so the scene live-updates (Towers/Panels appear,
 * disappear, recolor) without re-parsing raw messages in the rendering
 * components. A structural delta arriving before any snapshot has nothing to
 * reconcile against and is ignored until the snapshot arrives.
 *
 * The one exception is a `panelBlink` delta: a transient activity pulse that is
 * NOT scene state (ADR-0007). It bypasses {@link reduceScene} and `SceneState`
 * and is recorded on the out-of-band {@link blinkStore}, which the Panels
 * renderer reads to flash the affected Panel instance and settle it back —
 * fire-and-forget, never mutating the reconciled state.
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
      if (frame.delta.type === 'panelBlink') {
        // A blink is a transient "activity happened on this pod" pulse, not a
        // change to the scene (ADR-0007): it bypasses the reconciliation reducer
        // and `SceneState` entirely and drives the out-of-band visual blink
        // channel, which the Panels renderer reads to flash that one instance.
        // Fire-and-forget — recorded even before the first snapshot (harmless:
        // nothing renders it yet), never mutating state.
        blinkStore.trigger(
          frame.delta.namespace,
          frame.delta.pod,
          frame.delta.activity,
          performance.now(),
        )
        return
      }
      // A structural delta reconciles against the current snapshot; drop it if
      // none yet.
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
