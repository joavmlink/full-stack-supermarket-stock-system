// The API for the Playwright tests: the real app on an in-memory PGlite with
// fake users, on a dedicated port. Test-only (never built into dist): it adds
// POST /__e2e/reset, which empties every table and inserts the users again, so
// each test starts from the same data.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { startLocalDatabase } from '../src/db/local.js';
import { createPool } from '../src/db/pool.js';
import { ensureSchema } from '../src/db/schema.js';
import { logError, silentLogger, type Logger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import { fakeBreachCheck, insertUser, resetDatabase, testConfig, TEST_SCRYPT } from './helpers.js';

const port = Number(process.env.E2E_API_PORT ?? 3100);
const origins = (process.env.E2E_ORIGINS ?? 'http://127.0.0.1:5174').split(',');

/** The accounts every test can sign in with (password: STRONG_PASSWORD in helpers.ts). */
const E2E_USERS = [
  { email: 'admin@example.com', fullName: 'Alex Admin', role: 'admin' },
  { email: 'employee@example.com', fullName: 'Erin Employee', role: 'employee' },
  { email: 'other.employee@example.com', fullName: 'Owen Other', role: 'employee' },
] as const;

// Server errors (500s) are printed, so a failing test shows their stack; request logs are not.
const logger: Logger = { info: silentLogger.info, error: (event, fields) => console.error(event, fields) };

const local = await startLocalDatabase();
const pool = createPool(local.connectionString, 1, logger);
await ensureSchema(pool);

async function seed(): Promise<void> {
  await resetDatabase(pool);
  for (const user of E2E_USERS) await insertUser(pool, user);
}
await seed();

const app = createApp({
  pool,
  config: testConfig({ port, corsOrigins: origins }),
  logger,
  scrypt: TEST_SCRYPT,
  breachCheck: fakeBreachCheck(),
});

// A test that waits on the API until its timeout should say why: requests that
// take long or end without an answer, and stalls of the event loop (PGlite runs
// on this thread), are printed. Only the path is logged, never the query.
const SLOW_REQUEST_MS = 2_000;
function watchRequest(req: IncomingMessage, res: ServerResponse): void {
  const started = Date.now();
  const path = new URL(req.url ?? '/', 'http://e2e.invalid').pathname;
  res.on('close', () => {
    const elapsed = Date.now() - started;
    if (!res.writableFinished) console.error(`e2e_request_unanswered ${req.method} ${path} after ${elapsed} ms`);
    else if (elapsed > SLOW_REQUEST_MS) console.error(`e2e_request_slow ${req.method} ${path} ${res.statusCode} in ${elapsed} ms`);
  });
}

// The CPU the process used meanwhile tells a busy thread (about as much CPU as
// the stall) from a process the system did not run (almost none).
const LOOP_CHECK_MS = 500;
let lastTick = Date.now();
let lastCpu = process.cpuUsage();
setInterval(() => {
  const stalled = Date.now() - lastTick - LOOP_CHECK_MS;
  const cpu = process.cpuUsage(lastCpu);
  if (stalled > SLOW_REQUEST_MS) {
    const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
    console.error(`e2e_event_loop_stalled for ${stalled} ms (CPU used: ${cpuMs} ms), until ${new Date().toISOString()}`);
  }
  lastTick = Date.now();
  lastCpu = process.cpuUsage();
}, LOOP_CHECK_MS).unref();

// Resets run one after another, never interleaved.
let resetting = Promise.resolve();
const server = createServer((req, res) => {
  watchRequest(req, res);
  if (req.method !== 'POST' || req.url !== '/__e2e/reset') {
    app(req, res);
    return;
  }
  resetting = resetting.then(seed).then(
    () => {
      res.writeHead(204).end();
    },
    (error: unknown) => {
      logError(logger, 'e2e_reset_failed', error);
      res.writeHead(500).end();
    },
  );
});

async function shutdown(): Promise<void> {
  server.close();
  server.closeAllConnections();
  await pool.end();
  await local.close();
  process.exit(0);
}

server.listen(port, '127.0.0.1', () => console.log(`E2E API on http://127.0.0.1:${port}`));
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
