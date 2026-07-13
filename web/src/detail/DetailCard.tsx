import { type ReactNode } from 'react'

/**
 * DetailCard is the shared chrome of every Detail Popup: the glowing *Hackers*
 * card frame, the title/kind header, and the sole non-cluster affordance — a
 * close button. It is deliberately read-only (ADR-0003): the only control it
 * offers is closing itself; there are no action buttons, no exec, no full log
 * viewer. Bodies (Tower summary, Pod detail + log tail) are passed as children.
 *
 * It is a plain DOM component so it can be rendered both directly (unit tests)
 * and inside a drei `Html` (in-world, anchored beside the clicked element).
 */
export function DetailCard({
  title,
  kind,
  kindLabel,
  onClose,
  children,
}: {
  title: string
  /** Stable target discriminator for the popup ('tower' | 'pod'), exposed on the DOM. */
  kind: 'tower' | 'pod'
  kindLabel: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="detail-card"
      data-testid="detail-popup"
      data-detail-kind={kind}
      role="dialog"
      aria-label={`${title} details`}
    >
      <header className="detail-card__header">
        <div className="detail-card__heading">
          <span className="detail-card__kind">{kindLabel}</span>
          <span className="detail-card__title">{title}</span>
        </div>
        <button
          type="button"
          className="detail-card__close"
          aria-label="Close details"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="detail-card__body">{children}</div>
    </div>
  )
}

/** Renders a list of label/value rows as the popup's summary table. */
export function DetailRows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="detail-rows">
      {rows.map((row) => (
        <div className="detail-rows__row" key={row.label}>
          <dt className="detail-rows__label">{row.label}</dt>
          <dd className="detail-rows__value">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
