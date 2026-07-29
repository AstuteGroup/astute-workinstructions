/**
 * Local daily call counter — hard ceiling per distributor cog.
 *
 * Pre-flight check that short-circuits the franchise-api wrapper when the
 * day's call count is at the configured ceiling, so we never burn through the
 * supplier's daily quota in a thundering herd at quota refresh. Companion to
 * the jitter in shared/api-retry-policy.js — jitter spreads retries across
 * the morning, ceiling guarantees we don't outrun normal-traffic budget.
 *
 * The reset boundary tracks Mouser's confirmed pattern: midnight
 * America/Chicago (CDT during DST, CST otherwise) — see
 * shared/api-retry-policy.js docstring on hoursUntilNextChicagoMidnight().
 *
 * Counts increment when a call is ALLOWED. Pre-checks that hit the ceiling do
 * NOT increment (we never made the call). Failures from the actual supplier
 * (5xx, timeouts, MaxCallPerDay from THEIR side) DO count — they consumed a
 * quota slot from the supplier's perspective even though they returned errors.
 *
 * Concurrency: read-modify-write of the JSON file is mildly racy across the
 * cron worker + enrich-poller processes. For the precision we need (avoid
 * 1000s of overruns, not 5), an off-by-a-few count is acceptable. The
 * try/catch around readState returns fresh state on parse errors so a
 * temporarily-corrupt file self-heals on the next write.
 *
 * Per-cog ceilings come from env vars (default unset = no enforcement except
 * for the explicit mouser default below). To enable enforcement for a new
 * cog, set the matching env var, e.g.:
 *   MOUSER_DAILY_CEILING=900
 *   DIGIKEY_DAILY_CEILING=1900
 */

const fs = require('fs');
const path = require('path');

const COUNTER_FILE = path.join(process.env.HOME || '/home/analytics_user', 'workspace', '.api-daily-counter.json');

// Per-cog daily ceilings. Env var overrides the default.
//
// Updated 2026-07-20: ALL distributors now have default ceilings to prevent
// the thundering-herd doom loop (22K MPNs × 10 retries = 215K wasted calls).
// When ANY 429 is received, the distributor is marked "at ceiling" via
// markAtCeiling() so no more calls are attempted until the reset time.
//
// Defaults are conservative (below typical supplier limits) to leave headroom
// for legitimate fresh traffic after quota reset.
const CEILINGS = {
  mouser:     Number(process.env.MOUSER_DAILY_CEILING)     || 900,    // Confirmed ~1000/day limit
  digikey:    Number(process.env.DIGIKEY_DAILY_CEILING)    || 900,    // Confirmed ~1000/day limit
  arrow:      Number(process.env.ARROW_DAILY_CEILING)      || 20000,  // No known limit; high ceiling for markAtCeiling()
  tti:        Number(process.env.TTI_DAILY_CEILING)        || 20000,
  future:     Number(process.env.FUTURE_DAILY_CEILING)     || 20000,
  newark:     Number(process.env.NEWARK_DAILY_CEILING)     || 20000,
  master:     Number(process.env.MASTER_DAILY_CEILING)     || 20000,
  rutronik:   Number(process.env.RUTRONIK_DAILY_CEILING)   || 20000,
  waldom:     Number(process.env.WALDOM_DAILY_CEILING)     || 20000,
  sager:      Number(process.env.SAGER_DAILY_CEILING)      || 20000,
  oemsecrets: Number(process.env.OEMSECRETS_DAILY_CEILING) || 20000,
};

