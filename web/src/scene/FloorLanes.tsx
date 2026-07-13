import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { type Tower } from '../generated/scenestate'
import {
  decorativeLaneActivitySource,
  type LaneActivitySource,
  PULSES_PER_LANE,
} from './laneActivity'
import { LANE_HEIGHT, laneRoutes } from './laneLayout'

/**
 * The shape exposed on `window` for the e2e Floor Lane test (#28). A pulse's
 * motion is continuous and driven by wall-clock time (see the decorative
 * {@link LaneActivitySource}), so there is nothing deterministic to inject the
 * way the blink test hook (`window.__htpBlinkTest`) injects a one-shot event —
 * instead this hook lets the test read the live lane count and every currently
 * drawn pulse's world position straight back out of the `InstancedMesh`es, so
 * it can assert lanes exist between real Towers and that a pulse's position
 * actually changes from one poll to the next (proof the animation is live,
 * without pixel-diffing).
 */
export interface FloorLaneTestHook {
  /** Every routed lane's identity, in draw order. */
  listLanes: () => Array<{ id: string; from: string; to: string }>
  /** World-space `[x, y, z]` position of every pulse instance currently drawn,
   * across all lanes, in mesh order. */
  readPulsePositions: () => Array<[number, number, number]>
}

declare global {
  interface Window {
    /**
     * Test-only handle onto the live lane list and the pulse InstancedMesh's
     * current instance positions. Ships in the production bundle for the same
     * reason `__htpBlinkTest` does (see Panels.tsx): this project's e2e runs
     * against the real built binary (ADR-0004), so a dev-only guard would strip
     * it from the very build the test exercises. It only reads back purely
     * decorative, already-rendered positions — no surface in a read-only
     * cinematic viewer (ADR-0003).
     */
    __htpFloorLaneTest?: FloorLaneTestHook
  }
}

/**
 * LANE_COLOR is a dimmer cousin of {@link TOWER_COLOR}: Floor Lanes read as
 * background circuitry on the scene floor, not competing for attention with
 * the Towers/Panels they connect (CONTEXT.md: "a glowing line on the scene
 * floor connecting two Towers").
 */
export const LANE_COLOR = '#1c6e86'

/** Bright near-white cyan for the traveling pulse itself, so it clearly reads
 * as brighter than the lane it travels along. */
export const PULSE_COLOR = '#bff4ff'

const LANE_THICKNESS = 0.05
const PULSE_SIZE = 0.16

export interface FloorLanesProps {
  /** The scene's Towers — lane geometry is derived from their grid positions
   * (see {@link laneRoutes}); Panels are ignored. */
  towers: readonly Tower[]
  /**
   * The source driving each lane's traveling pulses. Defaults to
   * {@link decorativeLaneActivitySource} — v1's decorative, not-data-driven
   * animation (CONTEXT.md, issue #28). This prop is the whole swap seam: a
   * later ticket that wants pulses driven by a real signal (traffic, control
   * plane, …) passes a different {@link LaneActivitySource} here; nothing else
   * in this renderer, or in {@link laneRoutes}'s geometry, needs to change.
   */
  activitySource?: LaneActivitySource
}

/**
 * FloorLanes renders every Floor Lane connecting grid-adjacent Towers: a dim
 * static line segment on the floor (geometry from {@link laneRoutes}, a pure
 * WebGL-free module unit-tested independently) plus traveling light pulses
 * along it (positions/brightness from a {@link LaneActivitySource}, likewise
 * unit-tested independently in laneActivity.test.ts). This component is
 * deliberately thin glue — validated by the Playwright e2e screenshot/video
 * (ADR-0004) rather than more unit tests — matching how {@link Panels}
 * separates `panelInstances` (pure layout) from the `<instancedMesh>` renderer.
 *
 * Both the static segments and the pulses are drawn as a single `InstancedMesh`
 * each (one draw call apiece, however many lanes/pulses exist), the same scale
 * decision {@link Panels} makes for Pods — a large cluster's grid can have many
 * lanes, and one draw call per lane would regress render cost for no visual
 * benefit over instancing.
 *
 * Every grid-adjacent pair is connected by an axis-aligned segment (see
 * {@link LanePlacement.axis}), so a lane's static mesh only ever needs a 0° or
 * 90° Y rotation — no per-lane angle math.
 */
