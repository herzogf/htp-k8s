import { type PanelInstance } from '../scene/panelLayout'
import { type TowerPlacement } from '../scene/towerLayout'

/**
 * The Detail Popup selection model: which Tower or Panel (Pod) the user clicked
 * and therefore which in-world Detail Popup is open (CONTEXT.md's "Detail
 * Popup"). This is the pure, WebGL-free vocabulary the click handlers push and
 * the popup layer reads; the fetch/stream wiring and the drei `Html` rendering
 * live in the components that consume it.
 *
 * A selection carries the clicked element's identity (to fetch its detail from
 * the ADR-0009 read-only endpoints) plus the world-space `anchor` the popup is
 * pinned beside in 3D space — so the popup travels with the Tower/Panel rather
 * than floating in fixed screen space.
 */

/** Selection of a Tower: opens the Node/Namespace summary popup at `anchor`. */
export interface TowerSelection {
  kind: 'tower'
  /** The Tower's identity — Node name or Namespace/Project name. */
  name: string
  /** World-space point the popup is anchored beside: [x, y, z]. */
  anchor: [number, number, number]
}

/** Selection of a Panel (Pod): opens the pod detail + log tail popup at `anchor`. */
export interface PodSelection {
  kind: 'pod'
  /** The Pod's Namespace/Project. */
  namespace: string
  /** The Pod's name. */
  pod: string
  /** World-space point the popup is anchored beside: [x, y, z]. */
  anchor: [number, number, number]
}

/** What the user currently has selected, driving the open Detail Popup. */
export type Selection = TowerSelection | PodSelection

/**
 * The {@link TowerSelection} for a clicked Tower, anchored at the prism's
 * placement. This is the pure click→selection mapping a Tower's pointer handler
 * applies once #74's pick has resolved the hit to a {@link TowerPlacement}; kept
 * here (WebGL-free, unit-tested) so the same mapping backs both the real click
 * path and the e2e test hook without duplicating the shape.
 */
export function towerSelection(placement: TowerPlacement): TowerSelection {
  return { kind: 'tower', name: placement.name, anchor: placement.position }
}

/**
 * The {@link PodSelection} for a clicked Panel, anchored at the Panel's
 * world-space centre — the pure mapping applied once #74's instanced pick
 * ({@link import('../scene/panelLayout').resolvePanel}) has resolved the hit
 * `instanceId` to its originating {@link PanelInstance}.
 */
export function panelSelection(instance: PanelInstance): PodSelection {
  return {
    kind: 'pod',
    namespace: instance.namespace,
    pod: instance.pod,
    anchor: instance.position,
  }
}
