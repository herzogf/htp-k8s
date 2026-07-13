import { type Tower } from '../generated/scenestate'
import { TOWER_FOOTPRINT, type TowerPlacement, towerPlacements } from './towerLayout'

/**
 * LANE_HEIGHT lifts a Floor Lane's segment (and its pulses) just clear of the
 * scene floor at y = 0, echoing {@link PANEL_STANDOFF}'s reason: rendering
 * exactly on the floor plane would z-fight with the `gridHelper` floor grid.
 */
export const LANE_HEIGHT = 0.05

/**
 * LanePlacement is one Floor Lane resolved to a concrete segment in the 3D
 * scene: the world-space endpoints of the glowing line connecting two
 * grid-adjacent Towers, plus enough metadata (`midpoint`/`length`/`axis`) for a
 * thin renderer to place a static segment mesh without recomputing geometry. It
 * is the pure, WebGL-free output of {@link laneRoutes} — the seam a unit test
 * asserts layout on without a renderer, mirroring {@link TowerPlacement} for
 * Towers and `PanelInstance` for Panels.
 */
export interface LanePlacement {
  /** Stable identity for this lane: `"<from>-><to>"`. Doubles as the key a
   * {@link LaneActivitySource} (see laneActivity.ts) is queried by, so a later
   * real-data source can key its traffic samples the same way. */
  id: string
  /** Name of the Tower this lane starts at (the "from" side of {@link id}). */
  from: string
  /** Name of the Tower this lane ends at (the "to" side of {@link id}). */
  to: string
  /** World-space start point, trimmed clear of the `from` Tower's footprint. */
  start: [number, number, number]
  /** World-space end point, trimmed clear of the `to` Tower's footprint. */
  end: [number, number, number]
  /** World-space midpoint of the segment — convenient for centring a static mesh. */
  midpoint: [number, number, number]
  /** World-space length of the trimmed segment. */
  length: number
  /** Which world axis the segment runs along. Grid-adjacent Towers are always
   * connected by an axis-aligned segment (never diagonal), so a renderer can
   * pick a mesh rotation from this instead of computing an angle. */
  axis: 'x' | 'z'
}

/**
 * Routes Floor Lanes between grid-adjacent Towers, turning the backend's grid
 * (`Tower.grid`) into the pure geometry a renderer draws (see {@link
 * FloorLanes}). CONTEXT.md's Floor Lane is "a glowing line on the scene floor
 * connecting two Towers" — this connects each Tower to its immediate right
 * (`col + 1`, same `row`) and immediate below (`row + 1`, same `col`) neighbour,
 * when one is present in the scene. That yields a lattice covering every
 * occupied grid cell with exactly one lane per adjacent pair (each edge is only
 * ever emitted from its "smaller" side, so it can't be double-counted), rather
 * than an O(n²) mesh connecting every Tower to every other Tower — the latter
 * would neither match the "lane on the floor between neighbours" reference look
 * nor scale to a large cluster's Tower count.
 *
 * A Tower with no grid-adjacent neighbour (an isolated Tower, or the sole Tower
 * in the scene) simply has no lanes touching it — Floor Lanes are decoration on
 * top of the grid, never a requirement for a Tower to render (ADR-0002-style
 * graceful absence).
 */
export function laneRoutes(towers: readonly Tower[]): LanePlacement[] {
  if (towers.length === 0) {
    return []
  }

  const placements = towerPlacements(towers)
  const indexByGridKey = new Map<string, number>()
  towers.forEach((tower, i) => {
    indexByGridKey.set(gridKey(tower.grid.col, tower.grid.row), i)
  })

  const lanes: LanePlacement[] = []
  towers.forEach((tower, i) => {
    const { col, row } = tower.grid

    const rightIndex = indexByGridKey.get(gridKey(col + 1, row))
    if (rightIndex !== undefined) {
      lanes.push(makeLane(placements[i], placements[rightIndex], 'x'))
    }

    const belowIndex = indexByGridKey.get(gridKey(col, row + 1))
    if (belowIndex !== undefined) {
      lanes.push(makeLane(placements[i], placements[belowIndex], 'z'))
    }
  })

  return lanes
}

function gridKey(col: number, row: number): string {
  return `${col},${row}`
}

/**
 * Builds one {@link LanePlacement} between two Towers already known to be
 * grid-adjacent along `axis`. Trims each end back by half a Tower's footprint
 * so the visible segment runs between the Towers' faces rather than passing
 * through their translucent volumes.
 */
function makeLane(from: TowerPlacement, to: TowerPlacement, axis: 'x' | 'z'): LanePlacement {
  const trim = TOWER_FOOTPRINT / 2
  const [fromX, , fromZ] = from.position
  const [toX, , toZ] = to.position
  // Grid-adjacent Towers differ along exactly one axis; signum picks which way
  // to trim (the other axis's delta is always 0, so trimming it is a no-op).
  const dirX = Math.sign(toX - fromX)
  const dirZ = Math.sign(toZ - fromZ)

  const start: [number, number, number] = [fromX + dirX * trim, LANE_HEIGHT, fromZ + dirZ * trim]
  const end: [number, number, number] = [toX - dirX * trim, LANE_HEIGHT, toZ - dirZ * trim]
  const midpoint: [number, number, number] = [
    (start[0] + end[0]) / 2,
    LANE_HEIGHT,
    (start[2] + end[2]) / 2,
  ]
  const length = Math.hypot(end[0] - start[0], end[2] - start[2])

  return {
    id: `${from.name}->${to.name}`,
    from: from.name,
    to: to.name,
    start,
    end,
    midpoint,
    length,
    axis,
  }
}
