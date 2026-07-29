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

// Per-distributor limits. ALL active distributors should be throttled to
// prevent rate-limit cascades like the July 2026 DigiKey incident (46,533
// 429 errors from unthrottled requests creating a thundering-herd retry loop).
//
// `perMinute` should leave headroom under the supplier's actual limit:
// clock skew + overlapping windows mean we can't push right to the edge.
//
// Rationale for each limit (updated 2026-07-20):
//   mouser:   ~30/min actual limit (confirmed via MaxCallPerMinute errors)
//   digikey:  Strict daily quota + per-minute burst limit; conservative
//   arrow:    Generally permissive; OAuth-based
//   future:   Similar to Arrow architecture
//   tti:      OAuth-based, moderate limits
//   newark:   Element14/Farnell API; moderate limits
//   rutronik: EU-based, observed timeouts under load
//   master:   Seen 503s under load; conservative
//   sager:    Generally permissive
//   waldom:   Generally permissive
const LIMITS = {
  mouser:   { perMinute: 25 },
  digikey:  { perMinute: 10 },
  arrow:    { perMinute: 20 },
  future:   { perMinute: 20 },
  tti:      { perMinute: 15 },
  newark:   { perMinute: 15 },
  rutronik: { perMinute: 10 },
  master:   { perMinute: 15 },
  sager:    { perMinute: 20 },
  waldom:   { perMinute: 20 },
};

const ACQUIRE_MAX_WAIT_MS = 5 * 60 * 1000;  // 5 min — beyond this, throw

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// When a distributor returns too many consecutive 429s, stop trying for a
// cooldown period. This prevents the thundering-herd retry loop where 46K+
// items all wake up after 1 hour and immediately re-429.
//
// State is per-distributor in the same state file:
//   {
//     "digikey": {
//       "tokens": 5.2,
//       "lastRefillAt": 1721500000000,
//       "circuitOpen": true,
//       "circuitOpenUntil": 1721503600000,
//       "consecutive429s": 15
//     }
//   }
const CIRCUIT_BREAKER = {
  threshold: 10,            // consecutive 429s before circuit opens
  cooldownMs: 30 * 60 * 1000, // 30 min cooldown when open
};

/**
 * Record a 429 from a distributor. If threshold is exceeded, open the circuit.
 * Called from franchise-api.js catch block when a 429 is detected.
 *
 * @param {string} distributor
 */
function record429(distributor) {
  if (!acquireLock()) return;
  try {
    const state = readState();
    const now = Date.now();
    const prior = state[distributor] || {};
    const consecutive = (prior.consecutive429s || 0) + 1;

    state[distributor] = {
      ...prior,
      consecutive429s: consecutive,
      last429At: now,
    };

    if (consecutive >= CIRCUIT_BREAKER.threshold && !prior.circuitOpen) {
      state[distributor].circuitOpen = true;
      state[distributor].circuitOpenUntil = now + CIRCUIT_BREAKER.cooldownMs;
      // eslint-disable-next-line no-console
      console.error(`[api-throttle] Circuit breaker OPEN for ${distributor} after ${consecutive} consecutive 429s. Cooldown until ${new Date(state[distributor].circuitOpenUntil).toISOString()}`);
    }

    writeState(state);
  } finally {
    releaseLock();
  }
}

/**
 * Record a successful API call. Resets the consecutive 429 counter and closes
 * the circuit if it was open.
 *
 * @param {string} distributor
 */
function recordSuccess(distributor) {
  if (!acquireLock()) return;
  try {
    const state = readState();
    const prior = state[distributor] || {};

    if (prior.consecutive429s > 0 || prior.circuitOpen) {
      state[distributor] = {
        ...prior,
        consecutive429s: 0,
        circuitOpen: false,
        circuitOpenUntil: null,
      };
      writeState(state);
    }
  } finally {
    releaseLock();
  }
}

/**
 * Check if circuit breaker is open for a distributor.
 *
 * @param {string} distributor
 * @returns {{ open: boolean, until?: Date, consecutive429s?: number }}
 */
function checkCircuitBreaker(distributor) {
  const state = readState();
  const prior = state[distributor] || {};

  if (!prior.circuitOpen) {
    return { open: false };
  }

  const now = Date.now();
  if (prior.circuitOpenUntil && now >= prior.circuitOpenUntil) {
    // Cooldown expired — circuit auto-closes on next acquire()
    return { open: false, expired: true };
  }

  return {
    open: true,
    until: new Date(prior.circuitOpenUntil),
    consecutive429s: prior.consecutive429s,
  };
}

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

  // Circuit breaker check — if open, refuse the call immediately
  const circuit = checkCircuitBreaker(distributor);
  if (circuit.open) {
    const minLeft = Math.ceil((circuit.until - Date.now()) / 60000);
    throw new Error(`${distributor} circuit breaker OPEN (${circuit.consecutive429s} consecutive 429s, ${minLeft}min cooldown remaining)`);
  }

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
  record429,
  recordSuccess,
  checkCircuitBreaker,
  _LIMITS: LIMITS,
  _STATE_FILE: STATE_FILE,
  _CIRCUIT_BREAKER: CIRCUIT_BREAKER,
};
