import { DetailCard, DetailRows } from './DetailCard'
import { towerDetailView } from './detailView'
import { useTowerDetail } from './useDetail'

/**
 * The Detail Popup body for a clicked Tower: the Node or Namespace/Project
 * summary from `GET /api/towers/{name}` (ADR-0009), read-only. Fetching and the
 * kind-discriminator flattening live in {@link useTowerDetail} /
 * {@link towerDetailView}; this component only renders the load / degraded /
 * loaded states inside the shared {@link DetailCard}.
 */
export function TowerDetailPopup({ name, onClose }: { name: string; onClose: () => void }) {
  const { data, loading, error } = useTowerDetail(name)

  if (loading) {
    return (
      <DetailCard title={name} kind="tower" kindLabel="Tower" onClose={onClose}>
        <p className="detail-card__status">Loading…</p>
      </DetailCard>
    )
  }

  if (error || !data) {
    return (
      <DetailCard title={name} kind="tower" kindLabel="Tower" onClose={onClose}>
        <p className="detail-card__status">Details unavailable.</p>
      </DetailCard>
    )
  }

  const view = towerDetailView(data)

  return (
    <DetailCard title={view.title} kind="tower" kindLabel={view.kindLabel} onClose={onClose}>
      {view.degraded ? (
        <p className="detail-card__status">Summary not available for this {view.kindLabel}.</p>
      ) : (
        <DetailRows rows={view.rows} />
      )}
    </DetailCard>
  )
}
