import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import express from 'express';
import { startServer } from '../src/server.js';

const app = () => {
  const instance = express();
  instance.get('/ping', (_req, res) => {
    res.json({ pong: true });
  });
  return instance;
};

describe('startServer', () => {
  test('listens on port 0 and reports the real port', async () => {
    const running = await startServer({ app: app(), port: 0, host: '127.0.0.1' });
    try {
      assert.ok(running.port > 0);
      const response = await fetch(`http://127.0.0.1:${running.port}/ping`);
      assert.deepEqual(await response.json(), { pong: true });
    } finally {
      await running.close();
    }
  });

  test('close() is not held open by an idle keep-alive connection', async () => {
    const running = await startServer({ app: app(), port: 0, host: '127.0.0.1' });
    // A raw keep-alive request leaves an idle socket open after the response.
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: running.port, path: '/ping', agent: false, headers: { Connection: 'keep-alive' } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    const started = Date.now();
    await running.close();
    assert.ok(Date.now() - started < 1_000, 'close() returned promptly');
  });

  test('close() is idempotent and runs onClose once', async () => {
    let closed = 0;
    const running = await startServer({
      app: app(),
      port: 0,
      host: '127.0.0.1',
      onClose: async () => {
        closed += 1;
      },
    });
    await Promise.all([running.close(), running.close()]);
    await running.close();
    assert.equal(closed, 1);
  });

  test('onClose still runs when server.close() fails', async () => {
    let closed = 0;
    const running = await startServer({
      app: app(),
      port: 0,
      host: '127.0.0.1',
      onClose: async () => {
        closed += 1;
      },
    });
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
    await assert.rejects(running.close(), { code: 'ERR_SERVER_NOT_RUNNING' });
    assert.equal(closed, 1);
  });

  test('rejects when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await assert.rejects(startServer({ app: app(), port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
