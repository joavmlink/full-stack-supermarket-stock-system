import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderModule, selectEntries } from './build-password-blocklist.mjs';

describe('selectEntries', () => {
  test('keeps unique, normalized entries between 15 and 128 characters, sorted', () => {
    const text = [
      'password',
      '1q2w3e4r5t6y7u8i',
      '1Q2W3E4R5T6Y7U8I',
      'exactly15chars!',
      'fourteen chars',
      'x'.repeat(128),
      'y'.repeat(129),
      '',
    ].join('\r\n');
    assert.deepEqual(selectEntries(text), ['1q2w3e4r5t6y7u8i', 'exactly15chars!', 'x'.repeat(128)]);
  });

  test('decodes hashcat $hex[...] entries before filtering', () => {
    const encoded = `$hex[${Buffer.from('http://example.com', 'utf8').toString('hex')}]`;
    const short = `$hex[${Buffer.from('http://ads', 'utf8').toString('hex')}]`;
    assert.deepEqual(selectEntries(`${encoded}\n${short}`), ['http://example.com']);
  });

  test('leaves out entries that are email addresses, which are personal data', () => {
    assert.deepEqual(selectEntries('someone.long@example.com\n@example-domain.com\nnot an email address'), [
      '@example-domain.com',
      'not an email address',
    ]);
  });

  test('counts code points, not UTF-16 units, and applies NFC', () => {
    const decomposed = 'café'.repeat(3); // 15 code points before NFC, 12 after
    const astral = '😀'.repeat(15); // 15 code points, 30 UTF-16 units
    assert.deepEqual(selectEntries(`${decomposed}\n${astral}`), [astral]);
  });
});

describe('renderModule', () => {
  test('renders a typed module with the source and license notice', () => {
    const output = renderModule(['aaaaaaaaaaaaaaa'], { sourceName: 'list.txt', sha256: 'abc' });
    assert.match(output, /MIT License, Copyright \(c\) 2018 Daniel Miessler/);
    assert.match(output, /File: list\.txt \(sha256 abc\)/);
    assert.match(output, /export const COMMON_PASSWORDS: readonly string\[\] = \[\n {2}"aaaaaaaaaaaaaaa"\n\];/);
  });
});
