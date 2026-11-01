import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { createCaptureLogger, JSON_HEADERS, startTestServer, testConfig, type TestServer } from './helpers.js';

/**
 * A TCP server that accepts and immediately destroys every connection. It stays
 * bound for the whole file, so no other process can take the port meanwhile.
 */
let dropping: Server;
let connections = 0;
let server: TestServer;
let pool: ReturnType<typeof createPool>;
const capture = createCaptureLogger();

before(async () => {
  dropping = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
  const { port } = dropping.address() as AddressInfo;
  pool = createPool(`postgresql://app_user:not-a-real-password@127.0.0.1:${port}/app`, 1, capture.logger);
  server = await startTestServer(createApp({ pool, config: testConfig(), logger: capture.logger }));
});

after(async () => {
  await server.close();
  await pool.end();
  await new Promise<void>((resolve) => dropping.close(() => resolve()));
});

describe('database unavailable', () => {
  test('a write answers 503 SERVICE_UNAVAILABLE with Retry-After: 5', async () => {
    const response = await fetch(`${server.url}/api/anything`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
    assert.doesNotMatch(body.error.message, /127\.0\.0\.1|not-a-real-password/);
    assert.ok(connections >= 1, 'the pool reached the dropping server');
  });

  test('the failure is logged with its cause', () => {
    const logged = capture.entries.find((entry) => entry.event === 'request_failed');
    assert.ok(logged);
    assert.equal(logged.fields.status, 503);
  });

  test('requests that do not touch the database keep working', async () => {
    const response = await fetch(`${server.url}/api/health`);
    assert.equal(response.status, 200);
    await response.body?.cancel();
  });
});
