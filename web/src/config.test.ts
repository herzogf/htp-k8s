import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WS_URL, getApiBaseUrl, getWebSocketUrl } from './config'

describe('getWebSocketUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to the default url when VITE_WS_URL is unset', () => {
    expect(getWebSocketUrl()).toBe(DEFAULT_WS_URL)
  })

  it('uses VITE_WS_URL when set, so a build can target a different backend', () => {
    vi.stubEnv('VITE_WS_URL', 'ws://cluster.example/ws')

    expect(getWebSocketUrl()).toBe('ws://cluster.example/ws')
  })
})

describe('getApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives the http origin from the default ws url', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:8080')
  })

  it('derives from VITE_WS_URL, swapping scheme and dropping the /ws path', () => {
    vi.stubEnv('VITE_WS_URL', 'ws://cluster.example:9090/ws')

    expect(getApiBaseUrl()).toBe('http://cluster.example:9090')
  })

  it('maps a secure wss url to https', () => {
    vi.stubEnv('VITE_WS_URL', 'wss://cluster.example/ws')

    expect(getApiBaseUrl()).toBe('https://cluster.example')
  })

  it('prefers an explicit VITE_API_URL override when set', () => {
    vi.stubEnv('VITE_WS_URL', 'ws://cluster.example/ws')
    vi.stubEnv('VITE_API_URL', 'https://detail.example')

    expect(getApiBaseUrl()).toBe('https://detail.example')
  })
})
