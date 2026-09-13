import { describe, expect, it } from 'vitest';

import { engineLabel, formatDateTime } from './format.js';

// Every assertion pins the zone, so the suite reads the same on a laptop in
// New York and in a UTC CI container.
const utc = { timeZone: 'UTC' };

describe('formatDateTime', () => {
  it('renders day, short month, year and a 24-hour clock', () => {
    expect(formatDateTime('2026-09-13T14:05:00Z', utc)).toBe('13 Sep 2026, 14:05');
  });

  it('accepts a Date and a millisecond timestamp too', () => {
    const t = Date.UTC(2026, 0, 2, 9, 7);
    expect(formatDateTime(new Date(t), utc)).toBe('2 Jan 2026, 09:07');
    expect(formatDateTime(t, utc)).toBe('2 Jan 2026, 09:07');
  });

  it('shows midnight as 00, never 24', () => {
    expect(formatDateTime('2026-03-01T00:00:00Z', utc)).toBe('1 Mar 2026, 00:00');
  });

  it('honours the zone it is given', () => {
    expect(formatDateTime('2026-09-13T14:05:00Z', { timeZone: 'America/New_York' })).toBe(
      '13 Sep 2026, 10:05',
    );
  });

  it('renders nothing-to-show as an em dash', () => {
    expect(formatDateTime(null, utc)).toBe('—');
    expect(formatDateTime(undefined, utc)).toBe('—');
    expect(formatDateTime('', utc)).toBe('—');
    expect(formatDateTime('not a date', utc)).toBe('—');
  });
});

describe('engineLabel', () => {
  it('spells the two engines the way the project does', () => {
    expect(engineLabel('latex')).toBe('LaTeX');
    expect(engineLabel('typst')).toBe('Typst');
  });

  it('passes an unknown value through rather than inventing a name', () => {
    expect(engineLabel('markdown')).toBe('markdown');
  });
});
