import { z } from 'zod';

/** An empty variable (`VAR=` in a .env file) counts as not set, for every type. */
const emptyAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const env = <T extends z.ZodType>(schema: T) => z.preprocess(emptyAsUndefined, schema);

const positiveInt = (fallback: number, max: number) =>
  env(z.coerce.number().int().min(1).max(max).default(fallback));

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'must be a postgres:// or postgresql:// URL',
});

/** An http(s) origin: scheme, host and optional port, normalized (lowercase host, no default port). */
const origin = z.url({ protocol: /^https?$/, error: 'must be an http(s) origin' }).transform((value, ctx) => {
  const parsed = new URL(value);
  const extra = parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '';
  if (extra || parsed.username !== '' || parsed.password !== '') {
    ctx.addIssue({ code: 'custom', message: 'must be a bare origin (scheme, host and optional port)' });
    return z.NEVER;
  }
  return parsed.origin;
});

const EnvSchema = z
  .object({
    NODE_ENV: env(z.enum(['development', 'test', 'production']).default('development')),
    VERCEL: env(z.string().optional()),
    PORT: env(z.coerce.number().int().min(0).max(65_535).default(3000)),
    DATABASE_URL: env(postgresUrl.optional()),
    PGLITE_DATA_DIR: env(z.string().optional()),
    CORS_ORIGINS: env(z.string().default('http://localhost:5173')),
    SESSION_TTL_HOURS: positiveInt(12, 24 * 30),
    RATE_LIMIT_WINDOW_MS: positiveInt(60_000, 3_600_000),
    RATE_LIMIT_READ_MAX: positiveInt(300, 1_000_000),
    RATE_LIMIT_WRITE_MAX: positiveInt(60, 1_000_000),
    RATE_LIMIT_LOGIN_WINDOW_MS: positiveInt(900_000, 86_400_000),
    RATE_LIMIT_LOGIN_MAX: positiveInt(10, 1_000_000),
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: positiveInt(100, 1_000_000),
    PWNED_PASSWORDS_URL: env(
      z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).default('https://api.pwnedpasswords.com'),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && value.DATABASE_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is required when NODE_ENV=production' });
    }
  });

const OriginsSchema = z.array(origin);

export interface Config {
  isProduction: boolean;
  port: number;
  /** `undefined` means "use the embedded PGlite database". */
  databaseUrl: string | undefined;
  /** PGlite data directory; `undefined` keeps the database in memory. */
  pgliteDataDir: string | undefined;
  corsOrigins: string[];
  /** Only behind Vercel, whose proxy rewrites X-Forwarded-For. */
  trustProxy: boolean;
  sessionTtlMs: number;
  /** Base URL of the Have I Been Pwned "Pwned Passwords" range API. */
  pwnedPasswordsUrl: string;
  rateLimit: {
    windowMs: number;
    readMax: number;
    writeMax: number;
    loginWindowMs: number;
    /** Failed logins per client IP. */
    loginMax: number;
    /** Failed logins per account, from any IP. Well above loginMax: a client at its limit leaves the owner able to sign in. */
    loginAccountMax: number;
  };
}

/** Raised for invalid configuration. The message names variables, never their values. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.') || 'environment'} ${issue.message}`).join('; ');
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${describeIssues(parsed.error.issues)}`);
  }
  const value = parsed.data;

  const rawOrigins = value.CORS_ORIGINS.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const origins = OriginsSchema.safeParse(rawOrigins);
  if (!origins.success) {
    const issues = origins.error.issues.map((issue) => ({ ...issue, path: ['CORS_ORIGINS'] }));
    throw new ConfigError(`Invalid configuration: ${describeIssues(issues)}`);
  }

  return {
    isProduction: value.NODE_ENV === 'production',
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    pgliteDataDir: value.PGLITE_DATA_DIR ?? (value.NODE_ENV === 'development' ? 'data' : undefined),
    corsOrigins: origins.data,
    trustProxy: value.VERCEL === '1',
    sessionTtlMs: value.SESSION_TTL_HOURS * 3_600_000,
    pwnedPasswordsUrl: value.PWNED_PASSWORDS_URL.replace(/\/+$/, ''),
    rateLimit: {
      windowMs: value.RATE_LIMIT_WINDOW_MS,
      readMax: value.RATE_LIMIT_READ_MAX,
      writeMax: value.RATE_LIMIT_WRITE_MAX,
      loginWindowMs: value.RATE_LIMIT_LOGIN_WINDOW_MS,
      loginMax: value.RATE_LIMIT_LOGIN_MAX,
      loginAccountMax: value.RATE_LIMIT_LOGIN_ACCOUNT_MAX,
    },
  };
}
