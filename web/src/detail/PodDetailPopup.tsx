import { LogTailMaxLines } from '../generated/scenestate'
import { DetailCard, DetailRows } from './DetailCard'
import { podDetailRows } from './detailView'
import { usePodDetail } from './useDetail'
import { useLogTail } from './useLogTail'

/**
 * The Detail Popup body for a clicked Panel (Pod): the static pod detail from
 * `GET /api/pods/{ns}/{name}` plus the live, height-limited log tail streamed
 * over SSE (ADR-0009), read-only (ADR-0003 — no exec, no full log viewer). The
 * fetch and the stream are separate hooks so the tail keeps updating while (and
 * after) the static detail loads. Both key off the same `namespace`/`pod`, so
 * they open and close together with the popup.
 */
export function PodDetailPopup({
  namespace,
  pod,
  onClose,
}: {
  namespace: string
  pod: string
  onClose: () => void
}) {
  const { data, loading, error } = usePodDetail(namespace, pod)
  // The log tail streams independently of the static detail load — open it
  // straight away so lines appear even while the summary is still in flight.
  const logLines = useLogTail(namespace, pod)

  return (
    <DetailCard title={pod} kind="pod" kindLabel="Pod" onClose={onClose}>
      {loading && <p className="detail-card__status">Loading…</p>}
      {!loading && (error || !data) && <p className="detail-card__status">Details unavailable.</p>}
      {!loading && data && <DetailRows rows={podDetailRows(data)} />}

      {!loading && data && data.events.length > 0 && (
        <section className="detail-events" aria-label="Recent events">
          <h4 className="detail-section__title">Recent events</h4>
          <ul className="detail-events__list">
            {data.events.slice(0, 3).map((event, index) => (
              <li className="detail-events__item" key={`${event.reason}-${index}`}>
                <span className="detail-events__reason" data-event-type={event.type}>
                  {event.reason}
                </span>{' '}
                {event.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <LogTailView lines={logLines} />
    </DetailCard>
  )
}

/**
 * The bounded live log tail: at most {@link LogTailMaxLines} rows, height-capped
 * so it can never grow into a full log viewer (ADR-0003). The window is streamed
 * whole by the backend, so this just renders the current lines; a `data-testid`
 * and `data-line-count` make the tail assertable in the e2e DOM.
 */
function LogTailView({ lines }: { lines: string[] }) {
  return (
    <section className="detail-logtail" aria-label="Live log tail">
      <h4 className="detail-section__title">Log tail</h4>
      <pre className="detail-logtail__lines" data-testid="log-tail" data-line-count={lines.length}>
        {lines.length === 0
          ? '(waiting for log output…)'
          : lines.slice(-LogTailMaxLines).join('\n')}
      </pre>
    </section>
  )
}
