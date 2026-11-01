import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AppError } from '../src/errors.js';
import { COMMON_PASSWORDS } from '../src/lib/password-blocklist-data.js';
import {
  acceptNewPassword,
  type BreachCheck,
  createPwnedPasswordsCheck,
  findPasswordProblem,
} from '../src/lib/password-policy.js';
import { verifyPassword } from '../src/lib/password.js';
import {
  BREACHED_PASSWORD,
  createCaptureLogger,
  fakeBreachCheck,
  startFakePwnedPasswords,
  STRONG_PASSWORD,
  TEST_SCRYPT,
  type FakePwnedPasswords,
} from './helpers.js';

describe('findPasswordProblem', () => {
  test('accepts a long passphrase with no composition rules', () => {
    assert.equal(findPasswordProblem(STRONG_PASSWORD), null);
    assert.equal(findPasswordProblem('alllowercaseletterswithoutdigits'), null);
  });

  test('rejects every bundled common password, ignoring case', () => {
    assert.ok(COMMON_PASSWORDS.length > 300);
    for (const common of COMMON_PASSWORDS) {
      assert.match(findPasswordProblem(common) ?? '', /commonly used/, common);
      assert.match(findPasswordProblem(common.toUpperCase()) ?? '', /commonly used|pattern|sequence|close/, common);
    }
  });

  for (const repeated of ['kkkkkkkkkkkkkkkkk', 'abababababababab', 'abcdabcdabcdabcd', '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀']) {
    test(`rejects the repeated pattern "${repeated}"`, () => {
      assert.match(findPasswordProblem(repeated) ?? '', /pattern repeated/);
    });
  }

  for (const sequence of ['abcdefghijklmnop', 'ponmlkjihgfedcba', 'qrstuvwxyz{|}~']) {
    test(`rejects the sequence "${sequence}"`, () => {
      assert.match(findPasswordProblem(sequence) ?? '', /sequence/);
    });
  }

  test('rejects passwords built from the service name, the email or the full name', () => {
    assert.match(findPasswordProblem('Supermarket2026!!!!') ?? '', /name of this service|close/);
    const context = { email: 'maria.gonzalez@example.com', fullName: 'María González' };
    assert.match(findPasswordProblem('MariaGonzalez2026!!', context) ?? '', /close/);
    assert.match(findPasswordProblem('maria.gonzalez@example.com', context) ?? '', /close/);
    assert.match(findPasswordProblem('mariagonzalez123456', context) ?? '', /close/);
    assert.equal(findPasswordProblem('maria likes long walks', context), null);
  });

  test('ignores diacritics when comparing with the name', () => {
    assert.match(findPasswordProblem('LuciaFernandez2026', { fullName: 'Lucía Fernández' }) ?? '', /close/);
    assert.match(findPasswordProblem('Lucía Fernández 2026', { fullName: 'Lucia Fernandez' }) ?? '', /close/);
  });

  test('does not treat a password without letters as matching an empty context', () => {
    assert.equal(findPasswordProblem('8264 9173 0582 7731', { email: '1234@example.com', fullName: '...' }), null);
  });
});

