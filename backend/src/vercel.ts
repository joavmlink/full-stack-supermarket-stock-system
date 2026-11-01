import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { ensureSchema } from './db/schema.js';
import { AppError } from './errors.js';
import { createLogger, logError, type Logger } from './logger.js';
import { toHttpError, writeErrorResponse } from './middlewares/errors.js';

type Handler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  /** Closes the instance's pool (used by tests; Vercel just freezes the instance). */
  close(): Promise<void>;
};

const HEALTH_PATH = '/api/health';

function isHealthCheck(req: IncomingMessage): boolean {
  return new URL(req.url ?? '/', 'http://localhost').pathname === HEALTH_PATH;
}

/**
 * Builds the serverless handler. A missing or invalid configuration answers
 * 503 JSON instead of crashing (Vercel would serve its own non-JSON page).
 * The pool lives as long as the instance; the schema is created on the first
 * request that needs the database and retried on a later request if it fails.
 * The health check skips that step, so it never wakes the database.
 */
export function createVercelHandler(env: NodeJS.ProcessEnv, logger: Logger = createLogger()): Handler {
  let config;
  try {
    config = loadConfig({ ...env, NODE_ENV: 'production', VERCEL: '1' });
  } catch (error) {
    logError(logger, 'server_misconfigured', error);
    const misconfigured = async (_req: IncomingMessage, res: ServerResponse) =>
      writeErrorResponse(
        res,
        new AppError(503, 'SERVER_MISCONFIGURED', 'The server is misconfigured. Try again later.', {
          headers: { 'Retry-After': '60' },
        }),
      );
    return Object.assign(misconfigured, { close: async () => {} });
  }

  const ready = openDatabase(config, logger).then((db) => ({
    db,
    app: createApp({ pool: db.pool, config, logger }),
  }));
  let schema: Promise<void> | undefined;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { db, app } = await ready;
      if (!isHealthCheck(req)) {
        schema ??= ensureSchema(db.pool).catch((error: unknown) => {
          schema = undefined;
          throw error;
        });
        await schema;
      }
      app(req, res);
    } catch (error) {
      logError(logger, 'request_setup_failed', error);
      writeErrorResponse(res, toHttpError(error));
    }
  };
  return Object.assign(handle, { close: async () => (await ready).db.close() });
}

let handler: Handler | undefined;

/**
 * The Vercel Function entry; the handler is created on the first request and
 * reused by the instance. It is an Express app, not a plain function, because
 * Vercel gives an app the untouched request: express.json reads the body and
 * applies its own limit and error responses, as it does everywhere else.
 */
const entry = express();
entry.disable('x-powered-by');
entry.use((req, res) => {
  handler ??= createVercelHandler(process.env);
  return handler(req, res);
});

export default entry;
