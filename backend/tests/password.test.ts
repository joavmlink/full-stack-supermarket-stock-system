import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createDummyHash,
  hashPassword,
  normalizePassword,
  PRODUCTION_SCRYPT,
  verifyPassword,
  verifyPasswordOrDummy,
} from '../src/lib/password.js';
import { TEST_SCRYPT } from './helpers.js';

describe('hashPassword', () => {
  test('uses the OWASP scrypt parameters by default and embeds them in the hash', async () => {
    assert.deepEqual(PRODUCTION_SCRYPT, { N: 131_072, r: 8, p: 1, keyLength: 64 });
    const hash = await hashPassword('correct horse battery staple');
    assert.match(hash, /^scrypt\$131072\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  test('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here', TEST_SCRYPT), hashPassword('same password here', TEST_SCRYPT)]);
    assert.notEqual(a, b);
  });
});

describe('verifyPassword', () => {
  test('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', TEST_SCRYPT);
    assert.equal(await verifyPassword('correct horse battery stapler', hash), false);
  });

  test('reads the parameters from the stored hash', async () => {
    const hash = await hashPassword('a different cost works too', { N: 2 ** 11, r: 4, p: 2, keyLength: 32 });
    assert.match(hash, /^scrypt\$2048\$4\$2\$/);
    assert.equal(await verifyPassword('a different cost works too', hash), true);
  });

  test('treats canonically equivalent Unicode passwords as the same (NFC)', async () => {
    const composed = 'piñata party at noon'; // ñ as one code point
    const decomposed = 'piñata party at noon'; // n + combining tilde
    assert.notEqual(composed, decomposed);
    assert.equal(normalizePassword(decomposed), composed);
    const hash = await hashPassword(decomposed, TEST_SCRYPT);
    assert.equal(await verifyPassword(composed, hash), true);
  });

  test('verifyPasswordOrDummy rejects a missing account after one derivation with the same parameters', async () => {
    const dummy = createDummyHash(TEST_SCRYPT);
    assert.equal(typeof dummy, 'string', 'built synchronously, without hashing');
    assert.match(dummy, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    assert.notEqual(createDummyHash(TEST_SCRYPT), dummy, 'random salt and key');
    assert.equal(await verifyPasswordOrDummy('correct horse battery staple', undefined, dummy), false);
    const real = await hashPassword('correct horse battery staple', TEST_SCRYPT);
    assert.equal(await verifyPasswordOrDummy('correct horse battery staple', real, dummy), true);
    assert.equal(await verifyPasswordOrDummy('wrong horse battery staple', real, dummy), false);
  });

  for (const stored of ['', 'plain-text', 'bcrypt$2b$10$abc', 'scrypt$1024$8$1$not base64$x', 'scrypt$1024$8$1$abc=']) {
    test(`never matches a malformed stored hash: "${stored}"`, async () => {
      assert.equal(await verifyPassword('anything at all here', stored), false);
    });
  }
});
