import { useState, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { LOW_STOCK_THRESHOLD } from '../api/limits';
import { useDelayedFlag } from '../hooks/use-delayed-flag';
import { formatInteger } from '../lib/numbers';
import type { WriteState } from '../stores/shared';
import { Button, buttonClass } from './Button';
import { Spinner } from './Spinner';

const TONES = {
  error: 'border-red-200 bg-red-50 text-red-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  info: 'border-slate-200 bg-white text-slate-700',
} as const;

export function Notice({
  tone,
  children,
  testId,
  role,
  state,
}: {
  tone: keyof typeof TONES;
  children: ReactNode;
  testId?: string;
  role?: 'alert' | 'status';
  state?: string;
}) {
  return (
    <div role={role} data-testid={testId} data-state={state} className={`rounded-lg border px-4 py-3 ${TONES[tone]}`}>
      {children}
    </div>
  );
}

/**
 * A write as the user sees it: pending ("Saving…", then "Retrying…" while the
 * connection fails), failed (with "Retry"), rejected (the server's reason, no
 * "Retry": sending the same thing again would get the same answer). A
 * rejection already explained on the form's fields (`explainedOnFields`) only
 * points at them. Nothing is shown when idle or succeeded.
 */
export function WriteStatus({
  state,
  pendingLabel = 'Saving…',
  onRetry,
  explainedOnFields = false,
  testId = 'write-status',
}: {
  state: WriteState;
  pendingLabel?: string;
  onRetry?: () => void;
  explainedOnFields?: boolean;
  testId?: string;
}) {
  if (state.status === 'pending') {
    return (
      <p role="status" data-testid={testId} data-state="pending" className="flex items-center gap-2 text-sm text-slate-700">
        <Spinner className="size-4" />
        {state.retrying ? 'Connection problem. Retrying…' : pendingLabel}
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <Notice tone="error" role="alert" testId={testId} state="failed">
        <p>{state.message}</p>
        <p className="text-sm">Retrying is safe: it never saves anything twice.</p>
        {onRetry && (
          <Button variant="secondary" className="mt-2" onClick={onRetry} data-testid="retry-write">
            Retry
          </Button>
        )}
      </Notice>
    );
  }
  if (state.status === 'rejected' && explainedOnFields) {
    return (
      <p role="alert" data-testid={testId} data-state="rejected" className="text-sm font-medium text-red-700">
        Check the highlighted fields.
      </p>
    );
  }
  if (state.status === 'rejected') {
    return (
      <Notice tone="error" role="alert" testId={testId} state="rejected">
        {state.message}
      </Notice>
    );
  }
  return null;
}

/** A destructive action that asks once more, inline (no browser dialog). */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  pending = false,
  disabled = false,
  testId,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
  pending?: boolean;
  disabled?: boolean;
  testId: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking || pending) {
    return (
      <Button variant="secondary" pending={pending} disabled={disabled} onClick={() => setAsking(true)} data-testid={testId}>
        {label}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={question} className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">{question}</span>
      <Button
        variant="danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        data-testid={`${testId}-confirm`}
      >
        Delete
      </Button>
      <Button variant="secondary" onClick={() => setAsking(false)} data-testid={`${testId}-cancel`}>
        Cancel
      </Button>
    </div>
  );
}

export function LoadMore({
  hasMore,
  status,
  error,
  onLoadMore,
}: {
  hasMore: boolean;
  status: 'idle' | 'loading' | 'error';
  error: string | null;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      {status === 'error' && (
        <p role="alert" className="text-sm text-red-700" data-testid="load-more-error">
          {error}
        </p>
      )}
      <Button variant="secondary" pending={status === 'loading'} onClick={onLoadMore} data-testid="load-more">
        {status === 'error' ? 'Retry' : 'Load more'}
      </Button>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div data-testid="empty-state" className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">
      {children}
    </div>
  );
}

/** A refresh in progress while the old data stays on screen; appears after 300 ms like the page fallback. */
export function Refreshing({ active }: { active: boolean }) {
  const visible = useDelayedFlag(active);
  if (!active) return null;
  return (
    <span role="status" className="inline-flex items-center gap-1 text-sm text-slate-600">
      {visible && <Spinner className="size-4" />}
      <span className={visible ? '' : 'sr-only'}>Updating…</span>
    </span>
  );
}

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </div>
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function LinkButton({ variant = 'primary', className = '', ...props }: LinkProps & { variant?: 'primary' | 'secondary' }) {
  return <Link className={`${buttonClass(variant)} ${className}`} {...props} />;
}

export const textLinkClass = 'font-semibold text-emerald-800 underline underline-offset-2 hover:text-emerald-900';

/** Out of stock (0), low stock (1 to the threshold) or plain units. */
export function StockBadge({ quantity }: { quantity: number }) {
  if (quantity === 0) {
    return <span className="rounded-full bg-red-100 px-2 py-0.5 text-sm font-semibold text-red-800">Out of stock</span>;
  }
  const low = quantity <= LOW_STOCK_THRESHOLD;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-sm font-semibold ${low ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-800'}`}
    >
      {formatInteger(quantity)} in stock{low ? ' (low)' : ''}
    </span>
  );
}
