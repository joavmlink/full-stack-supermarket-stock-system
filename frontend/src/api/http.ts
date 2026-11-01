// The HTTP core, without `import.meta.env`, so Node unit tests can import it
// with a fake `fetch`. `client.ts` builds the instance the app uses.
import { ApiError, HTTP_ERROR, INVALID_RESPONSE, NETWORK_ERROR, isUnauthenticated, type ApiErrorDetail } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
}

export interface ResponseWithHeaders<T> {
  data: T;
  headers: Headers;
}

export interface HttpClient {
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  /** Like `request`, but also returns the response headers (for `Link`). */
  requestWithHeaders<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<ResponseWithHeaders<T>>;
  /** Called whenever the API answers 401 UNAUTHENTICATED; returns a function that removes the listener. */
  onUnauthenticated(listener: () => void): () => void;
}

export interface HttpClientOptions {
  /** `http://localhost:3000/api` in development, `/api` in production. */
  baseUrl: string;
  fetch?: typeof fetch;
}

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
const INVALID_RESPONSE_MESSAGE = 'The server sent an unexpected response. Please try again.';

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

const isJson = (response: Response) => JSON_CONTENT_TYPE.test(response.headers.get('content-type') ?? '');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The API's error body: `{ error: { code, message, details } }`. */
function parseErrorBody(body: unknown): { code: string; message: string; details: ApiErrorDetail[] } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message, details } = body.error;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  const validDetails = Array.isArray(details)
    ? details.filter((detail): detail is ApiErrorDetail => isRecord(detail) && typeof detail.message === 'string')
    : [];
  return { code, message, details: validDetails };
}

/** `Retry-After` in seconds; the HTTP-date form is not used by the API and is ignored. */
function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const listeners = new Set<() => void>();

  const readJson = (response: Response): Promise<unknown> => response.json().catch(() => undefined);

  async function errorFrom(response: Response): Promise<ApiError> {
    const parsed = isJson(response) ? parseErrorBody(await readJson(response)) : null;
    const retryAfterSeconds = retryAfter(response.headers);
    if (parsed === null) {
      return new ApiError(response.status, HTTP_ERROR, `The server answered with an error (${response.status}). Please try again.`, {
        retryAfterSeconds,
      });
    }
    return new ApiError(response.status, parsed.code, parsed.message, { details: parsed.details, retryAfterSeconds });
  }

  async function requestWithHeaders<T>(
    method: HttpMethod,
    path: string,
    { body }: RequestOptions = {},
  ): Promise<ResponseWithHeaders<T>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
      });
    } catch {
      throw new ApiError(0, NETWORK_ERROR, NETWORK_MESSAGE);
    }

    if (!response.ok) {
      const error = await errorFrom(response);
      if (isUnauthenticated(error)) for (const listener of listeners) listener();
      throw error;
    }
    if (response.status === 204 || response.status === 205) {
      return { data: undefined as T, headers: response.headers };
    }
    // A 2xx that is not JSON (for example, an HTML page from a proxy or the SPA
    // fallback) must reach the screen's error state, not break it.
    const data = isJson(response) ? await readJson(response) : undefined;
    if (data === undefined) throw new ApiError(response.status, INVALID_RESPONSE, INVALID_RESPONSE_MESSAGE);
    return { data: data as T, headers: response.headers };
  }

  return {
    requestWithHeaders,
    async request<T>(method: HttpMethod, path: string, requestOptions?: RequestOptions) {
      return (await requestWithHeaders<T>(method, path, requestOptions)).data;
    },
    onUnauthenticated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
