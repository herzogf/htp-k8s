import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WS_URL, getWebSocketUrl } from './config'

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
