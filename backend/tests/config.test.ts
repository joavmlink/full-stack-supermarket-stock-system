import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';

const SECRET_URL = 'postgresql://app_user:not-a-real-password@db.example.com:5432/app?sslmode=require';

describe('loadConfig', () => {
  test('applies development defaults', () => {
    const config = loadConfig({});
    assert.equal(config.isProduction, false);
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, undefined);
    assert.equal(config.pgliteDataDir, 'data');
    assert.deepEqual(config.corsOrigins, ['http://localhost:5173']);
    assert.equal(config.trustProxy, false);
    assert.equal(config.sessionTtlMs, 12 * 3_600_000);
    assert.deepEqual(config.rateLimit, {
      windowMs: 60_000,
      readMax: 300,
      writeMax: 60,
      loginWindowMs: 900_000,
      loginMax: 10,
      loginAccountMax: 100,
    });
  });

  test('keeps PGlite in memory outside development unless a directory is set', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).pgliteDataDir, undefined);
    assert.equal(loadConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: './tmp-db' }).pgliteDataDir, './tmp-db');
  });

  test('treats empty variables as not set, including numeric ones', () => {
    const config = loadConfig({
      NODE_ENV: '',
      PORT: '',
      DATABASE_URL: '  ',
      CORS_ORIGINS: '',
      SESSION_TTL_HOURS: '',
      RATE_LIMIT_WINDOW_MS: '',
      RATE_LIMIT_READ_MAX: '',
      RATE_LIMIT_WRITE_MAX: '',
      RATE_LIMIT_LOGIN_WINDOW_MS: '',
      RATE_LIMIT_LOGIN_MAX: '',
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '',
      VERCEL: '',
    });
    assert.equal(config.isProduction, false);
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, undefined);
    assert.deepEqual(config.corsOrigins, ['http://localhost:5173']);
    assert.equal(config.rateLimit.readMax, 300);
    assert.equal(config.trustProxy, false);
  });

  test('accepts port 0 and parses numbers', () => {
    const config = loadConfig({ PORT: '0', RATE_LIMIT_WRITE_MAX: '5', SESSION_TTL_HOURS: '1' });
    assert.equal(config.port, 0);
    assert.equal(config.rateLimit.writeMax, 5);
    assert.equal(config.sessionTtlMs, 3_600_000);
  });

  test('parses a comma-separated list of origins', () => {
    const config = loadConfig({ CORS_ORIGINS: ' http://localhost:5173 , https://shop.example.com/ ,,' });
    assert.deepEqual(config.corsOrigins, ['http://localhost:5173', 'https://shop.example.com']);
  });

  test('normalizes origins (lowercase host, default port removed)', () => {
    const config = loadConfig({ CORS_ORIGINS: 'https://Shop.Example.com,https://shop.example.com:443,http://localhost:80' });
    assert.deepEqual(config.corsOrigins, ['https://shop.example.com', 'https://shop.example.com', 'http://localhost']);
  });

  test('defaults the Pwned Passwords URL and strips trailing slashes', () => {
    assert.equal(loadConfig({}).pwnedPasswordsUrl, 'https://api.pwnedpasswords.com');
    assert.equal(loadConfig({ PWNED_PASSWORDS_URL: 'http://127.0.0.1:8080//' }).pwnedPasswordsUrl, 'http://127.0.0.1:8080');
  });

  test('trusts the proxy only on Vercel', () => {
    assert.equal(loadConfig({ VERCEL: '1' }).trustProxy, true);
    assert.equal(loadConfig({ VERCEL: '0' }).trustProxy, false);
  });

  test('requires DATABASE_URL in production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), {
      name: 'ConfigError',
      message: /DATABASE_URL is required when NODE_ENV=production/,
    });
    const config = loadConfig({ NODE_ENV: 'production', DATABASE_URL: SECRET_URL });
    assert.equal(config.isProduction, true);
    assert.equal(config.databaseUrl, SECRET_URL);
  });

  for (const [name, value] of [
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['PORT', '3.5'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['RATE_LIMIT_READ_MAX', '0'],
    ['SESSION_TTL_HOURS', '1000'],
    ['DATABASE_URL', 'mysql://user:pass@host/db'],
    ['DATABASE_URL', 'not a url'],
    ['CORS_ORIGINS', 'ftp://example.com'],
    ['CORS_ORIGINS', 'https://example.com/app'],
    ['CORS_ORIGINS', 'https://example.com/?a=1'],
    ['CORS_ORIGINS', 'https://example.com/#top'],
    ['CORS_ORIGINS', 'https://user:pass@example.com'],
    ['CORS_ORIGINS', 'not-an-origin'],
    ['PWNED_PASSWORDS_URL', 'ftp://example.com'],
  ] as const) {
    test(`rejects ${name}=${value}`, () => {
      assert.throws(() => loadConfig({ [name]: value }), (error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(`^Invalid configuration: ${name}`));
        return true;
      });
    });
  }

  test('never includes values in error messages', () => {
    const leaky = 'postgres-but-wrong://app_user:not-a-real-password@db.example.com/app';
    assert.throws(
      () => loadConfig({ DATABASE_URL: leaky, CORS_ORIGINS: 'https://secret-origin.example.com/path' }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.doesNotMatch(error.message, /not-a-real-password|app_user|secret-origin/);
        return true;
      },
    );
  });
});