// Per-distributor reset timezone. Quota resets at midnight in this timezone.
// Env var overrides: MOUSER_RESET_TZ=America/Chicago, DIGIKEY_RESET_TZ=UTC, etc.
//
// Confirmed:
//   - Mouser: midnight America/Chicago (observed 2026-05 via failure pattern analysis)
//   - DigiKey: likely midnight America/Chicago (Minnesota HQ), but not confirmed
//
// Others default to America/Chicago since we have no data and it's a reasonable
// guess for US-based distributors. European distys (Rutronik) might be different.
const RESET_TIMEZONES = {
  mouser:     process.env.MOUSER_RESET_TZ     || 'America/Chicago',  // Confirmed
  digikey:   process.env.DIGIKEY_RESET_TZ    || 'America/Chicago',  // Likely (MN HQ)
  arrow:      process.env.ARROW_RESET_TZ      || 'America/Chicago',
  tti:        process.env.TTI_RESET_TZ        || 'America/Chicago',
  future:     process.env.FUTURE_RESET_TZ     || 'America/Chicago',
  newark:     process.env.NEWARK_RESET_TZ     || 'America/Chicago',
  master:     process.env.MASTER_RESET_TZ     || 'America/Chicago',
  rutronik:   process.env.RUTRONIK_RESET_TZ   || 'Europe/Berlin',    // German company
  waldom:     process.env.WALDOM_RESET_TZ     || 'America/Chicago',
  sager:      process.env.SAGER_RESET_TZ      || 'America/Chicago',
  oemsecrets: process.env.OEMSECRETS_RESET_TZ || 'UTC',              // Aggregator, unclear
};

/**
 * Compute the most-recent midnight in the given timezone as a UTC ISO string.
 *
 * Used to detect when a distributor's daily counter should reset.
 *
 * @param {string} timezone - IANA timezone (e.g., 'America/Chicago', 'UTC', 'Europe/Berlin')
 * @returns {string} ISO string of most recent midnight in that timezone
 */
function todaysMidnightIso(timezone = 'America/Chicago') {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = t => Number(parts.find(p => p.type === t).value);
  const h = get('hour'), min = get('minute'), s = get('second');
  // 'en-CA' returns hour as 24 at midnight instead of 0 in some Node builds — normalize.
  const hNorm = h === 24 ? 0 : h;
  const elapsedSec = hNorm * 3600 + min * 60 + s;
  // Floor to whole-second precision so two calls within the same second
  // produce IDENTICAL strings — otherwise the stored lastReset is always
  // microseconds older than today's recomputed value and counters reset
  // on every increment.
  const midnightMs = now.getTime() - elapsedSec * 1000;
  return new Date(Math.floor(midnightMs / 1000) * 1000).toISOString();
}

// Legacy alias for backwards compatibility
function todaysChicagoMidnightIso() {
  return todaysMidnightIso('America/Chicago');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf-8'));
  } catch {
    return { counts: {} };
  }
}

function writeState(state) {
  try {
    // Atomic rename-after-write so concurrent readers never see a partial file.
    const tmp = COUNTER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, COUNTER_FILE);
  } catch { /* swallow — counter errors must never block real calls */ }
}

/**
 * Check if a specific distributor's counter should reset based on its timezone.
 * Each distributor tracks its own lastReset in the state.
 *
 * State structure (v2 - per-distributor reset times):
 * {
 *   "counts": {
 *     "mouser": { "count": 50, "lastReset": "2026-07-20T05:00:00.000Z" },
 *     "digikey": { "count": 100, "lastReset": "2026-07-20T05:00:00.000Z" }
 *   }
 * }
 *
 * Migration: old state with top-level lastReset is auto-migrated on first write.
 */
function maybeResetCog(state, cog) {
  const timezone = RESET_TIMEZONES[cog] || 'America/Chicago';
  const todayIso = todaysMidnightIso(timezone);

  if (!state.counts) state.counts = {};

  // Initialize or migrate cog entry
  if (!state.counts[cog] || typeof state.counts[cog] === 'number') {
    // Migration from old format (counts[cog] was just a number)
    const oldCount = typeof state.counts[cog] === 'number' ? state.counts[cog] : 0;
    state.counts[cog] = { count: oldCount, lastReset: state.lastReset || todayIso };
  }

  const cogState = state.counts[cog];

  // Reset if we've passed midnight in this cog's timezone
  if (!cogState.lastReset || new Date(cogState.lastReset) < new Date(todayIso)) {
    cogState.count = 0;
    cogState.lastReset = todayIso;
  }

  return cogState;
}

