import { useEffect } from 'react'
import { type SceneState } from '../generated/scenestate'
import { panelInstances } from '../scene/panelLayout'
import { towerPlacements } from '../scene/towerLayout'
import { panelSelection, type Selection, towerSelection } from './selection'

/**
 * The shape published on `window.__htpDetailTest` for the Playwright e2e (#24).
 * The Detail Popup opens from a click that raycasts against the WebGL canvas —
 * and synthetic pointer input does NOT reliably hit an instanced Panel / Tower
 * in headless Chromium (the same flakiness #20/#74 hit). So, exactly as
 * FreeFlyControls exposes the live camera through `__htpCameraTest`, this hook
 * exposes the scene's real Towers/Panels and a way to open a given one's popup
 * *through the same `select` a click calls* (via the pure {@link towerSelection}/
 * {@link panelSelection} mapping). The e2e then asserts on the popup's real drei
 * `Html` DOM — the deterministic, meaningful part — without depending on a
 * headless raycast landing on a specific instance.
 */
export interface DetailTestHook {
  /** The Towers currently in the scene, in scene order. */
  towers: () => { name: string }[]
  /** The Pods (Panels) currently in the scene, in scene order. */
  pods: () => { namespace: string; pod: string }[]
  /** Open the Detail Popup for a Tower by name; false if no such Tower. */
  selectTower: (name: string) => boolean
  /** Open the Detail Popup for a Pod by identity; false if no such Pod. */
  selectPod: (namespace: string, pod: string) => boolean
  /** Close the open Detail Popup. */
  clear: () => void
}

declare global {
  interface Window {
    /**
     * Test-only handle for driving the Detail Popup (#24) deterministically —
     * see {@link DetailTestHook}. It ships in the production bundle on purpose:
     * this project's e2e runs the real built binary (ADR-0004), and it is a
     * read-only affordance in a read-only viewer (ADR-0003) — it only opens the
     * same read-only popup a click opens, exposing no mutate/exec path.
     */
    __htpDetailTest?: DetailTestHook
  }
}

/**
 * Publishes {@link DetailTestHook} on `window` for the current scene, re-derived
 * whenever the scene snapshot changes so the exposed Towers/Panels stay current.
 * Removes the handle on unmount. `select`/`clear` are the Scene's own selection
 * setters, so a hook-driven selection is indistinguishable from a click-driven
 * one downstream.
 */
export function useDetailTestHook(
  sceneState: SceneState | null,
  select: (selection: Selection) => void,
  clear: () => void,
): void {
  useEffect(() => {
    const towers = sceneState ? sceneState.towers : []
    const placements = towerPlacements(towers)
    const instances = panelInstances(towers)

    window.__htpDetailTest = {
      towers: () => placements.map((placement) => ({ name: placement.name })),
      pods: () =>
        instances.map((instance) => ({ namespace: instance.namespace, pod: instance.pod })),
      selectTower: (name) => {
        const placement = placements.find((candidate) => candidate.name === name)
        if (!placement) {
          return false
        }
        select(towerSelection(placement))
        return true
      },
      selectPod: (namespace, pod) => {
        const instance = instances.find(
          (candidate) => candidate.namespace === namespace && candidate.pod === pod,
        )
        if (!instance) {
          return false
        }
        select(panelSelection(instance))
        return true
      },
      clear,
    }

    return () => {
      delete window.__htpDetailTest
    }
  }, [sceneState, select, clear])
}
