import type { Request, RequestHandler, Response, Router } from 'express';
import { AppError } from '../errors.js';

/** The request path without the query string (as received, including the /api mount). */
export function requestPath(req: Request): string {
  return req.originalUrl.split('?')[0] ?? '';
}

/** The Location of a resource created under this collection path (a trailing slash is ignored). */
function locationOf(req: Request, id: string): string {
  return `${requestPath(req).replace(/\/+$/, '')}/${id}`;
}

/**
 * The outcome of a create with a client-generated id. Retrying the same write
 * returns the stored resource (`created: false`) instead of an error, so a
 * retry whose first response was lost still succeeds; a different write with
 * a taken id answers 409 ALREADY_EXISTS.
 */
export interface Created<T> {
  item: T;
  created: boolean;
}

/** 201 with Location for a new resource, 200 with the same body for a replayed create. */
export function sendCreated(req: Request, res: Response, result: Created<{ id: string }>): void {
  res
    .status(result.created ? 201 : 200)
    .location(locationOf(req, result.item.id))
    .json(result.item);
}

type Method = 'get' | 'post' | 'patch' | 'delete';
export type RouteHandlers = Partial<Record<Method, RequestHandler[]>>;

/**
 * Registers the handlers of one path and answers every other method with
 * 405 METHOD_NOT_ALLOWED and an `Allow` header (HEAD is implied by GET).
 */
export function defineRoute(router: Router, path: string, handlers: RouteHandlers): void {
  const route = router.route(path);
  const allowed: string[] = [];
  for (const [method, chain] of Object.entries(handlers) as [Method, RequestHandler[]][]) {
    route[method](...chain);
    allowed.push(method.toUpperCase());
    if (method === 'get') allowed.push('HEAD');
  }
  const allow = allowed.join(', ');
  route.all((_req, _res, next) => {
    next(
      new AppError(405, 'METHOD_NOT_ALLOWED', 'This method is not allowed on this route.', {
        headers: { Allow: allow },
      }),
    );
  });
}
