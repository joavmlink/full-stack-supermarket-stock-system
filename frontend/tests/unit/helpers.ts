import { ApiError, NETWORK_ERROR } from '../../src/api/errors';
import type { RetryDeps } from '../../src/lib/retry';
import type { StoreDeps } from '../../src/stores/shared';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A fake API method: every call waits until the test settles it. `calls`
 * holds the arguments and the deferred of each call, in order.
 */
export function fakeMethod<A extends unknown[], R>() {
  const calls: { args: A; reply: Deferred<R> }[] = [];
  const method = (...args: A): Promise<R> => {
    const reply = deferred<R>();
    calls.push({ args, reply });
    return reply.promise;
  };
  return Object.assign(method, { calls });
}

export const offline = () => new ApiError(0, NETWORK_ERROR, 'Could not reach the server.');
export const serverError = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
export const rejected = (status: number, code: string, message = 'Rejected.', details: ApiError['details'] = []) =>
  new ApiError(status, code, message, { details });

/**
 * Retry timers the test controls: each wait is recorded and stays pending
 * until `wakeAll` (or the signal aborts, like the real sleep).
 */
export function fakeRetryDeps() {
  const waits: { ms: number; wake(): void }[] = [];
  const retry: RetryDeps = {
    random: () => 0.5,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
        waits.push({ ms, wake: resolve });
      }),
  };
  return {
    retry,
    waits,
    /** Lets failed attempts reach their wait, ends every wait, then lets the next attempts start. */
    async wakeAll() {
      await flush();
      for (const wait of waits.splice(0)) wait.wake();
      await flush();
    },
  };
}

/** Store deps with controlled timers and predictable ids (`id-1`, `id-2`, ...). */
export function fakeStoreDeps() {
  const timers = fakeRetryDeps();
  let counter = 0;
  const deps: StoreDeps = { retry: timers.retry, newId: () => `id-${++counter}` };
  return { deps, timers };
}
