import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorMessage } from '../api/errors';
import type { WriteOutcome } from '../lib/retry';
import {
  createIdempotencyKey,
  createRequestGate,
  createWriteTracker,
  isNotFound,
  writeOf,
  type ItemLoadStatus,
  type StoreDeps,
  type WriteState,
  type Writes,
} from './shared';

/**
 * The create/edit screen of one resource (a product, an employee). Writes are
 * kept per form ("save:new", "save:<id>", "remove:<id>"), so a form shows only
 * its own; they retry on their own and keep going when the user leaves. A form
 * reopened while its write is unfinished shows that write and what it sent.
 */
export interface EditorState<T, F> {
  /** null on the "new" form. */
  targetId: string | null;
  item: T | null;
  loadStatus: ItemLoadStatus;
  loadError: string | null;
  writes: Writes;

  /** The form opened (or reopened) for this id, or for a new item. */
  open(targetId: string | null): Promise<void>;
  /** Loads the stored item again for a new form, discarding a finished save (a version conflict, a failed load). */
  reload(): Promise<void>;
  /** Creates, or saves only what changed. */
  submit(fields: F): Promise<WriteOutcome<T>>;
  delete(): Promise<WriteOutcome<void>>;
  /** "Retry" after a failed save or delete: the same request again. */
  retry(action: EditorAction): Promise<WriteOutcome<unknown>>;
  reset(): void;
}

export type EditorAction = 'save' | 'remove';

const writeKey = (action: EditorAction, targetId: string | null) => `${action}:${targetId ?? 'new'}`;

/** The save or delete of the form that is open. */
export const editorWrite = <T, F>(state: EditorState<T, F>, action: EditorAction): WriteState =>
  writeOf(state.writes, writeKey(action, state.targetId));

/** What the open form's unfinished save sent, to show it again. */
export const editorDraft = <T, F>(state: EditorState<T, F>): F | undefined => {
  const write = state.writes[writeKey('save', state.targetId)];
  return write !== undefined && write.state.status !== 'succeeded' ? (write.input as F) : undefined;
};

export interface EditorConfig<T, F> {
  get(id: string): Promise<T>;
  create(id: string, fields: F): Promise<T>;
  update(current: T, changes: Partial<F>): Promise<T>;
  remove(id: string): Promise<void>;
  /** The fields that differ from the stored item (empty: nothing to save). */
  changes(current: T, fields: F): Partial<F>;
  onSaved?(item: T, created: boolean): void;
  onRemoved?(id: string): void;
  deps: StoreDeps;
}

export type EditorStore<T, F> = StoreApi<EditorState<T, F>>;

export function createEditorStore<T extends { id: string }, F>(config: EditorConfig<T, F>): EditorStore<T, F> {
  const gate = createRequestGate();
  const createKey = createIdempotencyKey(config.deps.newId);

  return createStore<EditorState<T, F>>()((set, get) => {
    const tracker = createWriteTracker(config.deps, { get: () => get().writes, set: (writes) => set({ writes }) });
    const busy = (targetId: string | null) =>
      tracker.isPending(writeKey('save', targetId)) || tracker.isPending(writeKey('remove', targetId));

    function load(id: string) {
      return gate.run(id, async (isLatest) => {
        set({ loadStatus: 'loading', loadError: null });
        try {
          const item = await config.get(id);
          if (!isLatest() || get().targetId !== id) return;
          set({ item, loadStatus: 'loaded' });
        } catch (error) {
          if (!isLatest() || get().targetId !== id) return;
          set(isNotFound(error) ? { item: null, loadStatus: 'notFound' } : { loadStatus: 'error', loadError: errorMessage(error) });
        }
      });
    }

    return {
      targetId: null,
      item: null,
      loadStatus: 'idle',
      loadError: null,
      writes: {},

      open(targetId) {
        // A finished write belongs to the previous visit; an unfinished one is shown again.
        tracker.dismiss(writeKey('save', targetId));
        tracker.dismiss(writeKey('remove', targetId));
        // The form starts from what is stored now, not from an earlier visit (the version it
        // sends must be that of the values it shows); only a form showing an unfinished write keeps its item.
        if (get().targetId !== targetId || !busy(targetId)) set({ targetId, item: null, loadStatus: 'idle', loadError: null });
        return targetId === null ? Promise.resolve() : load(targetId);
      },

      reload() {
        const { targetId } = get();
        if (targetId === null) return Promise.resolve();
        tracker.dismiss(writeKey('save', targetId));
        set({ item: null, loadStatus: 'idle', loadError: null });
        return load(targetId);
      },

      async submit(fields) {
        const { targetId, item } = get();
        if (busy(targetId)) return { kind: 'cancelled' };
        if (targetId === null) {
          const id = createKey.for(fields);
          return tracker.start(writeKey('save', null), {
            kind: 'create',
            input: fields,
            operation: () => config.create(id, fields),
            onSuccess: (created) => {
              createKey.clear(id);
              config.onSaved?.(created, true);
            },
          });
        }
        if (item === null) return { kind: 'cancelled' };
        const changes = config.changes(item, fields);
        if (Object.keys(changes).length === 0) {
          return tracker.start(writeKey('save', targetId), { kind: 'update', input: fields, operation: async () => item });
        }
        return tracker.start(writeKey('save', targetId), {
          kind: 'update',
          input: fields,
          operation: () => config.update(item, changes),
          onSuccess: (saved) => {
            if (get().targetId === saved.id) set({ item: saved, loadStatus: 'loaded' });
            gate.writeLanded();
            config.onSaved?.(saved, false);
          },
        });
      },

      async delete() {
        const { targetId } = get();
        if (targetId === null || busy(targetId)) return { kind: 'cancelled' };
        return tracker.start(writeKey('remove', targetId), {
          kind: 'remove',
          operation: () => config.remove(targetId),
          onSuccess: () => config.onRemoved?.(targetId),
        });
      },

      retry(action) {
        return tracker.retry(writeKey(action, get().targetId));
      },

      reset() {
        tracker.reset();
        gate.invalidate();
        createKey.clear();
        set({ targetId: null, item: null, loadStatus: 'idle', loadError: null });
      },
    };
  });
}
