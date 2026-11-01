import { createHash } from 'node:crypto';
import { logError, type Logger } from '../logger.js';
import { hashPassword, normalizePassword, type ScryptParams } from './password.js';
import { COMMON_PASSWORDS } from './password-blocklist-data.js';
import { validationError } from './validation.js';

/** NIST SP 800-63B-4 lengths for single-factor passwords, counted in Unicode code points. */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

const BLOCKLIST: ReadonlySet<string> = new Set(COMMON_PASSWORDS);

/** Names of this service, compared against the letters of a candidate password. */
const SERVICE_TERMS = ['supermarket', 'supermarketstock', 'supermarketstocksystem', 'stocksystem', 'inventory'];

export interface PasswordContext {
  email?: string;
  fullName?: string;
}

/** Letters only, lowercase and without diacritics, so "Lucía" and "lucia2026" compare equal. */
const letters = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '');

function isSequential(codePoints: number[]): boolean {
  if (codePoints.length < 2) return false;
  const step = codePoints[1]! - codePoints[0]!;
  return (step === 1 || step === -1) && codePoints.every((point, i) => i === 0 || point - codePoints[i - 1]! === step);
}

/**
 * Offline checks for a new password: the bundled list of common passwords, a
 * short repeated pattern, a strictly sequential run, and context-specific words
 * (this service, the user's name and email). Returns the reason, or null.
 */
export function findPasswordProblem(password: string, context: PasswordContext = {}): string | null {
  const candidate = normalizePassword(password).toLowerCase();
  if (BLOCKLIST.has(candidate)) return 'This password is on a list of commonly used passwords.';
  if (/^(.{1,4})\1+$/su.test(candidate)) return 'This password is a short pattern repeated.';
  if (isSequential([...candidate].map((char) => char.codePointAt(0)!))) {
    return 'This password is a simple sequence of characters.';
  }
  const terms = [...SERVICE_TERMS];
  if (context.email) terms.push(letters(context.email), letters(context.email.split('@')[0] ?? ''));
  if (context.fullName) terms.push(letters(context.fullName));
  const candidateLetters = letters(candidate);
  if (candidateLetters !== '' && terms.includes(candidateLetters)) {
    return 'This password is too close to a name, an email or the name of this service.';
  }
  return null;
}

export type BreachCheckResult = 'breached' | 'not_found' | 'unavailable';
export type BreachCheck = (password: string) => Promise<BreachCheckResult>;

const USER_AGENT = 'supermarket-stock-system';

/**
 * Have I Been Pwned "Pwned Passwords" range API with k-anonymity: only the first
 * 5 characters of the SHA-1 hash leave the server. Padding hides the real number
 * of matches (padded entries have a count of 0). Any failure is reported as
 * "unavailable" and logged, so setting a password never depends on a third party.
 */
export function createPwnedPasswordsCheck(options: {
  baseUrl: string;
  logger: Logger;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}): BreachCheck {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const fetchRange = options.fetch ?? fetch;
  return async (password) => {
    const hash = createHash('sha1').update(normalizePassword(password), 'utf8').digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    try {
      const response = await fetchRange(`${options.baseUrl}/range/${prefix}`, {
        headers: { 'User-Agent': USER_AGENT, 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // An unread body keeps the connection busy until garbage collection.
        await response.body?.cancel();
        throw new Error(`Pwned Passwords answered HTTP ${response.status}`);
      }
      for (const line of (await response.text()).split('\n')) {
        const [lineSuffix, count] = line.trim().split(':');
        if (lineSuffix === suffix && Number(count) > 0) return 'breached';
      }
      return 'not_found';
    } catch (error) {
      logError(options.logger, 'breach_check_unavailable', error);
      return 'unavailable';
    }
  };
}

/**
 * The only way to turn a new password into a stored hash: it must pass the
 * offline checks and the breach check first. A rejection is a 400
 * VALIDATION_ERROR on `password` that gives the reason (NIST requires it).
 */
export async function acceptNewPassword(
  password: string,
  context: PasswordContext,
  services: { breachCheck: BreachCheck; scrypt: ScryptParams },
): Promise<string> {
  let problem = findPasswordProblem(password, context);
  if (problem === null && (await services.breachCheck(password)) === 'breached') {
    problem = 'This password has appeared in a data breach. Choose a different one.';
  }
  if (problem !== null) {
    throw validationError('Choose a different password.', [{ path: 'password', message: problem }]);
  }
  return hashPassword(password, services.scrypt);
}
