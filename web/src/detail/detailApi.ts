import { type LogTail, type PodDetail, type TowerDetail } from '../generated/scenestate'

/**
 * The read-only Detail transport (ADR-0009): thin, pure wrappers over the
 * backend's on-demand HTTP endpoints and the SSE log-tail stream. Kept
 * WebGL-free and framework-free so the URL building and payload handling are
 * unit-tested without a renderer; the React hooks in this folder bind these to
 * component lifecycles.
 *
 * All three are strictly read-only GET/SSE (ADR-0003) — there is deliberately no
 * write, exec, or mutate path here.
 */

/** URL of the per-Tower detail endpoint, `GET /api/towers/{name}`. */
export function towerDetailUrl(baseUrl: string, name: string): string {
  return `${baseUrl}/api/towers/${encodeURIComponent(name)}`
}

/** URL of the per-Pod detail endpoint, `GET /api/pods/{namespace}/{name}`. */
export function podDetailUrl(baseUrl: string, namespace: string, pod: string): string {
  return `${baseUrl}/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}`
}

/** URL of the per-Pod SSE log-tail stream, `GET /api/pods/{namespace}/{name}/logtail`. */
export function logTailUrl(baseUrl: string, namespace: string, pod: string): string {
  return `${podDetailUrl(baseUrl, namespace, pod)}/logtail`
}

/**
 * Fetches a {@link TowerDetail} for the clicked Tower. Rejects on a non-2xx
 * response so the popup can show an error state rather than rendering a body
 * that was actually an error page. `signal` lets a caller abort the fetch when
 * the popup closes or the selection changes mid-flight.
 */
export async function fetchTowerDetail(
  baseUrl: string,
  name: string,
  signal?: AbortSignal,
): Promise<TowerDetail> {
  const response = await fetch(towerDetailUrl(baseUrl, name), { signal })
  if (!response.ok) {
    throw new Error(`tower detail request failed: ${response.status}`)
  }
  return (await response.json()) as TowerDetail
}

/**
 * Fetches a {@link PodDetail} for the clicked Panel's Pod (the static half of
 * the pod popup; the live log tail streams separately over SSE). See
 * {@link fetchTowerDetail} for the error/abort contract.
 */
export async function fetchPodDetail(
  baseUrl: string,
  namespace: string,
  pod: string,
  signal?: AbortSignal,
): Promise<PodDetail> {
  const response = await fetch(podDetailUrl(baseUrl, namespace, pod), { signal })
  if (!response.ok) {
    throw new Error(`pod detail request failed: ${response.status}`)
  }
  return (await response.json()) as PodDetail
}

/**
 * Parses one SSE log-tail frame's `data:` payload into its lines, or `null` if
 * the payload isn't a valid {@link LogTail}. Each frame is the whole current
 * window (replaced whole, ADR-0009), so the caller renders the returned lines
 * directly without keeping a ring of its own. Malformed frames are dropped
 * (return `null`) rather than throwing, so one bad line can't tear down a live
 * stream.
 */
export function parseLogTailFrame(data: string): string[] | null {
  try {
    const frame = JSON.parse(data) as LogTail
    if (!frame || !Array.isArray(frame.lines)) {
      return null
    }
    return frame.lines
  } catch {
    return null
  }
}
