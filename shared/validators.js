/**
 * Shared format validators for fields that flow through multiple writers.
 *
 * Promote a regex/check here when 2+ modules need the same validation —
 * keeps backfill scripts and steady-state writers consistent so a value that
 * passes the backfill won't fail at write time (or vice versa).
 *
 * USAGE:
 *   const { ECCN_REGEX, isValidEccn } = require('./validators');
 *   if (!isValidEccn(value)) { logger.warn(...); skip; }
 */

// ─── ECCN ────────────────────────────────────────────────────────────────────
//
// Export Control Classification Number — US Bureau of Industry and Security.
// Common formats:
//   - "EAR99"             — non-controlled commercial items (most common)
//   - "5A002.a"           — single sub-class
//   - "3A001.a.1.a"       — nested sub-class
//   - "N/A"               — manufacturer-asserted not applicable
//
// This regex is intentionally loose — better to write a slightly malformed
// value than to drop a real one. The chuboe_eccn column is varchar(25), so
// values longer than that are also rejected (defense against runaway data).

// Pattern: EAR99 / N/A / base (1 digit + 1 letter A-E + 3 digits) optionally
// followed by any number of `.<alphanumeric>` sub-class segments.
// Examples matched: EAR99, 5A002, 5A002.a, 3A001.a.1.a, 5A002.b.2.b.4
const ECCN_REGEX = /^(EAR99|N\/A|[0-9][A-E][0-9]{3}(\.[a-z0-9]+)*)$/i;
const ECCN_MAX_LENGTH = 25;

/**
 * Returns true if the value looks like a valid ECCN.
 * Null / undefined / empty → false (caller should handle missing values, not validation).
 */
function isValidEccn(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (s === '') return false;
  if (s.length > ECCN_MAX_LENGTH) return false;
  return ECCN_REGEX.test(s);
}

module.exports = {
  ECCN_REGEX,
  ECCN_MAX_LENGTH,
  isValidEccn,
};
