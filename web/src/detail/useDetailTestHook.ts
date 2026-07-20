import { useEffect } from 'react'
import { type SceneState } from '../generated/scenestate'
import { type FocusController, panelFocusPose, towerFocusPose } from '../scene/focus'
import { panelInstances, sceneTowerHeight } from '../scene/panelLayout'
import { towerPlacements } from '../scene/towerLayout'
import { towerRenderedHeights } from '../scene/towerRenderedHeightRegistry'
import { panelSelection, type Selection, towerSelection } from './selection'

/**
 * The shape published on `window.__htpDetailTest` for the Playwright e2e (#24).
 * The Detail Popup opens from a click that raycasts against the WebGL canvas —
 * and synthetic pointer input does NOT reliably hit an instanced Panel / Tower
 * in headless Chromium (the same flakiness #20/#74 hit). So, exactly as
 * FreeFlyControls exposes the live camera through `__htpCameraTest`, this hook
 * exposes the scene's real Towers/Panels and a way to open a given one's popup
 * *through the same `focus` + `select` a click calls* (via the pure
 * {@link towerSelection}/{@link panelSelection} mapping and the matching
 * {@link towerFocusPose}/{@link panelFocusPose}). Mirroring the full click — the
 * camera fly-to as well as the selection — matters because the popup is anchored
 * in-world beside the element (see {@link DetailLayer}): a select without the
 * focus leaves the popup pinned wherever its Panel happens to project, often off
 * the camera frame, so opening it exactly as a click does is what puts it on
 * screen. The e2e then asserts on the popup's real drei `Html` DOM — the
 * deterministic, meaningful part — without depending on a headless raycast
 * landing on a specific instance.
 */
export interface DetailTestHook {
  /**
   * The Towers currently in the scene, in scene order. `panelCount` is that
   * Tower's own Pod count — added for issue #29's nightly dense-scene
   * coverage, so an e2e test can find (and assert on) the busiest/sparsest
   * Tower in a large seeded scene without re-deriving it from the raw
   * SceneState, and can numerically confirm a dense seed actually engages
   * #59's four-face wrap / scene-height growth (`panelLayout.ts`'s
   * `sceneRowsPerFace`/`sceneTowerHeight`) rather than assuming the seed is
   * dense enough. `position` is the Tower's real world-space centre (the
   * same value `selectTower` frames off internally) — also added for #29, so
   * a nightly test can build its OWN custom camera vantage (via
   * `__htpCameraTest.requestFocus`) framing a specific Tower, or two Towers
   * at once, without waiting on #165 (Focus's own Tower framing is not yet
   * scene-height-aware and can clip a grown Tower's roof/base out of frame).
   */
  towers: () => { name: string; panelCount: number; position: [number, number, number] }[]
  /** The Pods (Panels) currently in the scene, in scene order. */
  pods: () => { namespace: string; pod: string }[]
  /** Fly to and open the Detail Popup for a Tower by name; false if no such Tower. */
  selectTower: (name: string) => boolean
  /** Fly to and open the Detail Popup for a Pod by identity; false if no such Pod. */
  selectPod: (namespace: string, pod: string) => boolean
  /** Close the open Detail Popup. */
  clear: () => void
  /**
   * The scene's actual, uniform Tower height (`panelLayout.ts`'s
   * `sceneTowerHeight`) — `TOWER_HEIGHT` at rest, taller once a busy Tower's
   * Pods outgrow the four-face capacity at that height (#59). Since every
   * Tower stands on the floor (y = 0), this is also the scene's roofline Y
   * (every Tower prism's top). Added for issue #29's nightly Demo Mode
   * roofline-clearance guard: #162 made every altitude band derive from this
   * same value, so an e2e assertion needs it directly rather than
   * reimplementing `sceneTowerHeight` across the e2e/app compilation
   * boundary.
   */
  sceneHeight: () => number
  /**
   * Each currently-mounted Tower's own, actually-RENDERED prism height (not
   * `sceneHeight()` recomputed a second time) — added for issue #29's nightly
   * busy-vs-sparse "identical height, sparse Tower unfilled rather than
   * shorter" guard. `sceneHeight()` is `sceneTowerHeight(towers)`, the SAME
   * scalar `Scene.tsx` computes once and hands every `<Tower>`; a test that
   * only reads that shared scalar back is tautological — it cannot tell "both
   * Towers rendered at the identical, correct height" apart from "one Tower
   * silently rendered at the wrong height" (a stale prop, a keying bug, a
   * future refactor), since both read the exact same computation. This is
   * sourced from each `<Tower>`'s OWN `<boxGeometry>` (see
   * `towerRenderedHeightRegistry.ts` / `Tower.tsx`), an independent path from
   * `sceneHeight()`, so it is the one field that can actually disagree with
   * itself across two Towers if the property under test broke.
   */
  towerRenderedHeights: () => { name: string; height: number }[]
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
 * Removes the handle on unmount. `focus`/`select`/`clear` are the Scene's own
 * Focus controller and selection setters, and each open flies the camera then
 * sets the selection in the same order a real click does (see {@link Panels}'
 * `onClick`), so a hook-driven open is indistinguishable from a click-driven one
 * downstream — camera framing included.
 */
export function useDetailTestHook(
  sceneState: SceneState | null,
  focus: FocusController | null,
  select: (selection: Selection) => void,
  clear: () => void,
): void {
  useEffect(() => {
    const towers = sceneState ? sceneState.towers : []
    // #59: match the scene's real uniform Tower height so a hook-driven Tower
    // focus lands on the same Y the actually-rendered (possibly grown) prism
    // sits at — see Scene.tsx's own sceneTowerHeight call.
    const height = sceneTowerHeight(towers)
    const placements = towerPlacements(towers, height)
    const instances = panelInstances(towers)

    window.__htpDetailTest = {
      // placements and towers share the same input order (towerPlacements
      // preserves it — see towerLayout.ts), so zipping by index pairs each
      // placement with its own Tower's real Pod count.
      towers: () =>
        placements.map((placement, i) => ({
          name: placement.name,
          panelCount: towers[i]?.panels.length ?? 0,
          position: placement.position,
        })),
      pods: () =>
        instances.map((instance) => ({ namespace: instance.namespace, pod: instance.pod })),
      sceneHeight: () => height,
      towerRenderedHeights: () => towerRenderedHeights(),
      selectTower: (name) => {
        const placement = placements.find((candidate) => candidate.name === name)
        if (!placement) {
          return false
        }
        focus?.requestFocus(towerFocusPose(placement.position))
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
        focus?.requestFocus(panelFocusPose(instance.position, instance.rotationY))
        select(panelSelection(instance))
        return true
      },
      clear,
    }

    return () => {
      delete window.__htpDetailTest
    }
  }, [sceneState, focus, select, clear])
}
