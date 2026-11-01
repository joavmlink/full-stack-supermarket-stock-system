import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import {
  createCaptureLogger,
  expectError,
  failingPool,
  JSON_HEADERS,
  resetDatabase,
  startTestDatabase,
  startTestServer,
  testConfig,
  type LogEntry,
  type TestDatabase,
  type TestServer,
} from './helpers.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

let db: TestDatabase;
let server: TestServer;
let entries: LogEntry[];

before(async () => {
  db = await startTestDatabase();
  const capture = createCaptureLogger();
  entries = capture.entries;
  server = await startTestServer(createApp({ pool: db.pool, config: testConfig(), logger: capture.logger }));
});

after(async () => {
  await server.close();
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db.pool);
  entries.length = 0;
});

describe('health', () => {
  test('GET /api/health answers ok', async () => {
    const response = await fetch(`${server.url}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  test('HEAD /api/health is implied by GET', async () => {
    const response = await fetch(`${server.url}/api/health`, { method: 'HEAD' });
    assert.equal(response.status, 200);
  });
});

describe('routing errors', () => {
  test('unknown routes answer 404 ROUTE_NOT_FOUND in JSON', async () => {
    await expectError(await fetch(`${server.url}/api/nope`), 404, 'ROUTE_NOT_FOUND');
    await expectError(await fetch(`${server.url}/elsewhere`), 404, 'ROUTE_NOT_FOUND');
  });

  test('unsupported methods answer 405 with an Allow header', async () => {
    const response = await fetch(`${server.url}/api/health`, { method: 'DELETE' });
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    await expectError(response, 405, 'METHOD_NOT_ALLOWED');
  });
});

describe('request bodies', () => {
  test('a body over 10 KB answers 413', async () => {
    const body = JSON.stringify({ text: 'x'.repeat(11 * 1024) });
    await expectError(
      await fetch(`${server.url}/api/anything`, { method: 'POST', headers: JSON_HEADERS, body }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
  });

  test('malformed JSON answers 400 INVALID_JSON', async () => {
    await expectError(
      await fetch(`${server.url}/api/anything`, { method: 'POST', headers: JSON_HEADERS, body: '{"a":' }),
      400,
      'INVALID_JSON',
    );
  });

  test('a JSON primitive answers 400 INVALID_JSON (strict mode)', async () => {
    await expectError(
      await fetch(`${server.url}/api/anything`, { method: 'POST', headers: JSON_HEADERS, body: '"text"' }),
      400,
      'INVALID_JSON',
    );
  });

  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    test(`a ${contentType} body answers 415`, async () => {
      await expectError(
        await fetch(`${server.url}/api/anything`, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body: 'a=1',
        }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    });
  }

  test('a body without Content-Type answers 415', async () => {
    await expectError(
      await fetch(`${server.url}/api/anything`, { method: 'PATCH', body: new Uint8Array([123, 125]) }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  test('a non UTF-8 charset answers 415', async () => {
    await expectError(
      await fetch(`${server.url}/api/anything`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=latin1' },
        body: '{}',
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  test('a compressed body answers 415', async () => {
    await expectError(
      await fetch(`${server.url}/api/anything`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'Content-Encoding': 'gzip' },
        body: gzipSync('{}'),
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  test('a write without a body passes the JSON check', async () => {
    await expectError(await fetch(`${server.url}/api/anything`, { method: 'POST' }), 404, 'ROUTE_NOT_FOUND');
  });
});

describe('security headers and CORS', () => {
  test('helmet headers are set and X-Powered-By is not', async () => {
    const response = await fetch(`${server.url}/api/health`);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-security-policy'));
  });

  test('an allowed origin gets CORS headers with credentials and exposed headers', async () => {
    const response = await fetch(`${server.url}/api/health`, { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(response.headers.get('access-control-expose-headers'), 'Link,Retry-After,RateLimit,RateLimit-Policy');
  });

  test('a disallowed origin gets no CORS headers but is not rejected', async () => {
    const response = await fetch(`${server.url}/api/health`, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('a preflight lists the allowed methods and headers', async () => {
    const response = await fetch(`${server.url}/api/products`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET,HEAD,POST,PATCH,DELETE');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(response.headers.get('access-control-max-age'), '600');
  });
});

describe('request log', () => {
  test('logs method, path without query, status and duration only', async () => {
    await fetch(`${server.url}/api/health?token=secret-value`, {
      headers: { 'X-Forwarded-For': '203.0.113.7', Cookie: 'sid=secret-cookie' },
    });
    const entry = entries.find((item) => item.event === 'request');
    assert.ok(entry);
    assert.deepEqual(Object.keys(entry.fields).sort(), ['durationMs', 'method', 'path', 'status']);
    assert.equal(entry.fields.path, '/api/health');
    assert.equal(entry.fields.status, 200);
    assert.doesNotMatch(JSON.stringify(entries), /secret|203\.0\.113\.7|127\.0\.0\.1/);
  });
});

describe('unexpected errors', () => {
  test('a 500 keeps the stack in the log and out of the response', async () => {
    const capture = createCaptureLogger();
    const broken = await startTestServer(
      createApp({ pool: failingPool(new Error('kaboom internal detail')), config: testConfig(), logger: capture.logger }),
    );
    try {
      const response = await fetch(`${broken.url}/api/anything`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      const error = await expectError(response, 500, 'INTERNAL_ERROR');
      assert.doesNotMatch(JSON.stringify(error), /kaboom/);
      const logged = capture.entries.find((entry) => entry.event === 'request_failed');
      assert.ok(logged);
      assert.equal(logged.level, 'error');
      assert.equal(logged.fields.status, 500);
      assert.match(JSON.stringify(logged.fields.error), /kaboom internal detail/);
      assert.match(String((logged.fields.error as { stack: string }).stack), /at /);
    } finally {
      await broken.close();
    }
  });

  test('an unreachable database answers 503 with Retry-After', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const broken = await startTestServer(
      createApp({ pool: failingPool(error), config: testConfig(), logger: createCaptureLogger().logger }),
    );
    try {
      const response = await fetch(`${broken.url}/api/anything`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(response.headers.get('retry-after'), '5');
      await expectError(response, 503, 'SERVICE_UNAVAILABLE');
    } finally {
      await broken.close();
    }
  });
});
