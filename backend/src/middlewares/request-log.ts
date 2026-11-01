import type { RequestHandler } from 'express';
import { requestPath } from '../lib/routing.js';
import type { Logger } from '../logger.js';

/** Logs method, path (without the query string), status and duration. Never IPs, bodies or headers. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const path = requestPath(req);
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - started) / 1_000n) / 1000;
      logger.info('request', { method: req.method, path, status: res.statusCode, durationMs });
    });
    next();
  };
}
