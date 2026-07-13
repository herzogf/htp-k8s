import { Edges } from '@react-three/drei'
import { type ThreeEvent } from '@react-three/fiber'
import { useSelection } from '../detail/selectionContext'
import { towerFocusPose } from './focus'
import { useFocus } from './focusContext'
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
 * Clicking a Tower does two things (#21, #24): it hands the {@link towerFocusPose}
 * for this Tower's placement to the shared {@link FocusController} — the camera
 * rig picks it up and smoothly flies to it — and it selects this Tower, opening
 * its in-world Detail Popup anchored beside the prism. The click is stopped from
 * propagating so a ray that also grazes a farther Tower acts only on the one
 * actually clicked.
 */
export function Tower({ placement }: { placement: TowerPlacement }) {
  const focus = useFocus()
  const { select } = useSelection()

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    focus?.requestFocus(towerFocusPose(placement.position))
    select({ kind: 'tower', name: placement.name, anchor: placement.position })
  }

  return (
    <mesh position={placement.position} onClick={onClick}>
      <boxGeometry args={[TOWER_FOOTPRINT, TOWER_HEIGHT, TOWER_FOOTPRINT]} />
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
