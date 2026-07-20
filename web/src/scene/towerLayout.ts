import { type Tower } from '../generated/scenestate'

/**
 * TOWER_SPACING is the world-space distance between adjacent grid slots, i.e.
 * the centre-to-centre gap between neighbouring Towers along a row or column.
 * The backend hands us abstract grid indices (see GridPosition); the visual
 * spacing is deliberately a frontend concern, fixed here.
 */
export const TOWER_SPACING = 4

/**
 * TOWER_HEIGHT is the world-space height of a Tower prism at rest — the floor
 * for the scene's actual rendered height, and what a Tower renders at when its
 * scene has no need to grow taller. Towers stand on the scene floor (y = 0), so
 * a Tower's centre sits at `height / 2`.
 *
 * A busy scene renders every Tower taller than this: {@link sceneTowerHeight}
 * in panelLayout.ts (#59) derives one scene-wide height — never smaller than
 * this floor — from the busiest Tower's pod count, once wrapping Panels across
 * all four faces at this height stops being enough room. Every Tower in the
 * scene is then drawn at that same taller height (a uniform skyline; a Tower
 * with fewer pods just has unfilled faces, it is never shorter), so this
 * constant alone is no longer "the" Tower height once a scene is that busy —
 * see {@link towerPlacements}'s `height` parameter and Tower.tsx's `height` prop.
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
 * lifted to `height / 2` so its prism rests on the floor at y = 0.
 *
 * `height` defaults to {@link TOWER_HEIGHT} but callers that need every Tower
 * drawn at the scene-wide uniform height (#59's `sceneTowerHeight`, panelLayout.ts
 * — every Tower is rendered at the same height regardless of its own pod count,
 * so the skyline stays level) pass it explicitly; every Tower in one call shares
 * the same `height`, matching that uniform-height requirement.
 *
 * Input order is preserved, so the result lines up one-to-one with the backend's
 * deterministic grid-by-name ordering.
 */
export function towerPlacements(
  towers: readonly Tower[],
  height: number = TOWER_HEIGHT,
): TowerPlacement[] {
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
      height / 2,
      (tower.grid.row - centerRow) * TOWER_SPACING,
    ],
  }))
}
