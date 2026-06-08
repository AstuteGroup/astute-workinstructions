/**
 * Weekend Gate — skip digests on Saturday/Sunday EST
 *
 * Usage:
 *   const { isWeekendEST, exitIfWeekend } = require('../shared/weekend-gate');
 *
 *   // Check only
 *   if (isWeekendEST()) { console.log('Skipping — weekend'); process.exit(0); }
 *
 *   // Or one-liner at top of digest script
 *   exitIfWeekend();  // exits 0 if Sat/Sun EST, continues otherwise
 *
 * Weekend = Saturday 00:00 EST through Sunday 23:59 EST
 * (i.e., day-of-week 0 or 6 in America/New_York)
 */

'use strict';

const TIMEZONE = 'America/New_York';

/**
 * Returns true if current time is Saturday or Sunday in EST/EDT.
 */
function isWeekendEST(now = new Date()) {
  // Get day of week in EST/EDT (0 = Sunday, 6 = Saturday)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  });
  const dayStr = formatter.format(now);
  return dayStr === 'Sat' || dayStr === 'Sun';
}

/**
 * Exit cleanly (code 0) if it's the weekend in EST. Otherwise return.
 * Pass { silent: true } to skip the console message.
 */
function exitIfWeekend(opts = {}) {
  if (isWeekendEST()) {
    if (!opts.silent) {
      const now = new Date();
      const estTime = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now);
      console.log(`[weekend-gate] Skipping — ${estTime} EST is weekend.`);
    }
    process.exit(0);
  }
}

module.exports = { isWeekendEST, exitIfWeekend };
