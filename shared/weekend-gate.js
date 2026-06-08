/**
 * Weekend Gate — skip digests on Saturday/Sunday EST
 *
 * Usage:
 *   const { isWeekendEST, exitIfWeekend } = require('../shared/weekend-gate');
 *
 *   // Check only
 *   if (isWeekendEST()) { console.log('Skipping — weekend'); process.exit(0); }
 *
 *   // One-liner at top of digest script (no state tracking)
 *   exitIfWeekend();  // exits 0 if Sat/Sun EST, continues otherwise
 *
 *   // With state advancement ("time stop" — so Monday doesn't include weekend)
 *   exitIfWeekend({
 *     stateFile: '/path/to/last-digest.json',
 *     stateKey: 'lastSent',  // optional, defaults to 'lastSent'
 *   });
 *
 * Weekend = Saturday 00:00 EST through Sunday 23:59 EST
 * (i.e., day-of-week 0 or 6 in America/New_York)
 *
 * State advancement: When stateFile is provided and we're skipping due to
 * weekend, we update the state file's timestamp to "now" so Monday's digest
 * doesn't pull in all the weekend activity. The state file format is assumed
 * to be JSON with an ISO timestamp at the specified key.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
 * Advance a state file's timestamp to "now" so the next run's window
 * starts fresh. Used to implement "time stop" over weekends.
 */
function advanceStateFile(stateFile, stateKey = 'lastSent') {
  if (!stateFile) return;
  try {
    let state = {};
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    state[stateKey] = new Date().toISOString();
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error(`[weekend-gate] Failed to advance state file: ${e.message}`);
    return false;
  }
}

/**
 * Exit cleanly (code 0) if it's the weekend in EST. Otherwise return.
 *
 * Options:
 *   silent: true      — suppress console message
 *   stateFile: path   — advance this state file's timestamp before exiting
 *   stateKey: string  — key in state file to update (default: 'lastSent')
 */
function exitIfWeekend(opts = {}) {
  if (isWeekendEST()) {
    const now = new Date();

    // Advance state file if provided (time-stop behavior)
    if (opts.stateFile) {
      const advanced = advanceStateFile(opts.stateFile, opts.stateKey || 'lastSent');
      if (advanced && !opts.silent) {
        console.log(`[weekend-gate] Advanced state file: ${opts.stateFile}`);
      }
    }

    if (!opts.silent) {
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

module.exports = { isWeekendEST, exitIfWeekend, advanceStateFile };
