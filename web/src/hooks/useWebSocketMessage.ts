import { useEffect, useState } from 'react'

/**
 * Opens a WebSocket connection to `url` and returns the raw text content of
 * the most recently received message (or `null` before the first message
 * arrives). Non-text payloads (Blob/ArrayBuffer) are ignored — this is a
 * placeholder seam for the real Scene State / Scene Delta wire protocol,
 * which is introduced in a later ticket.
 *
 * The socket is reopened whenever `url` changes, and closed on unmount.
 */
export function useWebSocketMessage(url: string): string | null {
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const socket = new WebSocket(url)

    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        setMessage(event.data)
      }
    }

    socket.addEventListener('message', handleMessage)

    return () => {
      socket.removeEventListener('message', handleMessage)
      socket.close()
    }
  }, [url])

  return message
}
