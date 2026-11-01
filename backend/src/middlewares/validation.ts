import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '../errors.js';
import { parseInput } from '../lib/validation.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasBody(headers: Record<string, string | string[] | undefined>): boolean {
  const length = headers['content-length'];
  return headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/** Rejects request bodies that are not JSON with 415 before the body parser runs. */
export const requireJson: RequestHandler = (req, _res, next) => {
  if (BODY_METHODS.has(req.method) && hasBody(req.headers) && !req.is('application/json')) {
    next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The request body must be application/json.'));
    return;
  }
  next();
};

/** Validates the body and replaces `req.body` with the normalized value. */
export function validateBody<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, _res, next) => {
    req.body = parseInput(schema, req.body ?? null, 'request body');
    next();
  };
}
