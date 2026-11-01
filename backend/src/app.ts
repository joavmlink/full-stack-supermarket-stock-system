import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Config } from './config.js';
import { PRODUCTION_SCRYPT, type ScryptParams } from './lib/password.js';
import { createPwnedPasswordsCheck, type BreachCheck } from './lib/password-policy.js';
import type { Logger } from './logger.js';
import { authenticate } from './middlewares/auth.js';
import { createErrorHandler, routeNotFound } from './middlewares/errors.js';
import { readRateLimit, writeRateLimit } from './middlewares/rate-limit.js';
import { requestLogger } from './middlewares/request-log.js';
import { requireJson } from './middlewares/validation.js';
import { healthRoutes } from './routes/health-routes.js';
import { apiRoutes } from './routes/index.js';

export interface AppDependencies {
  pool: pg.Pool;
  config: Config;
  logger: Logger;
  /** Injectable randomness for the probabilistic cleanup of expired rows (tests). */
  random?: () => number;
  /** Password hashing cost; tests use a cheaper one. Defaults to PRODUCTION_SCRYPT. */
  scrypt?: ScryptParams;
  /** Breached-password check; tests inject a fake. Defaults to Have I Been Pwned. */
  breachCheck?: BreachCheck;
}

/** The dependencies with their production defaults resolved, as routes and controllers get them. */
export type AppServices = Required<AppDependencies>;

function resolveServices(deps: AppDependencies): AppServices {
  return {
    ...deps,
    random: deps.random ?? Math.random,
    scrypt: deps.scrypt ?? PRODUCTION_SCRYPT,
    breachCheck:
      deps.breachCheck ?? createPwnedPasswordsCheck({ baseUrl: deps.config.pwnedPasswordsUrl, logger: deps.logger }),
  };
}

const BODY_LIMIT = '10kb';

/** Builds the Express app without listening on a port. */
export function createApp(deps: AppDependencies): Express {
  const services = resolveServices(deps);
  const { config, logger, pool } = services;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.set('query parser', 'simple');

  app.use(helmet());
  app.use(
    cors({
      // Disallowed origins simply get no CORS headers (never a 403): on Vercel
      // the browser also sends Origin on same-origin requests.
      origin: config.corsOrigins,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type'],
      exposedHeaders: ['Link', 'Retry-After', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );
  app.use(requestLogger(logger));

  app.use('/api', healthRoutes());

  const { rateLimit } = config;
  app.use('/api', readRateLimit({ windowMs: rateLimit.windowMs, limit: rateLimit.readMax }));
  app.use(
    '/api',
    writeRateLimit({ pool, logger, windowMs: rateLimit.windowMs, limit: rateLimit.writeMax, random: services.random }),
  );

  app.use(requireJson);
  app.use(express.json({ limit: BODY_LIMIT, inflate: false }));

  app.use('/api', authenticate(pool, config));
  app.use('/api', apiRoutes(services));
  app.use(routeNotFound);
  app.use(createErrorHandler(logger));
  return app;
}
