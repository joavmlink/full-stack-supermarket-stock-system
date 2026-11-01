import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PRELOAD_RELOAD_INTERVAL_MS,
  PRELOAD_RELOAD_KEY,
  handlePreloadError,
  parseReloadTimestamp,
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

describe('handlePreloadError', () => {
  function setup(stored: string | null, options: { blocked?: 'read' | 'write' | 'access' } = {}) {
    const values = new Map<string, string>();
    if (stored !== null) values.set(PRELOAD_RELOAD_KEY, stored);
    let reloads = 0;
    let prevented = false;
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
        { preventDefault: () => (prevented = true) },
        {
          storage: () => {
            if (options.blocked === 'access') throw new Error('SecurityError');
            return storage;
          },
          now: () => 50_000,
          reload: () => reloads++,
        },
      );
    return { run, values, result: () => ({ reloads, prevented }) };
  }

  test('the first failure records the time, swallows the error and reloads', () => {
    const { run, values, result } = setup(null);
    run();
    assert.deepEqual(result(), { reloads: 1, prevented: true });
    assert.equal(values.get(PRELOAD_RELOAD_KEY), '50000');
  });

  test('a failure right after an automatic reload lets the error reach the Error Boundary', () => {
    const { run, values, result } = setup('45000');
    run();
    assert.deepEqual(result(), { reloads: 0, prevented: false });
    assert.equal(values.get(PRELOAD_RELOAD_KEY), '45000');
  });

  test('a corrupt stored value counts as no previous reload', () => {
    const { run, result } = setup('garbage');
    run();
    assert.deepEqual(result(), { reloads: 1, prevented: true });
  });

  for (const [blocked, label] of [
    ['access', 'accessed'],
    ['read', 'read'],
    ['write', 'written'],
  ] as const) {
    test(`never reloads when storage cannot be ${label}`, () => {
      const { run, result } = setup(null, { blocked });
      run();
      assert.deepEqual(result(), { reloads: 0, prevented: false });
    });
  }
});
