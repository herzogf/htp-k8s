import { Edges } from '@react-three/drei'
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
 * additively-ish instead of z-fighting into opaque slabs. Panels on the Tower
 * faces (the pods) are a later ticket (#15) — this renders only the structure.
 */
export function Tower({ placement }: { placement: TowerPlacement }) {
  return (
    <mesh position={placement.position}>
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
