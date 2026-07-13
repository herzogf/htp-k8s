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
