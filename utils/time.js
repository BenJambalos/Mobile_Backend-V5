// Time handling for the whole backend. ONE rule, applied everywhere:
//
//   * Instants are stored and transported as UTC (MySQL TIMESTAMP columns, ISO
//     strings ending in "Z"). Nothing in the database is shifted.
//   * Anything the SERVER formats into text for a person (a time like
//     "10:05 AM", a date, a "TODAY"/"YESTERDAY" group, an hour label on a
//     chart) is formatted in DISPLAY_TIMEZONE (default Asia/Manila), never in
//     the zone the server process happens to run in.
//
// Why this exists: Railway runs Node in UTC. `new Date(x).toLocaleTimeString()`
// therefore printed UTC clock times, 8 hours behind Philippine time, while the
// date still looked right for most of the day. See QA finding F.
const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'Asia/Manila';

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ISO-8601 UTC ("2026-10-28T02:05:00.000Z") or null. This is what the app
// should parse, then convert to the phone's local time.
function iso(value) {
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

function fmt(value, options) {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, ...options }).format(d);
}

// "October 28, 2026"
function formatDateLong(value) {
  return fmt(value, { month: 'long', day: 'numeric', year: 'numeric' });
}

// "10:05 AM"
function formatTime(value) {
  return fmt(value, { hour: 'numeric', minute: '2-digit', hour12: true });
}

// "10/28/2026, 10:05 AM"  (same shape the notifications list always used)
function formatDateTime(value) {
  return fmt(value, { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// "2026-10-28": the calendar day in the display zone (for grouping/comparing).
function dayKey(value) {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// TODAY / YESTERDAY / "OCTOBER 26, 2026", judged by calendar days in the display zone.
function dateGroupFor(value, now = new Date()) {
  const key = dayKey(value);
  if (!key) return '';
  if (key === dayKey(now)) return 'TODAY';
  if (key === dayKey(new Date(now.getTime() - 24 * 3600 * 1000))) return 'YESTERDAY';
  return formatDateLong(value).toUpperCase();
}

// "+08:00": the display zone's current UTC offset, for MySQL CONVERT_TZ(). Only
// whole-offset zones without daylight saving are fully reliable with a fixed
// offset (Asia/Manila qualifies); the value is computed once at start-up.
function computeUtcOffset(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return '+00:00';
  return `${m[1]}${m[2]}:${m[3] || '00'}`;
}
const DISPLAY_UTC_OFFSET = computeUtcOffset(DISPLAY_TIMEZONE);

// SQL fragment: a TIMESTAMP column (read in a UTC session, see db.js) expressed
// as display-zone wall-clock time.
function localSql(column) {
  return `CONVERT_TZ(${column}, '+00:00', '${DISPLAY_UTC_OFFSET}')`;
}

module.exports = {
  DISPLAY_TIMEZONE,
  DISPLAY_UTC_OFFSET,
  toDate,
  iso,
  formatDateLong,
  formatTime,
  formatDateTime,
  dayKey,
  dateGroupFor,
  computeUtcOffset,
  localSql,
};
