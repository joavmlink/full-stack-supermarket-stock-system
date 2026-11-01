import { ApiError, errorMessage, isRetryable } from '../api/errors';

/**
 * Writes are retried only for errors that can go away on their own (no
 * response, 429, 5xx): 4 attempts in all, waiting about 1 s, 2 s and 4 s
 * (half fixed, half random, so many tabs do not retry in step). A
 * `Retry-After` is honored when it is short; a longer one ends the write as
 * failed, and the user decides when to retry.
 */
export const RETRY_POLICY = { maxAttempts: 4, baseDelayMs: 1000, maxRetryAfterMs: 30_000 } as const;

/** The wait before the next attempt, or null when the write must stop retrying. */
export function retryDelayMs(error: unknown, attempt: number, random: () => number): number | null {
  if (!isRetryable(error) || attempt >= RETRY_POLICY.maxAttempts) return null;
  const retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  if (retryAfterSeconds !== undefined) {
    const delay = retryAfterSeconds * 1000;
    return delay <= RETRY_POLICY.maxRetryAfterMs ? delay : null;
  }
  const backoff = RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1);
  return Math.round(backoff / 2 + random() * (backoff / 2));
}

/**
 * - `succeeded`: the server stored it (a repeated create also answers 200 with the stored resource);
 * - `failed`: retryable errors until the attempts ran out; the user can retry the same write;
 * - `rejected`: the server refused it (4xx): retrying would get the same answer;
 * - `cancelled`: whoever owned the write is gone (sign-out), so it stopped.
 */
export type WriteOutcome<T> =
  | { kind: 'succeeded'; value: T }
  | { kind: 'failed'; message: string }
  | { kind: 'rejected'; error: ApiError }
  | { kind: 'cancelled' };

export interface RetryDeps {
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export const realRetryDeps: RetryDeps = {
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
    }),
  random: Math.random,
};

/**
 * Runs a write until it succeeds, is rejected, runs out of retries or `signal`
 * aborts. It does not depend on any screen: leaving the page does not stop it.
 * `onRetry` reports each new attempt after the first.
 */
export async function runWithRetries<T>(
  operation: () => Promise<T>,
  { signal, deps, onRetry }: { signal: AbortSignal; deps: RetryDeps; onRetry?: (attempt: number) => void },
): Promise<WriteOutcome<T>> {
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) return { kind: 'cancelled' };
    if (attempt > 1) onRetry?.(attempt);
    try {
      return { kind: 'succeeded', value: await operation() };
    } catch (error) {
      if (signal.aborted) return { kind: 'cancelled' };
      const delay = retryDelayMs(error, attempt, deps.random);
      if (delay === null) {
        if (error instanceof ApiError && !isRetryable(error)) return { kind: 'rejected', error };
        return { kind: 'failed', message: errorMessage(error) };
      }
      await deps.sleep(delay, signal);
    }
  }
}
