import { createStore } from 'zustand/vanilla';
import type { CategoriesApi } from '../api/catalog-api';
import { errorMessage } from '../api/errors';
import { MAX_PAGE_SIZE } from '../api/limits';
import type { Category } from '../api/types';
import type { WriteOutcome } from '../lib/retry';
import {
  createIdempotencyKey,
  createRequestGate,
  createWriteTracker,
  type LoadStatus,
  type StoreDeps,
  type Writes,
} from './shared';

/** The key of the "new category" form in `writes`; every other key is a category id. */
export const NEW_CATEGORY = 'new';

/**
 * Every category, sorted by name: there are few, and both the products filter
 * and the product form need all of them. Writes are tracked per row, with
 * their kind (`create`, `rename`, `remove`), so a row reopened later still
 * labels and retries the right one.
 */
export interface CategoriesState {
  items: Category[];
  status: LoadStatus;
  error: string | null;
  writes: Writes;

  load(): Promise<void>;
  create(name: string): Promise<WriteOutcome<Category>>;
  rename(id: string, name: string): Promise<WriteOutcome<Category>>;
  remove(id: string): Promise<WriteOutcome<void>>;
  /** "Retry" after a failed write: the same request again. */
  retry(key: string): Promise<WriteOutcome<unknown>>;
  /** Hides a finished write's message (a row leaves edit mode, the form is typed in again). */
  dismiss(key: string): void;
  reset(): void;
}

const byName = (a: Category, b: Category) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

export function createCategoriesStore(api: CategoriesApi, deps: StoreDeps) {
  const gate = createRequestGate();
  const createKey = createIdempotencyKey(deps.newId);

  return createStore<CategoriesState>()((set, get) => {
    const tracker = createWriteTracker(deps, { get: () => get().writes, set: (writes) => set({ writes }) });

    /** A write changed the list; a load in flight may have read it before, so it is sent again. */
    const apply = (items: Category[]) => {
      set({ items: items.toSorted(byName) });
      gate.writeLanded();
    };

    return {
      items: [],
      status: 'idle',
      error: null,
      writes: {},

      load() {
        return gate.run('all', async (isLatest) => {
          set({ status: 'loading', error: null });
          try {
            const items: Category[] = [];
            let before: string | undefined;
            do {
              const page = await api.list({ before, limit: MAX_PAGE_SIZE });
              items.push(...page.items);
              before = page.nextCursor ?? undefined;
            } while (before !== undefined && isLatest());
            if (isLatest()) set({ items: items.toSorted(byName), status: 'loaded' });
          } catch (error) {
            if (isLatest()) set({ status: 'error', error: errorMessage(error) });
          }
        });
      },

      create(name) {
        const id = createKey.for({ name });
        return tracker.start(NEW_CATEGORY, {
          kind: 'create',
          input: name,
          operation: () => api.create(id, name),
          onSuccess: (category) => {
            createKey.clear(id);
            apply([...get().items.filter((item) => item.id !== category.id), category]);
          },
        });
      },

      rename(id, name) {
        return tracker.start(id, {
          kind: 'rename',
          input: name,
          operation: () => api.rename(id, name),
          onSuccess: (category) => apply(get().items.map((item) => (item.id === id ? category : item))),
        });
      },

      remove(id) {
        return tracker.start(id, {
          kind: 'remove',
          operation: () => api.remove(id),
          onSuccess: () => apply(get().items.filter((item) => item.id !== id)),
        });
      },

      retry: (key) => tracker.retry(key),
      dismiss: (key) => tracker.dismiss(key),

      reset() {
        tracker.reset();
        gate.invalidate();
        createKey.clear();
        set({ items: [], status: 'idle', error: null });
      },
    };
  });
}
