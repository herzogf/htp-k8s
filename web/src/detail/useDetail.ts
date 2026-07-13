import { useEffect, useState } from 'react'
import { getApiBaseUrl } from '../config'
import { type PodDetail, type TowerDetail } from '../generated/scenestate'
import { fetchPodDetail, fetchTowerDetail } from './detailApi'

/**
 * The async state of a one-shot Detail fetch: the loaded payload, whether it is
 * still in flight, and whether it failed. Exactly one of `loading`/`error`/`data
 * !== null` describes the current state.
 */
export interface DetailState<T> {
  data: T | null
  loading: boolean
  error: boolean
}

const LOADING: DetailState<never> = { data: null, loading: true, error: false }

/**
 * Fetches the {@link TowerDetail} for `name` and tracks its load state, re-running
 * whenever `name` changes (a different Tower is selected). The in-flight request
 * is aborted on unmount or when `name` changes, so a closing popup or a rapid
 * re-selection can't land a stale response on the wrong Tower. The popup layer
 * remounts this on selection change (a fresh `key`), so it starts each Tower from
 * the initial loading state without an in-effect reset.
 */
export function useTowerDetail(name: string): DetailState<TowerDetail> {
  const [state, setState] = useState<DetailState<TowerDetail>>(LOADING)

  useEffect(() => {
    const controller = new AbortController()
    fetchTowerDetail(getApiBaseUrl(), name, controller.signal)
      .then((data) => setState({ data, loading: false, error: false }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ data: null, loading: false, error: true })
        }
      })
    return () => controller.abort()
  }, [name])

  return state
}

/**
 * Fetches the {@link PodDetail} for a Pod and tracks its load state, re-running
 * (and aborting the previous request) whenever the Pod identity changes. This is
 * the static half of the pod popup; the live log tail streams separately via
 * {@link import('./useLogTail').useLogTail}. Like {@link useTowerDetail} the popup
 * layer remounts this per selection, so it starts each Pod from loading state.
 */
export function usePodDetail(namespace: string, pod: string): DetailState<PodDetail> {
  const [state, setState] = useState<DetailState<PodDetail>>(LOADING)

  useEffect(() => {
    const controller = new AbortController()
    fetchPodDetail(getApiBaseUrl(), namespace, pod, controller.signal)
      .then((data) => setState({ data, loading: false, error: false }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ data: null, loading: false, error: true })
        }
      })
    return () => controller.abort()
  }, [namespace, pod])

  return state
}
