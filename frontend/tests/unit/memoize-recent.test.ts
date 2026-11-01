import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { memoizeRecent } from '../../src/lib/memoize-recent';
import { fakeMethod, flush } from './helpers';

describe('memoizeRecent', () => {
  function setup() {
    let clock = 0;
    const fetch = fakeMethod<[string], string>();
    const memo = memoizeRecent(fetch, { ttlMs: 5000, now: () => clock });
    return { fetch, memo, advance: (ms: number) => (clock += ms) };
  }

  test('an identical call in flight or within the window shares the answer', async () => {
    const { fetch, memo, advance } = setup();
    const first = memo.get('milk');
    assert.equal(memo.get('milk'), first);
    fetch.calls[0]?.reply.resolve('answer');
    await flush();
    advance(4999);
    assert.equal(await memo.get('milk'), 'answer');
    assert.equal(fetch.calls.length, 1);
  });

  test('after the window, another key or a clear, it asks again', async () => {
    const { fetch, memo, advance } = setup();
    void memo.get('milk');
    fetch.calls[0]?.reply.resolve('answer');
    await flush();
    void memo.get('bread');
    advance(5000);
    void memo.get('milk');
    memo.clear();
    void memo.get('bread');
    assert.deepEqual(fetch.calls.map((call) => call.args[0]), ['milk', 'bread', 'milk', 'bread']);
  });

  test('a failed call is forgotten at once', async () => {
    const { fetch, memo } = setup();
    const failing = memo.get('milk');
    fetch.calls[0]?.reply.reject(new Error('offline'));
    await assert.rejects(failing);
    await flush();
    void memo.get('milk');
    assert.equal(fetch.calls.length, 2);
  });
});
