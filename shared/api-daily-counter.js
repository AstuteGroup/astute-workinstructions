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

// Per-cog daily ceilings. Default 0 = no enforcement; explicit env var unlocks.
// Mouser default 900 (free tier is 1,000 — leaves 10% headroom for legitimate
// fresh traffic post-reset and any clock drift between local + supplier).
const CEILINGS = {
  mouser:     Number(process.env.MOUSER_DAILY_CEILING)     || 900,
  digikey:    Number(process.env.DIGIKEY_DAILY_CEILING)    || 0,
  arrow:      Number(process.env.ARROW_DAILY_CEILING)      || 0,
  tti:        Number(process.env.TTI_DAILY_CEILING)        || 0,
  future:     Number(process.env.FUTURE_DAILY_CEILING)     || 0,
  newark:     Number(process.env.NEWARK_DAILY_CEILING)     || 0,
  master:     Number(process.env.MASTER_DAILY_CEILING)     || 0,
  rutronik:   Number(process.env.RUTRONIK_DAILY_CEILING)   || 0,
  waldom:     Number(process.env.WALDOM_DAILY_CEILING)     || 0,
  sager:      Number(process.env.SAGER_DAILY_CEILING)      || 0,
  oemsecrets: Number(process.env.OEMSECRETS_DAILY_CEILING) || 0,
};

/**
 * Compute the most-recent midnight America/Chicago as a UTC ISO string.
 *
 * Used to detect when the daily counter should reset. If state.lastReset is
 * older than this, the counter for every cog is zeroed out.
 *
 * Implementation: get current wall-clock in CT, compute elapsed seconds since
 * local midnight, subtract from "now" → UTC moment of today's CT midnight.
 */
function todaysChicagoMidnightIso() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
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

function readState() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf-8'));
  } catch {
    return { lastReset: null, counts: {} };
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

function maybeReset(state) {
  const todayIso = todaysChicagoMidnightIso();
  if (!state.lastReset || new Date(state.lastReset) < new Date(todayIso)) {
    state.lastReset = todayIso;
    state.counts = {};
  }
  return state;
}

/**
 * Atomic check + increment. Returns `{ allowed, count, ceiling }`.
 *
 * - allowed=true  → caller may proceed; count was incremented.
 * - allowed=false → caller is at/over ceiling; count was NOT incremented.
 *                   Caller should throw a synthetic MaxCallPerDay so the
 *                   retry policy applies its normal backoff + jitter.
 *
 * If ceiling for this cog is 0/unset, allowed is always true and no count
 * is recorded (preserves behavior for cogs without explicit limits).
 */
function checkAndIncrement(cog) {
  const ceiling = CEILINGS[cog] || 0;
  if (ceiling <= 0) return { allowed: true, count: 0, ceiling: null };

  const state = maybeReset(readState());
  const current = state.counts[cog] || 0;
  if (current >= ceiling) {
    return { allowed: false, count: current, ceiling };
  }
  state.counts[cog] = current + 1;
  writeState(state);
  return { allowed: true, count: current + 1, ceiling };
}

/**
 * Read-only inspection. Useful for digests / drift checks / debugging.
 */
function getCount(cog) {
  const state = maybeReset(readState());
  return {
    count: state.counts[cog] || 0,
    ceiling: CEILINGS[cog] || null,
    lastReset: state.lastReset,
  };
}

function getAllCounts() {
  const state = maybeReset(readState());
  const out = {};
  for (const cog of Object.keys(CEILINGS)) {
    if (!CEILINGS[cog]) continue;
    out[cog] = {
      count: state.counts[cog] || 0,
      ceiling: CEILINGS[cog],
      atCeiling: (state.counts[cog] || 0) >= CEILINGS[cog],
    };
  }
  return { lastReset: state.lastReset, cogs: out };
}

module.exports = {
  checkAndIncrement,
  getCount,
  getAllCounts,
  _CEILINGS: CEILINGS,
  _COUNTER_FILE: COUNTER_FILE,
};