describe('createPwnedPasswordsCheck', () => {
  let fake: FakePwnedPasswords;
  let baseUrl: string;

  const sha1 = (value: string) => createHash('sha1').update(value).digest('hex').toUpperCase();

  before(async () => {
    fake = await startFakePwnedPasswords([BREACHED_PASSWORD]);
    baseUrl = fake.url;
  });

  after(async () => {
    await fake.close();
  });

  beforeEach(() => {
    fake.requests.length = 0;
    delete fake.respond;
  });

  const check = (timeoutMs?: number) => {
    const capture = createCaptureLogger();
    return { capture, run: createPwnedPasswordsCheck({ baseUrl, logger: capture.logger, timeoutMs }) };
  };

  test('sends only the first 5 hash characters, with padding and a user agent', async () => {
    const { run } = check();
    assert.equal(await run(STRONG_PASSWORD), 'not_found');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.url, `/range/${sha1(STRONG_PASSWORD).slice(0, 5)}`);
    assert.equal(fake.requests[0]?.headers['add-padding'], 'true');
    assert.equal(fake.requests[0]?.headers['user-agent'], 'supermarket-stock-system');
  });

  test('reports a breached password when its suffix has a positive count', async () => {
    assert.equal(await check().run(BREACHED_PASSWORD), 'breached');
    const suffix = sha1(STRONG_PASSWORD).slice(5);
    fake.respond = () => ({ status: 200, body: `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${suffix}:42\r\n` });
    assert.equal(await check().run(STRONG_PASSWORD), 'breached');
  });

  test('ignores padding entries, which have a count of 0', async () => {
    fake.respond = () => ({ status: 200, body: `${sha1(STRONG_PASSWORD).slice(5)}:0\r\n` });
    assert.equal(await check().run(STRONG_PASSWORD), 'not_found');
  });

  test('an error status is "unavailable" and is logged', async () => {
    fake.respond = () => ({ status: 503, body: 'down' });
    const { run, capture } = check();
    assert.equal(await run(STRONG_PASSWORD), 'unavailable');
    assert.equal(capture.entries[0]?.event, 'breach_check_unavailable');
    assert.match(JSON.stringify(capture.entries[0]?.fields), /HTTP 503/);
  });

  test('an error response has its body cancelled, so the connection is released', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const run = createPwnedPasswordsCheck({
      baseUrl,
      logger: createCaptureLogger().logger,
      fetch: async () => new Response(body, { status: 429 }),
    });
    assert.equal(await run(STRONG_PASSWORD), 'unavailable');
    assert.equal(cancelled, true);
  });

  test('a slow answer times out as "unavailable"', async () => {
    fake.respond = () => ({ status: 200, body: '', delayMs: 500 });
    const started = Date.now();
    assert.equal(await check(100).run(STRONG_PASSWORD), 'unavailable');
    assert.ok(Date.now() - started < 450);
  });

  test('an unreachable service is "unavailable"', async () => {
    const run = createPwnedPasswordsCheck({ baseUrl: 'http://127.0.0.1:9', logger: createCaptureLogger().logger });
    assert.equal(await run(STRONG_PASSWORD), 'unavailable');
  });
});

describe('acceptNewPassword', () => {
  const services = (breachCheck: BreachCheck = fakeBreachCheck()) => ({ breachCheck, scrypt: TEST_SCRYPT });

  const expectRejection = async (promise: Promise<string>, reason: RegExp) => {
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details[0]?.path, 'password');
      assert.match(error.details[0]?.message ?? '', reason);
      return true;
    });
  };

  test('returns the hash of an accepted password', async () => {
    const hash = await acceptNewPassword(STRONG_PASSWORD, {}, services());
    assert.match(hash, /^scrypt\$1024\$/);
    assert.equal(await verifyPassword(STRONG_PASSWORD, hash), true);
  });

  test('rejects with the offline reason without calling the breach check', async () => {
    const breachCheck = fakeBreachCheck();
    await expectRejection(acceptNewPassword('kkkkkkkkkkkkkkkkk', {}, services(breachCheck)), /pattern/);
    assert.equal(breachCheck.calls.length, 0);
  });

  test('rejects a breached password', async () => {
    await expectRejection(
      acceptNewPassword(STRONG_PASSWORD, {}, services(fakeBreachCheck([STRONG_PASSWORD]))),
      /data breach/,
    );
  });

  test('accepts when the breach check is unavailable (fail-open)', async () => {
    const hash = await acceptNewPassword(STRONG_PASSWORD, {}, services(async () => 'unavailable'));
    assert.equal(await verifyPassword(STRONG_PASSWORD, hash), true);
  });
});
