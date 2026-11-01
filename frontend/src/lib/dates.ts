const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Building a formatter is costly (about 30 µs); lists format a date per row, so each time zone gets one. */
const formatters = new Map<string | undefined, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * "31 Oct 2026, 14:05" in the given time zone (the browser's by default). The
 * day comes first and the month is a word, so the date reads the same way to
 * everyone. Only numeric parts come from Intl; the text is built here, so it
 * does not change with the ICU version ("Sep" vs "Sept", "," vs " at ").
 */
export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new TypeError('Expected an ISO 8601 date.');
  const parts = formatterFor(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const month = MONTHS[Number(part('month')) - 1] ?? '';
  return `${Number(part('day'))} ${month} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
