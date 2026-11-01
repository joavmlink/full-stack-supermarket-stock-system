import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COMMON_PASSWORDS } from '../src/lib/password-blocklist-data.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../src/lib/password-policy.js';

// The generator is a plain .mjs script; a string specifier keeps TypeScript from resolving it.
const generatorPath: string = '../../scripts/build-password-blocklist.mjs';
const generator = (await import(generatorPath)) as { MIN_LENGTH: number; MAX_LENGTH: number };

describe('generated password blocklist', () => {
  test('the generator filters with the same limits as the password policy', () => {
    assert.equal(generator.MIN_LENGTH, PASSWORD_MIN_LENGTH);
    assert.equal(generator.MAX_LENGTH, PASSWORD_MAX_LENGTH);
  });

  test('every entry is normalized, unique, sorted and within the limits', () => {
    for (const entry of COMMON_PASSWORDS) {
      assert.equal(entry, entry.normalize('NFC').toLowerCase(), entry);
      const length = [...entry].length;
      assert.ok(length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH, entry);
      assert.doesNotMatch(entry, /^\$hex\[/, entry);
      assert.doesNotMatch(entry, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'an email address is personal data');
    }
    assert.equal(new Set(COMMON_PASSWORDS).size, COMMON_PASSWORDS.length);
    assert.deepEqual([...COMMON_PASSWORDS].sort(), COMMON_PASSWORDS);
  });
});
