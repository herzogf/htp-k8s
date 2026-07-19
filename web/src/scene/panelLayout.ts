import { type Tower } from '../generated/scenestate'
import { TOWER_FOOTPRINT, TOWER_HEIGHT, towerPlacements } from './towerLayout'

/**
 * PANELS_PER_ROW is how many Panels sit side by side across a Tower's face
 * before the next Pod wraps to a row above. Kept small so the row of Panels fits
 * comfortably inside the Tower footprint with dark gaps between them, matching
 * the reference stills.
 */
export const PANELS_PER_ROW = 3

/**
 * PANEL_SIZE is the world-space edge length of a (square) Panel quad — a small
 * glowing rectangle on the Tower face.
 */
export const PANEL_SIZE = 0.34

/**
 * PANEL_GAP is the world-space dark gap between adjacent Panels, both across a
 * row and between stacked rows, so individual Pods read as separate lights.
 */
const PANEL_GAP = 0.16

const PANEL_PITCH = PANEL_SIZE + PANEL_GAP

/**
 * PANEL_STANDOFF lifts a Panel just clear of the Tower's translucent face so it
 * renders proud of the surface rather than z-fighting with it.
 */
const PANEL_STANDOFF = 0.02

/** Drops the top row of Panels below the Tower's cap, leaving a header skirt. */
const PANEL_TOP_MARGIN = 0.4

/**
 * PANEL_FACES_PER_TOWER is the number of side faces of a Tower's (square-
 * footprint) prism that carry Panels: front (+Z), right (+X), back (-Z), left
 * (-X), walked in that order — the "fill all four sides of a tower first" half
 * of #59's design direction. {@link facePlacement} is what maps a face index
 * (`0..PANEL_FACES_PER_TOWER - 1`) to its world-space transform.
 */
export const PANEL_FACES_PER_TOWER = 4

/**
 * panelRowsPerFace is how many rows of Panels fit down one Tower face at a
 * given Tower `height`, top-down: the first row sits just below the cap (after
 * {@link PANEL_TOP_MARGIN}) and each following row steps {@link PANEL_PITCH}
 * lower, until the next row would put a Panel's bottom edge through the floor.
 * This is the per-face capacity #59's four-faces-before-growing-height rule is
 * built on: {@link sceneTowerHeight} multiplies it by {@link PANELS_PER_ROW} and
 * {@link PANEL_FACES_PER_TOWER} to get one Tower's total capacity at `height`,
 * and {@link panelInstances} calls it again (on the resolved scene height) to
 * know where a Panel's row wraps to the next face.
 */
export function panelRowsPerFace(height: number): number {
  return Math.max(1, Math.floor((height - PANEL_TOP_MARGIN - PANEL_SIZE) / PANEL_PITCH) + 1)
}

/**
 * The inverse of {@link panelRowsPerFace}: the smallest Tower `height` that lets
 * a face fit `rows` rows of Panels without the bottom row dropping through the
 * floor — the exact-fit height {@link sceneTowerHeight} grows a busy scene to.
 */
function heightForRows(rows: number): number {
  return PANEL_TOP_MARGIN + PANEL_SIZE + Math.max(0, rows - 1) * PANEL_PITCH
}

/**
 * sceneTowerHeight is the single, scene-wide Tower height #59 requires: driven
 * by the busiest Tower's pod count, and applied to every Tower in the scene (see
 * {@link towerPlacements}'s `height` param and `Tower.tsx`'s `height` prop) so
 * the skyline stays uniform — a Tower with fewer Pods simply has unfilled
 * faces, it is never rendered shorter than another.
 *
 * Stays at the resting {@link TOWER_HEIGHT} as long as the busiest Tower's Pods
 * fit across its four faces at that height (see {@link panelRowsPerFace}); once
 * that capacity is exceeded, this grows to the smallest height whose four-face
 * capacity fits the busiest Tower's Pod count exactly (#59's "fill all four
 * sides first, then grow height" order — growth is scene-wide and uniform, not
 * per-Tower, so no Tower is ever shorter than another).
 */
