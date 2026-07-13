import { useEffect, useState } from 'react'
import { getApiBaseUrl } from '../config'
import { logTailUrl, parseLogTailFrame } from './detailApi'

/**
 * Subscribes to a Pod's bounded live log tail over SSE (ADR-0009) and returns the
 * current window — at most `LogTailMaxLines` lines, oldest first. Each SSE frame
 * is the whole current window (replaced whole by the backend), so this hook just
 * swaps in the latest frame's lines; it keeps no ring of its own.
 *
 * The `EventSource` is opened for the given Pod and, crucially, **closed on
 * unmount and whenever the Pod identity changes** — closing the stream is what
 * cancels the server-side `GetLogs(Follow)`, so an orphaned popup can't leave a
 * log follow running on the backend. The popup layer remounts per selection (a
 * fresh `key`), so each Pod starts from an empty window and never shows the
 * previous pod's tail.
 */
export function useLogTail(namespace: string, pod: string): string[] {
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    const source = new EventSource(logTailUrl(getApiBaseUrl(), namespace, pod))
    source.onmessage = (event) => {
      const parsed = parseLogTailFrame(event.data)
      if (parsed) {
        setLines(parsed)
      }
    }
    return () => source.close()
  }, [namespace, pod])

  return lines
}
