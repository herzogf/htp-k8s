import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiBaseUrl, getWebSocketUrl } from './config'

/**
 * Stubs `window.location` for the duration of one test. jsdom's `window` is
 * `globalThis` in this environment, so `vi.stubGlobal('location', …)`
 * reaches both — `vi.unstubAllGlobals()` (called in `afterEach` below)
 * restores the real jsdom location afterwards.
 */
function stubLocation(protocol: string, host: string) {
  vi.stubGlobal('location', { protocol, host })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('getWebSocketUrl', () => {
  it('derives ws:// from window.location on plain http', () => {
    stubLocation('http:', 'localhost:8080')

    expect(getWebSocketUrl()).toBe('ws://localhost:8080/ws')
  })

  it('derives wss:// from window.location behind https (the mixed-content fix)', () => {
    stubLocation('https:', 'cluster.example')

    expect(getWebSocketUrl()).toBe('wss://cluster.example/ws')
  })

  it('follows the current host, so a remote viewer dials the server they loaded the page from', () => {
    stubLocation('http:', 'cluster.example:9090')

    expect(getWebSocketUrl()).toBe('ws://cluster.example:9090/ws')
  })

  it('uses VITE_WS_URL as an escape hatch when set, ignoring window.location', () => {
    stubLocation('https:', 'cluster.example')
    vi.stubEnv('VITE_WS_URL', 'ws://elsewhere.example/ws')

    expect(getWebSocketUrl()).toBe('ws://elsewhere.example/ws')
  })
})

describe('getApiBaseUrl', () => {
  it('derives the http origin from window.location', () => {
    stubLocation('http:', 'localhost:8080')

    expect(getApiBaseUrl()).toBe('http://localhost:8080')
  })

  it('derives the https origin from window.location behind https', () => {
    stubLocation('https:', 'cluster.example')

    expect(getApiBaseUrl()).toBe('https://cluster.example')
  })

  it('derives from VITE_WS_URL, swapping scheme and dropping the /ws path', () => {
    stubLocation('http:', 'localhost:8080')
    vi.stubEnv('VITE_WS_URL', 'ws://cluster.example:9090/ws')

    expect(getApiBaseUrl()).toBe('http://cluster.example:9090')
  })

  it('maps a secure wss url to https', () => {
    stubLocation('http:', 'localhost:8080')
    vi.stubEnv('VITE_WS_URL', 'wss://cluster.example/ws')

    expect(getApiBaseUrl()).toBe('https://cluster.example')
  })

  it('prefers an explicit VITE_API_URL override when set', () => {
    stubLocation('http:', 'localhost:8080')
    vi.stubEnv('VITE_WS_URL', 'ws://cluster.example/ws')
    vi.stubEnv('VITE_API_URL', 'https://detail.example')

    expect(getApiBaseUrl()).toBe('https://detail.example')
  })
})