export function sceneTowerHeight(towers: readonly Tower[]): number {
  const maxPanels = towers.reduce((max, tower) => Math.max(max, tower.panels.length), 0)
  const baseCapacity = panelRowsPerFace(TOWER_HEIGHT) * PANELS_PER_ROW * PANEL_FACES_PER_TOWER
  if (maxPanels <= baseCapacity) {
    return TOWER_HEIGHT
  }
  const rowsNeeded = Math.ceil(maxPanels / (PANELS_PER_ROW * PANEL_FACES_PER_TOWER))
  return Math.max(TOWER_HEIGHT, heightForRows(rowsNeeded))
}

/**
 * FaceTransform is one Tower side face's contribution to a Panel's world-space
 * placement: the outward offset along the face's own width axis (`col`, still
 * to be combined with the Tower's centre) resolves to `dx`/`dz`, the face sits
 * {@link PANEL_STANDOFF} clear of the Tower's footprint edge, and `rotationY`
 * (radians about Y) turns the Panel quad — whose unrotated normal faces +Z — to
 * face outward from whichever side it's on.
 */
interface FaceTransform {
  dx: number
  dz: number
  rotationY: number
}

/**
 * Resolves one Panel's (`face`, `col`) position within its Tower face to a
 * {@link FaceTransform}, walking the four faces front (+Z) → right (+X) →
 * back (-Z) → left (-X) — see {@link PANEL_FACES_PER_TOWER}. `col` is centred
 * the same way {@link panelInstances} centred a row on the front face pre-#59,
 * so a Tower with few enough Pods to stay on face 0 renders identically to
 * before.
 */
function facePlacement(face: number, col: number): FaceTransform {
  const offset = (col - (PANELS_PER_ROW - 1) / 2) * PANEL_PITCH
  const edge = TOWER_FOOTPRINT / 2 + PANEL_STANDOFF
  switch (face % PANEL_FACES_PER_TOWER) {
    case 0: // front (+Z)
      return { dx: offset, dz: edge, rotationY: 0 }
    case 1: // right (+X)
      return { dx: edge, dz: -offset, rotationY: Math.PI / 2 }
    case 2: // back (-Z)
      return { dx: -offset, dz: -edge, rotationY: Math.PI }
    default: // left (-X)
      return { dx: -edge, dz: offset, rotationY: -Math.PI / 2 }
  }
}

/**
 * PanelInstance is one Pod resolved to a concrete glowing rectangle in the 3D
 * scene: its world-space centre and color, plus the identity needed to resolve
 * it back to its originating Pod. It is the pure, WebGL-free output of
 * {@link panelInstances} — the seam a unit test asserts on without a renderer,
 * and the per-instance data an `InstancedMesh` writes into its matrix/color
 * buffers in list order.
 */
export interface PanelInstance {
  /** Name of the Tower this Panel sits on (the Node or Namespace/Project). */
  tower: string
  /** The Pod's Namespace/Project — part of its cluster-unique identity. */
  namespace: string
  /** The Pod's name. */
  pod: string
  /** Hex color for the Pod's phase, taken straight from `Panel.color`. */
  color: string
  /** World-space centre of the Panel quad: [x, y, z]. */
  position: [number, number, number]
  /**
   * Rotation about Y (radians) that turns the Panel quad — whose unrotated
   * geometry faces +Z — to face outward from whichever of the Tower's four
   * faces (#59) it's on: `0` on the front (+Z) face, non-zero on the right/
   * back/left faces. `0` for every Panel pre-#59 (single-face layout), so this
   * is a no-op rotation for any scene that never wraps past the front face.
   */
  rotationY: number
}

