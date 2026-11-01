import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../src/api/errors';
import { RETRY_POLICY, realRetryDeps, retryDelayMs, runWithRetries } from '../../src/lib/retry';
import { fakeRetryDeps, flush, offline, rejected, serverError } from './helpers';

describe('retryDelayMs', () => {
  test('network errors, 429 and 5xx are retried with a growing, jittered backoff', () => {
    for (const error of [offline(), serverError(), new ApiError(500, 'INTERNAL_ERROR', 'x'), rejected(429, 'RATE_LIMITED')]) {
      assert.equal(retryDelayMs(error, 1, () => 0), 500);
      assert.equal(retryDelayMs(error, 1, () => 1), 1000);
      assert.equal(retryDelayMs(error, 2, () => 0.5), 1500);
      assert.equal(retryDelayMs(error, 3, () => 1), 4000);
    }
  });

  test('after the last attempt there is no retry', () => {
    assert.equal(retryDelayMs(offline(), RETRY_POLICY.maxAttempts, () => 0), null);
  });

  test('4xx (other than 429) and non-API errors are never retried', () => {
    for (const status of [400, 401, 403, 404, 405, 409, 413, 415]) {
      assert.equal(retryDelayMs(rejected(status, 'X'), 1, () => 0), null, String(status));
    }
    assert.equal(retryDelayMs(new TypeError('bug'), 1, () => 0), null);
  });

  test('a short Retry-After is honored; a long one stops the retries', () => {
    const soon = new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 7 });
    const later = new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 900 });
    assert.equal(retryDelayMs(soon, 1, () => 0), 7000);
    assert.equal(retryDelayMs(later, 1, () => 0), null);
  });
});

describe('runWithRetries', () => {
  function run(results: (() => Promise<string>)[], signal = new AbortController().signal) {
    const timers = fakeRetryDeps();
    const retries: number[] = [];
    let attempts = 0;
    const outcome = runWithRetries(() => results[attempts++]?.() ?? Promise.reject(new Error('no more')), {
      signal,
      deps: timers.retry,
      onRetry: (attempt) => retries.push(attempt),
    });
    return { outcome, timers, retries, attempts: () => attempts };
  }

  test('succeeds at once', async () => {
    const { outcome, retries } = run([async () => 'ok']);
    assert.deepEqual(await outcome, { kind: 'succeeded', value: 'ok' });
    assert.deepEqual(retries, []);
  });

  test('retries a network error and a 503, then succeeds', async () => {
    const { outcome, timers, retries } = run([
      () => Promise.reject(offline()),
      () => Promise.reject(serverError()),
      async () => 'stored',
    ]);
    await flush();
    assert.deepEqual(timers.waits.map((wait) => wait.ms), [750]);
    await timers.wakeAll();
    assert.deepEqual(timers.waits.map((wait) => wait.ms), [1500]);
    await timers.wakeAll();
    assert.deepEqual(await outcome, { kind: 'succeeded', value: 'stored' });
    assert.deepEqual(retries, [2, 3]);
  });

  test('ends as failed after the last attempt, with the last message', async () => {
    const { outcome, timers, attempts } = run(Array.from({ length: 5 }, () => () => Promise.reject(offline())));
    for (let i = 0; i < RETRY_POLICY.maxAttempts; i++) await timers.wakeAll();
    assert.deepEqual(await outcome, { kind: 'failed', message: 'Could not reach the server.' });
    assert.equal(attempts(), RETRY_POLICY.maxAttempts);
  });

  test('a 4xx ends as rejected at once, keeping the API error', async () => {
    const conflict = rejected(409, 'CATEGORY_NAME_TAKEN', 'A category with this name already exists.');
    const { outcome, attempts, timers } = run([() => Promise.reject(conflict)]);
    assert.deepEqual(await outcome, { kind: 'rejected', error: conflict });
    assert.equal(attempts(), 1);
    assert.equal(timers.waits.length, 0);
  });

  test('a 4xx after a retry is still rejected', async () => {
    const { outcome, timers } = run([() => Promise.reject(offline()), () => Promise.reject(rejected(400, 'VALIDATION_ERROR'))]);
    await timers.wakeAll();
    assert.equal((await outcome).kind, 'rejected');
  });

  test('an unexpected error fails with a generic message', async () => {
    const { outcome } = run([() => Promise.reject(new TypeError('bug'))]);
    assert.deepEqual(await outcome, { kind: 'failed', message: 'Something went wrong. Please try again.' });
  });

  test('aborting during the wait cancels without another attempt', async () => {
    const controller = new AbortController();
    const { outcome, attempts } = run([() => Promise.reject(offline()), async () => 'never'], controller.signal);
    await flush();
    controller.abort();
    assert.deepEqual(await outcome, { kind: 'cancelled' });
    assert.equal(attempts(), 1);
  });

  test('a response that arrives after the abort is cancelled too', async () => {
    const controller = new AbortController();
    const { outcome } = run(
      [
        () => {
          controller.abort();
          return Promise.reject(offline());
        },
      ],
      controller.signal,
    );
    assert.deepEqual(await outcome, { kind: 'cancelled' });
  });
});

describe('realRetryDeps.sleep', () => {
  test('resolves after the delay', async () => {
    const started = Date.now();
    await realRetryDeps.sleep(20, new AbortController().signal);
    assert.ok(Date.now() - started >= 15);
  });

  test('resolves at once when aborted, and clears its timer', async () => {
    const controller = new AbortController();
    const sleeping = realRetryDeps.sleep(60_000, controller.signal);
    controller.abort();
    await sleeping;
    await realRetryDeps.sleep(60_000, controller.signal);
  });
});
