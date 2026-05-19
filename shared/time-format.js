/**
 * Central Time display helpers — single source of truth for date formatting
 * across all workflows that emit dates to operator-facing outputs
 * (CSV / xlsx / HTML / email / console).
 *
 * Convention (decided 2026-05-19): all operator-facing dates display in
 * Central Time with the label "CT" (DST-agnostic — we don't ping-pong between
 * "CDT" and "CST" labels because the operator's mental model is just "Central").
 *
 * If you're writing a new workflow that emits a date, use these helpers.
 * Do NOT roll your own toLocaleString call. Do NOT display UTC. Do NOT use
 * "CDT" / "CST" suffix labels.
 *
 * Database gotcha (also documented in shared/data-model.md):
 *   `chuboe_*.created` is `timestamp without time zone` storing CDT-digit
 *   values. PG session is UTC. So `SELECT r.created` returns CDT digits as
 *   a naive timestamp string. parseDBCreated() handles that correctly.
 */

'use strict';

const TZ = 'America/Chicago';
const LABEL = 'CT';

// ─── Core formatters ────────────────────────────────────────────────────────

/**
 * Full timestamp with seconds — e.g. "2026-05-19 09:06:47 CT".
 * Use for audit trails, logs, anywhere you want to round-trip a precise moment.
 */
function fmtCT(d) {
  const dt = _toDate(d);
  if (!dt) return '';
  return _format(dt, true) + ' ' + LABEL;
}

/**
 * Compact timestamp without seconds — e.g. "2026-05-19 09:06 CT".
 * Use in tables, summaries, dashboards.
 */
function fmtCTShort(d) {
  const dt = _toDate(d);
  if (!dt) return '';
  return _format(dt, false) + ' ' + LABEL;
}

/**
 * Date-only — e.g. "2026-05-19".
 * Use when time-of-day adds no signal (daily report headers, file names, etc).
 * No "CT" suffix — there's nothing tz-ambiguous about a date.
 */
function fmtCTDate(d) {
  const dt = _toDate(d);
  if (!dt) return '';
  return _format(dt, false).slice(0, 10);
}

/**
 * Current moment formatted full — convenience wrapper around fmtCT(new Date()).
 */
function nowCT() {
  return fmtCT(new Date());
}

// ─── DB-side helpers ────────────────────────────────────────────────────────

/**
 * Parse a value returned from psql for a `chuboe_*.created`-style column —
 * a naive timestamp string whose digits represent CDT. Returns a real Date
 * object (true UTC moment).
 *
 * Example:  parseDBCreated('2026-05-19 02:19:11.576')  → Date for 07:19:11 UTC
 *
 * This compensates for the fact that the DB column doesn't carry a tz, so
 * `new Date('2026-05-19 02:19:11')` would otherwise be interpreted using the
 * Node process's local time (typically UTC on the server → wrong).
 */
function parseDBCreated(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  // Drop any trailing tz suffix in case the column was already cast (defensive).
  const naive = s.replace(/[+-]\d{2}(:?\d{2})?$/, '').replace(/\s+$/, '');
  // Interpret as Chicago-local; convert to UTC via Intl trick.
  // Build the UTC moment such that, when formatted in Chicago, it reads back as `naive`.
  const m = naive.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac] = m;
  // Try UTC offset for CDT (-5) first; check by formatting back. If the
  // formatted value matches `naive`, we picked correctly. If not, retry CST (-6).
  for (const offsetHours of [5, 6]) {
    const guess = Date.UTC(+y, +mo - 1, +d, +h + offsetHours, +mi, +se || 0, frac ? Math.round(Number('0.' + frac) * 1000) : 0);
    const dt = new Date(guess);
    const back = _format(dt, true);
    const wantPrefix = `${y}-${mo}-${d} ${h}:${mi}`;
    if (back.startsWith(wantPrefix)) return dt;
  }
  return null;
}

// ─── SQL snippets ───────────────────────────────────────────────────────────

/**
 * SQL fragment for SELECT-ing a `chuboe_*.created`-style column for display.
 * Use in psql queries when you want CSV/console output in CT digits.
 *
 *   `SELECT ${ctSqlSelect('r.created')} AS rfq_dt ...`
 *
 * Since the column already stores CDT-naive digits, no conversion is needed
 * — we just to_char it for clean formatting. The result is what the operator
 * expects: e.g. "2026-05-19 02:19:11".
 */
function ctSqlSelect(columnExpr) {
  return `to_char(${columnExpr}, 'YYYY-MM-DD HH24:MI:SS')`;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function _toDate(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  if (typeof d === 'number') return new Date(d);
  if (typeof d === 'string') {
    // ISO 8601 round-trip
    const iso = new Date(d);
    if (!isNaN(iso)) return iso;
    // Fallback: a DB-style naive string — assume CT-digits
    return parseDBCreated(d);
  }
  return null;
}

function _format(date, withSeconds) {
  // Intl.DateTimeFormat in en-CA gives YYYY-MM-DD; en-GB gives 24h time.
  // Compose manually to guarantee "YYYY-MM-DD HH:mm[:ss]" in TZ.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const ymd = `${lookup.year}-${lookup.month}-${lookup.day}`;
  // hour: en-CA can return "24" at midnight; normalize to "00"
  const hh = lookup.hour === '24' ? '00' : lookup.hour;
  const hms = withSeconds
    ? `${hh}:${lookup.minute}:${lookup.second}`
    : `${hh}:${lookup.minute}`;
  return `${ymd} ${hms}`;
}

module.exports = {
  fmtCT,
  fmtCTShort,
  fmtCTDate,
  nowCT,
  parseDBCreated,
  ctSqlSelect,
  // Constants exposed for downstream code that needs them
  TZ,
  LABEL,
};