/**
 * Flattens the nested Panels of a `SceneState`'s Towers into a single ordered
 * list of {@link PanelInstance}s — one per Pod across the whole scene — ready to
 * drive one `InstancedMesh` over all Panels (the scale decision: a single draw
 * call, not one mesh per Tower).
 *
 * Each Tower's Panels are laid out in a grid {@link PANELS_PER_ROW} wide,
 * filled top-down (the first Pod at the top of a face, later rows stepping
 * toward the floor — carried over from #15) — but #59 replaces the single
 * front-face grid with one that **fills all four of the Tower's side faces
 * before it needs to grow**: a Tower's Pods fill the front (+Z) face top-down
 * first, then wrap to the right (+X), back (-Z), and left (-X) faces in turn
 * (see {@link facePlacement}), each starting its own new grid at the top. Only
 * once a Tower's Pod count would overflow all four faces at the scene's
 * current height does the scene need to grow taller — and when it does, EVERY
 * Tower in the scene (not just the busy one) is drawn at that same taller
 * {@link sceneTowerHeight}, so the skyline stays a uniform height and a quieter
 * Tower simply has unfilled faces rather than being shorter. Positions are
 * resolved at the Tower's own world placement (see {@link towerPlacements}).
 * The output order is tower order then Panel order, so an instance index is a
 * stable handle back onto its (Tower, Pod) — {@link resolvePanel} reverses
 * it — which is what makes later click-picking (#20) instance-aware.
 */
export function panelInstances(towers: readonly Tower[]): PanelInstance[] {
  const placements = towerPlacements(towers)
  const height = sceneTowerHeight(towers)
  const rowsPerFace = panelRowsPerFace(height)
  const faceCapacity = rowsPerFace * PANELS_PER_ROW

  return towers.flatMap((tower, towerIndex) => {
    const [towerX, , towerZ] = placements[towerIndex].position

    return tower.panels.map((panel, panelIndex) => {
      // Fill all four faces before wrapping back around (defensive: a single
      // Tower's own Pod count never exceeds the scene-wide capacity
      // sceneTowerHeight sized `height` to, since it was sized to the busiest
      // Tower — but modulo keeps this total rather than silently truncating if
      // that invariant is ever violated).
      const face = Math.floor(panelIndex / faceCapacity) % PANEL_FACES_PER_TOWER
      const indexInFace = panelIndex % faceCapacity
      const col = indexInFace % PANELS_PER_ROW
      const row = Math.floor(indexInFace / PANELS_PER_ROW)
      // Fill top-down within the face: the first Pod's row sits just below the
      // Tower's cap and each subsequent row steps downward toward the floor.
      const y = height - PANEL_TOP_MARGIN - PANEL_SIZE / 2 - row * PANEL_PITCH
      const { dx, dz, rotationY } = facePlacement(face, col)

      return {
        tower: tower.name,
        namespace: panel.namespace,
        pod: panel.pod,
        color: panel.color,
        position: [towerX + dx, y, towerZ + dz] as [number, number, number],
        rotationY,
      }
    })
  })
}

/**
 * Resolves an `InstancedMesh` instance index back to the {@link PanelInstance}
 * it was built from — the originating Pod — or `undefined` if the index is out
 * of range. This is the instance-aware picking primitive: a click handler reads
 * the hit `instanceId` and looks up which Pod it is (click interaction itself is
 * a later ticket, #20).
 */
export function resolvePanel(
  instances: readonly PanelInstance[],
  instanceId: number,
): PanelInstance | undefined {
  return instances[instanceId]
}

/**
 * The reverse of {@link resolvePanel}: finds the instance index for a Pod's
 * cluster-unique `(namespace, pod)` identity, or `undefined` if no instance in
 * the scene is that Pod. Where {@link resolvePanel} answers "which Pod is this
 * instance?" (picking a click), this answers "which instance is this Pod?" — the
 * pod→instance direction anything keyed by Pod identity needs to address one
 * specific instance in the flattened list the InstancedMesh draws. The blink
 * animation itself doesn't need it (it sweeps every instance against the blink
 * store per frame); it's the lookup the #19 e2e hook uses to read one target
 * Panel's rendered color back out of the mesh.
 */
export function panelInstanceIndex(
  instances: readonly PanelInstance[],
  namespace: string,
  pod: string,
): number | undefined {
  const index = instances.findIndex((p) => p.namespace === namespace && p.pod === pod)
  return index === -1 ? undefined : index
}
