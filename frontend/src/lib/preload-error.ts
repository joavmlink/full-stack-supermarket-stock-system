// A tab opened before a deploy asks for chunks that no longer exist. Vite fires
// `vite:preloadError` when a lazy page fails to load: reload once to get the new
// build. If it keeps failing, let the error reach the Error Boundary instead of
// reloading in a loop.

export const PRELOAD_RELOAD_KEY = 'supermarket-stock-system:preload-reload-at';
/** At most one automatic reload in this window. */
export const PRELOAD_RELOAD_INTERVAL_MS = 10_000;

/** Whether to reload, given when the last automatic reload happened (`null`: never). */
export function shouldReloadAfterPreloadError(now: number, lastReloadAt: number | null): boolean {
  if (lastReloadAt === null) return true;
  const elapsed = now - lastReloadAt;
  // A timestamp in the future (the clock moved back) cannot prove a recent reload.
  return elapsed < 0 || elapsed >= PRELOAD_RELOAD_INTERVAL_MS;
}

export function parseReloadTimestamp(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export interface PreloadErrorEnvironment {
  /** `sessionStorage`; reading the property itself can throw when storage is blocked. */
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  now: () => number;
  reload: () => void;
}

/** Handles one `vite:preloadError` event; `preventDefault` stops Vite from rethrowing the error. */
export function handlePreloadError(event: Pick<Event, 'preventDefault'>, env: PreloadErrorEnvironment): void {
  const now = env.now();
  try {
    const storage = env.storage();
    if (!shouldReloadAfterPreloadError(now, parseReloadTimestamp(storage.getItem(PRELOAD_RELOAD_KEY)))) return;
    storage.setItem(PRELOAD_RELOAD_KEY, String(now));
  } catch {
    // Without storage the guard cannot work, so never reload automatically.
    return;
  }
  event.preventDefault();
  env.reload();
}

export function installPreloadErrorReload(target: Window): void {
  target.addEventListener('vite:preloadError', (event) =>
    handlePreloadError(event, {
      storage: () => target.sessionStorage,
      now: () => Date.now(),
      reload: () => target.location.reload(),
    }),
  );
}
