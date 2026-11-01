import { createStore } from 'zustand/vanilla';
import { errorMessage, hasDetailAt } from '../api/errors';
import type { Page } from '../api/types';
import { createRequestGate, type LoadStatus } from './shared';

export interface PagedListState<T, F> {
  /** The filters of the list on screen (or being loaded). */
  filters: F | null;
  items: T[];
  nextCursor: string | null;
  status: LoadStatus;
  error: string | null;
  moreStatus: 'idle' | 'loading' | 'error';
  moreError: string | null;

  /** Loads the first page; the same filters again refresh the list and keep it on screen meanwhile. */
  load(filters: F): Promise<void>;
  /** "Load more": the next page, appended. */
  loadMore(): Promise<void>;
  /** A write created this item: it goes first if it belongs to the list on screen. */
  added(item: T): void;
  /** A write changed this item: replaced, or dropped if it no longer matches the filters. */
  updated(item: T): void;
  removed(id: string): void;
  reset(): void;
}

export interface PagedListConfig<T, F> {
  fetchPage(filters: F, before: string | undefined): Promise<Page<T>>;
  /** Whether an item belongs to the list with these filters (for `added` and `updated`). */
  matches(item: T, filters: F): boolean;
}

type Data<T, F> = Pick<PagedListState<T, F>, 'filters' | 'items' | 'nextCursor' | 'status' | 'error' | 'moreStatus' | 'moreError'>;

/** "Load more" cursors tried before giving up when items keep disappearing. */
const MAX_CURSOR_FALLBACKS = 10;

/** The API answers 400 on `before` when the cursor row is no longer part of the list (deleted, or out of scope). */
const isStaleCursor = (error: unknown) => hasDetailAt(error, 'before');

export function createPagedListStore<T extends { id: string }, F>(config: PagedListConfig<T, F>) {
  const empty = (): Data<T, F> => ({
    filters: null,
    items: [],
    nextCursor: null,
    status: 'idle',
    error: null,
    moreStatus: 'idle',
    moreError: null,
  });
  const gate = createRequestGate();

  return createStore<PagedListState<T, F>>()((set, get) => ({
    ...empty(),

    load(filters) {
      return gate.run(`load:${JSON.stringify(filters)}`, async (isLatest) => {
        const sameList = JSON.stringify(get().filters) === JSON.stringify(filters);
        set({
          ...(sameList ? {} : { items: [], nextCursor: null }),
          filters,
          status: 'loading',
          error: null,
          moreStatus: 'idle',
          moreError: null,
        });
        try {
          const page = await config.fetchPage(filters, undefined);
          if (isLatest()) set({ items: page.items, nextCursor: page.nextCursor, status: 'loaded' });
        } catch (error) {
          if (isLatest()) set({ status: 'error', error: errorMessage(error) });
        }
      });
    },

    loadMore() {
      const { filters, nextCursor, status, moreStatus } = get();
      if (filters === null || nextCursor === null || status !== 'loaded' || moreStatus === 'loading') {
        return Promise.resolve();
      }
      return gate.run(`more:${nextCursor}`, async (isLatest) => {
        set({ moreStatus: 'loading', moreError: null });
        let cursor = nextCursor;
        const gone = new Set<string>();
        try {
          for (let fallback = 0; ; fallback++) {
            try {
              const page = await config.fetchPage(filters, cursor);
              if (!isLatest()) return;
              const loaded = get().items.filter((item) => !gone.has(item.id));
              const seen = new Set(loaded.map((item) => item.id));
              set({
                items: [...loaded, ...page.items.filter((item) => !seen.has(item.id))],
                nextCursor: page.nextCursor,
                moreStatus: 'idle',
              });
              return;
            } catch (error) {
              // The cursor item was deleted since it loaded: continue from the
              // item before it (the duplicates that brings back are skipped).
              if (!isStaleCursor(error) || fallback >= MAX_CURSOR_FALLBACKS) throw error;
              gone.add(cursor);
              const items = get().items;
              const index = items.findIndex((item) => item.id === cursor);
              const previous = index < 0 ? undefined : items.slice(0, index).findLast((item) => !gone.has(item.id));
              if (previous === undefined) throw error;
              cursor = previous.id;
            }
          }
        } catch (error) {
          if (isLatest()) set({ moreStatus: 'error', moreError: errorMessage(error) });
        }
      });
    },

    // A read in flight may have been answered before the write: it is sent again first.
    added(item) {
      gate.writeLanded();
      const { filters, items, status } = get();
      if (filters === null || status !== 'loaded' || !config.matches(item, filters)) return;
      set({ items: [item, ...items.filter((existing) => existing.id !== item.id)] });
    },

    updated(item) {
      gate.writeLanded();
      const { filters, items } = get();
      if (filters === null || !items.some((existing) => existing.id === item.id)) return;
      set({
        items: config.matches(item, filters)
          ? items.map((existing) => (existing.id === item.id ? item : existing))
          : items.filter((existing) => existing.id !== item.id),
      });
    },

    removed(id) {
      gate.writeLanded();
      set({ items: get().items.filter((item) => item.id !== id) });
    },

    reset() {
      gate.invalidate();
      set(empty());
    },
  }));
}
