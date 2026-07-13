import { type ThreeEvent, useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { panelSelection } from '../detail/selection'
import { useSelection } from '../detail/selectionContext'
import { type PanelActivity, type Tower } from '../generated/scenestate'
import { blinkStore } from './blinks'
import { panelFocusPose } from './focus'
import { useFocus } from './focusContext'
import { PANEL_SIZE, panelInstanceIndex, panelInstances, resolvePanel } from './panelLayout'

/** The color a Panel flashes toward at a blink's peak — pure white, so even an
 * already-saturated phase color (neon green) still visibly brightens. */
const BLINK_FLASH = new THREE.Color(0xffffff)

/**
 * The shape exposed on `window` for the e2e blink test (#19). Blinks fire from
 * transient cluster activity that can't be reproduced deterministically in the
 * static KWOK e2e scene, so this hook lets the test inject one and read the
 * affected instance's rendered color straight from the InstancedMesh's color
 * buffer — the observable effect of the trigger → animation path.
 */
export interface BlinkTestHook {
  /** Every rendered Panel's Pod identity, in instance order — so the test can pick a real one. */
  listPanels: () => Array<{ namespace: string; pod: string }>
  /** Injects a blink for a Pod, exactly as a `panelBlink` delta would (same clock). */
  triggerBlink: (namespace: string, pod: string, activity: PanelActivity) => void
  /**
   * The Pod's Panel instance color as currently written to the mesh, `[r, g, b]`
   * in 0..1, or `null` if that Pod isn't in the scene. During a blink this reads
   * brighter (lerped toward white); once settled it reads the base phase color.
   */
  readColor: (namespace: string, pod: string) => [number, number, number] | null
}

declare global {
  interface Window {
    /**
     * Test-only handle onto the blink channel and the live Panel color buffer.
     * The Panels render into a WebGL InstancedMesh that isn't DOM-queryable, so
     * the Playwright test injects a blink and reads the resulting per-instance
     * brightness through this hook. It ships in the production bundle on purpose:
     * this project's e2e runs against the real built binary (ADR-0004), so a
     * dev-only guard would strip the hook from the very build the test exercises.
     * It only injects a purely-visual, transient pulse and reads a color back —
     * no surface in a read-only cinematic viewer (ADR-0003).
     */
    __htpBlinkTest?: BlinkTestHook
  }
}

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
 *
 * Clicking a Panel does two things (#21, #24): the pointer event's `instanceId`
 * is resolved back to its {@link PanelInstance}, that Pod's {@link panelFocusPose}
 * is handed to the shared {@link FocusController} for the camera rig to fly to —
 * close enough to read that specific Panel — and that Pod is selected, opening
 * its in-world Detail Popup (pod detail + live log tail) anchored beside it.
 *
 * Blinks (#19) are the per-instance activity animation: a transient `panelBlink`
 * signal recorded on the out-of-band {@link blinkStore} (not a `SceneState`
 * change — see {@link useSceneState}) makes that one Pod's instance flash brighter
 * and settle back, driven per frame by {@link useFrame} writing into the same
 * instance color buffer the layout pass fills. It is purely visual and touches no
 * scene state, so it is instance-aware for free — only the pulsing Pod's color is
 * modulated, every other Panel is left at its phase color.
 */
export function Panels({ towers }: { towers: readonly Tower[] }) {
  const instances = useMemo(() => panelInstances(towers), [towers])
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const focus = useFocus()
  const { select } = useSelection()
  // Whether the previous frame drew any blink. When a blink settles we need one
  // final frame that restores every base color and uploads it; this ref is how
  // that trailing frame is detected so the mesh doesn't stay stuck bright.
  const wasBlinking = useRef(false)
  // Scratch color reused each frame so the blink loop allocates nothing.
  const blinkColor = useRef(new THREE.Color())

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    // Instanced picking: R3F reports which instance the ray hit as `instanceId`;
    // resolve it back to the Pod it was built from (panelLayout stashes the same
    // ordered list on userData). A miss (no instanceId) simply does nothing.
    if (event.instanceId === undefined) {
      return
    }
    const instance = resolvePanel(instances, event.instanceId)
    if (!instance) {
      return
    }
    event.stopPropagation()
    focus?.requestFocus(panelFocusPose(instance.position))
    select(panelSelection(instance))
  }

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

  // Drive the transient blink each frame: a Panel with an active pulse in the
  // out-of-band blinkStore (fed by a #18 panelBlink delta, NOT the reducer) is
  // brightened toward white on its ease-out envelope, then settled back to its
  // phase color. Instance-aware: only the pulsing Pods are rewritten; the rest
  // keep the base colors the layout pass wrote. When nothing is (or just was)
  // blinking this returns immediately, so the at-rest scene pays nothing.
  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || !mesh.instanceColor || instances.length === 0) {
      return
    }
    const now = performance.now()
    if (!blinkStore.hasActive(now) && !wasBlinking.current) {
      return
    }

    const color = blinkColor.current
    let anyBlinking = false
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i]
      const intensity = blinkStore.intensityFor(instance.namespace, instance.pod, now)
      if (intensity > 0) {
        anyBlinking = true
        mesh.setColorAt(i, color.set(instance.color).lerp(BLINK_FLASH, intensity))
      } else if (wasBlinking.current) {
        // Settling frame: restore this instance's base phase color.
        mesh.setColorAt(i, color.set(instance.color))
      }
    }
    mesh.instanceColor.needsUpdate = true
    wasBlinking.current = anyBlinking
  })

  // Expose the e2e blink hook: inject a blink and read a Panel instance's live
  // color from the mesh (see BlinkTestHook). Re-created when the instance list
  // changes so listPanels/readColor resolve against the current scene.
  useEffect(() => {
    window.__htpBlinkTest = {
      listPanels: () => instances.map((p) => ({ namespace: p.namespace, pod: p.pod })),
      triggerBlink: (namespace, pod, activity) =>
        blinkStore.trigger(namespace, pod, activity, performance.now()),
      readColor: (namespace, pod) => {
        const mesh = meshRef.current
        if (!mesh || !mesh.instanceColor) {
          return null
        }
        const index = panelInstanceIndex(instances, namespace, pod)
        if (index === undefined) {
          return null
        }
        const color = new THREE.Color()
        mesh.getColorAt(index, color)
        return [color.r, color.g, color.b]
      },
    }
    return () => {
      delete window.__htpBlinkTest
    }
  }, [instances])

  if (instances.length === 0) {
    return null
  }

  return (
    <instancedMesh
      ref={meshRef}
      onClick={onClick}
      // args = [geometry, material, count]; both are declared as children below,
      // so pass undefined and let R3F attach them. Count is the max instances.
      args={[undefined, undefined, instances.length]}
    >
      <planeGeometry args={[PANEL_SIZE, PANEL_SIZE]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}
