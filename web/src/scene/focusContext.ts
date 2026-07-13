import { createContext, useContext } from 'react'
import { type FocusController } from './focus'

/**
 * FocusContext shares one {@link FocusController} across the scene so a click on
 * a Tower or Panel (in {@link Tower}/{@link Panels}) can hand its target Pose to
 * the camera rig ({@link FreeFlyControls}), which lives elsewhere in the tree.
 * The Provider is rendered inside the R3F `<Canvas>` so it reaches the 3D
 * children. It is `null` by default: a mesh outside a Provider simply can't
 * focus (its {@link useFocus} handle is `null`) rather than crashing.
 */
export const FocusContext = createContext<FocusController | null>(null)

/**
 * The shared {@link FocusController}, or `null` when rendered outside a
 * FocusContext Provider. Click handlers guard on `null` so the scene degrades to
 * "clicks do nothing" rather than throwing if the Provider is ever absent.
 */
export function useFocus(): FocusController | null {
  return useContext(FocusContext)
}