export function FloorLanes({
  towers,
  activitySource = decorativeLaneActivitySource,
}: FloorLanesProps) {
  const lanes = useMemo(() => laneRoutes(towers), [towers])
  const maxPulses = lanes.length * PULSES_PER_LANE

  const laneMeshRef = useRef<THREE.InstancedMesh>(null)
  const pulseMeshRef = useRef<THREE.InstancedMesh>(null)

  // Static lane segments never move once the grid is laid out, so they are
  // written once per lane list (mirrors Panels' useLayoutEffect for its base
  // instance matrices/colors).
  useLayoutEffect(() => {
    const mesh = laneMeshRef.current
    if (!mesh) {
      return
    }
    if (lanes.length === 0) {
      mesh.count = 0
      return
    }

    const dummy = new THREE.Object3D()
    lanes.forEach((lane, i) => {
      dummy.position.set(...lane.midpoint)
      dummy.rotation.set(0, lane.axis === 'z' ? Math.PI / 2 : 0, 0)
      dummy.scale.set(lane.length, 1, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.count = lanes.length

    // No pulses have been positioned for this lane list yet — hide the pulse
    // mesh until the first useFrame tick below writes real positions, so a
    // just-changed lane list can never flash a stale pulse at the origin.
    if (pulseMeshRef.current) {
      pulseMeshRef.current.count = 0
    }
  }, [lanes])

  // Drive every lane's traveling pulses each frame: query the activity source
  // for the current (t, intensity) of each pulse on each lane, and place one
  // pulse instance at that fractional position along the lane's trimmed
  // segment. Pure decoration — no scene state is read or written here besides
  // the mesh's own instance buffer.
  useFrame(() => {
    const mesh = pulseMeshRef.current
    if (!mesh || lanes.length === 0) {
      return
    }

    const now = performance.now()
    const dummy = new THREE.Object3D()
    let index = 0

    for (const lane of lanes) {
      const pulses = activitySource.pulsesFor(lane.id, now)
      for (const pulse of pulses) {
        if (index >= maxPulses) {
          break
        }
        const x = lane.start[0] + (lane.end[0] - lane.start[0]) * pulse.t
        const z = lane.start[2] + (lane.end[2] - lane.start[2]) * pulse.t
        dummy.position.set(x, LANE_HEIGHT, z)
        dummy.scale.setScalar(Math.max(pulse.intensity, 0))
        dummy.updateMatrix()
        mesh.setMatrixAt(index, dummy.matrix)
        index++
      }
    }

    mesh.count = index
    mesh.instanceMatrix.needsUpdate = true
  })

  // Expose the e2e Floor Lane hook: list the routed lanes and read every
  // currently-drawn pulse's live world position back out of the mesh (see
  // FloorLaneTestHook). Re-created when the lane list changes so it resolves
  // against the current scene.
  useEffect(() => {
    window.__htpFloorLaneTest = {
      listLanes: () => lanes.map((lane) => ({ id: lane.id, from: lane.from, to: lane.to })),
      readPulsePositions: () => {
        const mesh = pulseMeshRef.current
        if (!mesh) {
          return []
        }
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const positions: Array<[number, number, number]> = []
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix)
          position.setFromMatrixPosition(matrix)
          positions.push([position.x, position.y, position.z])
        }
        return positions
      },
    }
    return () => {
      delete window.__htpFloorLaneTest
    }
  }, [lanes])

  if (lanes.length === 0) {
    return null
  }

  return (
    <>
      <instancedMesh ref={laneMeshRef} args={[undefined, undefined, lanes.length]}>
        <boxGeometry args={[1, LANE_THICKNESS, LANE_THICKNESS]} />
        <meshBasicMaterial color={LANE_COLOR} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={pulseMeshRef} args={[undefined, undefined, maxPulses]}>
        <boxGeometry args={[PULSE_SIZE, PULSE_SIZE, PULSE_SIZE]} />
        <meshBasicMaterial color={PULSE_COLOR} toneMapped={false} />
      </instancedMesh>
    </>
  )
}