// Legacy function for backwards compatibility with old callers
function maybeReset(state) {
  // Just ensure state structure exists - per-cog reset happens in maybeResetCog
  if (!state.counts) state.counts = {};
  return state;
}

/**
 * Atomic check + increment. Returns `{ allowed, count, ceiling, resetTimezone }`.
 *
 * - allowed=true  → caller may proceed; count was incremented.
 * - allowed=false → caller is at/over ceiling; count was NOT incremented.
 *                   Caller should throw a synthetic MaxCallPerDay so the
 *                   retry policy applies its normal backoff + jitter.
 *
 * If ceiling for this cog is 0/unset, allowed is always true and no count
 * is recorded (preserves behavior for cogs without explicit limits).
 *
 * Each distributor resets at midnight in its configured timezone (RESET_TIMEZONES).
 */
function checkAndIncrement(cog) {
  const ceiling = CEILINGS[cog] || 0;
  const timezone = RESET_TIMEZONES[cog] || 'America/Chicago';

  if (ceiling <= 0) return { allowed: true, count: 0, ceiling: null, resetTimezone: timezone };

  const state = readState();
  const cogState = maybeResetCog(state, cog);

  if (cogState.count >= ceiling) {
    return { allowed: false, count: cogState.count, ceiling, resetTimezone: timezone };
  }

  cogState.count += 1;
  writeState(state);
  return { allowed: true, count: cogState.count, ceiling, resetTimezone: timezone };
}

/**
 * Mark a distributor as "at ceiling" immediately.
 *
 * Called when a 429 is received — instead of retrying every hour and wasting
 * capacity, we immediately block all further calls until midnight in the
 * distributor's configured timezone.
 *
 * This is the key fix for the 215K DigiKey failure doom loop (July 2026).
 *
 * The retry queue will still schedule retries, but checkAndIncrement() will
 * return allowed=false until the counter resets at midnight.
 */
function markAtCeiling(cog) {
  const ceiling = CEILINGS[cog];
  if (!ceiling) return; // No ceiling configured for this cog

  const timezone = RESET_TIMEZONES[cog] || 'America/Chicago';
  const state = readState();
  const cogState = maybeResetCog(state, cog);

  // Only mark if not already at/over ceiling
  if (cogState.count < ceiling) {
    cogState.count = ceiling;
    writeState(state);
    // eslint-disable-next-line no-console
    console.log(`[api-daily-counter] ${cog} marked at ceiling (${ceiling}) after 429 — no calls until midnight ${timezone}`);
  }
}

/**
 * Check if a distributor is at ceiling (read-only, doesn't increment).
 */
function isAtCeiling(cog) {
  const ceiling = CEILINGS[cog];
  if (!ceiling) return false;

  const state = readState();
  const cogState = maybeResetCog(state, cog);
  return cogState.count >= ceiling;
}

/**
 * Read-only inspection. Useful for digests / drift checks / debugging.
 */
function getCount(cog) {
  const timezone = RESET_TIMEZONES[cog] || 'America/Chicago';
  const state = readState();
  const cogState = maybeResetCog(state, cog);
  return {
    count: cogState.count,
    ceiling: CEILINGS[cog] || null,
    lastReset: cogState.lastReset,
    resetTimezone: timezone,
  };
}

function getAllCounts() {
  const state = readState();
  const out = {};
  for (const cog of Object.keys(CEILINGS)) {
    if (!CEILINGS[cog]) continue;
    const cogState = maybeResetCog(state, cog);
    const timezone = RESET_TIMEZONES[cog] || 'America/Chicago';
    out[cog] = {
      count: cogState.count,
      ceiling: CEILINGS[cog],
      atCeiling: cogState.count >= CEILINGS[cog],
      lastReset: cogState.lastReset,
      resetTimezone: timezone,
    };
  }
  return { cogs: out };
}

module.exports = {
  checkAndIncrement,
  markAtCeiling,
  isAtCeiling,
  getCount,
  getAllCounts,
  todaysMidnightIso,
  _CEILINGS: CEILINGS,
  _RESET_TIMEZONES: RESET_TIMEZONES,
  _COUNTER_FILE: COUNTER_FILE,
};
