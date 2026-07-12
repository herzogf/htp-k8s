import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocketMessage } from './useWebSocketMessage'

type Listener = (event: MessageEvent) => void

/** Minimal fake standing in for the browser WebSocket in jsdom (which has no real one). */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  closed = false
  private listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    )
  }

  close() {
    this.closed = true
  }

  emit(type: string, event: Partial<MessageEvent>) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as MessageEvent)
    }
  }
}

describe('useWebSocketMessage', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts with no message before anything arrives', () => {
    const { result } = renderHook(() => useWebSocketMessage('ws://example.test/ws'))

    expect(result.current).toBeNull()
  })

  it('opens a socket to the given url', () => {
    renderHook(() => useWebSocketMessage('ws://example.test/ws'))

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe('ws://example.test/ws')
  })

  it('updates with the raw text of a received message', () => {
    const { result } = renderHook(() => useWebSocketMessage('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: 'hello scene' })
    })

    expect(result.current).toBe('hello scene')
  })

  it('replaces the message with each new one received', () => {
    const { result } = renderHook(() => useWebSocketMessage('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: 'first' })
    })
    act(() => {
      socket.emit('message', { data: 'second' })
    })

    expect(result.current).toBe('second')
  })

  it('ignores non-text payloads', () => {
    const { result } = renderHook(() => useWebSocketMessage('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: new Blob(['binary']) })
    })

    expect(result.current).toBeNull()
  })

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useWebSocketMessage('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    unmount()

    expect(socket.closed).toBe(true)
  })

  it('closes the old socket and opens a new one when the url changes', () => {
    const { rerender } = renderHook(({ url }) => useWebSocketMessage(url), {
      initialProps: { url: 'ws://example.test/a' },
    })
    const first = FakeWebSocket.instances[0]

    rerender({ url: 'ws://example.test/b' })

    expect(first.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url).toBe('ws://example.test/b')
  })
})
