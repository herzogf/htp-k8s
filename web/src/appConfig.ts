/**
 * The frontend's one piece of startup config carried over HTTP rather than the
 * `/ws` scene stream (#91): `GET /api/config`. It is deliberately not part of
 * `SceneState` — that's a cluster presentation view-model (ADR-0008), not app
 * config — so it gets its own tiny fetch, done once at bootstrap by
 * {@link import('./hooks/useAppConfig').useAppConfig}.
 */

/**
 * `AppConfig` is the backend's resolved startup configuration the frontend
 * needs before the scene even connects:
 *
 * - `demoSeed`: the seed for Demo Mode's Canyon-tour PRNG (`scene/demoMode.ts`).
 *   Resolved by the backend (`-demo-seed` flag / `HTP_K8S_DEMO_SEED` env, or a
 *   random pick at startup) and always logged there — this is the "same spot +
 *   same seed replays identically" reproduction key (ADR-0010). The frontend
 *   never invents its own seed; it only ever plays back this one.
 * - `demoAutostart`: whether Demo Mode should already be flying the instant the
 *   page loads (the backend's `-demo` flag / `HTP_K8S_DEMO` env), independent of
 *   the seed — a seed can be pinned without forcing autostart.
 */
export interface AppConfig {
  demoSeed: number
  demoAutostart: boolean
}

/**
 * The config used until the real `GET /api/config` response arrives (or if it
 * never does — offline dev, a backend that predates this endpoint): Demo Mode
 * off, and an arbitrary fixed seed so the Canyon tour is still fully
 * functional (just not reproducing a backend-logged seed) if switched on by
 * hand before the fetch resolves.
 */
export const DEFAULT_APP_CONFIG: AppConfig = { demoSeed: 1, demoAutostart: false }

/** URL of the startup config endpoint, `GET /api/config`. */
export function appConfigUrl(baseUrl: string): string {
  return `${baseUrl}/api/config`
}

/**
 * Fetches the {@link AppConfig}. Rejects on a non-2xx response, mirroring
 * `detail/detailApi.ts`'s fetch wrappers, so the caller ({@link
 * import('./hooks/useAppConfig').useAppConfig}) can fall back to {@link
 * DEFAULT_APP_CONFIG} on any failure rather than rendering a half-parsed body.
 */
export async function fetchAppConfig(baseUrl: string, signal?: AbortSignal): Promise<AppConfig> {
  const response = await fetch(appConfigUrl(baseUrl), { signal })
  if (!response.ok) {
    throw new Error(`app config request failed: ${response.status}`)
  }
  return (await response.json()) as AppConfig
}
