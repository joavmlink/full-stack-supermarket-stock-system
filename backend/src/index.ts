import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import type { Database } from './db/database.js';
import { createLogger, logError } from './logger.js';
import { startServer, type RunningServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const logger = createLogger();
let db: Database | undefined;
let running: RunningServer | undefined;
let interrupted = false;

async function main(): Promise<void> {
  logger.info('server_starting');
  const config = loadConfig();
  const started = await bootstrap(config, logger);
  db = started.db;
  // A signal during bootstrap: don't start listening; shutdown() closes the database.
  if (interrupted) return;
  try {
    running = await startServer({ app: started.app, port: config.port, onClose: () => started.db.close() });
  } catch (error) {
    await started.db.close().catch(() => {});
    throw error;
  }
  logger.info('server_started', {
    port: running.port,
    database: config.databaseUrl === undefined ? 'pglite' : 'postgres',
  });
}

const startup = main().catch((error: unknown) => {
  logError(logger, 'startup_failed', error);
  if (!interrupted) process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logger.info('shutdown_started', { signal });
  const timer = setTimeout(() => {
    logger.error('shutdown_timed_out', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  // Interrupted while starting: let the startup settle so whatever it opened gets closed.
  const startupInterrupted = running === undefined;
  interrupted = true;
  try {
    await startup;
    await (running?.close() ?? db?.close());
    logger.info('shutdown_completed', { startupInterrupted });
    process.exit(startupInterrupted ? 1 : 0);
  } catch (error) {
    logError(logger, 'shutdown_failed', error);
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logError(logger, 'unhandled_rejection', reason);
});
