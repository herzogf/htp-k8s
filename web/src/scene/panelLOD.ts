import { panelKey } from './blinks'
import { TOWER_SPACING } from './towerLayout'

/**
 * The pure, WebGL-free core of Panel text LOD (#25): given a camera distance,
 * how much "hinted, illegible scrolling text" detail (CONTEXT.md's Panel look,
 * matching the *Hackers* reference stills) a Panel should show versus falling
 * back to a flat color blob for render cost. Kept separate from the renderer
 * ({@link Panels}) so the distance → detail curve and the look's tuning
 * constants are unit-tested without a renderer; the actual text-like pattern is
 * drawn entirely in a fragment shader (no per-instance JS work, no per-frame
 * allocation — see {@link Panels}), so this module's job is to be the single
 * source of truth for the numbers that shader mirrors, not to run every frame
 * itself.
 */

/**
 * PANEL_LOD_NEAR_DISTANCE is the camera distance (world units, from a Panel) at
 * and below which a Panel shows full text-like detail — comfortably covering
 * both a Focus fly-to on a single Panel ({@link PANEL_VIEW_DISTANCE}, much
 * closer) and casual close-range free-fly past a Tower face.
 */
export const PANEL_LOD_NEAR_DISTANCE = TOWER_SPACING * 0.75

/**
 * PANEL_LOD_FAR_DISTANCE is the camera distance beyond which a Panel is a fully
 * flat color blob — no shader-side text pattern is evaluated at all. Kept a
 * modest multiple of {@link TOWER_SPACING} past {@link PANEL_LOD_NEAR_DISTANCE}
 * so the transition reads as a deliberate near/far LOD swap (acceptance
 * criteria #1/#2) rather than a hair-trigger flicker while flying at a
 * middling distance, and so the scene's default wide establishing shot (many
 * tower-spacings out) settles on the cheap blob path.
 */
export const PANEL_LOD_FAR_DISTANCE = TOWER_SPACING * 2

/**
 * PANEL_TEXT_COLUMNS / PANEL_TEXT_ROWS is the glyph grid a Panel's "hinted,
 * illegible scrolling text" pattern is divided into — small enough that
 * individual cells never resolve into actual legible characters (CONTEXT.md:
 * "hinted/illegible"), just a blocky dot-matrix-display texture.
 */
export const PANEL_TEXT_COLUMNS = 4
export const PANEL_TEXT_ROWS = 7

/**
 * PANEL_TEXT_SCROLL_SPEED is how fast the glyph grid scrolls, in grid rows per
 * second — the "scrolling" half of the look. Deliberately not synced across
 * Panels (see {@link panelTextPhase}), so a wall of Panels doesn't scroll in
 * lockstep like a single shared readout.
 */
export const PANEL_TEXT_SCROLL_SPEED = 1.4

/**
 * PANEL_TEXT_DARKEN is how much an "off" glyph cell dims a Panel's phase color
 * (multiplied into it), on a 0..1 scale. Dimming rather than blacking out keeps
 * the Panel's phase color legible at a glance even up close — the text pattern
 * reads as texture on top of the color, not a replacement for it.
 */
export const PANEL_TEXT_DARKEN = 0.32

/**
 * smoothstep is GLSL's classic cubic Hermite interpolation: 0 at/below `edge0`,
 * 1 at/above `edge1`, and a smooth (zero-derivative-at-both-ends) ease between.
 * Reimplemented here (rather than depending on three.js's MathUtils) so this
 * module has zero WebGL-adjacent imports, and so its exact formula is the one
 * {@link panelDetailBlend}'s doc comment promises matches the fragment shader's
 * own `smoothstep(uLodNear, uLodFar, dist)` call — the two are meant to be
 * read side by side.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * The detail blend for a Panel at `distance` world units from the camera: `1`
 * at/below `near` (full text-like detail), `0` at/above `far` (a fully flat
 * color blob), eased smoothly in between so flying through the transition band
 * doesn't pop. This is the "camera-distance → detail level" decision itself —
 * the pure seam this module exists to make unit-testable — and it is a direct
 * match for the fragment shader's `1.0 - smoothstep(uLodNear, uLodFar, dist)`,
 * evaluated per-fragment on the GPU so no per-instance or per-frame JS work is
 * needed to drive it (see {@link Panels}).
 *
 * Defaults to this module's tuned {@link PANEL_LOD_NEAR_DISTANCE}/
 * {@link PANEL_LOD_FAR_DISTANCE}; the explicit parameters exist so a test can
 * probe the curve's shape independent of the current tuning.
 */
export function panelDetailBlend(
  distance: number,
  near: number = PANEL_LOD_NEAR_DISTANCE,
  far: number = PANEL_LOD_FAR_DISTANCE,
): number {
  return 1 - smoothstep(near, far, distance)
}

/**
 * A deterministic pseudo-random phase in `[0, 1)` for a Pod's Panel, derived
 * from its cluster-unique `(namespace, pod)` identity via the same
 * {@link panelKey} the blink store uses. The shader's scrolling glyph pattern
 * offsets its scroll position by this per-instance phase, so a wall of Panels
 * scrolls out of sync with its neighbours rather than as one shared readout —
 * purely a look decision, computed once (not per frame) and written into a
 * per-instance buffer attribute by the renderer.
 *
 * A simple FNV-1a hash over the key: fast, dependency-free, and — crucially —
 * stable across runs/processes (unlike `Math.random()`), so the same Pod always
 * gets the same phase without threading any state.
 */
export function panelTextPhase(namespace: string, pod: string): number {
  const key = panelKey(namespace, pod)
  let hash = 0x811c9dc5 // FNV-1a 32-bit offset basis
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) // FNV-1a 32-bit prime
  }
  // Force unsigned before normalizing, so the result always lands in [0, 1).
  return (hash >>> 0) / 0x100000000
}
