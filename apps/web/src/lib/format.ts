// The one date-time formatter for the UI. Five panels used to carry their own
// (`toLocaleString` with five different option bags), so a checkpoint, a
// comment, a token and an audit row each spelled the same instant four ways.
//
// Output is fixed-shape: `13 Sep 2026, 14:05` — day, short month, year, then
// a 24-hour clock. The month is always the English three-letter form, taken
// from the en-US short month names (en-GB has started spelling "Sept").
// Missing or unparseable input renders as an em dash, which is what the
// "never used" column of a table wants anyway.

const dash = '—';

export interface FormatDateTimeOptions {
  // IANA zone. Defaults to the browser's; tests pass 'UTC' so the assertion
  // does not depend on the machine running it.
  timeZone?: string;
}

export function formatDateTime(
  value: string | number | Date | null | undefined,
  { timeZone }: FormatDateTimeOptions = {},
): string {
  if (value === null || value === undefined || value === '') return dash;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return dash;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // h23, not hour12:false — the latter yields "24:05" for the first hour of
    // the day in some engines.
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
}

// Display name for a document engine. The wire value is lowercase
// (`latex` / `typst`) and two lists used to render it through CSS
// `uppercase`, which produced "LATEX" — a spelling the project never
// uses. Anything unknown passes through unchanged.
export function engineLabel(engine: string): string {
  switch (engine) {
    case 'latex':
      return 'LaTeX';
    case 'typst':
      return 'Typst';
    default:
      return engine;
  }
}
