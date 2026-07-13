import type {
  GridPosition,
  Panel,
  PanelActivity,
  SceneDelta as WireSceneDelta,
  Tower,
} from '../generated/scenestate'

/**
 * The kinds of Scene Delta the backend emits after the initial snapshot
 * (ADR-0007). A hand-written literal union, deliberately narrower than the
 * generated wire type's `SceneDeltaType` (which tygo emits as a bare `string`):
 * this is the discriminant a reducer switches on.
 */
export type SceneDeltaType =
  | 'towerAdded'
  | 'towerRemoved'
  | 'towerMoved'
  | 'panelAdded'
  | 'panelUpdated'
  | 'panelRemoved'
  | 'panelBlink'

/**
 * A Scene Delta as the frontend models it: a true discriminated union with the
 * exact fields each kind carries. This is the internal, ergonomic counterpart
 * to the generated {@link WireSceneDelta}, whose fields are all optional because
 * tygo cannot express a Go tagged-union struct as a TS union. Narrow a wire
 * delta into this shape at the boundary with {@link parseSceneDelta}; downstream
 * code (the reconciliation reducer, issue #17) consumes only this type and gets
 * exhaustiveness and per-kind field typing for free.
 */
export type SceneDelta =
  | { type: 'towerAdded'; tower: Tower }
  | { type: 'towerRemoved'; towerName: string }
  | { type: 'towerMoved'; towerName: string; grid: GridPosition }
  | { type: 'panelAdded'; towerName: string; panel: Panel }
  | { type: 'panelUpdated'; towerName: string; panel: Panel }
  | { type: 'panelRemoved'; towerName: string; namespace: string; pod: string }
  | {
      type: 'panelBlink'
      towerName: string
      namespace: string
      pod: string
      activity: PanelActivity
    }

/**
 * Narrows a raw wire Scene Delta into the typed {@link SceneDelta} union, or
 * returns `null` for a payload this frontend can't use. This is the single
 * trust boundary between the loosely-typed wire (every field optional) and the
 * strict internal model: it verifies the fields each kind actually requires are
 * present and well-typed before asserting the narrowed member.
 *
 * A `null` result — logged with `console.warn`, never thrown — covers both a
 * malformed payload (a kind missing a required field) and an unknown/future
 * `type` this build doesn't recognize. Returning `null` rather than throwing is
 * graceful degradation (ADR-0002's spirit on the wire): one bad or
 * newer-than-us delta is skipped, the stream and scene survive, and the client
 * recovers fully on its next reconnect snapshot.
 */
export function parseSceneDelta(raw: WireSceneDelta): SceneDelta | null {
  // The wire discriminant is typed `string`; treat it as our literal union so
  // the switch narrows and its default is exhaustiveness-checked below.
  const type = raw.type as SceneDeltaType

  switch (type) {
    case 'towerAdded':
      if (isTower(raw.tower)) {
        return { type, tower: raw.tower }
      }
      break
    case 'towerRemoved':
      if (isNonEmptyString(raw.towerName)) {
        return { type, towerName: raw.towerName }
      }
      break
    case 'towerMoved':
      if (isNonEmptyString(raw.towerName) && isGridPosition(raw.grid)) {
        return { type, towerName: raw.towerName, grid: raw.grid }
      }
      break
    case 'panelAdded':
      if (isNonEmptyString(raw.towerName) && isPanel(raw.panel)) {
        return { type, towerName: raw.towerName, panel: raw.panel }
      }
      break
    case 'panelUpdated':
      if (isNonEmptyString(raw.towerName) && isPanel(raw.panel)) {
        return { type, towerName: raw.towerName, panel: raw.panel }
      }
      break
    case 'panelRemoved':
      if (
        isNonEmptyString(raw.towerName) &&
        isNonEmptyString(raw.namespace) &&
        isNonEmptyString(raw.pod)
      ) {
        return { type, towerName: raw.towerName, namespace: raw.namespace, pod: raw.pod }
      }
      break
    case 'panelBlink':
      // A transient activity pulse (ADR-0007): identified like panelRemoved by
      // (towerName, namespace, pod), plus the activity kind that shapes the
      // flash. It carries no scene state and never reaches the reducer — it is
      // routed to the visual blink channel in useSceneState.
      if (
        isNonEmptyString(raw.towerName) &&
        isNonEmptyString(raw.namespace) &&
        isNonEmptyString(raw.pod) &&
        isNonEmptyString(raw.activity)
      ) {
        return {
          type,
          towerName: raw.towerName,
          namespace: raw.namespace,
          pod: raw.pod,
          activity: raw.activity,
        }
      }
      break
    default: {
      // Exhaustiveness guard: if a new SceneDeltaType is added above without a
      // case here, `type` stops being `never` and this fails to compile. At
      // runtime this branch also catches an unknown/future wire `type`.
      const _exhaustive: never = type
      void _exhaustive
      console.warn(`ignoring Scene Delta with unknown type: ${JSON.stringify(raw.type)}`)
      return null
    }
  }

  // Reached only when the kind was recognized but its required fields were
  // missing or malformed.
  console.warn(`ignoring malformed "${type}" Scene Delta`, raw)
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isGridPosition(value: unknown): value is GridPosition {
  return isRecord(value) && typeof value.col === 'number' && typeof value.row === 'number'
}

function isPanel(value: unknown): value is Panel {
  return (
    isRecord(value) &&
    isNonEmptyString(value.pod) &&
    typeof value.namespace === 'string' &&
    typeof value.phase === 'string' &&
    typeof value.color === 'string'
  )
}

function isTower(value: unknown): value is Tower {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isGridPosition(value.grid) &&
    Array.isArray(value.panels) &&
    value.panels.every(isPanel)
  )
}
