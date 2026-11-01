import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError, HTTP_ERROR, INVALID_RESPONSE, NETWORK_ERROR } from '../../src/api/errors';
import { createHttpClient } from '../../src/api/http';

interface Call {
  url: string;
  init: RequestInit;
}

/** A client whose `fetch` records each call and answers with `respond`. */
function clientWith(respond: (call: Call) => Response | Promise<Response>, baseUrl = 'http://api.test/api') {
  const calls: Call[] = [];
  const client = createHttpClient({
    baseUrl,
    fetch: async (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the request to fail');
}

describe('requests', () => {
  test('sends JSON with credentials to the base URL and parses the JSON answer', async () => {
    const { client, calls } = clientWith(() => json({ id: 'a' }, 201));
    assert.deepEqual(await client.request('POST', '/categories', { body: { name: 'Dairy' } }), { id: 'a' });
    const [call] = calls;
    assert.equal(call?.url, 'http://api.test/api/categories');
    assert.equal(call?.init.method, 'POST');
    assert.equal(call?.init.credentials, 'include');
    assert.equal(call?.init.body, '{"name":"Dairy"}');
    assert.deepEqual(call?.init.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  test('a request without a body sends no Content-Type', async () => {
    const { client, calls } = clientWith(() => json([]));
    await client.request('GET', '/categories');
    assert.equal(calls[0]?.init.body, undefined);
    assert.deepEqual(calls[0]?.init.headers, { Accept: 'application/json' });
  });

  test('works with a relative base URL and ignores its trailing slash', async () => {
    const { client, calls } = clientWith(() => json({}), '/api/');
    await client.request('GET', '/stats');
    assert.equal(calls[0]?.url, '/api/stats');
  });

  test('204 resolves with undefined', async () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    assert.equal(await client.request('DELETE', '/categories/a'), undefined);
  });

  test('requestWithHeaders also returns the headers', async () => {
    const { client } = clientWith(() => json([1], 200, { Link: '</api/products?before=x>; rel="next"' }));
    const { data, headers } = await client.requestWithHeaders<number[]>('GET', '/products');
    assert.deepEqual(data, [1]);
    assert.equal(headers.get('link'), '</api/products?before=x>; rel="next"');
  });

  test('accepts a +json media type', async () => {
    const { client } = clientWith(
      () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/problem+json' } }),
    );
    assert.deepEqual(await client.request('GET', '/x'), { ok: true });
  });
});

describe('unusable successful responses', () => {
  test('a 2xx HTML page rejects with INVALID_RESPONSE', async () => {
    const { client } = clientWith(
      () => new Response('<!doctype html><title>Proxy</title>', { headers: { 'Content-Type': 'text/html' } }),
    );
    const error = await rejection(client.request('GET', '/products'));
    assert.equal(error.code, INVALID_RESPONSE);
    assert.equal(error.status, 200);
  });

  test('a 2xx without a Content-Type rejects with INVALID_RESPONSE', async () => {
    const { client } = clientWith(() => new Response('{"a":1}', { headers: { 'Content-Type': '' } }));
    assert.equal((await rejection(client.request('GET', '/products'))).code, INVALID_RESPONSE);
  });

  test('a 2xx whose JSON does not parse rejects with INVALID_RESPONSE', async () => {
    const { client } = clientWith(
      () => new Response('{"truncated', { headers: { 'Content-Type': 'application/json' } }),
    );
    assert.equal((await rejection(client.request('GET', '/products'))).code, INVALID_RESPONSE);
  });

  test('a lookalike media type is not JSON', async () => {
    const { client } = clientWith(() => new Response('{}', { headers: { 'Content-Type': 'application/jsonp' } }));
    assert.equal((await rejection(client.request('GET', '/products'))).code, INVALID_RESPONSE);
  });
});

describe('error responses', () => {
  test("the API's error body becomes an ApiError with its code, message and details", async () => {
    const details = [{ path: 'name', message: 'is required' }, 'not a detail', { path: 'x' }];
    const { client } = clientWith(() =>
      json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', details } }, 400),
    );
    const error = await rejection(client.request('POST', '/categories', { body: {} }));
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Invalid request body.');
    assert.deepEqual(error.details, [{ path: 'name', message: 'is required' }]);
  });

  test('a 429 keeps Retry-After in seconds', async () => {
    const { client } = clientWith(() =>
      json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } }, 429, {
        'Retry-After': '42',
      }),
    );
    const error = await rejection(client.request('GET', '/products'));
    assert.equal(error.retryAfterSeconds, 42);
  });

  test('a Retry-After date is ignored', async () => {
    const { client } = clientWith(() =>
      json({ error: { code: 'RATE_LIMITED', message: 'Slow down.' } }, 429, {
        'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
      }),
    );
    assert.equal((await rejection(client.request('GET', '/products'))).retryAfterSeconds, undefined);
  });

  for (const [label, response] of [
    ['an HTML error page', () => new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } })],
    ['JSON without the error shape', () => json({ message: 'nope' }, 502)],
    ['JSON that does not parse', () => new Response('{', { status: 502, headers: { 'Content-Type': 'application/json' } })],
    ['an error body with a non-string code', () => json({ error: { code: 7, message: 'x' } }, 502)],
  ] as const) {
    test(`${label} becomes a generic HTTP_ERROR with the status`, async () => {
      const { client } = clientWith(response);
      const error = await rejection(client.request('GET', '/products'));
      assert.equal(error.status, 502);
      assert.equal(error.code, HTTP_ERROR);
      assert.match(error.message, /\(502\)/);
    });
  }

  test('a failed fetch becomes NETWORK_ERROR with status 0', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = await rejection(client.request('GET', '/products'));
    assert.equal(error.status, 0);
    assert.equal(error.code, NETWORK_ERROR);
    assert.match(error.message, /Could not reach the server/);
  });
});

describe('onUnauthenticated', () => {
  const unauthenticated = () => json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }, 401);

  test('every listener hears a 401 UNAUTHENTICATED, which still rejects', async () => {
    const { client } = clientWith(unauthenticated);
    let heard = 0;
    client.onUnauthenticated(() => heard++);
    client.onUnauthenticated(() => heard++);
    assert.equal((await rejection(client.request('GET', '/categories'))).code, 'UNAUTHENTICATED');
    assert.equal(heard, 2);
  });

  test('wrong credentials (401 INVALID_CREDENTIALS) and 403 are not a lost session', async () => {
    let status = 401;
    const { client } = clientWith(() =>
      json({ error: { code: status === 401 ? 'INVALID_CREDENTIALS' : 'FORBIDDEN', message: 'x' } }, status),
    );
    let heard = 0;
    client.onUnauthenticated(() => heard++);
    await rejection(client.request('POST', '/auth/login', { body: {} }));
    status = 403;
    await rejection(client.request('POST', '/categories', { body: {} }));
    assert.equal(heard, 0);
  });

  test('the returned function removes the listener', async () => {
    const { client } = clientWith(unauthenticated);
    let heard = 0;
    const remove = client.onUnauthenticated(() => heard++);
    remove();
    await rejection(client.request('GET', '/categories'));
    assert.equal(heard, 0);
  });
});
