import type { MovementType } from '../api/types';
import { MOVEMENT_TYPE_LABELS } from '../lib/movement-types';

const COLORS: Record<MovementType, string> = {
  sale: 'bg-sky-100 text-sky-900',
  restock: 'bg-emerald-100 text-emerald-900',
  adjustment: 'bg-slate-200 text-slate-800',
};

export function MovementTypeBadge({ type }: { type: MovementType }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-sm font-semibold ${COLORS[type]}`} data-testid="movement-type-badge">
      {MOVEMENT_TYPE_LABELS[type].one}
    </span>
  );
}
