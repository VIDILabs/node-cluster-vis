/**
 * The wire format for timestamps.
 *
 * `Date.toISOString()` is the obvious thing to reach for and is wrong here: it
 * converts to UTC and appends `Z`, `pd.to_datetime` then returns a tz-aware
 * Timestamp, and comparing that against the frame's naive `datetime64[ns]`
 * index raises. Every manual baseline change went out that way and came back a
 * 500.
 */
import { formatStamp, parseStamp, toNaiveISO } from './time.js';

const AT = new Date(2024, 5, 9, 21, 5, 30);   // local, deliberately late in the day

describe('toNaiveISO', () => {
  test('carries no zone marker', () => {
    expect(toNaiveISO(AT)).toBe('2024-06-09T21:05:30');
    expect(toNaiveISO(AT)).not.toContain('Z');
    expect(toNaiveISO(AT)).not.toMatch(/[+-]\d{2}:\d{2}$/);
  });

  test('is the wall clock the user is shown, not a UTC instant', () => {
    // The boxes read `2024-06-09 21:05:30` and the axis beside them is local
    // too, so 21:05 is what has to go out — in any zone, including one where
    // toISOString() would name a different day.
    expect(toNaiveISO(AT)).toBe(formatStamp(AT).replace(' ', 'T'));
    expect(+parseStamp(toNaiveISO(AT))).toBe(+AT);
  });

  test('a value the server sent comes back byte-for-byte', () => {
    // What /api/mrdmd emits: naive, no zone. Round-tripping it must not shift
    // it, or a drag that moved nothing would still move the window.
    const fromServer = '2024-01-01T00:00:00';
    expect(toNaiveISO(new Date(fromServer))).toBe(fromServer);
  });

  test('junk yields an empty string rather than "Invalid Date"', () => {
    expect(toNaiveISO('nonsense')).toBe('');
    expect(toNaiveISO(null)).toBe('');
  });
});
