import { groupThousands, withoutLeadingZeros } from './money';

/** 1250 → "1.250", -5 → "-5" (the same separators as prices). */
export function formatInteger(value: number): string {
  if (!Number.isSafeInteger(value)) throw new TypeError('Expected a safe integer.');
  const digits = groupThousands(String(Math.abs(value)));
  return value < 0 ? `-${digits}` : digits;
}

/** The noun that goes with a count: "unit" for 1 or -1, "units" otherwise. */
export const countNoun = (value: number, noun: string) => (Math.abs(value) === 1 ? noun : `${noun}s`);

/** 1 → "1 product", 1250 → "1.250 products". */
export const formatCount = (value: number, noun: string) => `${formatInteger(value)} ${countNoun(value, noun)}`;

/** 1 → "1 unit", 1250 → "1.250 units". */
export const formatUnits = (value: number) => formatCount(value, 'unit');

/** A stock change with its sign: "+5", "-1.250", "0". */
export function formatDelta(value: number): string {
  return value > 0 ? `+${formatInteger(value)}` : formatInteger(value);
}

export type QuantityInputResult = { ok: true; value: number } | { ok: false; error: string };

/** Whole numbers, optionally with dot-grouped thousands ("1250" or "1.250"). */
const QUANTITY_INPUT = /^(?:\d{1,3}(?:\.\d{3})+|\d+)$/;

export function parseQuantityInput(text: string, { min, max }: { min: number; max: number }): QuantityInputResult {
  const input = text.trim();
  if (input === '') return { ok: false, error: 'Enter a quantity.' };
  if (!QUANTITY_INPUT.test(input)) return { ok: false, error: 'Enter a whole number.' };
  const digits = withoutLeadingZeros(input.replaceAll('.', ''));
  // Compared as digits first, so a huge input never becomes an imprecise number.
  if (digits.length > String(max).length || Number(digits) > max) {
    return { ok: false, error: `Enter at most ${formatInteger(max)}.` };
  }
  const value = Number(digits);
  if (value < min) return { ok: false, error: `Enter at least ${formatInteger(min)}.` };
  return { ok: true, value };
}
