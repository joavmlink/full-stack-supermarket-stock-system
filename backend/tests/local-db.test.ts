import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { startLocalDatabase } from '../src/db/local.js';

const tempDirs: string[] = [];

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'local-db-'));
  tempDirs.push(root);
  return join(root, 'data');
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The PID of a process that has already exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(result.stdout);
}

describe('startLocalDatabase data directory lock', () => {
  test('a second opener of the same directory fails with a clear message', async () => {
    const dataDir = tempDataDir();
    const first = await startLocalDatabase(dataDir);
    try {
      assert.equal(readFileSync(`${dataDir}.lock`, 'utf8'), String(process.pid));
      await assert.rejects(startLocalDatabase(dataDir), {
        message: new RegExp(`in use by another process \\(PID ${process.pid}\\)`),
      });
    } finally {
      await first.close();
    }
  });

  test('closing releases the lock so the directory can be opened again', async () => {
    const dataDir = tempDataDir();
    await (await startLocalDatabase(dataDir)).close();
    assert.equal(existsSync(`${dataDir}.lock`), false);
    await (await startLocalDatabase(dataDir)).close();
  });

  test('a lock left by a process that no longer runs is taken over', async () => {
    const dataDir = tempDataDir();
    writeFileSync(`${dataDir}.lock`, String(deadPid()));
    const db = await startLocalDatabase(dataDir);
    try {
      assert.equal(readFileSync(`${dataDir}.lock`, 'utf8'), String(process.pid));
    } finally {
      await db.close();
    }
  });

  test('an in-memory database takes no lock', async () => {
    const db = await startLocalDatabase();
    await db.close();
  });
});
