// Prices are canonical decimal strings in the API ("1234.56", "0.50") and never
// pass through a JS number here, so no amount is ever rounded. The UI shows
// ARS as "$ 1.234,56". Intl.NumberFormat is not used: its output (the kind of
// space, the sign position) depends on the browser's ICU version.

const CURRENCY_SYMBOL = '$';
/** Non-breaking, so "$" never ends a line on its own. */
const SYMBOL_SEPARATOR = ' ';
const THOUSANDS_SEPARATOR = '.';
const DECIMAL_SEPARATOR = ',';

/** NUMERIC(10,2): up to 8 integer digits. */
const MAX_PRICE_INTEGER_DIGITS = 8;

export const PRICE_ERRORS = {
  required: 'Enter a price.',
  decimalPoint: 'Use a comma for decimals.',
  invalid: 'Enter a price like 1.234,56.',
  tooHigh: 'The price cannot exceed $ 99.999.999,99.',
} as const;

export type PriceInputResult = { ok: true; value: string } | { ok: false; error: string };

/** A decimal string as the API sends it; any number of integer digits (inventory totals exceed 8). */
const API_AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/** What an admin may type: digits with optional dot-grouped thousands, then a comma and up to 2 decimals. */
const PRICE_INPUT = /^(\d{1,3}(?:\.\d{3})+|\d*)(?:,(\d{0,2}))?$/;

/** "12.50" or "1234.5": a dot used as the decimal separator (reading it as thousands would be wrong). */
const DOT_DECIMALS = /^\d+\.\d{1,2}$/;

export const withoutLeadingZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '');

/** Inserts the thousands separator into a run of digits: "1234567" → "1.234.567". */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
}

/** "1234.5" → "1.234,50": the amount as an admin types it, without the symbol. Throws on anything but an API amount. */
export function formatAmount(value: string): string {
  const match = API_AMOUNT.exec(value);
  if (match === null) throw new TypeError('Expected a decimal amount such as "1234.56".');
  const [, integer = '', decimals = ''] = match;
  return `${groupThousands(withoutLeadingZeros(integer))}${DECIMAL_SEPARATOR}${decimals.padEnd(2, '0')}`;
}

/** "1234.5" → "$ 1.234,50" (with a non-breaking space). */
export function formatMoney(value: string): string {
  return `${CURRENCY_SYMBOL}${SYMBOL_SEPARATOR}${formatAmount(value)}`;
}

/**
 * Turns what an admin typed ("1.234,5", "1234", ",50") into the canonical
 * string the API expects ("1234.50"). A dot is only a thousands separator,
 * in groups of 3, so "12.50" is an error instead of silently meaning 1250.
 */
export function parsePriceInput(text: string): PriceInputResult {
  const input = text.trim();
  if (input === '') return { ok: false, error: PRICE_ERRORS.required };
  const match = PRICE_INPUT.exec(input);
  const [, grouped = '', decimals = ''] = match ?? [];
  const integer = grouped.replaceAll(THOUSANDS_SEPARATOR, '');
  // A lone comma, or a trailing comma with no decimals ("12,"), is not a price.
  const hasDigits = integer !== '' || decimals !== '';
  const danglingComma = input.endsWith(DECIMAL_SEPARATOR);
  if (match === null || !hasDigits || danglingComma) {
    return { ok: false, error: DOT_DECIMALS.test(input) ? PRICE_ERRORS.decimalPoint : PRICE_ERRORS.invalid };
  }
  const canonicalInteger = withoutLeadingZeros(integer === '' ? '0' : integer);
  if (canonicalInteger.length > MAX_PRICE_INTEGER_DIGITS) return { ok: false, error: PRICE_ERRORS.tooHigh };
  return { ok: true, value: `${canonicalInteger}.${decimals.padEnd(2, '0')}` };
}
