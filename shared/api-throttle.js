/**
 * Cross-Process Per-Distributor API Throttle (token bucket, file-backed)
 *
 * Wraps every franchise-api call with a per-disty rate limit so we don't
 * burn through suppliers' per-minute windows. Cross-process via a shared
 * state file so all of enrich-poller / rfq-loader-daemon / vortex-poller /
 * stockrfq-poller / lam-kitting cron / manual scripts cooperate on a single
 * budget per disty.
 *
 * Why this exists: confirmed 2026-05-06 that Mouser's "auth failure" flap
 * was actually `MaxCallPerMinute` — Mouser's per-minute rate limit returns
 * HTTP 403 with `ResourceKey=MaxCallPerMinute`. Three of our parallel
 * processes burst > 30 calls/min into Mouser → all rate-limited → cog reports
 * generic 401/403 → alerter spams. Real fix: never burst over the limit in
 * the first place. This module is that fix.
 *
 * Algorithm: classic token bucket per disty.
 *   - capacity     = per-minute limit (with margin)
 *   - refill rate  = capacity / 60 tokens per second (continuous refill)
 *   - acquire(d)   = await until a token is available, then decrement
 *
 * Cross-process coordination: read-decide-write inside an advisory file lock.
 * Sleep happens outside the lock so the lock is held for milliseconds.
 *
 * USAGE (from shared/franchise-api.js):
 *
 *   const throttle = require('./api-throttle');
 *   await throttle.acquire('mouser');     // blocks until under-limit
 *   const result = await mod.searchPart(mpn, qty);
 *
 * If the throttle gives up (max wait exceeded) it throws. The wrapper's
 * existing catch + retry policy treats that throw as RATE_LIMIT and enqueues
 * the call for retry — same as if Mouser had returned 403 itself. Net: we
 * never let the call go out at all; the retry queue picks it up later.
 *
 * NOT throttled — distributors with no entry in `LIMITS` below pass through.
 * Today only Mouser has a confirmed per-minute issue. Add others as we
 * discover them via `~/workspace/.api-failures.ndjson`.
 *
 * STATE FILE: shared/data/api-throttle-state.json
 *   {
 *     "mouser": {
 *       "tokens": 12.4,
 *       "lastRefillAt": 1778091420200
 *     }
 *   }
 *
 * Tokens are floats — partial-token state survives across processes.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.resolve(__dirname, 'data/api-throttle-state.json');
const LOCK_FILE = STATE_FILE + '.lock';

// Per-distributor limits. Only distys present here are throttled — others
// pass through unrestricted.
//
// `perMinute` should leave headroom under the supplier's actual limit:
// clock skew + overlapping windows mean we can't push right to the edge.
// Mouser's actual per-minute limit appears to be ~30 (per error message
// "Maximum calls per minute exceeded" + cog comment). Cap at 25 for margin.
const LIMITS = {
  mouser: { perMinute: 25 },
};

const ACQUIRE_MAX_WAIT_MS = 5 * 60 * 1000;  // 5 min — beyond this, throw

// Lock helpers — identical pattern to shared/auth-failure-alerts.js
function acquireLock() {
  for (let i = 0; i < 40; i++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 30 * 1000) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {}
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return {}; }
}

function writeState(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

/**
 * Try to acquire a token for `distributor`. Returns when a token is granted.
 * Throws if max wait exceeded (caller treats as a rate-limit and enqueues).
 *
 * Disty not in LIMITS → no-op (pass through).
 *
 * @param {string} distributor
 */
async function acquire(distributor) {
  const limit = LIMITS[distributor];
  if (!limit) return;  // not throttled

  const capacity = limit.perMinute;
  const refillPerSec = capacity / 60;
  const start = Date.now();

  while (Date.now() - start < ACQUIRE_MAX_WAIT_MS) {
    let waitMs = 100;

    if (acquireLock()) {
      try {
        const state = readState();
        const now = Date.now();
        const prior = state[distributor] || { tokens: capacity, lastRefillAt: now };
        const elapsedSec = Math.max(0, (now - prior.lastRefillAt) / 1000);
        const tokens = Math.min(capacity, prior.tokens + elapsedSec * refillPerSec);

        if (tokens >= 1) {
          state[distributor] = { tokens: tokens - 1, lastRefillAt: now };
          writeState(state);
          return;  // got a token, proceed
        }

        // Not enough — calculate wait, persist current refill state so other
        // processes see accurate refill state (and we don't re-do the math)
        waitMs = Math.ceil((1 - tokens) / refillPerSec * 1000);
        state[distributor] = { tokens, lastRefillAt: now };
        writeState(state);
      } finally {
        releaseLock();
      }
    }

    // Sleep outside the lock. Add jitter to prevent thundering herd.
    // Cap individual sleep at 5s so we periodically re-check (other process
    // may have hit a long block and we can grab earlier).
    const jitter = Math.floor(Math.random() * 100);
    await new Promise(r => setTimeout(r, Math.min(waitMs + jitter, 5000)));
  }

  throw new Error(`${distributor} throttle: max wait (5min) exceeded for token acquisition`);
}

module.exports = {
  acquire,
  _LIMITS: LIMITS,
  _STATE_FILE: STATE_FILE,
};
