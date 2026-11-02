// A tab opened before a deploy asks for chunks that no longer exist. Vite fires
// `vite:preloadError` when a lazy page fails to load: reload once to get the new
// build. If it keeps failing, let the error reach the Error Boundary instead of
// reloading in a loop.
//
// The browser keeps a missing chunk's 404 under the year-long cache of `/assets/`,
// and would go on using it if that chunk exists again (after a rollback). So the
// failed chunk is first requested past the cache, which replaces the stored answer.

export const PRELOAD_RELOAD_KEY = 'supermarket-stock-system:preload-reload-at';
/** At most one automatic reload in this window. */
export const PRELOAD_RELOAD_INTERVAL_MS = 10_000;
/** The reload waits this long at most for the failed chunk's fresh answer. */
const CHUNK_REFRESH_TIMEOUT_MS = 3_000;

/** The same-origin `/assets/` file an import error names; not every browser names one. */
export function failedChunkUrl(message: string, origin: string): string | null {
  const reference = /https?:\/\/\S+|\/assets\/\S+/.exec(message)?.[0];
  if (reference === undefined) return null;
  const url = new URL(reference, origin);
  return url.origin === origin && url.pathname.startsWith('/assets/') ? url.href : null;
}

/** Replaces the browser's stored answer for a chunk. A failure is ignored: the reload follows anyway. */
export async function refreshChunk(
  url: string,
  fetchChunk: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  try {
    const signal = AbortSignal.timeout(CHUNK_REFRESH_TIMEOUT_MS);
    const response = await fetchChunk(url, { cache: 'reload', signal });
    await response.arrayBuffer();
  } catch {
    // Nothing to do: the next load reports the failure if it remains.
  }
}

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
  origin: string;
  refresh: (url: string) => Promise<void>;
  reload: () => void;
}

/** The part of Vite's event used here; `payload` is the import error. */
type PreloadErrorEvent = Pick<Event, 'preventDefault'> & { payload?: unknown };

/**
 * Handles one `vite:preloadError` event; `preventDefault` stops Vite from rethrowing
 * the error, so it runs before the first await. The chunk is refreshed even without
 * a reload, so "Try again" on the error screen can load it.
 */
export async function handlePreloadError(event: PreloadErrorEvent, env: PreloadErrorEnvironment): Promise<void> {
  const message = event.payload instanceof Error ? event.payload.message : '';
  const chunk = failedChunkUrl(message, env.origin);
  const refreshed = chunk === null ? Promise.resolve() : env.refresh(chunk);

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
  await refreshed;
  env.reload();
}

export function installPreloadErrorReload(target: Window): void {
  target.addEventListener('vite:preloadError', (event) => {
    void handlePreloadError(event, {
      storage: () => target.sessionStorage,
      now: () => Date.now(),
      origin: target.location.origin,
      refresh: (url) => refreshChunk(url, (input, init) => target.fetch(input, init)),
      reload: () => target.location.reload(),
    });
  });
}
