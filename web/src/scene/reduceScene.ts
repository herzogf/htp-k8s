import type { Panel, SceneState, Tower } from '../generated/scenestate'
import type { SceneDelta } from './sceneDelta'

/**
 * Applies one narrowed {@link SceneDelta} to a {@link SceneState}, returning the
 * reconciled next state. This is the frontend's reconciliation reducer (ADR-0007):
 * the backend sends a full SceneState snapshot on connect and then a stream of
 * incremental Scene Deltas, and applying those deltas in order to the snapshot
 * reproduces the later snapshot exactly (the property {@link SceneDelta}'s
 * backend `Diff` guarantees).
 *
 * It is deliberately a pure, rendering-independent function: `(state, delta) =>
 * state`. Nothing here touches Three.js or React — the reducer's output is what
 * drives the scene (via {@link useSceneState}), so delta-application bugs (an
 * update on the wrong Panel, a removed Panel left stale) are caught in isolation
 * from rendering. Inputs are never mutated; every change returns fresh arrays and
 * objects so React sees new references.
 *
 * Identity keys: a Tower is keyed by its `name`, a Panel by its
 * `(namespace, pod)` pair (a Pod's cluster-unique identity). Deltas whose target
 * is absent (a move/update/remove for a Tower or Panel not in the state) are
 * applied as no-ops rather than fabricating state, so a stray or
 * already-superseded delta degrades gracefully instead of corrupting the scene —
 * the client fully recovers on its next reconnect snapshot regardless.
 */
export function reduceScene(state: SceneState, delta: SceneDelta): SceneState {
  switch (delta.type) {
    case 'towerAdded':
      // A brand-new Tower arrives whole, including its initial Panels. Upsert by
      // name so a re-added Tower replaces rather than duplicates.
      return { ...state, towers: upsertTower(state.towers, delta.tower) }

    case 'towerRemoved':
      // Drop the Tower and, with it, every Panel nested on it — no stale Panels
      // survive a Tower removal because they live under `tower.panels`.
      return { ...state, towers: state.towers.filter((t) => t.name !== delta.towerName) }

    case 'towerMoved':
      // Re-place a surviving Tower at its new grid slot. No-op if it is gone.
      return {
        ...state,
        towers: mapTower(state.towers, delta.towerName, (tower) => ({
          ...tower,
          grid: delta.grid,
        })),
      }

    case 'panelAdded':
      // A Panel appeared on an existing Tower. Upsert by (namespace, pod). No-op
      // if the Tower is absent.
      return {
        ...state,
        towers: mapTower(state.towers, delta.towerName, (tower) => ({
          ...tower,
          panels: upsertPanel(tower.panels, delta.panel),
        })),
      }

    case 'panelUpdated':
      // A Panel's content changed (e.g. phase/color). Replace the matching Panel
      // in place; leave the Tower untouched if that Panel is not present.
      return {
        ...state,
        towers: mapTower(state.towers, delta.towerName, (tower) => ({
          ...tower,
          panels: replacePanel(tower.panels, delta.panel),
        })),
      }

    case 'panelRemoved':
      // A Panel left an existing Tower. Remove it by (namespace, pod) so it is
      // actually gone, not left stale. No-op if the Tower or Panel is absent.
      return {
        ...state,
        towers: mapTower(state.towers, delta.towerName, (tower) => ({
          ...tower,
          panels: tower.panels.filter(
            (p) => !(p.namespace === delta.namespace && p.pod === delta.pod),
          ),
        })),
      }

    default: {
      // Exhaustiveness guard: adding a new SceneDelta member without a case here
      // makes `delta` stop being `never` and fails the build.
      const _exhaustive: never = delta
      void _exhaustive
      return state
    }
  }
}

/** Returns `towers` with `name`'s Tower replaced by `fn(tower)`; unchanged if absent. */
function mapTower(towers: Tower[], name: string, fn: (tower: Tower) => Tower): Tower[] {
  let changed = false
  const next = towers.map((tower) => {
    if (tower.name !== name) {
      return tower
    }
    changed = true
    return fn(tower)
  })
  return changed ? next : towers
}

/** Returns `towers` with `tower` added, or replacing the existing one of the same name. */
function upsertTower(towers: Tower[], tower: Tower): Tower[] {
  const index = towers.findIndex((t) => t.name === tower.name)
  if (index === -1) {
    return [...towers, tower]
  }
  const next = towers.slice()
  next[index] = tower
  return next
}

/** Returns `panels` with `panel` added, or replacing the existing one of the same identity. */
function upsertPanel(panels: Panel[], panel: Panel): Panel[] {
  const index = panels.findIndex((p) => p.namespace === panel.namespace && p.pod === panel.pod)
  if (index === -1) {
    return [...panels, panel]
  }
  const next = panels.slice()
  next[index] = panel
  return next
}

/** Returns `panels` with the Panel of `panel`'s identity replaced; unchanged if absent. */
function replacePanel(panels: Panel[], panel: Panel): Panel[] {
  let changed = false
  const next = panels.map((p) => {
    if (p.namespace !== panel.namespace || p.pod !== panel.pod) {
      return p
    }
    changed = true
    return panel
  })
  return changed ? next : panels
}
