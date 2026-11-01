import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Config } from '../config.js';

const TOKEN_BYTES = 32;
/** 32 random bytes in base64url: exactly 43 characters. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * `__Host-` makes the browser require Secure, Path=/ and no Domain, so no other
 * subdomain can set or overwrite the cookie. Local HTTP development cannot use
 * the prefix (it requires Secure), so it uses a plain name.
 */
function sessionCookieName(config: Config): string {
  return config.isProduction ? '__Host-sid' : 'sid';
}

export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Only the SHA-256 of the token is stored, so a database leak does not leak live sessions. */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** The session token from the request cookie, or undefined when absent or malformed. */
export function readSessionToken(req: Request, config: Config): string | undefined {
  const token = parseCookie(req.headers.cookie ?? '')[sessionCookieName(config)];
  return token !== undefined && TOKEN_FORMAT.test(token) ? token : undefined;
}

/** One attribute set for setting and clearing, so a logout always overwrites the login cookie. */
function buildSessionCookie(config: Config, value: string, maxAgeSeconds: number): string {
  return stringifySetCookie({
    name: sessionCookieName(config),
    value,
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function sessionCookie(config: Config, token: string): string {
  return buildSessionCookie(config, token, Math.floor(config.sessionTtlMs / 1000));
}

export function clearedSessionCookie(config: Config): string {
  return buildSessionCookie(config, '', 0);
}
