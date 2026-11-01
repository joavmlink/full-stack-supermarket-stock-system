import type { Express } from 'express';
import { createApp } from './app.js';
import type { Config } from './config.js';
import { openDatabase, type Database } from './db/database.js';
import { ensureSchema } from './db/schema.js';
import type { Logger } from './logger.js';

export interface Bootstrapped {
  app: Express;
  db: Database;
}

/** Shared startup: connect, create the schema, build the app. */
export async function bootstrap(config: Config, logger: Logger): Promise<Bootstrapped> {
  const db = await openDatabase(config, logger);
  try {
    await ensureSchema(db.pool);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return { app: createApp({ pool: db.pool, config, logger }), db };
}
