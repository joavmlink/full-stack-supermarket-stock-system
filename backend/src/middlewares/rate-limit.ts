import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Options, type Store } from 'express-rate-limit';
import type pg from 'pg';
import { AppError } from '../errors.js';
import { maybeRunInBackground } from '../lib/background.js';
import { sha256Hex } from '../lib/hash.js';
import type { Logger } from '../logger.js';
import { decrementHit, deleteExpiredHits, incrementHit, resetHits } from '../models/rate-limit-model.js';

/** Share of increments that also delete expired rows, so the table stays small. */
const CLEANUP_PROBABILITY = 0.01;

/**
 * SHA-256 of the client IP, with IPv6 addresses grouped by /56 subnet. Raw IPs
 * are never stored.
 */
function hashedClientKey(req: Request): string {
  return sha256Hex(ipKeyGenerator(req.ip ?? 'unknown'));
}

/**
 * express-rate-limit store backed by Postgres, so every instance (each Vercel
 * Function instance included) shares the same counters.
 */
export class PostgresStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  /** The most recent background cleanup; it never rejects (failures are logged). */
  lastCleanup: Promise<void> | undefined;
  private windowMs = 60_000;
  private readonly pool: pg.Pool;
  private readonly logger: Logger;
  private readonly random: () => number;

  constructor(options: { pool: pg.Pool; prefix: string; logger: Logger; random?: () => number }) {
    this.pool = options.pool;
    this.prefix = options.prefix;
    this.logger = options.logger;
    this.random = options.random ?? Math.random;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string) {
    const { hits, resetAt } = await incrementHit(this.pool, `${this.prefix}:${key}`, this.windowMs);
    this.lastCleanup =
      maybeRunInBackground({
        probability: CLEANUP_PROBABILITY,
        random: this.random,
        task: () => deleteExpiredHits(this.pool),
        logger: this.logger,
        event: 'rate_limit_cleanup_failed',
      }) ?? this.lastCleanup;
    return { totalHits: hits, resetTime: resetAt };
  }

  async decrement(key: string): Promise<void> {
    await decrementHit(this.pool, `${this.prefix}:${key}`);
  }

  async resetKey(key: string): Promise<void> {
    await resetHits(this.pool, `${this.prefix}:${key}`);
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const rejectTooManyRequests: Options['handler'] = (_req, _res, next) => {
  next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.'));
};

const commonOptions = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: hashedClientKey,
  handler: rejectTooManyRequests,
} satisfies Partial<Options>;

/** Reads: per-instance memory counter, mounted before anything that touches the database. */
export function readRateLimit(options: { windowMs: number; limit: number }): RequestHandler {
  return rateLimit({
    ...commonOptions,
    identifier: 'reads',
    windowMs: options.windowMs,
    limit: options.limit,
    skip: (req) => !READ_METHODS.has(req.method),
  });
}

/** Writes: counter shared by every instance through Postgres. */
export function writeRateLimit(options: {
  pool: pg.Pool;
  logger: Logger;
  windowMs: number;
  limit: number;
  random?: () => number;
}): RequestHandler {
  return rateLimit({
    ...commonOptions,
    identifier: 'writes',
    windowMs: options.windowMs,
    limit: options.limit,
    skip: (req) => READ_METHODS.has(req.method),
    store: new PostgresStore({ pool: options.pool, prefix: 'writes', logger: options.logger, random: options.random }),
  });
}

/**
 * Counts failed requests only (successful ones are refunded), shared through
 * Postgres under `name`. The count starts over when the window ends. `key`
 * defaults to the hashed client IP.
 */
export function failureRateLimit(options: {
  name: string;
  key?: (req: Request) => string;
  pool: pg.Pool;
  logger: Logger;
  windowMs: number;
  limit: number;
}): RequestHandler {
  return rateLimit({
    ...commonOptions,
    identifier: options.name,
    windowMs: options.windowMs,
    limit: options.limit,
    skipSuccessfulRequests: true,
    keyGenerator: options.key ?? hashedClientKey,
    store: new PostgresStore({ pool: options.pool, prefix: options.name, logger: options.logger }),
  });
}
