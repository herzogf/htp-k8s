import {
  type PodDetail,
  type TowerDetail,
  TowerKindNamespace,
  TowerKindNode,
} from '../generated/scenestate'

/**
 * Maps the raw Detail wire payloads (ADR-0009) to the flat label/value rows the
 * Detail Popup renders. This is the pure, WebGL-free presentation seam — it
 * resolves the {@link TowerDetail} `kind` discriminator (Node vs
 * Namespace/Project), handles the ADR-0002 degraded case where a summary is
 * absent, and formats the pod's key fields — all unit-tested without a renderer,
 * so the popup components stay thin.
 */

/** One label/value line in a Detail Popup's summary table. */
export interface DetailRow {
  label: string
  value: string
}

/** A Tower popup's rendered content: a heading plus its summary rows. */
export interface TowerDetailView {
  /** The Tower's name — the popup heading. */
  title: string
  /** What the Tower represents: "Node" or "Namespace / Project". */
  kindLabel: string
  /** The flattened summary rows, or empty when the summary is unavailable. */
  rows: DetailRow[]
  /**
   * True when the Tower is known but its summary payload is absent — the
   * ADR-0002 degraded case (e.g. a Node a namespace-scoped user may not Get).
   */
  degraded: boolean
}

/**
 * Flattens a {@link TowerDetail} into its popup view. Reads the `kind`
 * discriminator to pick the Node or Namespace/Project summary; when the matching
 * summary is nil (the degraded read) it returns no rows and flags `degraded` so
 * the popup can say "details unavailable" instead of rendering blanks.
 */
export function towerDetailView(detail: TowerDetail): TowerDetailView {
  if (detail.kind === TowerKindNode) {
    const node = detail.node
    return {
      title: detail.name,
      kindLabel: 'Node',
      degraded: !node,
      rows: node
        ? [
            { label: 'Status', value: node.status },
            { label: 'Pods', value: String(node.podCount) },
            { label: 'Kubelet', value: node.kubeletVersion || '—' },
            { label: 'OS / Arch', value: joinNonEmpty([node.os, node.architecture], ' / ') },
            {
              label: 'Capacity',
              value: `${node.cpu} CPU · ${node.memory} mem · ${node.pods} pods`,
            },
            { label: 'Labels', value: String(countKeys(node.labels)) },
          ]
        : [],
    }
  }

  if (detail.kind === TowerKindNamespace) {
    const ns = detail.namespace
    return {
      title: detail.name,
      kindLabel: 'Namespace / Project',
      degraded: !ns,
      rows: ns
        ? [
            { label: 'Phase', value: ns.phase || 'Unknown' },
            { label: 'Pods', value: String(ns.podCount) },
            { label: 'Labels', value: String(countKeys(ns.labels)) },
          ]
        : [],
    }
  }

  // Unknown/absent kind: still show the name, with no summary rows.
  return { title: detail.name, kindLabel: detail.kind || 'Tower', degraded: true, rows: [] }
}

/** A Pod popup's rendered summary rows (containers and events render separately). */
export function podDetailRows(detail: PodDetail): DetailRow[] {
  return [
    { label: 'Namespace', value: detail.namespace },
    { label: 'Phase', value: detail.phase },
    { label: 'Node', value: detail.node || '—' },
    { label: 'Restarts', value: String(detail.restartCount) },
    { label: 'Containers', value: summarizeContainers(detail) },
  ]
}

/** "2/3 ready" — ready container count over total, the at-a-glance health line. */
export function summarizeContainers(detail: PodDetail): string {
  const total = detail.containers.length
  const ready = detail.containers.filter((container) => container.ready).length
  return `${ready}/${total} ready`
}

function countKeys(map: { [key: string]: string } | undefined): number {
  return map ? Object.keys(map).length : 0
}

function joinNonEmpty(parts: string[], separator: string): string {
  const kept = parts.filter((part) => part.length > 0)
  return kept.length > 0 ? kept.join(separator) : '—'
}
