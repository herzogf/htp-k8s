import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PodDetail, type TowerDetail } from '../generated/scenestate'
import {
  fetchPodDetail,
  fetchTowerDetail,
  logTailUrl,
  parseLogTailFrame,
  podDetailUrl,
  towerDetailUrl,
} from './detailApi'

const BASE = 'http://localhost:8080'

describe('detail endpoint URLs', () => {
  it('builds the tower detail url', () => {
    expect(towerDetailUrl(BASE, 'node-a')).toBe('http://localhost:8080/api/towers/node-a')
  })

  it('builds the pod detail url', () => {
    expect(podDetailUrl(BASE, 'team', 'web-1')).toBe('http://localhost:8080/api/pods/team/web-1')
  })

  it('builds the log-tail url off the pod detail url', () => {
    expect(logTailUrl(BASE, 'team', 'web-1')).toBe(
      'http://localhost:8080/api/pods/team/web-1/logtail',
    )
  })

  it('percent-encodes path segments so odd names stay in-path', () => {
    expect(towerDetailUrl(BASE, 'a/b')).toBe('http://localhost:8080/api/towers/a%2Fb')
    expect(podDetailUrl(BASE, 'ns space', 'pod#1')).toBe(
      'http://localhost:8080/api/pods/ns%20space/pod%231',
    )
  })
})

describe('fetchTowerDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the tower url and returns the parsed TowerDetail', async () => {
    const payload: TowerDetail = { name: 'node-a', kind: 'node' }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const detail = await fetchTowerDetail(BASE, 'node-a')

    expect(fetchMock).toHaveBeenCalledWith(towerDetailUrl(BASE, 'node-a'), { signal: undefined })
    expect(detail).toEqual(payload)
  })

  it('rejects on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )

    await expect(fetchTowerDetail(BASE, 'node-a')).rejects.toThrow(/500/)
  })

  it('forwards an abort signal so a closing popup can cancel the fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await fetchTowerDetail(BASE, 'node-a', controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(towerDetailUrl(BASE, 'node-a'), {
      signal: controller.signal,
    })
  })
})

describe('fetchPodDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the pod url and returns the parsed PodDetail', async () => {
    const payload: PodDetail = {
      namespace: 'team',
      pod: 'web-1',
      node: 'node-a',
      phase: 'Running',
      color: '#39ff14',
      restartCount: 0,
      containers: [],
      events: [],
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const detail = await fetchPodDetail(BASE, 'team', 'web-1')

    expect(fetchMock).toHaveBeenCalledWith(podDetailUrl(BASE, 'team', 'web-1'), {
      signal: undefined,
    })
    expect(detail).toEqual(payload)
  })

  it('rejects on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )

    await expect(fetchPodDetail(BASE, 'team', 'web-1')).rejects.toThrow(/404/)
  })
})

describe('parseLogTailFrame', () => {
  it('returns the lines from a valid LogTail frame', () => {
    expect(parseLogTailFrame(JSON.stringify({ lines: ['a', 'b', 'c'] }))).toEqual(['a', 'b', 'c'])
  })

  it('accepts an empty window', () => {
    expect(parseLogTailFrame(JSON.stringify({ lines: [] }))).toEqual([])
  })

  it('returns null for malformed json', () => {
    expect(parseLogTailFrame('not json')).toBeNull()
  })

  it('returns null when lines is missing or not an array', () => {
    expect(parseLogTailFrame(JSON.stringify({}))).toBeNull()
    expect(parseLogTailFrame(JSON.stringify({ lines: 'oops' }))).toBeNull()
  })
})
