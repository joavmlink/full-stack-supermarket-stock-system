import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRICE_ERRORS, formatAmount, formatMoney, groupThousands, parsePriceInput } from '../../src/lib/money';

const NBSP = ' ';

/** Digit strings of a given length with varied patterns (no leading zero unless the length is 1). */
function digitSamples(length: number): string[] {
  if (length === 0) return [''];
  const samples = new Set([
    '9'.repeat(length),
    `1${'0'.repeat(length - 1)}`,
    '123456789'.slice(0, length).padEnd(length, '7'),
    `5${'0123456789'.repeat(2).slice(0, length - 1)}`,
  ]);
  if (length === 1) samples.add('0');
  return [...samples];
}

/** The thousands grouping written out by hand: dots every 3 digits from the right. */
function referenceGrouping(digits: string): string {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return groups.join('.');
}

/** Every canonical amount shape: 1 to 8 integer digits, exactly 2 decimals. */
function canonicalSamples(): string[] {
  const values: string[] = [];
  for (let length = 1; length <= 8; length++) {
    for (const integer of digitSamples(length)) {
      for (const decimals of ['00', '05', '50', '99']) values.push(`${integer}.${decimals}`);
    }
  }
  return values;
}

describe('groupThousands', () => {
  test('matches the hand-written grouping for every length from 1 to 20 digits', () => {
    for (let length = 1; length <= 20; length++) {
      for (const digits of digitSamples(length)) assert.equal(groupThousands(digits), referenceGrouping(digits), digits);
    }
  });
});

describe('formatMoney / formatAmount', () => {
  test('known values', () => {
    assert.equal(formatMoney('1234.56'), `$${NBSP}1.234,56`);
    assert.equal(formatMoney('0.50'), `$${NBSP}0,50`);
    assert.equal(formatMoney('0.00'), `$${NBSP}0,00`);
    assert.equal(formatMoney('12.5'), `$${NBSP}12,50`);
    assert.equal(formatMoney('7'), `$${NBSP}7,00`);
    assert.equal(formatMoney('99999999.99'), `$${NBSP}99.999.999,99`);
    assert.equal(formatAmount('1000000.10'), '1.000.000,10');
  });

  test('inventory totals beyond 8 integer digits keep every digit', () => {
    assert.equal(formatMoney('99999999990000000.01'), `$${NBSP}99.999.999.990.000.000,01`);
  });

  test('leading zeros are dropped, but one zero stays', () => {
    assert.equal(formatAmount('0012.30'), '12,30');
    assert.equal(formatAmount('000.30'), '0,30');
  });

  test('every canonical shape: digits and decimals survive, grouped by 3', () => {
    for (const value of canonicalSamples()) {
      const [integer = '', decimals = ''] = value.split('.');
      assert.equal(formatMoney(value), `$${NBSP}${referenceGrouping(integer)},${decimals}`, value);
    }
  });

  test('anything that is not an API amount throws', () => {
    for (const value of ['', '1,50', '-1.00', '1.234', '1e3', ' 1.00', 'NaN', '.50', '1.']) {
      assert.throws(() => formatMoney(value), TypeError, JSON.stringify(value));
    }
  });
});

describe('parsePriceInput', () => {
  const ok = (text: string) => {
    const result = parsePriceInput(text);
    assert.ok(result.ok, `${JSON.stringify(text)} should parse: ${result.ok ? '' : result.error}`);
    return result.value;
  };
  const error = (text: string) => {
    const result = parsePriceInput(text);
    assert.ok(!result.ok, `${JSON.stringify(text)} should be rejected, got ${result.ok ? result.value : ''}`);
    return result.error;
  };

  test('Argentine input becomes the canonical string', () => {
    assert.equal(ok('1234,56'), '1234.56');
    assert.equal(ok('1.234,56'), '1234.56');
    assert.equal(ok('1234'), '1234.00');
    assert.equal(ok('1.234'), '1234.00');
    assert.equal(ok('12,5'), '12.50');
    assert.equal(ok(',5'), '0.50');
    assert.equal(ok('0'), '0.00');
    assert.equal(ok('  99.999.999,99 '), '99999999.99');
    assert.equal(ok('007,10'), '7.10');
  });

  test('a dot used for decimals asks for a comma', () => {
    for (const text of ['12.50', '12.5', '1234.5', '0.99']) assert.equal(error(text), PRICE_ERRORS.decimalPoint, text);
  });

  test('empty input asks for a price', () => {
    assert.equal(error(''), PRICE_ERRORS.required);
    assert.equal(error('   '), PRICE_ERRORS.required);
  });

  test('more than 8 integer digits is too high; leading zeros do not count', () => {
    assert.equal(error('100.000.000'), PRICE_ERRORS.tooHigh);
    assert.equal(error('123456789,00'), PRICE_ERRORS.tooHigh);
    assert.equal(ok('000000001,00'), '1.00');
  });

  test('malformed input is invalid', () => {
    for (const text of [',', '12,', '1,234', '1,2,3', '-5', '+5', '$ 5', '1 234', '1.23.456', '12.345,678', 'abc', '1e3', '.5', '1.234.5']) {
      assert.equal(error(text), PRICE_ERRORS.invalid, text);
    }
  });

  test('exhaustive: every placement of dots in 1 to 8 digits (with and without decimals)', () => {
    for (let length = 1; length <= 8; length++) {
      const digits = '12345678'.slice(0, length);
      const gaps = length - 1;
      for (let mask = 0; mask < 2 ** gaps; mask++) {
        let text = digits[0] ?? '';
        for (let gap = 0; gap < gaps; gap++) text += `${mask & (1 << gap) ? '.' : ''}${digits[gap + 1] ?? ''}`;
        const valid = mask === 0 || (length >= 4 && text === referenceGrouping(digits));
        for (const suffix of ['', ',5', ',05']) {
          const input = text + suffix;
          const result = parsePriceInput(input);
          if (valid) {
            assert.deepEqual(result, { ok: true, value: `${digits}.${suffix.slice(1).padEnd(2, '0')}` }, input);
          } else {
            const expected = suffix === '' && /^\d+\.\d{1,2}$/.test(input) ? PRICE_ERRORS.decimalPoint : PRICE_ERRORS.invalid;
            assert.deepEqual(result, { ok: false, error: expected }, input);
          }
        }
      }
    }
  });

  test('exhaustive: 0 to 8 integer digits with 0 to 2 decimals', () => {
    for (let length = 0; length <= 8; length++) {
      for (const integer of digitSamples(length)) {
        for (const decimals of ['', '5', '05', '50']) {
          if (integer === '' && decimals === '') continue;
          const input = decimals === '' ? integer : `${integer},${decimals}`;
          const canonicalInteger = integer.replace(/^0+(?=\d)/, '') || '0';
          assert.equal(ok(input), `${canonicalInteger}.${decimals.padEnd(2, '0')}`, input);
          assert.equal(ok(groupedInput(integer, decimals)), `${canonicalInteger}.${decimals.padEnd(2, '0')}`, input);
        }
      }
    }
  });

  test('round trip: parse(formatAmount(x)) === x for every canonical shape', () => {
    for (const value of canonicalSamples()) assert.equal(ok(formatAmount(value)), value, value);
  });
});

function groupedInput(integer: string, decimals: string): string {
  const grouped = integer === '' ? '' : referenceGrouping(integer);
  return decimals === '' ? grouped : `${grouped},${decimals}`;
}
