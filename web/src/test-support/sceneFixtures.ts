import {
  ColorRunning,
  type Panel,
  PodPhaseRunning,
  type SceneState,
  type Tower,
  ViewModeNode,
} from '../generated/scenestate'

/**
 * Test factories for the wire-contract types (`SceneState`, `Tower`, `Panel`).
 *
 * The frontend tests build these shapes constantly, and every time the backend
 * contract grows a required field (Towers required, Panels required, Panels
 * nested under Towers) every hand-written object literal in every test breaks at
 * once. These factories are the single place those defaults live: each returns a
 * COMPLETE, valid object with all required fields filled in, and takes a
 * `Partial` of overrides for the handful of fields a given test actually cares
 * about. A future required-field addition is then a one-line change here rather
 * than a sweep across N fixtures.
 *
 * They are deliberately minimal — plain object spreads, no builders — and are
 * imported only by tests (nothing in the app bundle references this module).
 */

/**
 * Builds a complete {@link Panel}, defaulting to a healthy Running pod. Override
 * `phase`/`color` together to model other states (they are independent on the
 * wire — the backend derives `color` from `phase`, but a Panel just carries
 * both).
 */
export function makePanel(overrides: Partial<Panel> = {}): Panel {
  return {
    namespace: 'default',
    pod: 'pod',
    phase: PodPhaseRunning,
    color: ColorRunning,
    ...overrides,
  }
}

/**
 * Builds a complete {@link Tower} at grid slot (0, 0) with no Panels. Pass
 * `panels` (e.g. `[makePanel(), …]`) to give it pods, and `grid`/`name` to place
 * and identify it.
 */
export function makeTower(overrides: Partial<Tower> = {}): Tower {
  return {
    name: 'tower',
    grid: { col: 0, row: 0 },
    panels: [],
    ...overrides,
  }
}

/**
 * Builds a complete {@link SceneState}: a Node-mode scene with no Towers by
 * default. Pass `towers` (e.g. `[makeTower(…)]`) and/or `viewMode` to shape it.
 */
export function makeSceneState(overrides: Partial<SceneState> = {}): SceneState {
  return {
    viewMode: ViewModeNode,
    towers: [],
    ...overrides,
  }
}
