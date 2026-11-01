import type { ServerResponse } from 'node:http';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import { logError, type Logger } from '../logger.js';

/** Network-level failures reaching Postgres. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * SQLSTATEs for "database unavailable": too many connections, admin/crash shutdown,
 * cannot connect now, and a statement or transaction past its server-side limit.
 */
const UNAVAILABLE_SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03', '57014', '25P03']);

const UNAVAILABLE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'query read timeout',
  'connection terminated',
  'connection timeout',
  'too many connections',
];

/** True when the error means the database is unreachable, slow or saturated. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_ERROR_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code) || code.startsWith('08')) return true;
  }
  const message = error.message.toLowerCase();
  return UNAVAILABLE_MESSAGES.some((fragment) => message.includes(fragment));
}

const BODY_PARSER_ERRORS: Record<string, () => AppError> = {
  'entity.parse.failed': () => new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.'),
  'entity.too.large': () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'),
  'encoding.unsupported': () =>
    new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed or encoded request bodies are not supported.'),
  'charset.unsupported': () => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The request body must be UTF-8.'),
};

/** Translates any thrown value into the error that is safe to send to the client. */
export function toHttpError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const type = (error as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && type in BODY_PARSER_ERRORS) return BODY_PARSER_ERRORS[type]!();

  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError(400, 'BAD_REQUEST', 'The request is malformed.');
  }

  if (isDatabaseUnavailable(error)) {
    return new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again shortly.', {
      headers: { 'Retry-After': '5' },
    });
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
}

/**
 * Writes the single JSON error format. Uses the plain Node response API so the
 * Express error handler and the Vercel entry (before Express runs) share it.
 */
export function writeErrorResponse(res: ServerResponse, error: AppError): void {
  res.statusCode = error.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
  res.end(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }));
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const httpError = toHttpError(error);
    if (httpError.status >= 500) {
      logError(logger, 'request_failed', error, {
        method: req.method,
        path: req.path,
        status: httpError.status,
      });
    }
    writeErrorResponse(res, httpError);
  };
}

export const routeNotFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', 'The requested route does not exist.'));
};
