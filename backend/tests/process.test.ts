import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url));

interface LogLine {
  level: string;
  event: string;
  [key: string]: unknown;
}

/** Runs src/index.ts as a real child process and collects its JSON log lines. */
function startProcess(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: LogLine[] = [];
  const listeners = new Set<() => void>();
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          lines.push(JSON.parse(line) as LogLine);
        } catch {
          lines.push({ level: 'raw', event: line });
        }
        for (const listener of listeners) listener();
      }
    });
  }
  const waitFor = (event: string, timeoutMs = 20_000) =>
    new Promise<LogLine>((resolve, reject) => {
      const check = () => {
        const found = lines.find((line) => line.event === event);
        if (found) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timed out waiting for "${event}". Got: ${JSON.stringify(lines)}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, lines, waitFor, exited };
}

function stop(child: ChildProcess) {
  if (child.exitCode === null) child.kill();
}

describe('server process', () => {
  test('starts with PGlite and serves the API', async () => {
    const { child, waitFor, exited } = startProcess({ PORT: '0' });
    try {
      const started = await waitFor('server_started');
      assert.equal(started.database, 'pglite');
      const response = await fetch(`http://127.0.0.1:${String(started.port)}/api/health`);
      assert.deepEqual(await response.json(), { status: 'ok' });
    } finally {
      stop(child);
      await exited;
    }
  });

  test(
    'SIGTERM shuts down gracefully with exit code 0',
    // Windows has no POSIX signals: kill() terminates the process without running handlers.
    { skip: process.platform === 'win32' && 'POSIX signals are not delivered on Windows' },
    async () => {
      const { child, waitFor, exited } = startProcess({ PORT: '0' });
      await waitFor('server_started');
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0);
      await waitFor('shutdown_completed');
    },
  );

  test(
    'a signal during startup closes what was opened and exits',
    { skip: process.platform === 'win32' && 'POSIX signals are not delivered on Windows' },
    async () => {
      const { child, waitFor, exited } = startProcess({ PORT: '0' });
      // The signal handlers are installed in the same tick that logs server_starting.
      await waitFor('server_starting');
      child.kill('SIGTERM');
      const [code] = await exited;
      const completed = await waitFor('shutdown_completed');
      // Usually the signal lands during bootstrap (exit 1); if startup already finished, it is a normal shutdown.
      assert.equal(code, completed.startupInterrupted ? 1 : 0);
    },
  );

  test('invalid configuration exits with code 1 and a JSON log line', async () => {
    const { waitFor, exited } = startProcess({ PORT: 'not-a-port' });
    const [code] = await exited;
    assert.equal(code, 1);
    const failure = await waitFor('startup_failed');
    assert.equal(failure.level, 'error');
    const error = failure.error as { name: string; message: string; stack: string };
    assert.equal(error.name, 'ConfigError');
    assert.match(error.message, /PORT/);
    assert.ok(error.stack);
  });

  test('a busy port exits with code 1', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      const { waitFor, exited } = startProcess({ PORT: String(port) });
      const [code] = await exited;
      assert.equal(code, 1);
      const failure = await waitFor('startup_failed');
      assert.equal((failure.error as { code: string }).code, 'EADDRINUSE');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
