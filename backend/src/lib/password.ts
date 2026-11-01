import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  /** CPU/memory cost (a power of two). */
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

/** OWASP Password Storage Cheat Sheet parameters for scrypt (about 128 MiB per hash). */
export const PRODUCTION_SCRYPT: ScryptParams = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keyLength: 64 });

const SALT_BYTES = 16;
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

/** NIST SP 800-63B-4: passwords are normalized to NFC before hashing. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      normalizePassword(password),
      salt,
      params.keyLength,
      // Node's default maxmem (32 MiB) is below what N=2^17, r=8 needs (128 * N * r bytes).
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function format(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Returns `scrypt$N$r$p$salt$hash` (base64), so the parameters travel with each hash. */
export async function hashPassword(password: string, params: ScryptParams = PRODUCTION_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return format(params, salt, await derive(password, salt, params));
}

/**
 * A well-formed hash with random salt and key: verifying against it costs the
 * same as a real account and never matches. Built without hashing, so even the
 * first login of a fresh instance pays exactly one derivation.
 */
export function createDummyHash(params: ScryptParams): string {
  return format(params, randomBytes(SALT_BYTES), randomBytes(params.keyLength));
}

/** Verifies against the account's hash, or against `dummyHash` when there is no account (same cost, never true). */
export async function verifyPasswordOrDummy(
  password: string,
  stored: string | undefined,
  dummyHash: string,
): Promise<boolean> {
  const matches = await verifyPassword(password, stored ?? dummyHash);
  return stored !== undefined && matches;
}

/** Constant-time comparison; a malformed stored hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = FORMAT.exec(stored);
  if (!match) return false;
  const [, N, r, p, salt, hash] = match as unknown as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const params = { N: Number(N), r: Number(r), p: Number(p), keyLength: expected.length };
  const actual = await derive(password, Buffer.from(salt, 'base64'), params);
  return timingSafeEqual(actual, expected);
}
