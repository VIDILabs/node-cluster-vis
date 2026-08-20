/**
 * Timestamps, in the one form the rest of the app agrees on.
 *
 * The server's timestamps are **naive wall clock** — `2024-01-01T00:00:00`, no
 * zone — because that is what the telemetry export carries and what the frame's
 * index holds. The browser parses that form as local time, and the charts label
 * their x-axis with `d3.timeFormat`, which is also local. So wall clock is the
 * currency end to end, and the only thing that must never happen is a `Z`
 * sneaking in: `Date.toISOString()` converts to UTC, and `pd.to_datetime` then
 * returns a tz-aware Timestamp that cannot be compared against the naive index
 * at all. It raises `TypeError: Invalid comparison between dtype=datetime64[ns]
 * and Timestamp`, which is a 500, not a wrong answer.
 */

const pad = (n) => String(n).padStart(2, '0');

const parts = (date) => ({
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
});

// `new Date(null)` is the epoch, not an invalid date, so a missing value would
// otherwise format as 1970 — a plausible-looking timestamp for "nothing here".
const asDate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(+date) ? null : date;
};

/** `YYYY-MM-DD HH:mm:ss` — for reading, in the browser's own zone. */
export function formatStamp(value) {
    const date = asDate(value);
    if (!date) return '';
    const { date: d, time: t } = parts(date);
    return `${d} ${t}`;
}

/**
 * `YYYY-MM-DDTHH:mm:ss` — for the wire. Deliberately *not* `toISOString()`:
 * this is the same wall clock the server sent, handed straight back.
 */
export function toNaiveISO(value) {
    const date = asDate(value);
    if (!date) return '';
    const { date: d, time: t } = parts(date);
    return `${d}T${t}`;
}

/**
 * The inverse of `formatStamp`, plus a shorthand: a bare `HH:mm` or `HH:mm:ss`
 * keeps the day `fallback` already had. Baseline windows sit inside a single
 * run, so both ends share a date and retyping it is pure friction.
 */
export function parseStamp(text, fallback) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    const base = fallback instanceof Date && !Number.isNaN(+fallback) ? fallback : null;
    const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (timeOnly && base) {
        const date = new Date(base);
        date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3] || 0), 0);
        return Number.isNaN(+date) ? null : date;
    }

    // A space between the date and the time is not a form engines are required
    // to accept; the `T` is.
    const date = new Date(trimmed.replace(' ', 'T'));
    return Number.isNaN(+date) ? null : date;
}
