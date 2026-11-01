// Building blocks shared by the data stores. No React and no `import.meta.env`,
// so the Node unit tests use them directly.
import { ApiError, hasDetailAt, type ApiErrorDetail } from '../api/errors';
import { realRetryDeps, runWithRetries, type RetryDeps, type WriteOutcome } from '../lib/retry';

export interface StoreDeps {
  retry: RetryDeps;
  /** Client-generated ids for creates (the idempotency key of the write). */
  newId(): string;
}

export const realStoreDeps: StoreDeps = { retry: realRetryDeps, newId: () => crypto.randomUUID() };

/** A write as the screen shows it. */
export type WriteState =
  | { status: 'idle' }
  | { status: 'pending'; retrying: boolean }
  | { status: 'succeeded' }
  /** Retryable errors used up every attempt: the screen offers "Retry". */
  | { status: 'failed'; message: string }
  /** The server refused it (4xx): no "Retry", the user has to change something. */
  | { status: 'rejected'; message: string; code: string; details: ApiErrorDetail[] };

export const IDLE: WriteState = { status: 'idle' };
const PENDING: WriteState = { status: 'pending', retrying: false };
const RETRYING: WriteState = { status: 'pending', retrying: true };

function writeStateOf(outcome: WriteOutcome<unknown>): WriteState {
  switch (outcome.kind) {
    case 'succeeded':
      return { status: 'succeeded' };
    case 'failed':
      return { status: 'failed', message: outcome.message };
    case 'rejected':
      return { status: 'rejected', message: outcome.error.message, code: outcome.error.code, details: outcome.error.details };
    case 'cancelled':
      return IDLE;
  }
}

/** How a screen shows a read. */
export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';
/** A read of one item, which may not exist. */
export type ItemLoadStatus = LoadStatus | 'notFound';

/**
 * Orders the reads of one store: identical calls while one is in flight share
 * it (StrictMode runs effects twice, so a screen asks twice), and only the
 * latest request may apply its result.
 */
export function createRequestGate() {
  type Request = (isLatest: () => boolean) => Promise<void>;
  let ticket = 0;
  let inFlight: { key: string; ticket: number; promise: Promise<void>; request: Request } | null = null;

  function run(key: string, request: Request): Promise<void> {
    if (inFlight?.key === key && inFlight.ticket === ticket) return inFlight.promise;
    const mine = ++ticket;
    const promise = request(() => mine === ticket).finally(() => {
      if (inFlight?.ticket === mine) inFlight = null;
    });
    inFlight = { key, ticket: mine, promise, request };
    return promise;
  }

  return {
    run,
    /** Every request in flight becomes stale (its result is ignored). */
    invalidate() {
      ticket++;
      inFlight = null;
    },
    /**
     * A write changed the data: a read in flight may have been answered from
     * before it, so it is replaced by the same request sent again.
     */
    writeLanded() {
      if (inFlight === null) return;
      const { key, request } = inFlight;
      ticket++;
      inFlight = null;
      void run(key, request);
    },
  };
}

/**
 * The id of a create. While the body stays the same, every attempt reuses the
 * id, so the server stores it once and answers a repeat with the stored
 * resource. A different body, or a new create after a success, gets a new id.
 */
export function createIdempotencyKey(newId: () => string) {
  let last: { body: string; id: string } | null = null;
  return {
    for(body: unknown): string {
      const json = JSON.stringify(body);
      if (last?.body !== json) last = { body: json, id: newId() };
      return last.id;
    },
    /** The create that used `id` landed; a newer create keeps its own id. */
    clear(id?: string) {
      if (id === undefined || last?.id === id) last = null;
    },
  };
}

/** A write on screen: what it does, how it is going and what it sent. */
export interface TrackedWrite {
  kind: string;
  state: WriteState;
  /** What was sent, so a form reopened while the write is unfinished shows it. */
  input: unknown;
}

export type Writes = Readonly<Record<string, TrackedWrite>>;

export const writeOf = (writes: Writes, key: string): WriteState => writes[key]?.state ?? IDLE;

export interface WriteSpec<R> {
  kind: string;
  input?: unknown;
  operation(): Promise<R>;
  onSuccess?(value: R): void;
  onRejected?(error: ApiError): void;
}

/**
 * Runs the writes of one store, each under a key (a row, a form): retries
 * through `runWithRetries`, keeps their state in the store's `writes`, and
 * remembers the request of a failed write, so "Retry" sends exactly the same
 * one (same id, same body) whatever the screen shows by then. Writes do not
 * depend on any screen; `reset` (another user) stops them and voids their results.
 */
export function createWriteTracker(deps: StoreDeps, writes: { get(): Writes; set(writes: Writes): void }) {
  let lifetime = new AbortController();
  const specs = new Map<string, WriteSpec<unknown>>();

  const put = (key: string, entry: TrackedWrite | null) => {
    const { [key]: _previous, ...rest } = writes.get();
    writes.set(entry === null ? rest : { ...rest, [key]: entry });
  };
  const isPending = (key: string) => writes.get()[key]?.state.status === 'pending';

  async function start<R>(key: string, spec: WriteSpec<R>): Promise<WriteOutcome<R>> {
    if (isPending(key)) return { kind: 'cancelled' };
    const { signal } = lifetime;
    specs.set(key, spec as WriteSpec<unknown>);
    const show = (state: WriteState) => {
      if (!signal.aborted) put(key, { kind: spec.kind, input: spec.input, state });
    };
    show(PENDING);
    const outcome = await runWithRetries(spec.operation, { signal, deps: deps.retry, onRetry: () => show(RETRYING) });
    if (signal.aborted) return { kind: 'cancelled' };
    if (outcome.kind !== 'failed') specs.delete(key);
    if (outcome.kind === 'succeeded') spec.onSuccess?.(outcome.value);
    if (outcome.kind === 'rejected') spec.onRejected?.(outcome.error);
    show(writeStateOf(outcome));
    return outcome;
  }

  return {
    start,
    isPending,
    /** "Retry" after `failed`: the same request again. */
    retry(key: string): Promise<WriteOutcome<unknown>> {
      const spec = specs.get(key);
      return spec === undefined ? Promise.resolve({ kind: 'cancelled' }) : start(key, spec);
    },
    /** Forgets a finished write (the screen starts clean); a pending one stays. */
    dismiss(key: string) {
      if (isPending(key) || writes.get()[key] === undefined) return;
      specs.delete(key);
      put(key, null);
    },
    reset() {
      lifetime.abort();
      lifetime = new AbortController();
      specs.clear();
      writes.set({});
    },
  };
}

/** A 404, or an id in the URL that is not even valid: either way there is nothing to show. */
export function isNotFound(error: unknown): boolean {
  return (error instanceof ApiError && error.status === 404) || hasDetailAt(error, 'id');
}
