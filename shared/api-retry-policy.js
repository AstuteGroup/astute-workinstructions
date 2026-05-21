/**
 * Centralized API Retry Policy
 *
 * Pure classifier — no I/O. Inspects an error thrown by a franchise distributor
 * cog (mouser.js, digikey.js, etc.) and decides whether the call should be
 * retried via the Bucket A queue, and if so with what backoff.
 *
 * The wrapper in shared/franchise-api.js calls classify(err) inside its catch
 * block and enqueues based on the result. Cogs no longer need their own
 * enqueue logic — they just throw descriptive Errors and the policy decides.
 *
 * Why this exists: pre-2026-05-06, only digikey.js + mouser.js had per-cog
 * enqueue logic. The other 8 cogs (arrow, future, master, newark, oemsecrets,
 * rutronik, sager, tti, waldom) silently dropped every transient failure.
 * Centralizing here means every cog gets retry coverage and the rules live
 * in one place.
 *
 * USAGE:
 *
 *   const { classify } = require('./api-retry-policy');
 *   try {
 *     const result = await cog.searchPart(mpn, qty);
 *     ...
 *   } catch (err) {
 *     const verdict = classify(err);
 *     if (verdict.retry) enqueueRetry({ blocked_until_hours: verdict.blockedHours, ... });
 *     throw err;
 *   }
 *
 * CATEGORIES:
 *   AUTH        — 401 / Unauthorized / "check API key"
 *                 retry=true with longer backoff. Mouser flap-style 401s clear
 *                 within hours; if it's a real key rotation, max_attempts (5)
 *                 will exhaust to the operator email within ~20h.
 *   RATE_LIMIT  — 429 / 403 / "Forbidden" / "quota" / "call limit exceeded"
 *                 retry=true with 1h backoff (matches typical quota windows).
 *   TRANSIENT   — 5xx / timeout / ECONNRESET / EAI_AGAIN
 *                 retry=true with 30min backoff.
 *   PERMANENT   — JSON parse errors / "API key not configured"
 *                 retry=false. Upstream API shape changed or env is broken;
 *                 retrying won't help.
 *   UNKNOWN     — error doesn't match any pattern.
 *                 retry=true with 1h backoff (conservative — better to try
 *                 once than silently drop a possibly-recoverable error).
 *
 * Patterns are tested in order; first match wins. Add new patterns to the
 * appropriate category as cogs surface new error shapes.
 */

/**
 * Hours until next midnight America/Chicago (Mouser's quota reset boundary).
 *
 * Confirmed 2026-05-13 from ~/workspace/.mouser-failures.ndjson: MaxCallPerDay
 * failures flat-line ~1,500/hour, with a sharp dip at 05:00 UTC = midnight CDT.
 * The dip is the brief window where real calls succeed before the fresh daily
 * quota is exhausted again. So that's the reset boundary, not midnight UTC.
 *
 * Using America/Chicago handles DST automatically (CDT=UTC-5, CST=UTC-6).
 * Adds a 15-minute safety margin past midnight to avoid retrying inside any
 * quota-handover edge case.
 *
 * @param {number} jitterHours - If > 0, add a random 0..jitterHours hours past
 *   the reset boundary. This spreads classify-time retries across the morning
 *   instead of stacking on the reset minute (the thundering-herd problem
 *   confirmed 2026-05-21: every queue item waiting on MaxCallPerDay woke
 *   simultaneously at 05:00 UTC and re-exhausted the new daily quota within
 *   2-4 hours). Default 0 = no jitter, preserves prior behavior for callers
 *   that don't opt in (the worker's batch-push applies its own per-item jitter).
 */
function hoursUntilNextChicagoMidnight(jitterHours = 0) {
  const now = new Date();
  const tzString = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: true });
  const m = tzString.match(/(\d+):(\d+):(\d+)\s+(AM|PM)/);
  if (!m) return 6; // fallback if locale format ever changes
  let h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ampm = m[4];
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const hoursLeft = (24 - h) - (min / 60) - (s / 3600);
  const base = Math.max(0.5, hoursLeft + 0.25); // 15min safety past midnight, 30min floor
  if (jitterHours > 0) return base + Math.random() * jitterHours;
  return base;
}

