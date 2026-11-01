import type { RequestHandler, Response } from 'express';
import type pg from 'pg';
import type { Config } from '../config.js';
import { AppError, unauthenticated } from '../errors.js';
import { hashSessionToken, readSessionToken } from '../lib/session.js';
import { findSessionUser } from '../models/session-model.js';
import type { Role, User } from '../schemas/user-schemas.js';

declare global {
  // Express declares Locals as an interface; merging adds the signed-in user.
  namespace Express {
    interface Locals {
      user?: User;
    }
  }
}

/** Loads the signed-in user from the session cookie, if any. Only queries when a cookie is present. */
export function authenticate(pool: pg.Pool, config: Config): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req, config);
    if (token !== undefined) {
      const user = await findSessionUser(pool, hashSessionToken(token));
      if (user !== null) res.locals.user = user;
    }
    next();
  };
}

const requireAuth: RequestHandler = (_req, res, next) => {
  if (res.locals.user === undefined) {
    next(unauthenticated());
    return;
  }
  next();
};

function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (res.locals.user?.role !== role) {
      next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'));
      return;
    }
    next();
  };
}

/** The signed-in user; only call it after requireAuth. */
export function currentUser(res: Response): User {
  const user = res.locals.user;
  if (user === undefined) throw new Error('currentUser() called on a route without requireAuth');
  return user;
}

/** Shorthand chains for route definitions. */
export const signedIn = [requireAuth];
export const adminOnly = [requireAuth, requireRole('admin')];
