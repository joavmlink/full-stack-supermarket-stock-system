// No `import.meta.env` here: Node unit tests import this module directly.

export interface ApiErrorDetail {
  path?: string;
  message: string;
  [key: string]: unknown;
}

/** The request never got an HTTP response (offline, DNS, connection reset, CORS). */
export const NETWORK_ERROR = 'NETWORK_ERROR';
/** A response the client cannot use: a 2xx that is not JSON, or JSON that does not parse. */
export const INVALID_RESPONSE = 'INVALID_RESPONSE';
/** An error response without the API's error body (for example, a proxy's HTML page). */
export const HTTP_ERROR = 'HTTP_ERROR';

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/** Every failed API call rejects with this error. */
export class ApiError extends Error {
  override name = 'ApiError';
  /** HTTP status; 0 when there was no response. */
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  /** Seconds from the `Retry-After` header, when the server sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: ApiErrorDetail[]; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** A message that is safe and useful to show to the user. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : GENERIC_MESSAGE;
}

/** Errors that can go away on their own: no response, rate limited, or a server error. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === NETWORK_ERROR || error.status === 429 || error.status >= 500;
}

/** The session is gone (expired, signed out elsewhere, account deleted): sign in again. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'UNAUTHENTICATED';
}

/** A 400 whose details point at `path` (for example, the `before` cursor). */
export function hasDetailAt(error: unknown, path: string): boolean {
  return error instanceof ApiError && error.status === 400 && error.details.some((detail) => detail.path === path);
}
