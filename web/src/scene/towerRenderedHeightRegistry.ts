/**
 * A tiny module-level registry that {@link Tower} publishes its OWN actually-
 * rendered prism height into, keyed by Tower name — read by
 * `__htpDetailTest.towerRenderedHeights()` (issue #29's nightly busy-vs-sparse
 * "identical height" visual guard).
 *
 * Deliberately NOT sourced by re-calling `sceneTowerHeight` a second time (the
 * same function `Scene.tsx` already calls once to compute the single shared
 * `towerHeight` variable it hands every `<Tower>`): a test hook that just
 * re-derives that same scalar is tautological — it can never disagree with
 * itself even if a real rendering bug left two specific Tower *instances*
 * drawn at different heights (a stale prop, a React key/memoization bug, a
 * future refactor that lets a Tower compute its own height instead of taking
 * the scene-wide one). Reading back what each Tower's OWN `<boxGeometry>`
 * actually resolved `height` to, from inside {@link Tower} itself, is the
 * only signal that would catch that class of regression — see Tower.tsx's
 * own effect that populates this registry.
 */
const registry = new Map<string, number>()

/** Publishes (or updates) `name`'s actually-rendered prism height. */
export function setTowerRenderedHeight(name: string, height: number): void {
  registry.set(name, height)
}

/** Removes `name` from the registry — called on that Tower's unmount. */
export function clearTowerRenderedHeight(name: string): void {
  registry.delete(name)
}

/** A snapshot of every currently-mounted Tower's real, rendered prism height. */
export function towerRenderedHeights(): { name: string; height: number }[] {
  return [...registry.entries()].map(([name, height]) => ({ name, height }))
}
