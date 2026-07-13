import {
  ColorRunning,
  type ContainerDetail,
  type NamespaceSummary,
  type NodeSummary,
  type Panel,
  type PodDetail,
  PodPhaseRunning,
  type SceneState,
  type Tower,
  type TowerDetail,
  TowerKindNamespace,
  TowerKindNode,
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

/**
 * The on-demand Detail wire-contract factories (issue #24, ADR-0009). Same
 * intent as the Scene factories above: one place the `TowerDetail`/`PodDetail`
 * defaults live, so a new required field on those generated types is a one-line
 * change here rather than a sweep across the detail-popup tests.
 */

/** Builds a complete Node summary for a Node-mode {@link TowerDetail}. */
export function makeNodeSummary(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    ready: true,
    status: 'Ready',
    kubeletVersion: 'v1.31.0',
    os: 'linux',
    architecture: 'amd64',
    cpu: '8',
    memory: '32Gi',
    pods: '110',
    labels: { role: 'worker' },
    podCount: 12,
    ...overrides,
  }
}

/** Builds a complete Namespace/Project summary for a Namespace-mode {@link TowerDetail}. */
export function makeNamespaceSummary(overrides: Partial<NamespaceSummary> = {}): NamespaceSummary {
  return { phase: 'Active', labels: { team: 'x' }, podCount: 4, ...overrides }
}

/**
 * Builds a complete {@link TowerDetail}, defaulting to a Node-mode Tower with a
 * full {@link makeNodeSummary}. For a Namespace-mode fixture pass
 * `{ kind: TowerKindNamespace, node: undefined, namespace: makeNamespaceSummary() }`,
 * or use {@link makeNamespaceTowerDetail}.
 */
export function makeTowerDetail(overrides: Partial<TowerDetail> = {}): TowerDetail {
  return { name: 'node-a', kind: TowerKindNode, node: makeNodeSummary(), ...overrides }
}

/** Builds a Namespace-mode {@link TowerDetail} with a full Namespace summary. */
export function makeNamespaceTowerDetail(overrides: Partial<TowerDetail> = {}): TowerDetail {
  return {
    name: 'team-x',
    kind: TowerKindNamespace,
    namespace: makeNamespaceSummary(),
    ...overrides,
  }
}

/** Builds a complete container status for a {@link makePodDetail}. */
export function makeContainerDetail(overrides: Partial<ContainerDetail> = {}): ContainerDetail {
  return {
    name: 'app',
    image: 'app:1',
    ready: true,
    restartCount: 0,
    state: 'Running',
    ...overrides,
  }
}

/**
 * Builds a complete {@link PodDetail}, defaulting to a healthy single-container
 * Running pod with no events. Pass `containers`/`events` to model other states.
 */
export function makePodDetail(overrides: Partial<PodDetail> = {}): PodDetail {
  return {
    namespace: 'team',
    pod: 'web-1',
    node: 'node-a',
    phase: PodPhaseRunning,
    color: ColorRunning,
    restartCount: 0,
    containers: [makeContainerDetail()],
    events: [],
    ...overrides,
  }
}
