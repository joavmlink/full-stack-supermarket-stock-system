import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { loadConfig, type Config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { ensureSchema } from '../db/schema.js';
import { AppError } from '../errors.js';
import { PRODUCTION_SCRYPT } from '../lib/password.js';
import { acceptNewPassword, createPwnedPasswordsCheck } from '../lib/password-policy.js';
import { parseInput } from '../lib/validation.js';
import { createLogger, silentLogger } from '../logger.js';
import { createUser } from '../models/user-model.js';
import { AdminCreateSchema } from '../schemas/user-schemas.js';
import { createPrompter } from './prompt.js';

/**
 * Creates an administrator account. Run it once against the target database:
 *   npm run create-admin -w backend -- --env .env.production.local
 * The env file holds DATABASE_URL, so the secret never goes on the command line.
 * (Not `--env-file`: tsx also hands that flag to Node, which then fails on its own.)
 * Without DATABASE_URL it uses the local PGlite database (backend/data).
 */
function loadCliConfig(envFile: string | undefined): Config {
  if (envFile !== undefined) {
    // The file the operator names explicitly wins over the shell, so a stale
    // exported DATABASE_URL can never redirect the admin to another database.
    return loadConfig({ ...process.env, ...parseEnv(readFileSync(envFile, 'utf8')) });
  }
  // Like the server (`--env-file-if-exists=.env`): .env is optional and the shell wins over it.
  const dotenv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  return loadConfig({ ...dotenv, ...process.env });
}

/** Where the admin will be written, without credentials. */
function describeTarget(config: Config): string {
  if (config.databaseUrl !== undefined) {
    const url = new URL(config.databaseUrl);
    return `Postgres at ${url.host}${url.pathname}`;
  }
  return config.pgliteDataDir === undefined ? 'PGlite in memory' : `PGlite at ${resolve(config.pgliteDataDir)}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { env: { type: 'string' } } });
  const config = loadCliConfig(values.env);

  const prompter = createPrompter();
  let input;
  try {
    const fullName = await prompter.ask('Full name: ');
    const email = await prompter.ask('Email: ');
    const password = await prompter.askHidden('Password (15+ characters): ');
    const confirmation = await prompter.askHidden('Repeat the password: ');
    if (password !== confirmation) throw new Error('The passwords do not match.');
    input = parseInput(AdminCreateSchema, { fullName, email, password }, 'input');
  } finally {
    prompter.close();
  }

  // Breach-check failures are logged to stderr as JSON; the offline checks still apply.
  const logger = createLogger({ info: () => {}, error: (line) => process.stderr.write(`${line}\n`) });
  const passwordHash = await acceptNewPassword(input.password, input, {
    breachCheck: createPwnedPasswordsCheck({ baseUrl: config.pwnedPasswordsUrl, logger }),
    scrypt: PRODUCTION_SCRYPT,
  });

  process.stdout.write(`Target database: ${describeTarget(config)}\n`);
  const db = await openDatabase(config, silentLogger);
  try {
    await ensureSchema(db.pool);
    const admin = await createUser(db.pool, {
      id: randomUUID(),
      fullName: input.fullName,
      email: input.email,
      passwordHash,
      role: 'admin',
    });
    process.stdout.write(`Admin created: ${admin.email}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  // One format for every failure: validation and policy errors list their details.
  const details = error instanceof AppError ? error.details.map((detail) => `${detail.path ?? ''} ${detail.message}`.trim()) : [];
  const message = [error instanceof Error ? error.message : String(error), ...details].join(' ');
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
