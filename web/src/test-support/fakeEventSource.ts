/**
 * A minimal fake standing in for the browser `EventSource` in jsdom (which has
 * none), for the Detail Popup log-tail tests (#24, ADR-0009 SSE). It records
 * every constructed instance, lets a test push a frame via {@link emit}, and
 * flags {@link closed} so the "close on unmount / pod switch" lifecycle is
 * assertable. `vi.stubGlobal('EventSource', FakeEventSource)` installs it.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = []

  /** Clears the recorded instances — call in `beforeEach`. */
  static reset(): void {
    FakeEventSource.instances = []
  }

  readonly url: string
  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  /** Delivers one SSE frame's `data:` payload to the subscriber. */
  emit(data: string) {
    this.onmessage?.({ data } as MessageEvent)
  }
}
