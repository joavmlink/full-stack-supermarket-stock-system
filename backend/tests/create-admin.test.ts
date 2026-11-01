import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { startLocalDatabase } from '../src/db/local.js';
import { verifyPassword } from '../src/lib/password.js';
import {
  BREACHED_PASSWORD as BREACHED,
  startFakePwnedPasswords,
  STRONG_PASSWORD as PASSWORD,
  type FakePwnedPasswords,
} from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../src/cli/create-admin.ts', import.meta.url));
/** The tsx CLI, exactly as `npm run create-admin` launches it (tsx handles some flags itself). */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

let hibp: FakePwnedPasswords;
/** Working directory of the CLI: a fresh temp dir, so nothing can land in backend/data or read backend/.env. */
let workDir: string;
let dataDir: string;
const tempDirs: string[] = [];

before(async () => {
  hibp = await startFakePwnedPasswords([BREACHED]);
});

after(async () => {
  await hibp.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'create-admin-'));
  tempDirs.push(workDir);
  dataDir = join(workDir, 'db');
  hibp.requests.length = 0;
});

const posix = (path: string) => path.replaceAll('\\', '/');

/** `env` entries set to undefined are left out of the child environment. */
function runCli(answers: string[], options: { args?: string[]; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    NODE_ENV: 'development',
    PGLITE_DATA_DIR: dataDir,
    PWNED_PASSWORDS_URL: hibp.url,
    ...options.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, [TSX_CLI, SCRIPT, ...(options.args ?? [])], {
    cwd: workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(answers.map((answer) => `${answer}\n`).join(''));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function admins(dir: string) {
  const db = new PGlite(dir);
  try {
    const exists = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'users'`);
    if (exists.rows[0]?.n === 0) return [];
    const { rows } = await db.query<{ email: string; full_name: string; role: string; password_hash: string }>(
      'SELECT email, full_name, role, password_hash FROM users',
    );
    return rows;
  } finally {
    await db.close();
  }
}

describe('create-admin CLI', () => {
  test('creates an admin with a production-cost password hash', async () => {
    const result = await runCli(['Admin Person', ' Admin@Example.com ', PASSWORD, PASSWORD]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Admin created: admin@example\.com/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(PASSWORD));
    const rows = await admins(dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, 'admin');
    assert.equal(rows[0]?.full_name, 'Admin Person');
    assert.match(rows[0]!.password_hash, /^scrypt\$131072\$8\$1\$/);
    assert.equal(await verifyPassword(PASSWORD, rows[0]!.password_hash), true);
    assert.equal(hibp.requests.length, 1);
  });

  test('reads settings from --env', async () => {
    const envFile = join(workDir, 'cli.env');
    writeFileSync(envFile, `PGLITE_DATA_DIR=${posix(join(workDir, 'from-env-file'))}\n`);
    const result = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD], {
      args: ['--env', envFile],
      env: { PGLITE_DATA_DIR: undefined },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await admins(join(workDir, 'from-env-file'))).length, 1);
  });

  test('an explicit --env file wins over a variable already set in the shell', async () => {
    const envFile = join(workDir, 'cli.env');
    writeFileSync(envFile, `PGLITE_DATA_DIR=${posix(join(workDir, 'from-env-file'))}\n`);
    const result = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD], { args: ['--env', envFile] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await admins(join(workDir, 'from-env-file'))).length, 1);
    assert.deepEqual(await admins(dataDir), []);
  });

  test('without --env it loads .env from the working directory, like the server', async () => {
    writeFileSync(join(workDir, '.env'), `PGLITE_DATA_DIR=${posix(join(workDir, 'from-dotenv'))}\n`);
    const result = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD], {
      env: { PGLITE_DATA_DIR: undefined },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await admins(join(workDir, 'from-dotenv'))).length, 1);
  });

  test('a variable set in the shell wins over the default .env, like the server', async () => {
    writeFileSync(join(workDir, '.env'), `PGLITE_DATA_DIR=${posix(join(workDir, 'from-dotenv'))}\n`);
    const result = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await admins(dataDir)).length, 1);
  });

  test('says which database it writes to, without credentials', async () => {
    const local = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD]);
    assert.match(local.stdout, /Target database: PGlite at .*db/);
    const remote = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD], {
      env: { DATABASE_URL: 'postgresql://app_user:not-a-real-password@127.0.0.1:9/app' },
    });
    assert.equal(remote.code, 1);
    assert.match(remote.stdout, /Target database: Postgres at 127\.0\.0\.1:9\/app/);
    assert.doesNotMatch(remote.stdout + remote.stderr, /not-a-real-password|app_user/);
  });

  for (const [label, answers, message] of [
    ['mismatched passwords', ['Admin Person', 'admin@example.com', PASSWORD, `${PASSWORD}!`], /do not match/],
    ['a short password', ['Admin Person', 'admin@example.com', 'too short', 'too short'], /password must be at least 15/],
    ['an invalid email', ['Admin Person', 'admin', PASSWORD, PASSWORD], /email must be a valid email/],
    ['a common password', ['Admin Person', 'admin@example.com', '1q2w3e4r5t6y7u8i9o0p', '1q2w3e4r5t6y7u8i9o0p'], /commonly used/],
    ['a breached password', ['Admin Person', 'admin@example.com', BREACHED, BREACHED], /data breach/],
    ['missing answers', ['Admin Person'], /Input ended/],
  ] as const) {
    test(`exits with 1 on ${label} and creates nothing`, async () => {
      const result = await runCli([...answers]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, message);
      assert.deepEqual(await admins(dataDir), []);
    });
  }

  test('exits with 1 and a clear message when the --env file does not exist', async () => {
    const result = await runCli([], { args: ['--env', join(workDir, 'missing.env')] });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Error: .*missing.env/m);
  });

  test('refuses to open a local database that another process (npm run dev) has open', async () => {
    const running = await startLocalDatabase(dataDir);
    try {
      const result = await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /in use by another process \(PID \d+\)/);
    } finally {
      await running.close();
    }
  });

  test('exits with 1 when the email is taken', async () => {
    assert.equal((await runCli(['Admin Person', 'admin@example.com', PASSWORD, PASSWORD])).code, 0);
    const result = await runCli(['Someone Else', 'ADMIN@example.com', 'another long passphrase', 'another long passphrase']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already in use/);
    assert.equal((await admins(dataDir)).length, 1);
  });
});
