import { type Tower } from '../generated/scenestate'

/**
 * TOWER_SPACING is the world-space distance between adjacent grid slots, i.e.
 * the centre-to-centre gap between neighbouring Towers along a row or column.
 * The backend hands us abstract grid indices (see GridPosition); the visual
 * spacing is deliberately a frontend concern, fixed here.
 */
export const TOWER_SPACING = 4

/**
 * TOWER_HEIGHT is the world-space height of a Tower prism. Towers stand on the
 * scene floor (y = 0), so a Tower's centre sits at TOWER_HEIGHT / 2.
 */
export const TOWER_HEIGHT = 6

/**
 * TOWER_FOOTPRINT is the world-space width and depth of a Tower prism (a square
 * footprint), kept comfortably smaller than {@link TOWER_SPACING} so adjacent
 * Towers read as separate structures with dark floor between them.
 */
export const TOWER_FOOTPRINT = 1.6

/**
 * TowerPlacement is one Tower resolved to a concrete spot in the 3D scene: its
 * stable identity plus the world-space centre of its prism. It is the pure,
 * WebGL-free output of {@link towerPlacements} — the seam a unit test can
 * assert layout on without a renderer.
 */
export interface TowerPlacement {
  /** The Tower's stable identity (Node name, or Namespace/Project name). */
  name: string
  /** World-space centre of the Tower prism: [x, y, z]. */
  position: [number, number, number]
}

/**
 * Maps the Towers of a `SceneState` to their world-space placements, turning
 * each Tower's abstract grid index into a 3D position.
 *
 * Column indices run along the X axis and row indices along the Z axis, scaled
 * by {@link TOWER_SPACING}. The occupied grid is centred on the world origin
 * (its bounding box midpoint maps to x = z = 0) so the cluster stays framed for
 * the camera whatever its absolute grid indices are and however large it grows;
 * a single Tower therefore lands exactly at the origin. Every Tower's centre is
 * lifted to `TOWER_HEIGHT / 2` so its prism rests on the floor at y = 0.
 *
 * Input order is preserved, so the result lines up one-to-one with the backend's
 * deterministic grid-by-name ordering.
 */
export function towerPlacements(towers: readonly Tower[]): TowerPlacement[] {
  if (towers.length === 0) {
    return []
  }

  const cols = towers.map((tower) => tower.grid.col)
  const rows = towers.map((tower) => tower.grid.row)
  const centerCol = (Math.min(...cols) + Math.max(...cols)) / 2
  const centerRow = (Math.min(...rows) + Math.max(...rows)) / 2

  return towers.map((tower) => ({
    name: tower.name,
    position: [
      (tower.grid.col - centerCol) * TOWER_SPACING,
      TOWER_HEIGHT / 2,
      (tower.grid.row - centerRow) * TOWER_SPACING,
    ],
  }))
}
