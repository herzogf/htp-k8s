import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfigUrl, fetchAppConfig } from './appConfig'

const BASE = 'http://localhost:8080'

describe('appConfigUrl', () => {
  it('builds the /api/config url', () => {
    expect(appConfigUrl(BASE)).toBe('http://localhost:8080/api/config')
  })
})

describe('fetchAppConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the config url and returns the parsed AppConfig', async () => {
    const payload = { demoSeed: 42, demoAutostart: true }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const config = await fetchAppConfig(BASE)

    expect(fetchMock).toHaveBeenCalledWith(appConfigUrl(BASE), { signal: undefined })
    expect(config).toEqual(payload)
  })

  it('forwards an abort signal', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await fetchAppConfig(BASE, controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(appConfigUrl(BASE), { signal: controller.signal })
  })

  it('rejects on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )

    await expect(fetchAppConfig(BASE)).rejects.toThrow(/500/)
  })
})
