import { describe, expect, it } from 'vitest'
import { type PodDetail, type TowerDetail } from '../generated/scenestate'
import { podDetailRows, summarizeContainers, towerDetailView } from './detailView'

const nodeDetail = (overrides: Partial<TowerDetail> = {}): TowerDetail => ({
  name: 'node-a',
  kind: 'node',
  node: {
    ready: true,
    status: 'Ready',
    kubeletVersion: 'v1.31.0',
    os: 'linux',
    architecture: 'amd64',
    cpu: '8',
    memory: '32Gi',
    pods: '110',
    labels: { role: 'worker', zone: 'a' },
    podCount: 12,
  },
  ...overrides,
})

const namespaceDetail = (overrides: Partial<TowerDetail> = {}): TowerDetail => ({
  name: 'team-x',
  kind: 'namespace',
  namespace: { phase: 'Active', labels: { team: 'x' }, podCount: 4 },
  ...overrides,
})

const podDetail = (overrides: Partial<PodDetail> = {}): PodDetail => ({
  namespace: 'team',
  pod: 'web-1',
  node: 'node-a',
  phase: 'Running',
  color: '#39ff14',
  restartCount: 2,
  containers: [
    { name: 'app', image: 'app:1', ready: true, restartCount: 1, state: 'Running' },
    { name: 'sidecar', image: 'proxy:1', ready: false, restartCount: 1, state: 'Waiting' },
  ],
  events: [],
  ...overrides,
})

describe('towerDetailView', () => {
  it('flattens a Node summary in Node-mode', () => {
    const view = towerDetailView(nodeDetail())

    expect(view.title).toBe('node-a')
    expect(view.kindLabel).toBe('Node')
    expect(view.degraded).toBe(false)
    expect(view.rows).toContainEqual({ label: 'Status', value: 'Ready' })
    expect(view.rows).toContainEqual({ label: 'Pods', value: '12' })
    expect(view.rows).toContainEqual({ label: 'Kubelet', value: 'v1.31.0' })
    expect(view.rows).toContainEqual({ label: 'OS / Arch', value: 'linux / amd64' })
    expect(view.rows).toContainEqual({ label: 'Labels', value: '2' })
  })

  it('flattens a Namespace/Project summary in Namespace-mode', () => {
    const view = towerDetailView(namespaceDetail())

    expect(view.kindLabel).toBe('Namespace / Project')
    expect(view.degraded).toBe(false)
    expect(view.rows).toContainEqual({ label: 'Phase', value: 'Active' })
    expect(view.rows).toContainEqual({ label: 'Pods', value: '4' })
  })

  it('reads the kind discriminator, not just whichever summary is present', () => {
    // A node-kind tower with no node summary must not fall through to namespace.
    const view = towerDetailView({ name: 'node-a', kind: 'node' })

    expect(view.kindLabel).toBe('Node')
    expect(view.degraded).toBe(true)
    expect(view.rows).toEqual([])
  })

  it('flags the ADR-0002 degraded case when a namespace summary is absent', () => {
    const view = towerDetailView({ name: 'team-x', kind: 'namespace' })

    expect(view.degraded).toBe(true)
    expect(view.rows).toEqual([])
  })

  it('falls back to Unknown phase when the namespace phase is empty', () => {
    const view = towerDetailView(
      namespaceDetail({ namespace: { phase: '', labels: {}, podCount: 0 } }),
    )

    expect(view.rows).toContainEqual({ label: 'Phase', value: 'Unknown' })
  })
})

describe('podDetailRows', () => {
  it('surfaces the key pod fields', () => {
    const rows = podDetailRows(podDetail())

    expect(rows).toContainEqual({ label: 'Namespace', value: 'team' })
    expect(rows).toContainEqual({ label: 'Phase', value: 'Running' })
    expect(rows).toContainEqual({ label: 'Node', value: 'node-a' })
    expect(rows).toContainEqual({ label: 'Restarts', value: '2' })
    expect(rows).toContainEqual({ label: 'Containers', value: '1/2 ready' })
  })

  it('shows a dash for an unscheduled pod (no node)', () => {
    const rows = podDetailRows(podDetail({ node: '' }))

    expect(rows).toContainEqual({ label: 'Node', value: '—' })
  })
})

describe('summarizeContainers', () => {
  it('counts ready over total', () => {
    expect(summarizeContainers(podDetail())).toBe('1/2 ready')
  })

  it('reports 0/0 for a pod with no containers', () => {
    expect(summarizeContainers(podDetail({ containers: [] }))).toBe('0/0 ready')
  })
})
