import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { PagedListState } from '../stores/paged-list-store';
import type { LoadStatus } from '../stores/shared';
import { ErrorState } from './ErrorState';
import { EmptyState, LoadMore, Refreshing } from './feedback';
import { PageFallback } from './PageFallback';

/**
 * Every state of a list in one place: loading, error with Retry, empty, and the
 * items with a refresh indicator. A refresh that fails keeps the items on
 * screen with the error and Retry above them.
 */
export function ListStates<T>({
  items,
  status,
  error,
  errorText,
  onRetry,
  empty,
  children,
}: {
  items: T[];
  status: LoadStatus;
  error: string | null;
  /** Shown when the first load fails and the API gave no message. */
  errorText: string;
  onRetry: () => void;
  empty: ReactNode;
  children: (items: T[]) => ReactNode;
}) {
  if (items.length === 0) {
    if (status === 'error') return <ErrorState message={error ?? errorText} onRetry={onRetry} />;
    if (status !== 'loaded') return <PageFallback />;
    return <EmptyState>{empty}</EmptyState>;
  }
  return (
    <>
      {status === 'error' && (
        <div className="mb-3">
          <ErrorState message={`Could not refresh the list. ${error ?? ''}`.trim()} onRetry={onRetry} />
        </div>
      )}
      <div className="mb-2 flex min-h-6 justify-end">
        <Refreshing active={status === 'loading'} />
      </div>
      {children(items)}
    </>
  );
}

/** A paged list from its store: `ListStates` plus "Load more". */
export function PagedListView<T extends { id: string }, F>({
  store,
  onRetry,
  errorText,
  empty,
  children,
}: {
  store: StoreApi<PagedListState<T, F>>;
  onRetry: () => void;
  /** Shown when the first load fails and the API gave no message. */
  errorText: string;
  empty: ReactNode;
  children: (items: T[]) => ReactNode;
}) {
  const items = useStore(store, (state) => state.items);
  const status = useStore(store, (state) => state.status);
  const error = useStore(store, (state) => state.error);
  const nextCursor = useStore(store, (state) => state.nextCursor);
  const moreStatus = useStore(store, (state) => state.moreStatus);
  const moreError = useStore(store, (state) => state.moreError);

  return (
    <ListStates items={items} status={status} error={error} errorText={errorText} onRetry={onRetry} empty={empty}>
      {(loaded) => (
        <>
          {children(loaded)}
          <LoadMore hasMore={nextCursor !== null} status={moreStatus} error={moreError} onLoadMore={() => void store.getState().loadMore()} />
        </>
      )}
    </ListStates>
  );
}
