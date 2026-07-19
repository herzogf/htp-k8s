import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePodDetail, makeTowerDetail } from '../test-support/sceneFixtures'
import { usePodDetail, useTowerDetail } from './useDetail'

// getApiBaseUrl() derives the origin from window.location by default (see
// config); stub it so the derived base is deterministic regardless of
// jsdom's own default test URL.
const BASE = 'http://localhost:8080'

beforeEach(() => {
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8080' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useTowerDetail', () => {
  it('loads then returns the TowerDetail for the given tower', async () => {
    const payload = makeTowerDetail()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    )

    const { result } = renderHook(() => useTowerDetail('node-a'))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual(payload)
    expect(result.current.error).toBe(false)
  })

  it('requests the selected tower by name', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response('{}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useTowerDetail('node-b'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/towers/node-b`)
  })

  it('surfaces an error state on a failed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )

    const { result } = renderHook(() => useTowerDetail('node-a'))

    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('aborts the in-flight request on unmount', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal)
        return new Response('{}', { status: 200 })
      }),
    )

    const { unmount } = renderHook(() => useTowerDetail('node-a'))
    await waitFor(() => expect(signals).toHaveLength(1))
    unmount()

    expect(signals[0].aborted).toBe(true)
  })
})

describe('usePodDetail', () => {
  it('loads the PodDetail for the given pod identity', async () => {
    const payload = makePodDetail({ containers: [] })
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePodDetail('team', 'web-1'))

    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/pods/team/web-1`)
  })

  it('refetches when the pod identity changes', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response('{}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = renderHook(({ ns, pod }) => usePodDetail(ns, pod), {
      initialProps: { ns: 'team', pod: 'web-1' },
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    rerender({ ns: 'team', pod: 'web-2' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/pods/team/web-2`)
  })
})
