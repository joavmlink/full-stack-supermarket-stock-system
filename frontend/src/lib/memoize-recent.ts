/**
 * Reuses the answer of an identical call that is in flight or finished less
 * than `ttlMs` ago. A failed call is forgotten at once, so the next one tries
 * again. Keys are kept only while fresh.
 */
export function memoizeRecent<T>(
  fetch: (key: string) => Promise<T>,
  { ttlMs, now = Date.now }: { ttlMs: number; now?: () => number },
) {
  const entries = new Map<string, { promise: Promise<T>; settledAt: number | null }>();
  return {
    get(key: string): Promise<T> {
      const entry = entries.get(key);
      if (entry !== undefined && (entry.settledAt === null || now() - entry.settledAt < ttlMs)) return entry.promise;
      for (const [staleKey, stale] of entries) {
        if (stale.settledAt !== null && now() - stale.settledAt >= ttlMs) entries.delete(staleKey);
      }
      const fresh = { promise: fetch(key), settledAt: null as number | null };
      entries.set(key, fresh);
      fresh.promise.then(
        () => {
          fresh.settledAt = now();
        },
        () => {
          if (entries.get(key) === fresh) entries.delete(key);
        },
      );
      return fresh.promise;
    },
    clear() {
      entries.clear();
    },
  };
}
