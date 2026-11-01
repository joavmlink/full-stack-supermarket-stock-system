import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { EditorStore } from '../stores/editor-store';
import { ErrorState } from './ErrorState';
import { PageFallback } from './PageFallback';

/**
 * Opens the editor for `id` (null: a new item) and renders the form only once
 * there is something to edit: not found, a load error with Retry, or loading
 * in between. The form mounts after `open`, so it starts clean of what an
 * earlier visit left, and unmounts when the stored values are loaded again.
 */
export function EditorGate<T extends { id: string }, F>({
  store,
  id,
  notFound,
  errorText,
  children,
}: {
  store: EditorStore<T, F>;
  id: string | null;
  notFound: ReactNode;
  errorText: string;
  children: (item: T | null) => ReactNode;
}) {
  const item = useStore(store, (state) => state.item);
  const loadStatus = useStore(store, (state) => state.loadStatus);
  const loadError = useStore(store, (state) => state.loadError);
  const [openedFor, setOpenedFor] = useState<string | null>();

  useEffect(() => {
    void store.getState().open(id);
    setOpenedFor(id);
  }, [store, id]);

  if (openedFor !== id) return <PageFallback />;
  if (id === null) return children(null);
  if (loadStatus === 'notFound') return notFound;
  if (item !== null) return children(item);
  if (loadStatus === 'error') {
    return <ErrorState message={loadError ?? errorText} onRetry={() => void store.getState().reload()} />;
  }
  return <PageFallback />;
}
