import { useEffect, useState } from 'react'
import { type AppConfig, DEFAULT_APP_CONFIG, fetchAppConfig } from '../appConfig'
import { getApiBaseUrl } from '../config'

/**
 * Fetches the backend's {@link AppConfig} once at bootstrap (#91). Returns
 * {@link DEFAULT_APP_CONFIG} — Demo Mode off — until the fetch resolves (or
 * forever, if it fails), so a slow/unreachable `/api/config` degrades to "Demo
 * Mode starts off, switchable by hand" rather than blocking the scene.
 *
 * `Scene` reads this once at mount to seed its initial `demoActive` from
 * `demoAutostart` and to hand `demoSeed` to `FreeFlyControls`' Canyon tour
 * (`scene/demoMode.ts`); nothing here depends on the scene connection, so it
 * races the `/ws` snapshot rather than waiting on it.
 */
export function useAppConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG)

  useEffect(() => {
    const controller = new AbortController()
    fetchAppConfig(getApiBaseUrl(), controller.signal)
      .then(setConfig)
      .catch(() => {
        // Leave the default config in place — see the doc comment above.
      })
    return () => controller.abort()
  }, [])

  return config
}
