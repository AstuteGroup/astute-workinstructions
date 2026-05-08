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
  { pattern: /MaxCallPerDay|daily quota/i,                                       category: 'RATE_LIMIT', retry: true, blockedHours: 6, reason: 'Daily quota exhausted (resets ~midnight UTC)' },
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
        blockedHours: rule.blockedHours,
        reason: rule.reason,
        matchedPattern: rule.pattern.toString(),
      };
    }
  }
  return { ...FALLBACK, matchedPattern: null };
}

module.exports = { classify, _RULES: RULES, _FALLBACK: FALLBACK };
