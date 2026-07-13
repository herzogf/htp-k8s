import { Html } from '@react-three/drei'
import { useEffect } from 'react'
import { PodDetailPopup } from './PodDetailPopup'
import { useSelection } from './selectionContext'
import { TowerDetailPopup } from './TowerDetailPopup'

/**
 * DetailLayer renders the open Detail Popup in-world: it reads the current
 * {@link useSelection | selection} and mounts the matching popup inside a drei
 * `Html`, anchored at the clicked element's world-space point so the popup is
 * pinned beside the Tower/Panel in 3D space (CONTEXT.md's "in-world, not fixed
 * screen-space") rather than floating in a screen overlay. It lives inside the
 * R3F `<Canvas>`; when nothing is selected it renders nothing.
 *
 * `Html` renders real, queryable DOM (unlike the WebGL canvas), which is what
 * lets the Playwright e2e assert on the popup's content after a click. Closing
 * is offered three ways (the popup's close button, a click on empty space wired
 * to `clear` in {@link Scene}, and the Escape key handled here) — all read-only
 * (ADR-0003); none mutate the cluster.
 */
export function DetailLayer() {
  const { selection, clear } = useSelection()

  // Escape closes the open popup — the keyboard affordance alongside the close
  // button and click-empty-space. Only bound while a popup is open.
  useEffect(() => {
    if (!selection) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clear()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selection, clear])

  if (!selection) {
    return null
  }

  // Key by the selected identity so switching Tower/Panel remounts the popup
  // (and its fetch/SSE hooks) from a clean initial state, rather than mutating a
  // live one — which is why the hooks need no in-effect reset.
  const key =
    selection.kind === 'tower'
      ? `tower:${selection.name}`
      : `pod:${selection.namespace}/${selection.pod}`

  return (
    <Html
      key={key}
      position={selection.anchor}
      // Fixed screen-size card pinned to the 3D point (no distanceFactor), so the
      // detail text stays legible whatever the camera distance. Offset up/right
      // via the wrapper so the card sits beside the element, not over it.
      wrapperClass="detail-anchor"
      zIndexRange={[100, 0]}
      // Keep the card interactive (its close button) without the canvas behind it
      // hijacking clicks meant for the card.
      pointerEvents="auto"
    >
      {selection.kind === 'tower' ? (
        <TowerDetailPopup name={selection.name} onClose={clear} />
      ) : (
        <PodDetailPopup namespace={selection.namespace} pod={selection.pod} onClose={clear} />
      )}
    </Html>
  )
}
