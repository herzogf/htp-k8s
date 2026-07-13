import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PodPhaseCrashLoopBackOff,
  type SceneDelta as WireSceneDelta,
  type ViewMode,
  ViewModeNamespace,
  ViewModeNode,
} from '../generated/scenestate'
import { makePanel, makeSceneState, makeTower } from '../test-support/sceneFixtures'
import { useSceneState } from './useSceneState'

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

// A full, valid SceneState frame as the backend sends it — built through the
// shared factory so a new required field lands in one place, not here.
const snapshot = (viewMode: ViewMode) => JSON.stringify(makeSceneState({ viewMode }))

/** A Scene Delta frame as the backend sends it after the snapshot. */
const deltaFrame = (delta: WireSceneDelta) => JSON.stringify(delta)

describe('useSceneState', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts with no scene state before anything arrives', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))

    expect(result.current).toBeNull()
  })

  it('opens a socket to the given url', () => {
    renderHook(() => useSceneState('ws://example.test/ws'))

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe('ws://example.test/ws')
  })

  it('parses a received SceneState snapshot into a typed value', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: snapshot(ViewModeNode) })
    })

    expect(result.current).toEqual(makeSceneState({ viewMode: ViewModeNode }))
  })

  it('replaces the state with each new snapshot received', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: snapshot(ViewModeNode) })
    })
    act(() => {
      socket.emit('message', { data: snapshot(ViewModeNamespace) })
    })

    expect(result.current).toEqual(makeSceneState({ viewMode: ViewModeNamespace }))
  })

  it('keeps the last good state when a malformed frame arrives', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: snapshot(ViewModeNode) })
    })
    act(() => {
      socket.emit('message', { data: 'not json' })
    })

    expect(result.current).toEqual(makeSceneState({ viewMode: ViewModeNode }))
  })

  it('applies a delta to the snapshot so the scene live-updates', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: JSON.stringify(makeSceneState({ towers: [] })) })
    })
    const tower = makeTower({ name: 'node-a', panels: [makePanel({ pod: 'p1' })] })
    act(() => {
      socket.emit('message', { data: deltaFrame({ type: 'towerAdded', tower }) })
    })

    expect(result.current).toEqual(makeSceneState({ towers: [tower] }))
  })

  it('applies a rapid-fire sequence of deltas in arrival order', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', {
        data: JSON.stringify(
          makeSceneState({ towers: [makeTower({ name: 'node-a', panels: [] })] }),
        ),
      })
    })
    act(() => {
      socket.emit('message', {
        data: deltaFrame({
          type: 'panelAdded',
          towerName: 'node-a',
          panel: makePanel({ namespace: 'team', pod: 'web-1' }),
        }),
      })
      socket.emit('message', {
        data: deltaFrame({
          type: 'panelUpdated',
          towerName: 'node-a',
          panel: makePanel({ namespace: 'team', pod: 'web-1', phase: PodPhaseCrashLoopBackOff }),
        }),
      })
      socket.emit('message', {
        data: deltaFrame({ type: 'towerMoved', towerName: 'node-a', grid: { col: 2, row: 1 } }),
      })
    })

    expect(result.current).toEqual(
      makeSceneState({
        towers: [
          makeTower({
            name: 'node-a',
            grid: { col: 2, row: 1 },
            panels: [
              makePanel({ namespace: 'team', pod: 'web-1', phase: PodPhaseCrashLoopBackOff }),
            ],
          }),
        ],
      }),
    )
  })

  it('removes a Tower on a towerRemoved delta (no stale state)', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', {
        data: JSON.stringify(
          makeSceneState({
            towers: [makeTower({ name: 'node-a' }), makeTower({ name: 'node-b' })],
          }),
        ),
      })
    })
    act(() => {
      socket.emit('message', { data: deltaFrame({ type: 'towerRemoved', towerName: 'node-a' }) })
    })

    expect(result.current?.towers.map((t) => t.name)).toEqual(['node-b'])
  })

  it('ignores a delta that arrives before any snapshot', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', {
        data: deltaFrame({ type: 'towerAdded', tower: makeTower({ name: 'orphan' }) }),
      })
    })

    expect(result.current).toBeNull()
  })

  it('replaces reconciled delta state wholesale when a fresh snapshot arrives', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', {
        data: JSON.stringify(makeSceneState({ towers: [makeTower({ name: 'node-a' })] })),
      })
    })
    act(() => {
      socket.emit('message', {
        data: deltaFrame({ type: 'towerAdded', tower: makeTower({ name: 'node-b' }) }),
      })
    })
    // A reconnect snapshot (e.g. after a View Mode switch) resets everything.
    act(() => {
      socket.emit('message', {
        data: JSON.stringify(
          makeSceneState({ viewMode: ViewModeNamespace, towers: [makeTower({ name: 'team-x' })] }),
        ),
      })
    })

    expect(result.current).toEqual(
      makeSceneState({ viewMode: ViewModeNamespace, towers: [makeTower({ name: 'team-x' })] }),
    )
  })

  it('keeps the last good state when an unknown delta type arrives', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', {
        data: JSON.stringify(makeSceneState({ towers: [makeTower({ name: 'node-a' })] })),
      })
    })
    act(() => {
      socket.emit('message', { data: deltaFrame({ type: 'somethingNew' } as WireSceneDelta) })
    })

    expect(result.current).toEqual(makeSceneState({ towers: [makeTower({ name: 'node-a' })] }))
  })

  it('ignores non-text payloads', () => {
    const { result } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    act(() => {
      socket.emit('message', { data: new Blob(['binary']) })
    })

    expect(result.current).toBeNull()
  })

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useSceneState('ws://example.test/ws'))
    const socket = FakeWebSocket.instances[0]

    unmount()

    expect(socket.closed).toBe(true)
  })

  it('closes the old socket and opens a new one when the url changes', () => {
    const { rerender } = renderHook(({ url }) => useSceneState(url), {
      initialProps: { url: 'ws://example.test/a' },
    })
    const first = FakeWebSocket.instances[0]

    rerender({ url: 'ws://example.test/b' })

    expect(first.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url).toBe('ws://example.test/b')
  })
})
