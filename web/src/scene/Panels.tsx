import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { type Tower } from '../generated/scenestate'
import { PANEL_SIZE, panelInstances } from './panelLayout'

/**
 * Panels renders every Pod in the scene as a small glowing rectangle on its
 * Tower's face, drawn as a SINGLE `InstancedMesh` over all Panels across all
 * Towers — the project's scale decision (one draw call for thousands of Pods,
 * not one mesh per Pod or even per Tower). The per-instance placement and color
 * come from {@link panelInstances}, the pure WebGL-free seam (unit-tested in
 * panelLayout.test.ts); this component is the thin renderer that writes that
 * data into the mesh's instance matrix and color buffers.
 *
 * The material is an unlit `meshBasicMaterial` with tone-mapping off, so each
 * Panel reads as a flat neon light at exactly its phase color regardless of
 * scene lighting — the glowing-rectangle look of the reference stills, and a
 * cheap fallback that stays legible at any camera distance.
 *
 * Picking is instance-aware from the start: the `panelInstances` list is stashed
 * on the mesh's `userData` in the same order the instances are written, so a
 * later click handler (#20) can turn a hit `instanceId` straight back into the
 * originating Pod via {@link resolvePanel}.
 */
export function Panels({ towers }: { towers: readonly Tower[] }) {
  const instances = useMemo(() => panelInstances(towers), [towers])
  const meshRef = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh || instances.length === 0) {
      return
    }

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()
    instances.forEach((instance, i) => {
      dummy.position.set(...instance.position)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      mesh.setColorAt(i, color.set(instance.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true
    }
    mesh.count = instances.length
    // Stash the ordered instance list so instance-aware picking (#20) can
    // resolve a hit instanceId back to its Pod.
    mesh.userData.panelInstances = instances
  }, [instances])

  if (instances.length === 0) {
    return null
  }

  return (
    <instancedMesh
      ref={meshRef}
      // args = [geometry, material, count]; both are declared as children below,
      // so pass undefined and let R3F attach them. Count is the max instances.
      args={[undefined, undefined, instances.length]}
    >
      <planeGeometry args={[PANEL_SIZE, PANEL_SIZE]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}
