import type { Queryable } from '../db/pool.js';
import type { User } from '../schemas/user-schemas.js';
import { toUser, userColumns } from './user-model.js';

/**
 * Signs a browser in with a new session and, in the same statement, revokes the
 * session it was using before (if any), so a token is never reused across logins.
 *
 * The session exists only if the user still has the password that was verified.
 * The row lock orders this statement against a password change: either the change
 * waits and then deletes this session, or this waits and sees the new hash.
 * Returns false, with no session, when the password changed or the user is gone.
 */
export async function rotateSession(
  db: Queryable,
  previousHash: Buffer | null,
  tokenHash: Buffer,
  account: { userId: string; passwordHash: string },
  ttlMs: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH revoked AS (DELETE FROM sessions WHERE token_hash = $4)
     INSERT INTO sessions (token_hash, user_id, expires_at)
     SELECT $1::bytea, u.id, now() + $3::double precision * interval '1 millisecond'
     FROM users u
     WHERE u.id = $2 AND u.password_hash = $5
     FOR SHARE OF u`,
    [tokenHash, account.userId, ttlMs, previousHash, account.passwordHash],
  );
  return rowCount === 1;
}

/** The user of a live (not expired) session, or null. */
export async function findSessionUser(db: Queryable, tokenHash: Buffer): Promise<User | null> {
  const { rows } = await db.query(
    `SELECT ${userColumns('u')}
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] === undefined ? null : toUser(rows[0]);
}

export async function deleteSession(db: Queryable, tokenHash: Buffer): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function deleteUserSessions(db: Queryable, userId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function deleteExpiredSessions(db: Queryable): Promise<void> {
  await db.query('DELETE FROM sessions WHERE expires_at <= now()');
}
