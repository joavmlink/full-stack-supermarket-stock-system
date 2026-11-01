import { useEffect, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useStore } from 'zustand';
import { ErrorState } from '../components/ErrorState';
import { textLinkClass } from '../components/feedback';
import { MovementTypeBadge } from '../components/MovementTypeBadge';
import { PageFallback } from '../components/PageFallback';
import { useDocumentTitle } from '../hooks/use-document-title';
import { formatDateTime } from '../lib/dates';
import { formatMoney } from '../lib/money';
import { formatDelta, formatInteger } from '../lib/numbers';
import { movementStore } from '../stores';

const COLUMNS = 'sm:grid-cols-[1fr_8rem_6rem_6rem] sm:gap-3';

function Value({ label, strong = false, children }: { label: string; strong?: boolean; children: ReactNode }) {
  return (
    <p className="flex justify-between gap-3 sm:block sm:text-right">
      <span className="text-slate-600 sm:sr-only">{label}</span>
      <span className={`whitespace-nowrap ${strong ? 'font-semibold' : ''}`}>{children}</span>
    </p>
  );
}

/**
 * One movement with its lines. Names, brands and prices are snapshots from
 * when it was recorded, so a later edit or deletion does not rewrite history.
 */
export default function StockMovementDetailPage() {
  useDocumentTitle('Movement');
  const { id = '' } = useParams();
  const key = useStore(movementStore, (state) => state.key);
  const movement = useStore(movementStore, (state) => state.data);
  const status = useStore(movementStore, (state) => state.status);
  const error = useStore(movementStore, (state) => state.error);

  useEffect(() => {
    void movementStore.getState().load(id);
  }, [id]);

  const back = (
    <Link to="/stock-movements" className={textLinkClass}>
      Back to history
    </Link>
  );

  if (status === 'notFound') {
    return (
      <section className="space-y-3" data-testid="movement-not-found">
        <h1 className="text-2xl font-semibold">Movement not found</h1>
        {back}
      </section>
    );
  }
  if (status === 'error' && movement === null) {
    return <ErrorState message={error ?? 'Could not load the movement.'} onRetry={() => void movementStore.getState().load(id)} />;
  }
  if (movement === null || key !== id) return <PageFallback />;

  return (
    <section className="space-y-4" data-testid="movement-detail">
      <div className="space-y-2">
        {back}
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
          <MovementTypeBadge type={movement.type} />
          {formatDateTime(movement.createdAt)}
        </h1>
        <p className="text-slate-600">Recorded by {movement.user.fullName}</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white">
        {/* Column titles for wide screens; on phones every value carries its own label. */}
        <div
          aria-hidden="true"
          className={`hidden border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 sm:grid ${COLUMNS}`}
        >
          <span>Product</span>
          <span className="text-right">Unit price</span>
          <span className="text-right">Change</span>
          <span className="text-right">Stock after</span>
        </div>
        <ul className="divide-y divide-slate-200" aria-label="Products in this movement">
          {movement.items.map((item, index) => (
            <li key={index} className={`grid gap-1 px-4 py-3 text-sm sm:items-center ${COLUMNS}`} data-testid="movement-item">
              <div>
                <span className="font-medium">{item.product.name}</span>
                <span className="block text-slate-600">
                  {item.product.brand}
                  {item.product.id === null && ' · deleted product'}
                </span>
              </div>
              <Value label="Unit price">{formatMoney(item.unitPrice)}</Value>
              <Value label="Change" strong>
                {formatDelta(item.delta)}
              </Value>
              <Value label="Stock after">{formatInteger(item.quantityAfter)}</Value>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
