import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '../test-support/fakeEventSource'
import { useLogTail } from './useLogTail'

// getApiBaseUrl() with no VITE_WS_URL derives http://localhost:8080 (see config).
const BASE = 'http://localhost:8080'

beforeEach(() => {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useLogTail', () => {
  it('opens an EventSource to the pod log-tail endpoint', () => {
    renderHook(() => useLogTail('team', 'web-1'))

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe(`${BASE}/api/pods/team/web-1/logtail`)
  })

  it('starts with an empty window', () => {
    const { result } = renderHook(() => useLogTail('team', 'web-1'))

    expect(result.current).toEqual([])
  })

  it('replaces the window whole with each frame received', () => {
    const { result } = renderHook(() => useLogTail('team', 'web-1'))
    const source = FakeEventSource.instances[0]

    act(() => source.emit(JSON.stringify({ lines: ['line 1'] })))
    expect(result.current).toEqual(['line 1'])

    act(() => source.emit(JSON.stringify({ lines: ['line 2', 'line 3'] })))
    expect(result.current).toEqual(['line 2', 'line 3'])
  })

  it('ignores a malformed frame, keeping the last good window', () => {
    const { result } = renderHook(() => useLogTail('team', 'web-1'))
    const source = FakeEventSource.instances[0]

    act(() => source.emit(JSON.stringify({ lines: ['good'] })))
    act(() => source.emit('not json'))

    expect(result.current).toEqual(['good'])
  })

  it('closes the stream on unmount (cancelling the server-side follow)', () => {
    const { unmount } = renderHook(() => useLogTail('team', 'web-1'))
    const source = FakeEventSource.instances[0]

    unmount()

    expect(source.closed).toBe(true)
  })

  it('closes the old stream and opens a new one when the pod changes', () => {
    const { result, rerender } = renderHook(({ ns, pod }) => useLogTail(ns, pod), {
      initialProps: { ns: 'team', pod: 'web-1' },
    })
    const first = FakeEventSource.instances[0]
    act(() => first.emit(JSON.stringify({ lines: ['web-1 line'] })))
    expect(result.current).toEqual(['web-1 line'])

    rerender({ ns: 'team', pod: 'web-2' })

    expect(first.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].url).toBe(`${BASE}/api/pods/team/web-2/logtail`)
  })

  it('starts each freshly mounted pod from an empty window', () => {
    // The popup layer remounts per selection (DetailLayer keys by identity), so
    // a new mount — not an in-place prop change — is how a pod switch resets.
    const { result } = renderHook(() => useLogTail('team', 'web-9'))

    expect(result.current).toEqual([])
  })
})
