import type { RequestHandler } from 'express';
import type { AppServices } from '../app.js';
import { AppError } from '../errors.js';
import { maybeRunInBackground } from '../lib/background.js';
import { createDummyHash, verifyPasswordOrDummy } from '../lib/password.js';
import {
  clearedSessionCookie,
  hashSessionToken,
  newSessionToken,
  readSessionToken,
  sessionCookie,
} from '../lib/session.js';
import { findLoginUser } from '../models/user-model.js';
import { deleteExpiredSessions, deleteSession, rotateSession } from '../models/session-model.js';
import type { LoginBody } from '../schemas/user-schemas.js';

/** Share of logins that also delete expired sessions, in the background. */
const SESSION_CLEANUP_PROBABILITY = 0.05;

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');

export function createAuthController(services: AppServices) {
  const { pool, config, logger } = services;
  // Unknown emails are checked against a dummy hash with the same cost, so the
  // response time does not reveal whether an account exists.
  const dummyHash = createDummyHash(services.scrypt);

  const login: RequestHandler = async (req, res) => {
    const { email, password } = req.body as LoginBody;
    const account = await findLoginUser(pool, email);
    const valid = await verifyPasswordOrDummy(password, account?.passwordHash, dummyHash);
    if (account === null || !valid) throw invalidCredentials();

    // A new token on every login (no session fixation); the previous one, if any, is revoked.
    const previous = readSessionToken(req, config);
    const token = newSessionToken();
    const signedIn = await rotateSession(
      pool,
      previous === undefined ? null : hashSessionToken(previous),
      hashSessionToken(token),
      { userId: account.user.id, passwordHash: account.passwordHash },
      config.sessionTtlMs,
    );
    if (!signedIn) throw invalidCredentials();
    void maybeRunInBackground({
      probability: SESSION_CLEANUP_PROBABILITY,
      random: services.random,
      task: () => deleteExpiredSessions(pool),
      logger,
      event: 'session_cleanup_failed',
    });

    res.append('Set-Cookie', sessionCookie(config, token));
    res.json(account.user);
  };

  /**
   * Always succeeds: signing out twice, or without a session, is not an error.
   * The cookie is cleared only for a request that brought it, which a SameSite=Strict
   * cookie means a request from this site.
   */
  const logout: RequestHandler = async (req, res) => {
    const token = readSessionToken(req, config);
    if (token !== undefined) {
      await deleteSession(pool, hashSessionToken(token));
      res.append('Set-Cookie', clearedSessionCookie(config));
    }
    res.status(204).end();
  };

  /**
   * Who is signed in: `{ user }`, or `{ user: null }` without a valid session.
   * Always 200, so the app's first load (anonymous or not) produces no error
   * response; routes that need a session still answer 401.
   */
  const session: RequestHandler = (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: res.locals.user ?? null });
  };

  return { login, logout, session };
}