const RULES = [
  // PERMANENT — env / config issues that retrying won't fix
  { pattern: /API[\s_-]?key\s+(not\s+configured|missing|empty|unset|required)/i, category: 'PERMANENT', retry: false, blockedHours: 0, reason: 'API key not configured' },
  { pattern: /not\s+configured\s+in.*\.env/i,                                    category: 'PERMANENT', retry: false, blockedHours: 0, reason: 'Env var missing' },
  { pattern: /Parse error|JSON parse/i,                                          category: 'PERMANENT', retry: false, blockedHours: 0, reason: 'Response parse failure (upstream API shape may have changed)' },

  // RATE_LIMIT — quota / throttling / "too many" — retry with quota-window backoff
  // Per-minute limits get a short backoff so we don't waste an hour waiting for a 60s reset.
  // Mouser specifically: confirmed 2026-05-06 they use 403 with ResourceKey=MaxCallPerMinute for per-minute limits.
  // Our own client-side throttle in shared/api-throttle.js can also throw "max wait exceeded" — same backoff.
  { pattern: /throttle: max wait/i,                                              category: 'RATE_LIMIT', retry: true, blockedHours: 2/60, reason: 'Client-side throttle exhausted (await window)' },
  { pattern: /MaxCallPerMinute|per-minute rate limit/i,                          category: 'RATE_LIMIT', retry: true, blockedHours: 2/60, reason: 'Per-minute rate limit (~60s reset)' },
  // MaxCallPerDay: backoff lands at next midnight America/Chicago (Mouser's
  // confirmed reset boundary) PLUS up to 8 hours of random jitter — without
  // jitter, every item that hits MaxCallPerDay today wakes simultaneously at
  // 05:00 UTC tomorrow and re-exhausts the new daily quota within hours
  // (thundering herd, 2026-05-21). Dynamic via blockedHoursFn — classify()
  // invokes it at call time so each item gets its own random slot.
  { pattern: /MaxCallPerDay|daily quota/i,                                       category: 'RATE_LIMIT', retry: true, blockedHoursFn: () => hoursUntilNextChicagoMidnight(8), reason: 'Daily quota exhausted (resets midnight America/Chicago, 0-8h jittered)' },
  { pattern: /\b429\b|Rate limit|too many requests/i,                            category: 'RATE_LIMIT', retry: true, blockedHours: 1, reason: 'Rate limit (429)' },
  { pattern: /\bquota\b|call limit exceeded/i,                                   category: 'RATE_LIMIT', retry: true, blockedHours: 1, reason: 'Quota exhausted' },
  { pattern: /\b403\b|HTTP 403|Forbidden/i,                                      category: 'RATE_LIMIT', retry: true, blockedHours: 1, reason: '403 Forbidden (generic — could be quota or perms)' },

  // AUTH — bad credentials / auth signals — retry with longer backoff in case it's a flap
  { pattern: /\b401\b|Unauthoriz/i,                                              category: 'AUTH',       retry: true, blockedHours: 4, reason: '401 / Unauthorized' },
  { pattern: /check\s*API\s*key|invalid\s*API\s*key|invalid_client|invalid_grant|access_denied/i, category: 'AUTH', retry: true, blockedHours: 4, reason: 'Auth-style error' },
  { pattern: /Token expired/i,                                                   category: 'AUTH',       retry: true, blockedHours: 0.1, reason: 'OAuth token expired (refresh on next call)' },

  // TRANSIENT — server-side or network blips — retry quickly
  { pattern: /API error 5\d\d|HTTP 5\d\d|server error \(5\d\d\)|server error/i,  category: 'TRANSIENT',  retry: true, blockedHours: 0.5, reason: '5xx server error' },
  { pattern: /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i, category: 'TRANSIENT',  retry: true, blockedHours: 0.25, reason: 'Network/timeout' },
];

const FALLBACK = {
  category: 'UNKNOWN',
  retry: true,
  blockedHours: 1,
  reason: 'Unrecognized error — conservative retry',
};

/**
 * Classify an error by message pattern.
 *
 * @param {Error|string|*} error
 * @returns {{ category: string, retry: boolean, blockedHours: number, reason: string, matchedPattern: string|null }}
 */
function classify(error) {
  const msg = !error ? '' : (typeof error === 'string' ? error : (error.message || String(error)));
  if (!msg) return { ...FALLBACK, matchedPattern: null };

  for (const rule of RULES) {
    if (rule.pattern.test(msg)) {
      return {
        category: rule.category,
        retry: rule.retry,
        // blockedHoursFn (if present) is called at classify-time so dynamic
        // backoffs (e.g., "until next Chicago midnight") reflect current clock.
        blockedHours: typeof rule.blockedHoursFn === 'function' ? rule.blockedHoursFn() : rule.blockedHours,
        reason: rule.reason,
        matchedPattern: rule.pattern.toString(),
      };
    }
  }
  return { ...FALLBACK, matchedPattern: null };
}

module.exports = { classify, hoursUntilNextChicagoMidnight, _RULES: RULES, _FALLBACK: FALLBACK };
