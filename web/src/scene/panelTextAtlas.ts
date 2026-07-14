import * as THREE from 'three'
import { PANEL_NAME_MAX_CHARS, truncatePanelName } from './panelLOD'

/**
 * The per-Pod name text atlas (#25 follow-up): the piece that lets every Panel
 * show its Pod's *actual, readable* name while the whole scene stays a SINGLE
 * `InstancedMesh` (the scale decision — see panelLayout.ts / findings.md).
 *
 * Real per-instance text can't be a mesh per Pod without giving up instancing,
 * so instead every Pod's (truncated) name is rasterized ONCE into a shared
 * canvas texture — a grid of fixed-size cells, one cell per Pod — and the
 * Panels shader samples the right cell per instance via a per-instance cell
 * index stored in an `instanceNameCell` buffer attribute (alongside
 * `instancePhase`). One texture, one draw call, no per-frame text work; the
 * atlas is rebuilt only when the set of Pods changes.
 *
 * Capacity is bounded by {@link ATLAS_MAX_DIM} (a conservatively-portable max
 * texture size). Pods beyond that get a cell index of -1 and the shader falls
 * back to the glyph fill for them — graceful degradation at extreme scale
 * rather than a hard cap or a blown texture allocation. The modest e2e scene
 * and any realistic node/namespace view are comfortably within capacity.
 */

/**
 * CELL_W / CELL_H is one atlas cell's pixel size. Their ~3.5:1 aspect matches
 * the Panel's name-band aspect (a square Panel's top {@link PANEL_NAME_BAND}
 * strip), so the rasterized name maps onto the Panel without horizontal or
 * vertical stretching.
 */
const CELL_W = 256
const CELL_H = 72

/** Font pixel size and left padding used to rasterize a name into its cell.
 * Monospace so {@link PANEL_NAME_MAX_CHARS} characters have a predictable width
 * that fits `CELL_W` with room to spare. */
const FONT_PX = 28
const PAD_X = 12

/**
 * ATLAS_MAX_DIM caps the atlas canvas in either dimension. 4096 is supported
 * essentially everywhere WebGL2 runs (including headless Chromium's software
 * renderer used in e2e), so the atlas never fails to allocate; Pods past the
 * resulting capacity degrade to the glyph fill (cell index -1).
 */
const ATLAS_MAX_DIM = 4096

/**
 * The grid shape for `count` cells: how many columns and rows of cells the
 * atlas is arranged into, and the resulting `capacity` (cells that fit within
 * {@link ATLAS_MAX_DIM}). A roughly-square layout (`cols ≈ √count`) keeps both
 * atlas dimensions small. Pure and dependency-free, so it is unit-testable
 * without a canvas.
 */
export function atlasGrid(count: number): { cols: number; rows: number; capacity: number } {
  const maxCols = Math.max(1, Math.floor(ATLAS_MAX_DIM / CELL_W))
  const maxRows = Math.max(1, Math.floor(ATLAS_MAX_DIM / CELL_H))
  if (count <= 0) {
    return { cols: 1, rows: 1, capacity: 0 }
  }
  const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(count))))
  const rows = Math.min(maxRows, Math.ceil(count / cols))
  return { cols, rows, capacity: cols * rows }
}

/**
 * The built atlas: the texture to bind, the per-instance cell indices to write
 * into the `instanceNameCell` attribute (in the same order as `names`), and the
 * grid shape the shader needs to turn a cell index into cell UVs. `dispose`
 * frees the GPU texture when the atlas is replaced or the scene unmounts.
 */
export interface PanelTextAtlas {
  /** The rasterized-names texture, or `null` when there are no names to draw
   * (empty scene) or no 2D canvas is available (non-browser test env). */
  texture: THREE.Texture | null
  /** Per-instance cell index into the atlas, or -1 for a Pod past capacity. */
  cells: Float32Array
  /** Atlas grid width in cells. */
  cols: number
  /** Atlas grid height in cells. */
  rows: number
  /** Releases the GPU texture. Safe to call when `texture` is null. */
  dispose: () => void
}

/**
 * Rasterizes each name (truncated by {@link truncatePanelName} to
 * {@link PANEL_NAME_MAX_CHARS}) into a cell of a shared atlas texture, returning
 * the texture plus the per-instance cell indices the Panels shader samples with.
 *
 * Names are drawn white-on-black; the shader reads the red channel as a 0..1
 * text mask (text = bright phase color, background = dark), so the Pod's phase
 * color still reads through the label. `flipY = false` keeps cell row 0 at the
 * top of the canvas, matching the shader's cell → UV math. In a non-DOM test
 * environment (no `document`) it returns a null texture with valid cell indices,
 * so callers stay renderer-agnostic.
 */
export function buildPanelTextAtlas(names: readonly string[]): PanelTextAtlas {
  const { cols, rows, capacity } = atlasGrid(names.length)
  const cells = new Float32Array(names.length)
  for (let i = 0; i < names.length; i++) {
    cells[i] = i < capacity ? i : -1
  }

  const ctx = names.length > 0 ? create2DContext(cols * CELL_W, rows * CELL_H) : null
  if (!ctx) {
    return { texture: null, cells, cols, rows, dispose: () => {} }
  }

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, cols * CELL_W, rows * CELL_H)
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${FONT_PX}px "DejaVu Sans Mono", "Liberation Mono", monospace`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  for (let i = 0; i < names.length && i < capacity; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const text = truncatePanelName(names[i], PANEL_NAME_MAX_CHARS)
    ctx.fillText(text, col * CELL_W + PAD_X, row * CELL_H + CELL_H / 2)
  }

  const texture = new THREE.CanvasTexture(ctx.canvas)
  // Cell row 0 must sit at the top of the canvas for the shader's UV math.
  texture.flipY = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  // A text mask, not a color map: don't sRGB-decode it.
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true

  return { texture, cells, cols, rows, dispose: () => texture.dispose() }
}

/** Creates a 2D canvas context of the given pixel size, or `null` when no DOM
 * canvas is available (e.g. jsdom without a 2D backend) — the signal the caller
 * uses to fall back to a null texture. */
function create2DContext(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.getContext('2d')
}
