import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatDateTime } from '../../src/lib/dates';
import { nextPageCursor } from '../../src/lib/link-header';
import { formatDelta, formatInteger, formatUnits, parseQuantityInput } from '../../src/lib/numbers';

describe('formatInteger / formatUnits / formatDelta', () => {
  test('dot-grouped thousands', () => {
    assert.equal(formatInteger(0), '0');
    assert.equal(formatInteger(999), '999');
    assert.equal(formatInteger(1000), '1.000');
    assert.equal(formatInteger(1_000_000), '1.000.000');
    assert.equal(formatInteger(-1250), '-1.250');
  });

  test('units are singular only for one', () => {
    assert.equal(formatUnits(1), '1 unit');
    assert.equal(formatUnits(-1), '-1 unit');
    assert.equal(formatUnits(0), '0 units');
    assert.equal(formatUnits(1250), '1.250 units');
  });

  test('deltas carry their sign', () => {
    assert.equal(formatDelta(5), '+5');
    assert.equal(formatDelta(-1250), '-1.250');
    assert.equal(formatDelta(0), '0');
  });

  test('non-integers throw', () => {
    assert.throws(() => formatInteger(1.5), TypeError);
    assert.throws(() => formatInteger(Number.NaN), TypeError);
  });
});

describe('parseQuantityInput', () => {
  const range = { min: 1, max: 100_000 };

  test('plain and dot-grouped whole numbers', () => {
    assert.deepEqual(parseQuantityInput('12', range), { ok: true, value: 12 });
    assert.deepEqual(parseQuantityInput(' 1.250 ', range), { ok: true, value: 1250 });
    assert.deepEqual(parseQuantityInput('100.000', range), { ok: true, value: 100_000 });
    assert.deepEqual(parseQuantityInput('007', range), { ok: true, value: 7 });
  });

  test('errors name the problem', () => {
    assert.deepEqual(parseQuantityInput('', range), { ok: false, error: 'Enter a quantity.' });
    for (const text of ['1,5', '1.5', '12.50', '-3', 'abc', '1 000', '1.2345']) {
      assert.deepEqual(parseQuantityInput(text, range), { ok: false, error: 'Enter a whole number.' }, text);
    }
    assert.deepEqual(parseQuantityInput('0', range), { ok: false, error: 'Enter at least 1.' });
    assert.deepEqual(parseQuantityInput('100001', range), { ok: false, error: 'Enter at most 100.000.' });
    assert.deepEqual(parseQuantityInput('9'.repeat(40), range), { ok: false, error: 'Enter at most 100.000.' });
  });

  test('zero is valid when the minimum is zero', () => {
    assert.deepEqual(parseQuantityInput('0', { min: 0, max: 10 }), { ok: true, value: 0 });
  });
});

describe('formatDateTime', () => {
  test('day first, month as a word, 24-hour clock', () => {
    assert.equal(formatDateTime('2026-10-31T17:05:09.000Z', 'UTC'), '31 Oct 2026, 17:05');
    assert.equal(formatDateTime('2026-09-01T00:00:00.000Z', 'UTC'), '1 Sep 2026, 00:00');
  });

  test('uses the given time zone', () => {
    assert.equal(formatDateTime('2026-01-01T02:30:00.000Z', 'America/Argentina/Buenos_Aires'), '31 Dec 2025, 23:30');
  });

  test('every month has its name', () => {
    const names = Array.from({ length: 12 }, (_, month) =>
      formatDateTime(new Date(Date.UTC(2026, month, 15, 12)).toISOString(), 'UTC').split(' ')[1],
    );
    assert.deepEqual(names, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  test('an invalid date throws', () => {
    assert.throws(() => formatDateTime('yesterday', 'UTC'), TypeError);
  });
});

describe('nextPageCursor', () => {
  const id = '6f1c2b8e-0b4c-4a3e-9a51-3f0f5c1d2e10';

  test('reads before from the next link', () => {
    assert.equal(nextPageCursor(`</api/products?limit=20&q=milk&before=${id}>; rel="next"`), id);
  });

  test('finds next among several links and relation types, ignoring case and quotes', () => {
    assert.equal(nextPageCursor(`</a?before=x>; rel="prev", </b?before=${id}>; rel="Next last"`), id);
    assert.equal(nextPageCursor(`</b?before=${id}>; title="a, b"; rel=next`), id);
  });

  test('no header, no next link or no cursor means no next page', () => {
    assert.equal(nextPageCursor(null), null);
    assert.equal(nextPageCursor(''), null);
    assert.equal(nextPageCursor('</a?before=x>; rel="prev"'), null);
    assert.equal(nextPageCursor('</a?limit=20>; rel="next"'), null);
    assert.equal(nextPageCursor('garbage'), null);
  });
});
