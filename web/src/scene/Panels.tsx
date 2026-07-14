import { type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { panelSelection } from '../detail/selection'
import { useSelection } from '../detail/selectionContext'
import { type PanelActivity, type Tower } from '../generated/scenestate'
import { blinkStore } from './blinks'
import { panelFocusPose } from './focus'
import { useFocus } from './focusContext'
import {
  PANEL_LOD_FAR_DISTANCE,
  PANEL_LOD_NEAR_DISTANCE,
  PANEL_NAME_BAND,
  PANEL_TEXT_COLUMNS,
  PANEL_TEXT_DARKEN,
  PANEL_TEXT_ROWS,
  PANEL_TEXT_SCROLL_SPEED,
  panelTextPhase,
} from './panelLOD'
import { PANEL_SIZE, panelInstanceIndex, panelInstances, resolvePanel } from './panelLayout'
import { buildPanelTextAtlas, type PanelTextAtlas } from './panelTextAtlas'

/** The color a Panel flashes toward at a blink's peak — pure white, so even an
 * already-saturated phase color (neon green) still visibly brightens. */
const BLINK_FLASH = new THREE.Color(0xffffff)

/**
 * Formats a JS number as a GLSL float literal. WebGL2/GLSL ES 3.00 (what three
 * targets) has no implicit int→float conversion, so a bare integer constant
 * like `PANEL_TEXT_COLUMNS` (`4`) would fail to compile as `vec2(4, ...)`;
 * this guarantees every injected literal carries a decimal point.
 */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`
}

/** The uniforms {@link patchPanelMaterial} adds, stashed on the material so the
 * component can drive them without recompiling: the per-frame scroll clock and
 * the live name-atlas sampler + grid dimensions (swapped when the scene's Pods
 * change). Constructed as three's `THREE.Uniform` *class instances* (not plain
 * `{ value }` literals) so writing `.value` reads to the React compiler as an
 * external-object mutation — the same reason the blink loop may write
 * `instanceColor.needsUpdate` — rather than a React-owned one. */
interface PanelLodUniforms {
  uPanelLodTime: THREE.Uniform<number>
  uPanelNameAtlas: THREE.Uniform<THREE.Texture | null>
  uPanelNameCols: THREE.Uniform<number>
  uPanelNameRows: THREE.Uniform<number>
}

/**
 * Panel text LOD (#25): patches the InstancedMesh's `meshBasicMaterial` shader
 * (via `onBeforeCompile`, the supported way to extend a built-in three.js
 * material) so at close/mid camera distance each Panel shows the Pod's actual,
 * readable name across the top plus the "hinted, illegible scrolling text" glyph
 * fill of the *Hackers* reference stills below it, fading to the plain
 * flat-colored quad (today's baseline look, effectively zero extra cost) beyond
 * {@link PANEL_LOD_FAR_DISTANCE} — a name is unreadable from far anyway.
 *
 * This is deliberately GPU-only: the distance from camera is computed
 * per-fragment from `mvPosition` (already computed by the stock
 * `project_vertex` chunk — view space puts the camera at the origin, so its
 * length *is* the distance, with no extra uniform needed), so there is no
 * per-instance or per-frame JS loop driving the transition — it stays cheap
 * and correctly instance-aware (each instance's own fragments fade
 * independently) however many Panels are on screen. The only thing JS updates
 * per frame is a single scalar time uniform (see the `uPanelLodTime` write in
 * {@link Panels}'s `useFrame`); the per-instance data — a scroll `phase` and a
 * name-atlas `cell` index — is written once per instance-list change (not per
 * frame). The names themselves live in one shared texture atlas (see
 * {@link buildPanelTextAtlas}), so real per-Pod labels cost one extra texture
 * and NO extra draw calls: the single InstancedMesh over all Panels is intact.
 *
 * Only the fragment shader's final color is touched (multiplying
 * `diffuseColor.rgb`, right after the stock `color_fragment` chunk applies the
 * instance's phase color) — the existing instancing/instanceColor/picking
 * pipeline this material already relies on (blink recoloring, click picking) is
 * untouched.
 */
function patchPanelMaterial(
  this: THREE.MeshBasicMaterial,
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  shader.vertexShader = `
attribute float instancePhase;
attribute float instanceNameCell;
varying float vPanelLodDist;
varying float vPanelLodPhase;
varying float vPanelLodCell;
varying vec2 vPanelLodUv;
${shader.vertexShader}`.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
	// Panel LOD (#25): view-space length of the vertex position *is* its
	// distance from the camera (view space is camera-relative), so this needs
	// no extra camera-position uniform.
	vPanelLodDist = length( mvPosition.xyz );
	vPanelLodPhase = instancePhase;
	// Constant across the four verts of an instance's quad, so plain varying
	// interpolation carries the cell index intact — no flat qualifier needed.
	vPanelLodCell = instanceNameCell;
	vPanelLodUv = uv;`,
  )

  const nameAtlas = (this.userData.nameAtlas ?? {}) as {
    texture?: THREE.Texture | null
    cols?: number
    rows?: number
  }

  shader.fragmentShader = `
varying float vPanelLodDist;
varying float vPanelLodPhase;
varying float vPanelLodCell;
varying vec2 vPanelLodUv;
uniform float uPanelLodTime;
uniform sampler2D uPanelNameAtlas;
uniform float uPanelNameCols;
uniform float uPanelNameRows;
${shader.fragmentShader}`.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
	{
		// 1 (full text-like detail) at/below the near threshold, 0 (flat blob) at/
		// beyond the far threshold — the exact curve panelDetailBlend documents
		// and is unit-tested against (panelLOD.ts is this shader's source of truth
		// for the two threshold constants baked in below).
		float lodBlend = 1.0 - smoothstep(${glslFloat(PANEL_LOD_NEAR_DISTANCE)}, ${glslFloat(PANEL_LOD_FAR_DISTANCE)}, vPanelLodDist);
		float lit;
		float nameBandBottom = 1.0 - ${glslFloat(PANEL_NAME_BAND)};
		if ( vPanelLodUv.y > nameBandBottom && vPanelLodCell >= 0.0 && uPanelNameCols > 0.0 ) {
			// Top band: sample this Pod's own cell in the shared name atlas. The
			// cell index → (col,row) → atlas UV maths mirrors buildPanelTextAtlas's
			// grid layout (flipY=false: cell row 0 at the top of the canvas).
			float localU = vPanelLodUv.x;
			float localV = ( vPanelLodUv.y - nameBandBottom ) / ${glslFloat(PANEL_NAME_BAND)};
			float col = mod( vPanelLodCell, uPanelNameCols );
			float row = floor( vPanelLodCell / uPanelNameCols );
			float au = ( col + localU ) / uPanelNameCols;
			float av = ( row + 1.0 - localV ) / uPanelNameRows;
			float glyph = texture2D( uPanelNameAtlas, vec2( au, av ) ).r;
			// Bright phase-color text on a dark version of the same color, so the
			// name is legible AND still encodes the pod's phase by hue.
			lit = mix( 0.14, 1.0, glyph );
		} else {
			// Below the name: the illegible scrolling glyph fill (the Hackers
			// texture). A small, per-instance-offset grid of pseudo-random on/off
			// cells that scrolls over time, out of phase between Panels.
			vec2 cell = floor( vPanelLodUv * vec2( ${glslFloat(PANEL_TEXT_COLUMNS)}, ${glslFloat(PANEL_TEXT_ROWS)} ) );
			float scrollRows = floor( uPanelLodTime * ${glslFloat(PANEL_TEXT_SCROLL_SPEED)} + vPanelLodPhase * ${glslFloat(PANEL_TEXT_ROWS)} );
			float glyphSeed = cell.x + ( cell.y + scrollRows ) * 13.0 + vPanelLodPhase * 97.0;
			float glyphNoise = fract( sin( glyphSeed * 12.9898 ) * 43758.5453 );
			float glyphOn = step( 0.45, glyphNoise );
			// Dim (not black) "off" cells so the phase color reads through.
			lit = mix( ${glslFloat(PANEL_TEXT_DARKEN)}, 1.0, glyphOn );
		}
		// Fade the whole effect out toward the plain flat blob as lodBlend → 0.
		lit = mix( 1.0, lit, lodBlend );
		diffuseColor.rgb *= lit;
	}`,
  )

  shader.uniforms.uPanelLodTime = new THREE.Uniform(0)
  shader.uniforms.uPanelNameAtlas = new THREE.Uniform(nameAtlas.texture ?? null)
  shader.uniforms.uPanelNameCols = new THREE.Uniform(nameAtlas.cols ?? 0)
  shader.uniforms.uPanelNameRows = new THREE.Uniform(nameAtlas.rows ?? 0)
  // Stash this compile's uniforms on the material so the component can update
  // the time uniform per frame and swap in a rebuilt name atlas (on a scene
  // change) without re-deriving or re-compiling anything.
  this.userData.panelLodUniforms = shader.uniforms
}

/**
 * The shape exposed on `window` for the e2e blink test (#19). Blinks fire from
 * transient cluster activity that can't be reproduced deterministically in the
 * static KWOK e2e scene, so this hook lets the test inject one and read the
 * affected instance's rendered color straight from the InstancedMesh's color
 * buffer — the observable effect of the trigger → animation path.
 */
export interface BlinkTestHook {
  /** Every rendered Panel's Pod identity, in instance order — so the test can pick a real one. */
  listPanels: () => Array<{ namespace: string; pod: string }>
  /** Injects a blink for a Pod, exactly as a `panelBlink` delta would (same clock). */
  triggerBlink: (namespace: string, pod: string, activity: PanelActivity) => void
  /**
   * The Pod's Panel instance color as currently written to the mesh, `[r, g, b]`
   * in 0..1, or `null` if that Pod isn't in the scene. During a blink this reads
   * brighter (lerped toward white); once settled it reads the base phase color.
   */
  readColor: (namespace: string, pod: string) => [number, number, number] | null
}

declare global {
  interface Window {
    /**
     * Test-only handle onto the blink channel and the live Panel color buffer.
     * The Panels render into a WebGL InstancedMesh that isn't DOM-queryable, so
     * the Playwright test injects a blink and reads the resulting per-instance
     * brightness through this hook. It ships in the production bundle on purpose:
     * this project's e2e runs against the real built binary (ADR-0004), so a
     * dev-only guard would strip the hook from the very build the test exercises.
     * It only injects a purely-visual, transient pulse and reads a color back —
     * no surface in a read-only cinematic viewer (ADR-0003).
     */
    __htpBlinkTest?: BlinkTestHook
  }
}

/** A Panel's on-screen footprint as fractions of the canvas ([0, 1] on both
 * axes, `y` measured top-down to match image-pixel coordinates), as reported
 * by {@link PanelLodTestHook.getPanelScreenRect}. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The shape exposed on `window` for the e2e Panel text LOD test (#25). The
 * near/mid "hinted, illegible scrolling text" versus far "flat color blob"
 * swap (see {@link patchPanelMaterial}) happens entirely inside a fragment
 * shader — there is no per-instance JS state a test could read the way
 * {@link BlinkTestHook} reads the instance-color buffer, since the LOD detail
 * never touches it. So instead of exposing the *decision*, this exposes just
 * enough geometry for the test to sample the *rendered pixels* of one exact
 * Panel — its own projected on-screen rectangle, independent of the camera's
 * current position or angle — so a screenshot crop never accidentally spans a
 * neighbouring Panel or Tower edge (which would confound "is this panel
 * showing texture" with "are there several differently-colored things here").
 */
export interface PanelLodTestHook {
  /**
   * Projects a Pod's Panel quad to its on-screen {@link ScreenRect} using the
   * live camera, or `null` if that Pod isn't in the scene. Purely a read of
   * already-public scene/camera state (no scene mutation) — a read-only
   * affordance in a read-only viewer (ADR-0003).
   */
  getPanelScreenRect: (namespace: string, pod: string) => ScreenRect | null
}

declare global {
  interface Window {
    __htpPanelLodTest?: PanelLodTestHook
  }
}

/**
 * Panels renders every Pod in the scene as a small glowing rectangle on its
 * Tower's face, drawn as a SINGLE `InstancedMesh` over all Panels across all
 * Towers — the project's scale decision (one draw call for thousands of Pods,
 * not one mesh per Pod or even per Tower). The per-instance placement and color
 * come from {@link panelInstances}, the pure WebGL-free seam (unit-tested in
 * panelLayout.test.ts); this component is the thin renderer that writes that
 * data into the mesh's instance matrix and color buffers.
 *
 * The material is an unlit `meshBasicMaterial` with tone-mapping off, so each
 * Panel reads as a flat neon light at exactly its phase color regardless of
 * scene lighting — the glowing-rectangle look of the reference stills, and a
 * cheap fallback that stays legible at any camera distance.
 *
 * Text LOD (#25) is layered onto that same material via {@link
 * patchPanelMaterial}'s `onBeforeCompile`: close/mid Panels show the Pod's
 * actual (truncated) name as readable text across the top plus a "hinted,
 * illegible scrolling text" glyph fill below, fading to the plain flat blob
 * (this is the far LOD path — no separate code path or draw call) beyond
 * {@link PANEL_LOD_FAR_DISTANCE}. The near/far distance curve, the name
 * truncation rule, and the look's tuning constants are the pure, unit-tested
 * seam in `panelLOD.ts`; the names are rasterized once into a shared texture
 * atlas ({@link buildPanelTextAtlas}) sampled per-instance, so the transition
 * runs entirely on the GPU per-fragment (no per-instance or per-frame JS loop,
 * no extra draw call) and stays cheap and instance-aware however many Panels
 * are in view.
 *
 * Picking is instance-aware from the start: the `panelInstances` list is stashed
 * on the mesh's `userData` in the same order the instances are written, so a
 * later click handler (#20) can turn a hit `instanceId` straight back into the
 * originating Pod via {@link resolvePanel}.
 *
 * Clicking a Panel does two things (#21, #24): the pointer event's `instanceId`
 * is resolved back to its {@link PanelInstance}, that Pod's {@link panelFocusPose}
 * is handed to the shared {@link FocusController} for the camera rig to fly to —
 * close enough to read that specific Panel — and that Pod is selected, opening
 * its in-world Detail Popup (pod detail + live log tail) anchored beside it.
 *
 * Blinks (#19) are the per-instance activity animation: a transient `panelBlink`
 * signal recorded on the out-of-band {@link blinkStore} (not a `SceneState`
 * change — see {@link useSceneState}) makes that one Pod's instance flash brighter
 * and settle back, driven per frame by {@link useFrame} writing into the same
 * instance color buffer the layout pass fills. It is purely visual and touches no
 * scene state, so it is instance-aware for free — only the pulsing Pod's color is
 * modulated, every other Panel is left at its phase color.
 */
export function Panels({ towers }: { towers: readonly Tower[] }) {
  const instances = useMemo(() => panelInstances(towers), [towers])
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)
  // A TYPED handle onto the LOD shader uniforms (captured from the material once
  // it compiles). The per-frame time write goes through this rather than the
  // `any`-typed `material.userData`, so the compiler still sees a three
  // `Uniform` (external) being mutated — the same shape the blink loop mutates
  // through `meshRef` — rather than an opaque React-owned value.
  const lodUniformsRef = useRef<PanelLodUniforms | null>(null)
  const camera = useThree((state) => state.camera)
  const focus = useFocus()
  const { select } = useSelection()
  // The shared per-Pod name texture atlas (#25 follow-up), rebuilt only when the
  // set of Pods changes — one texture for every Panel's label, keeping the whole
  // scene one InstancedMesh. Disposed when replaced / on unmount (effect below).
  const nameAtlas: PanelTextAtlas = useMemo(
    () => buildPanelTextAtlas(instances.map((instance) => instance.pod)),
    [instances],
  )
  useEffect(() => nameAtlas.dispose, [nameAtlas])
  // Whether the previous frame drew any blink. When a blink settles we need one
  // final frame that restores every base color and uploads it; this ref is how
  // that trailing frame is detected so the mesh doesn't stay stuck bright.
  const wasBlinking = useRef(false)
  // Scratch color reused each frame so the blink loop allocates nothing.
  const blinkColor = useRef(new THREE.Color())

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    // Instanced picking: R3F reports which instance the ray hit as `instanceId`;
    // resolve it back to the Pod it was built from (panelLayout stashes the same
    // ordered list on userData). A miss (no instanceId) simply does nothing.
    if (event.instanceId === undefined) {
      return
    }
    const instance = resolvePanel(instances, event.instanceId)
    if (!instance) {
      return
    }
    event.stopPropagation()
    focus?.requestFocus(panelFocusPose(instance.position))
    select(panelSelection(instance))
  }

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh || instances.length === 0) {
      return
    }

    const dummy = new THREE.Object3D()
    const color = new THREE.Color()
    // Panel LOD (#25): each instance's scroll phase, computed once here (not
    // per frame) from its Pod identity, so the shader's glyph pattern (see
    // patchPanelMaterial) can offset that one instance's scroll without every
    // Panel scrolling in lockstep. A fresh buffer sized to the current
    // instance count, same lifecycle as the matrix/color buffers above.
    const phases = new Float32Array(instances.length)
    instances.forEach((instance, i) => {
      dummy.position.set(...instance.position)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      mesh.setColorAt(i, color.set(instance.color))
      phases[i] = panelTextPhase(instance.namespace, instance.pod)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true
    }
    mesh.count = instances.length
    mesh.geometry.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(phases, 1))
    // Panel LOD name atlas (#25 follow-up): the per-instance cell index into the
    // shared name texture, in the same instance order as everything above, so
    // the shader samples each Panel's own Pod name (or -1 → glyph fill for a Pod
    // past atlas capacity). A copy so the geometry owns its own buffer.
    mesh.geometry.setAttribute(
      'instanceNameCell',
      new THREE.InstancedBufferAttribute(nameAtlas.cells.slice(), 1),
    )
    // Hand the atlas to the material both for the first shader compile (read
    // from userData in patchPanelMaterial) and, if it has already compiled, by
    // swapping the live sampler/dimension uniforms in place — no recompile.
    const material = materialRef.current
    if (material) {
      material.userData.nameAtlas = nameAtlas
      const uniforms = (material.userData.panelLodUniforms as PanelLodUniforms | undefined) ?? null
      lodUniformsRef.current = uniforms
      if (uniforms) {
        uniforms.uPanelNameAtlas.value = nameAtlas.texture
        uniforms.uPanelNameCols.value = nameAtlas.cols
        uniforms.uPanelNameRows.value = nameAtlas.rows
      }
    }
    // Stash the ordered instance list so instance-aware picking (#20) can
    // resolve a hit instanceId back to its Pod.
    mesh.userData.panelInstances = instances
  }, [instances, nameAtlas])

  // Panel LOD (#25): advance the shader's scroll clock every frame, regardless
  // of blink activity. This is the ONLY per-frame LOD cost — one scalar
  // uniform write, O(1) in the Panel count, since the near/far distance fade
  // and the glyph pattern itself are evaluated per-fragment on the GPU (see
  // patchPanelMaterial), not looped over instances in JS.
  useFrame(() => {
    const uniforms = lodUniformsRef.current
    if (uniforms) {
      uniforms.uPanelLodTime.value = performance.now() / 1000
    }
  })

  // Drive the transient blink each frame: a Panel with an active pulse in the
  // out-of-band blinkStore (fed by a #18 panelBlink delta, NOT the reducer) is
  // brightened toward white on its ease-out envelope, then settled back to its
  // phase color. Instance-aware: only the pulsing Pods are rewritten; the rest
  // keep the base colors the layout pass wrote. When nothing is (or just was)
  // blinking this returns immediately, so the at-rest scene pays nothing.
  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || !mesh.instanceColor || instances.length === 0) {
      return
    }
    const now = performance.now()
    if (!blinkStore.hasActive(now) && !wasBlinking.current) {
      return
    }

    const color = blinkColor.current
    let anyBlinking = false
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i]
      const intensity = blinkStore.intensityFor(instance.namespace, instance.pod, now)
      if (intensity > 0) {
        anyBlinking = true
        mesh.setColorAt(i, color.set(instance.color).lerp(BLINK_FLASH, intensity))
      } else if (wasBlinking.current) {
        // Settling frame: restore this instance's base phase color.
        mesh.setColorAt(i, color.set(instance.color))
      }
    }
    mesh.instanceColor.needsUpdate = true
    wasBlinking.current = anyBlinking
  })

  // Expose the e2e blink hook: inject a blink and read a Panel instance's live
  // color from the mesh (see BlinkTestHook). Re-created when the instance list
  // changes so listPanels/readColor resolve against the current scene.
  useEffect(() => {
    window.__htpBlinkTest = {
      listPanels: () => instances.map((p) => ({ namespace: p.namespace, pod: p.pod })),
      triggerBlink: (namespace, pod, activity) =>
        blinkStore.trigger(namespace, pod, activity, performance.now()),
      readColor: (namespace, pod) => {
        const mesh = meshRef.current
        if (!mesh || !mesh.instanceColor) {
          return null
        }
        const index = panelInstanceIndex(instances, namespace, pod)
        if (index === undefined) {
          return null
        }
        const color = new THREE.Color()
        mesh.getColorAt(index, color)
        return [color.r, color.g, color.b]
      },
    }
    return () => {
      delete window.__htpBlinkTest
    }
  }, [instances])

  // Expose the e2e Panel LOD hook (#25): project a named Pod's Panel quad to
  // its on-screen rect using the live camera (see PanelLodTestHook), so the
  // test can crop a screenshot to exactly one Panel's own pixels — regardless
  // of where the camera currently is — rather than guessing screen coordinates
  // or risking a crop that spans a neighbour. `camera` is the same mutable
  // object FreeFlyControls/Focus update in place every frame, so re-running
  // this effect on every camera tick isn't needed: each call below reads the
  // camera's current transform at call time.
  useEffect(() => {
    window.__htpPanelLodTest = {
      getPanelScreenRect: (namespace, pod) => {
        const instance = instances.find((p) => p.namespace === namespace && p.pod === pod)
        if (!instance) {
          return null
        }
        const [cx, cy, cz] = instance.position
        const half = PANEL_SIZE / 2
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const [dx, dy] of [
          [-half, -half],
          [half, half],
        ]) {
          const corner = new THREE.Vector3(cx + dx, cy + dy, cz).project(camera)
          const xFrac = (corner.x + 1) / 2
          // NDC y is up; image/pixel y is down.
          const yFrac = (1 - corner.y) / 2
          minX = Math.min(minX, xFrac)
          maxX = Math.max(maxX, xFrac)
          minY = Math.min(minY, yFrac)
          maxY = Math.max(maxY, yFrac)
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      },
    }
    return () => {
      delete window.__htpPanelLodTest
    }
  }, [instances, camera])

  if (instances.length === 0) {
    return null
  }

  return (
    <instancedMesh
      ref={meshRef}
      onClick={onClick}
      // args = [geometry, material, count]; both are declared as children below,
      // so pass undefined and let R3F attach them. Count is the max instances.
      args={[undefined, undefined, instances.length]}
    >
      <planeGeometry args={[PANEL_SIZE, PANEL_SIZE]} />
      <meshBasicMaterial
        ref={materialRef}
        toneMapped={false}
        onBeforeCompile={patchPanelMaterial}
      />
    </instancedMesh>
  )
}
