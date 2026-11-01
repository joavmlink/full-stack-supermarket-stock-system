import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readHiddenKeys } from '../src/lib/hidden-input.js';

describe('readHiddenKeys', () => {
  test('collects characters until Enter', () => {
    assert.deepEqual(readHiddenKeys('', 'secret'), { value: 'secret', done: false, cancelled: false, rest: '' });
    assert.deepEqual(readHiddenKeys('secret', ' words\r'), {
      value: 'secret words',
      done: true,
      cancelled: false,
      rest: '',
    });
  });

  test('keeps what comes after Enter for the next prompt (pasted lines)', () => {
    assert.deepEqual(readHiddenKeys('', 'first answer\r\nsecond answer\r\n'), {
      value: 'first answer',
      done: true,
      cancelled: false,
      rest: 'second answer\r\n',
    });
    assert.equal(readHiddenKeys('', 'only\nnext').rest, 'next');
  });

  test('ignores arrow keys, Home/End and other escape sequences', () => {
    const keys = 'ab\u001b[Dc\u001b[H\u001b[1;5Cd\u001bOFe\u001b[3~f';
    assert.equal(readHiddenKeys('', keys).value, 'abcdef');
  });

  test('backspace removes the last character, including astral ones', () => {
    assert.equal(readHiddenKeys('', 'abc\u007f\u007fd').value, 'ad');
    assert.equal(readHiddenKeys('ok😀', '\b').value, 'ok');
    assert.equal(readHiddenKeys('', '\u007f').value, '');
  });

  test('ignores other control characters', () => {
    assert.equal(readHiddenKeys('', 'a\u0000b\tc\u0007').value, 'abc');
  });

  test('Ctrl+C cancels', () => {
    assert.deepEqual(readHiddenKeys('typed', 'more\u0003after'), { value: 'typedmore', done: true, cancelled: true, rest: '' });
  });
});
