import {
  type SceneState,
  type ViewMode,
  ViewModeNamespace,
  ViewModeNode,
} from '../generated/scenestate'

/**
 * Parses the raw text of a `/ws` frame into a typed {@link SceneState}, or
 * returns `null` when the frame is not a well-formed snapshot.
 *
 * The backend sends a full `SceneState` JSON snapshot on connect (ADR-0007).
 * We validate only the field this milestone consumes — a present, non-empty
 * string `viewMode` — and deliberately do not constrain the rest of the
 * object, so a snapshot that has grown extra fields (Towers/Panels in later
 * tickets) still parses. Unknown/extra properties are preserved on the
 * returned value and simply ignored by code that doesn't read them.
 */
export function parseSceneState(raw: string): SceneState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'viewMode' in parsed &&
    typeof (parsed as { viewMode: unknown }).viewMode === 'string' &&
    (parsed as { viewMode: string }).viewMode.length > 0
  ) {
    return parsed as SceneState
  }

  return null
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
