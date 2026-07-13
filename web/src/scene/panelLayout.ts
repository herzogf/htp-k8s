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
}

/**
 * Flattens the nested Panels of a `SceneState`'s Towers into a single ordered
 * list of {@link PanelInstance}s — one per Pod across the whole scene — ready to
 * drive one `InstancedMesh` over all Panels (the scale decision: a single draw
 * call, not one mesh per Tower).
 *
 * Each Tower's Panels are laid out on its front (+Z, camera-facing) face in a
 * grid {@link PANELS_PER_ROW} wide, centred on the Tower and filled top-down
 * (the first Pod at the top of the face, later rows stepping toward the floor),
 * at the Tower's own world placement (see {@link towerPlacements}). The output
 * order is tower order then Panel order, so an instance index is a stable handle
 * back onto its (Tower, Pod) — {@link resolvePanel} reverses it — which is what
 * makes later click-picking (#20) instance-aware.
 */
export function panelInstances(towers: readonly Tower[]): PanelInstance[] {
  const placements = towerPlacements(towers)

  return towers.flatMap((tower, towerIndex) => {
    const [towerX, , towerZ] = placements[towerIndex].position
    const faceZ = towerZ + TOWER_FOOTPRINT / 2 + PANEL_STANDOFF

    return tower.panels.map((panel, panelIndex) => {
      const col = panelIndex % PANELS_PER_ROW
      const row = Math.floor(panelIndex / PANELS_PER_ROW)
      const x = towerX + (col - (PANELS_PER_ROW - 1) / 2) * PANEL_PITCH
      // Fill top-down: the first Pod's row sits just below the Tower's cap and
      // each subsequent row steps downward toward the floor.
      const y = TOWER_HEIGHT - PANEL_TOP_MARGIN - PANEL_SIZE / 2 - row * PANEL_PITCH

      return {
        tower: tower.name,
        namespace: panel.namespace,
        pod: panel.pod,
        color: panel.color,
        position: [x, y, faceZ] as [number, number, number],
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
