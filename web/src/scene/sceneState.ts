import {
  type SceneDelta as WireSceneDelta,
  type SceneState,
  type ViewMode,
  ViewModeNamespace,
  ViewModeNode,
} from '../generated/scenestate'
import { parseSceneDelta, type SceneDelta } from './sceneDelta'

/**
 * A parsed `/ws` frame, routed to the one kind it is. The backend sends two
 * kinds of text frame on the same socket (ADR-0007): a full `SceneState`
 * snapshot on connect (and reconnect), then a stream of incremental
 * `SceneDelta` messages. They are told apart structurally — a delta carries a
 * `type` discriminant, a snapshot does not (it carries `viewMode`/`towers`) —
 * so the frontend never needs an out-of-band frame tag.
 */
export type SceneFrame =
  { kind: 'snapshot'; snapshot: SceneState } | { kind: 'delta'; delta: SceneDelta }

/**
 * Parses and routes the raw text of a `/ws` frame into a {@link SceneFrame}, or
 * returns `null` when the frame is neither a well-formed snapshot nor a usable
 * delta (malformed JSON, an unknown delta kind, or a snapshot missing its
 * `viewMode`). This is the single boundary where the loosely-typed wire becomes
 * the frontend's typed model; downstream code (the {@link useSceneState} hook)
 * consumes only the routed result.
 *
 * A delta is recognized by its `type` field and narrowed with
 * {@link parseSceneDelta}; anything else is treated as a candidate snapshot.
 * `null` is returned rather than thrown, so a single bad frame is skipped and
 * the stream survives (the client recovers fully on its next reconnect
 * snapshot).
 */
export function parseSceneFrame(raw: string): SceneFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isRecord(parsed)) {
    return null
  }

  // A delta is discriminated by a string `type`; the snapshot carries none.
  // parseSceneDelta re-validates every field, so handing it the loosely-typed
  // wire object (cast via unknown, as its remaining fields are all optional) is
  // exactly the trust boundary it is built for.
  if (typeof parsed.type === 'string') {
    const delta = parseSceneDelta(parsed as unknown as WireSceneDelta)
    return delta === null ? null : { kind: 'delta', delta }
  }

  return isSceneStateSnapshot(parsed) ? { kind: 'snapshot', snapshot: parsed } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reports whether a parsed value is a usable SceneState snapshot: an object with
 * a present, non-empty string `viewMode`. Only that field is validated (the one
 * the frontend routes on and always reads) — the rest of the object is left
 * unconstrained, so a snapshot that has grown extra fields still parses and its
 * extra properties are preserved for code that reads them.
 */
function isSceneStateSnapshot(value: unknown): value is SceneState {
  return isRecord(value) && typeof value.viewMode === 'string' && value.viewMode.length > 0
}

/**
 * Maps a detected {@link ViewMode} to a human-readable label for the on-screen
 * View Mode indicator. Falls back to a self-describing label for any value the
 * frontend doesn't recognize, so an unexpected mode is visible rather than
 * silently blank.
 */
export function viewModeLabel(viewMode: ViewMode): string {
  switch (viewMode) {
    case ViewModeNode:
      return 'Node view'
    case ViewModeNamespace:
      return 'Namespace / Project view'
    default:
      return `Unknown view mode (${viewMode})`
  }
}
