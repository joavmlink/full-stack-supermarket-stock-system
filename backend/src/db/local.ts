import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export interface LocalDatabase {
  connectionString: string;
  close(): Promise<void>;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * PGlite has no cross-process locking: two processes writing one data
 * directory (for example `npm run dev` and the create-admin CLI) can corrupt
 * it. A `<dir>.lock` file with the owner's PID makes the second opener fail; a
 * lock left behind by a process that no longer runs is taken over.
 */
function lockDataDir(dataDir: string): () => void {
  const lockPath = `${resolve(dataDir)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const take = () => writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  try {
    take();
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(owner) && owner > 0 && isRunning(owner)) {
      throw new Error(
        `The local database at ${dataDir} is in use by another process (PID ${owner}). Stop it (for example, npm run dev) and try again.`,
      );
    }
    rmSync(lockPath, { force: true });
    take();
  }
  return () => rmSync(lockPath, { force: true });
}

/**
 * Starts PGlite (embedded Postgres in WASM) behind a Postgres wire-protocol
 * socket, so development and tests use the same `pg` driver as production.
 * The socket listens on port 0 and the real port is read after `listen`, which
 * avoids racing other processes for a "free" port. PGlite is single-session:
 * the pool uses 1 connection and the server accepts 2, so a connection that the
 * pool discards after an error can be replaced while the old one closes.
 */
export async function startLocalDatabase(dataDir?: string): Promise<LocalDatabase> {
  const unlock = dataDir === undefined ? () => {} : lockDataDir(dataDir);
  const db = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 2 });
  try {
    await server.start();
  } catch (error) {
    await db.close();
    unlock();
    throw error;
  }
  return {
    connectionString: `postgresql://postgres@${server.getServerConn()}/postgres`,
    close: async () => {
      await server.stop();
      await db.close();
      unlock();
    },
  };
}
