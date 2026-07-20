import { Edges } from '@react-three/drei'
import { type ThreeEvent } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { type BoxGeometry, type Mesh } from 'three'
import { towerSelection } from '../detail/selection'
import { useSelection } from '../detail/selectionContext'
import { towerFocusPose } from './focus'
import { useFocus } from './focusContext'
import { clearTowerRenderedHeight, setTowerRenderedHeight } from './towerRenderedHeightRegistry'
import { TOWER_FOOTPRINT, TOWER_HEIGHT, type TowerPlacement } from './towerLayout'

/**
 * TOWER_COLOR is the cyan/blue emissive tint of a Tower, evoking the glowing
 * translucent data-center prisms of the 1995 film *Hackers* (see CONTEXT.md and
 * the reference stills). Used for both the volume glow and the bright edge lines.
 */
export const TOWER_COLOR = '#39d3ff'

/**
 * Tower renders one Tower structure: a tall, semi-transparent, self-lit prism
 * with bright glowing edges, placed at its resolved world position (see
 * {@link towerPlacements}).
 *
 * This is a deliberate first pass at the reference look rather than a finished
 * shader: an emissive, low-opacity `meshStandardMaterial` gives the translucent
 * inner glow and `drei`'s `<Edges>` traces the crisp neon outline that reads as
 * a cyberpunk hologram. Depth writes are disabled so overlapping Towers blend
 * additively-ish instead of z-fighting into opaque slabs. This renders only the
 * structure; the Pods on its faces are drawn separately as instanced Panels
 * (see {@link Panels}).
 *
 * `height` (#59) defaults to the resting {@link TOWER_HEIGHT} but the scene
 * passes every Tower the same scene-wide {@link sceneTowerHeight} (panelLayout.ts)
 * so the whole skyline renders at one uniform height once any Tower's Pods
 * need more than the four faces hold at the resting height — a Tower with
 * fewer Pods simply has unfilled faces rather than a shorter prism. Since
 * `placement.position`'s own Y is already `height / 2` (see
 * {@link towerPlacements}'s `height` param), the box geometry here must be
 * built from that same `height` or the prism and its Panels would part ways.
 *
 * Clicking a Tower does two things (#21, #24): it hands the {@link towerFocusPose}
 * for this Tower's placement to the shared {@link FocusController} — the camera
 * rig picks it up and smoothly flies to it — and it selects this Tower, opening
 * its in-world Detail Popup anchored beside the prism. The click is stopped from
 * propagating so a ray that also grazes a farther Tower acts only on the one
 * actually clicked.
 *
 * Every mount/update also publishes this Tower's own, actually-rendered prism
 * height (read back off its `<boxGeometry>`, not the `height` prop in
 * isolation) into {@link setTowerRenderedHeight} — see that module's doc
 * comment for why the nightly #29 busy-vs-sparse "identical height" e2e guard
 * needs this rather than a second call to `sceneTowerHeight`.
 */
export function Tower({
  placement,
  height = TOWER_HEIGHT,
}: {
  placement: TowerPlacement
  height?: number
}) {
  const focus = useFocus()
  const { select } = useSelection()
  const meshRef = useRef<Mesh>(null)

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    focus?.requestFocus(towerFocusPose(placement.position))
    select(towerSelection(placement))
  }

  useEffect(() => {
    const geometry = meshRef.current?.geometry as BoxGeometry | undefined
    const renderedHeight = geometry?.parameters.height
    if (renderedHeight !== undefined) {
      setTowerRenderedHeight(placement.name, renderedHeight)
    }
    return () => clearTowerRenderedHeight(placement.name)
    // `height` is read only to re-run this effect after R3F rebuilds the
    // <boxGeometry> for a new `args` — the value itself comes back off the
    // geometry, not this prop, so a stale/misrouted prop can't fake a pass.
  }, [placement.name, height])

  return (
    <mesh ref={meshRef} position={placement.position} onClick={onClick}>
      <boxGeometry args={[TOWER_FOOTPRINT, height, TOWER_FOOTPRINT]} />
      <meshStandardMaterial
        color={TOWER_COLOR}
        emissive={TOWER_COLOR}
        emissiveIntensity={0.9}
        transparent
        opacity={0.22}
        depthWrite={false}
      />
      <Edges color={TOWER_COLOR} />
    </mesh>
  )
}
