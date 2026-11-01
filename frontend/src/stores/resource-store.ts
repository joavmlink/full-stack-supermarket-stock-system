import { createStore } from 'zustand/vanilla';
import { errorMessage } from '../api/errors';
import { createRequestGate, isNotFound, type ItemLoadStatus } from './shared';

export interface ResourceState<T> {
  /** What is on screen (or being loaded): an id, or a fixed key for a single resource such as the stats. */
  key: string | null;
  data: T | null;
  status: ItemLoadStatus;
  error: string | null;
  /** Loads (or refreshes) one resource; a refresh keeps the current data on screen meanwhile. */
  load(key: string): Promise<void>;
  reset(): void;
}

export function createResourceStore<T>(fetch: (key: string) => Promise<T>) {
  const gate = createRequestGate();
  const empty = { key: null, data: null, status: 'idle', error: null } as const;

  return createStore<ResourceState<T>>()((set, get) => ({
    ...empty,

    load(key) {
      return gate.run(key, async (isLatest) => {
        set({ ...(get().key === key ? {} : { data: null }), key, status: 'loading', error: null });
        try {
          const data = await fetch(key);
          if (isLatest()) set({ data, status: 'loaded' });
        } catch (error) {
          if (!isLatest()) return;
          set(isNotFound(error) ? { data: null, status: 'notFound' } : { status: 'error', error: errorMessage(error) });
        }
      });
    },

    reset() {
      gate.invalidate();
      set(empty);
    },
  }));
}
