import { createContext, useContext } from 'react'
import { type Selection } from './selection'

/**
 * The shared Detail Popup selection: what a Tower/Panel click has selected and
 * the handlers to change it. Mirrors the {@link import('../scene/focusContext')}
 * FocusContext pattern — a click inside the R3F `<Canvas>` (in `Tower`/`Panels`)
 * both flies the camera (Focus, #74) and, through this context, opens the Detail
 * Popup for what it clicked. Unlike the imperative Focus hand-off, selection is
 * React state so the popup layer re-renders when it changes.
 *
 * The Provider is rendered inside the `<Canvas>` so it reaches both the clickable
 * meshes and the in-world `Html` popup layer (both live in R3F's tree). It
 * defaults to a no-op inert value: a mesh outside a Provider simply can't open a
 * popup rather than crashing.
 */
export interface SelectionApi {
  /** The currently selected Tower/Panel, or `null` when no popup is open. */
  selection: Selection | null
  /** Select a Tower/Panel, opening (or switching) its Detail Popup. */
  select(selection: Selection): void
  /** Close the Detail Popup (Escape, a close affordance, or a click on empty space). */
  clear(): void
}

const INERT: SelectionApi = {
  selection: null,
  select: () => {},
  clear: () => {},
}

export const SelectionContext = createContext<SelectionApi>(INERT)

/** The shared {@link SelectionApi}. Inert (no-op) outside a Provider. */
export function useSelection(): SelectionApi {
  return useContext(SelectionContext)
}
