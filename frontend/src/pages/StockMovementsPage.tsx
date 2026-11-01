import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { StockMovement } from '../api/types';
import { LinkButton, PageHeader } from '../components/feedback';
import { SelectField } from '../components/fields';
import { MovementTypeBadge } from '../components/MovementTypeBadge';
import { PagedListView } from '../components/PagedListView';
import { useDocumentTitle } from '../hooks/use-document-title';
import { useUpdateSearchParams } from '../hooks/use-update-search-params';
import { formatDateTime } from '../lib/dates';
import { MOVEMENT_TYPES, MOVEMENT_TYPE_LABELS, isMovementType } from '../lib/movement-types';
import { countNoun, formatCount, formatDelta } from '../lib/numbers';
import { movementsStore } from '../stores';
import { useAuth } from '../stores/auth';

/** Admins see every movement; employees see the ones they recorded. */
export default function StockMovementsPage() {
  useDocumentTitle('History');
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const [params] = useSearchParams();
  const updateParams = useUpdateSearchParams();
  const typeParam = params.get('type');
  const type = isMovementType(typeParam) ? typeParam : '';

  useEffect(() => {
    void movementsStore.getState().load({ type });
  }, [type]);

  return (
    <section data-testid="movements-page">
      <PageHeader
        title="History"
        actions={
          <LinkButton to="/stock-movements/new" data-testid="new-movement">
            Record movement
          </LinkButton>
        }
      >
        {!isAdmin && <p className="text-slate-600">The movements you recorded.</p>}
      </PageHeader>
      <SelectField
        label="Type"
        value={type}
        onChange={(event) => updateParams({ type: event.target.value }, { replace: false })}
        className="mb-4 max-w-xs"
        testId="movement-type-filter"
      >
        <option value="">All types</option>
        {MOVEMENT_TYPES.map((value) => (
          <option key={value} value={value}>
            {MOVEMENT_TYPE_LABELS[value].many}
          </option>
        ))}
      </SelectField>
      <PagedListView
        store={movementsStore}
        onRetry={() => void movementsStore.getState().load({ type })}
        errorText="Could not load the history."
        empty={type === '' ? 'No movements yet.' : 'No movements of this type.'}
      >
        {(items) => (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="movement-list">
            {items.map((movement) => (
              <MovementRow key={movement.id} movement={movement} showAuthor={isAdmin} />
            ))}
          </ul>
        )}
      </PagedListView>
    </section>
  );
}

function MovementRow({ movement, showAuthor }: { movement: StockMovement; showAuthor: boolean }) {
  const units = movement.items.reduce((total, item) => total + item.delta, 0);
  const products = movement.items.length;
  return (
    <li data-testid="movement-row">
      <Link
        to={`/stock-movements/${movement.id}`}
        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700"
      >
        <span className="flex flex-wrap items-center gap-2">
          <MovementTypeBadge type={movement.type} />
          <span className="text-sm text-slate-700">{formatDateTime(movement.createdAt)}</span>
          {showAuthor && <span className="text-sm text-slate-600">· {movement.user.fullName}</span>}
        </span>
        <span className="text-sm">
          {formatCount(products, 'product')} · <span className="font-semibold">{formatDelta(units)}</span> {countNoun(units, 'unit')}
        </span>
      </Link>
    </li>
  );
}
