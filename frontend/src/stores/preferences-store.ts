import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import type { FormMovementType } from '../api/types';
import { isFormMovementType } from '../lib/movement-types';

export const PREFERENCES_KEY = 'supermarket-stock-system:preferences';

/** Device preferences: they survive sign-out (they say nothing about the user). */
export interface PreferencesState {
  /** The type the stock form starts with: the last one used on this device. */
  movementType: FormMovementType;
  setMovementType(type: FormMovementType): void;
}

/**
 * localStorage can be missing or throw (private windows, blocked site data,
 * a full quota): preferences then last for the session only, and nothing breaks.
 */
export function safeStorage(getStorage: () => Storage): StateStorage {
  return {
    getItem(name) {
      try {
        return getStorage().getItem(name);
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      try {
        getStorage().setItem(name, value);
      } catch {
        // Not saved: the preference still applies until the page closes.
      }
    },
    removeItem(name) {
      try {
        getStorage().removeItem(name);
      } catch {
        // Nothing to clean up.
      }
    },
  };
}

export function createPreferencesStore(storage: StateStorage) {
  return createStore<PreferencesState>()(
    persist(
      (set) => ({
        movementType: 'sale',
        setMovementType: (movementType) => set({ movementType }),
      }),
      {
        name: PREFERENCES_KEY,
        version: 1,
        storage: createJSONStorage(() => storage),
        partialize: ({ movementType }) => ({ movementType }),
        // Stored data comes from outside the app: keep only valid values.
        merge: (persisted, current) => {
          const type = typeof persisted === 'object' && persisted !== null ? (persisted as Record<string, unknown>).movementType : undefined;
          return isFormMovementType(type) ? { ...current, movementType: type } : current;
        },
      },
    ),
  );
}
