import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PRELOAD_RELOAD_INTERVAL_MS,
  PRELOAD_RELOAD_KEY,
  failedChunkUrl,
  handlePreloadError,
  parseReloadTimestamp,
  refreshChunk,
  shouldReloadAfterPreloadError,
} from '../../src/lib/preload-error';

describe('shouldReloadAfterPreloadError', () => {
  const now = 1_000_000;
  for (const [label, last, expected] of [
    ['never reloaded', null, true],
    ['reloaded just now', now, false],
    ['reloaded 1 ms before the window ends', now - PRELOAD_RELOAD_INTERVAL_MS + 1, false],
    ['reloaded exactly one window ago', now - PRELOAD_RELOAD_INTERVAL_MS, true],
    ['reloaded long ago', now - 60 * PRELOAD_RELOAD_INTERVAL_MS, true],
    ['a timestamp in the future', now + 5_000, true],
  ] as const) {
    test(label, () => assert.equal(shouldReloadAfterPreloadError(now, last), expected));
  }
});

test('parseReloadTimestamp accepts only digits', () => {
  assert.equal(parseReloadTimestamp('1700000000000'), 1_700_000_000_000);
  for (const value of [null, '', 'abc', '-5', '1e3', '12.5', ' 12']) assert.equal(parseReloadTimestamp(value), null, String(value));
});

describe('failedChunkUrl', () => {
  const origin = 'https://app.example.com';
  const chunk = `${origin}/assets/ProductsPage-abc123.js`;

  for (const [label, message, expected] of [
    ['Chromium', `Failed to fetch dynamically imported module: ${chunk}`, chunk],
    ['Firefox', `error loading dynamically imported module: ${chunk}`, chunk],
    ['a stylesheet preloaded by Vite', 'Unable to preload CSS for /assets/index-abc123.css', `${origin}/assets/index-abc123.css`],
    ['a message without a URL', 'Importing a module script failed.', null],
    ['another origin', 'Failed to fetch dynamically imported module: https://cdn.example.net/assets/a.js', null],
    ['a file outside the assets', `Failed to fetch dynamically imported module: ${origin}/index.html`, null],
    ['a directory lookalike', `Failed to fetch dynamically imported module: ${origin}/assets-old/a.js`, null],
  ] as const) {
    test(label, () => assert.equal(failedChunkUrl(message, origin), expected));
  }
});

describe('handlePreloadError', () => {
  const chunkUrl = 'https://app.example.com/assets/StockMovementsPage-abc123.js';

  function setup(
    stored: string | null,
    options: { blocked?: 'read' | 'write' | 'access'; payload?: unknown; refreshed?: Promise<void> } = {},
  ) {
    const values = new Map<string, string>();
    if (stored !== null) values.set(PRELOAD_RELOAD_KEY, stored);
    let reloads = 0;
    let prevented = false;
    const refreshedUrls: string[] = [];
    const storage = {
      getItem: (key: string) => {
        if (options.blocked === 'read') throw new Error('SecurityError');
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.blocked === 'write') throw new Error('QuotaExceededError');
        values.set(key, value);
      },
    };
    const run = () =>
      handlePreloadError(
        { preventDefault: () => (prevented = true), payload: options.payload },
        {
          storage: () => {
            if (options.blocked === 'access') throw new Error('SecurityError');
            return storage;
          },
          now: () => 50_000,
          origin: 'https://app.example.com',
          refresh: (url) => {
            refreshedUrls.push(url);
            return options.refreshed ?? Promise.resolve();
          },
          reload: () => reloads++,
        },
      );
    return { run, values, refreshedUrls, result: () => ({ reloads, prevented }) };
  }

  const missingChunk = new Error(`Failed to fetch dynamically imported module: ${chunkUrl}`);

  test('the first failure records the time, swallows the error and reloads', async () => {
    const { run, values, result } = setup(null);
    await run();
    assert.deepEqual(result(), { reloads: 1, prevented: true });
    assert.equal(values.get(PRELOAD_RELOAD_KEY), '50000');
  });

  test('a failure right after an automatic reload lets the error reach the Error Boundary', async () => {
    const { run, values, result } = setup('45000');
    await run();
    assert.deepEqual(result(), { reloads: 0, prevented: false });
    assert.equal(values.get(PRELOAD_RELOAD_KEY), '45000');
  });

  test('a corrupt stored value counts as no previous reload', async () => {
    const { run, result } = setup('garbage');
    await run();
    assert.deepEqual(result(), { reloads: 1, prevented: true });
  });

  for (const [blocked, label] of [
    ['access', 'accessed'],
    ['read', 'read'],
    ['write', 'written'],
  ] as const) {
    test(`never reloads when storage cannot be ${label}`, async () => {
      const { run, result } = setup(null, { blocked });
      await run();
      assert.deepEqual(result(), { reloads: 0, prevented: false });
    });
  }

  test('asks for the failed chunk again, and reloads only after that answer', async () => {
    let answer = () => {};
    const refreshed = new Promise<void>((resolve) => (answer = resolve));
    const { run, refreshedUrls, result } = setup(null, { payload: missingChunk, refreshed });

    const finished = run();
    assert.deepEqual(refreshedUrls, [chunkUrl]);
    // Vite reads defaultPrevented as soon as the event returns, so this cannot wait.
    assert.deepEqual(result(), { reloads: 0, prevented: true });

    answer();
    await finished;
    assert.deepEqual(result(), { reloads: 1, prevented: true });
  });

  test('without a reload the chunk is still refreshed, so "Try again" can load it', async () => {
    const { run, refreshedUrls, result } = setup('45000', { payload: missingChunk });
    await run();
    assert.deepEqual(refreshedUrls, [chunkUrl]);
    assert.deepEqual(result(), { reloads: 0, prevented: false });
  });

  test('an error that names no chunk reloads without asking for anything', async () => {
    const { run, refreshedUrls, result } = setup(null, { payload: new Error('Importing a module script failed.') });
    await run();
    assert.deepEqual(refreshedUrls, []);
    assert.deepEqual(result(), { reloads: 1, prevented: true });
  });
});

describe('refreshChunk', () => {
  const url = 'https://app.example.com/assets/a.js';

  test('bypasses the browser cache, reads the whole answer and limits the wait', async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    let bodyRead = false;
    const fakeFetch = async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return { arrayBuffer: async () => ((bodyRead = true), new ArrayBuffer(0)) } as Response;
    };
    await refreshChunk(url, fakeFetch);
    assert.equal(calls[0]?.input, url);
    assert.equal(calls[0]?.init?.cache, 'reload');
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
    assert.equal(bodyRead, true);
  });

  test('a failed request is ignored, so the reload still happens', async () => {
    await refreshChunk(url, () => Promise.reject(new TypeError('Failed to fetch')));
  });
});
