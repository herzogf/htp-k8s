import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_CONFIG } from '../appConfig'
import { useAppConfig } from './useAppConfig'

describe('useAppConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the default config before the fetch resolves', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})), // never resolves
    )

    const { result } = renderHook(() => useAppConfig())

    expect(result.current).toEqual(DEFAULT_APP_CONFIG)
  })

  it('adopts the fetched config once it resolves', async () => {
    const payload = { demoSeed: 7, demoAutostart: true }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    )

    const { result } = renderHook(() => useAppConfig())

    await waitFor(() => expect(result.current).toEqual(payload))
  })

  it('keeps the default config when the fetch fails, rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )

    const { result } = renderHook(() => useAppConfig())

    // Give the rejected promise a tick to settle; state should still be the
    // untouched default rather than an unhandled rejection tearing the test down.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toEqual(DEFAULT_APP_CONFIG)
  })
})
