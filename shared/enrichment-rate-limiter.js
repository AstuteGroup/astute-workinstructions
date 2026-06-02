/**
 * Enrichment API Rate Limiter - Prevents DigiKey/Mouser 429 errors
 *
 * Problem: When crons resume after pause, enrichment poller hammers DigiKey
 * API immediately, hitting rate limits within seconds.
 *
 * Solution: Same pattern as vq-writer rate limiting:
 * - Per-run caps (total enrichments per tick)
 * - Per-distributor hourly caps
 * - Backfill mode detection
 * - Circuit breaker for 429s
 *
 * Created: 2026-06-02 (companion to shared/rate-limiter.js for VQ writes)
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.enrichment-rate.json');

// Rate limits
const LIMITS = {
  // Per-execution limits
  maxEnrichmentsPerRun: 50,          // Hard cap per poller tick (was unlimited!)

  // Per-distributor hourly limits (prevent 429s)
  maxCallsPerDistributorPerHour: {
    digikey: 100,     // DigiKey has strict rate limits
    mouser: 150,      // Mouser is more permissive
    arrow: 100,
    avnet: 100,
    newark: 100,
    future: 100,
    rutronik: 100,
  },

  // Backfill mode (when catching up after pause)
  backfillThreshold: 30,              // If >30 unenriched RFQs, enter backfill mode
  backfillMaxPerRun: 20,              // Lower cap during backfill
  backfillDelayMs: 500,               // 500ms between enrichments during backfill

  // Circuit breaker per distributor
  circuitBreakerThreshold: 10,        // Consecutive 429s before opening circuit
  circuitBreakerCooldown: 1800000,    // 30 minutes (vs 15 for VQ writes)
};

// State management
let _state = null;
let _sessionEnrichments = 0;
let _sessionStartTime = Date.now();

function loadState() {
  if (_state) return _state;

  try {
    if (fs.existsSync(STATE_FILE)) {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      _state = {
        calls: [],                     // Array of {timestamp, distributor, count}
        circuitBreakers: {},           // Per-distributor: {consecutiveFailures, openUntil}
      };
    }
  } catch (e) {
    console.warn(`[enrichment-rate-limiter] Could not load state: ${e.message}`);
    _state = { calls: [], circuitBreakers: {} };
  }

  // Clean old calls outside 24h window
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  _state.calls = _state.calls.filter(c => c.timestamp > dayAgo);

  return _state;
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    console.warn(`[enrichment-rate-limiter] Could not save state: ${e.message}`);
  }
}

/**
 * Check if a distributor's circuit breaker is open
 */
function checkCircuitBreaker(distributor) {
  const state = loadState();
  const cb = state.circuitBreakers[distributor];

  if (cb && cb.openUntil && Date.now() < cb.openUntil) {
    const minutesLeft = Math.ceil((cb.openUntil - Date.now()) / 60000);
    return {
      open: true,
      reason: `${distributor} circuit breaker open (${minutesLeft} min remaining after ${cb.consecutiveFailures} 429s)`,
    };
  }

  return { open: false };
}

/**
 * Check if we're in backfill mode based on unenriched RFQ count
 */
function isBackfillMode(unenrichedCount) {
  return unenrichedCount >= LIMITS.backfillThreshold;
}

/**
 * Get current call counts in various windows
 */
function getCallCounts() {
  const state = loadState();
  const now = Date.now();
  const hourAgo = now - (60 * 60 * 1000);

  const perDistributor = {};
  for (const dist in LIMITS.maxCallsPerDistributorPerHour) {
    const count = state.calls
      .filter(c => c.timestamp > hourAgo && c.distributor === dist)
      .reduce((sum, c) => sum + c.count, 0);
    perDistributor[dist] = count;
  }

  return {
    thisSession: _sessionEnrichments,
    perDistributor,
  };
}

/**
 * Check if we can enrich N more RFQs
 *
 * @param {number} count - How many RFQs we want to enrich
 * @param {object} opts - Options
 * @param {number} opts.unenrichedCount - For backfill mode detection
 * @returns {{allowed: boolean, reason?: string, limits: object}}
 */
function checkEnrichmentLimit(count, opts = {}) {
  const { unenrichedCount = 0 } = opts;

  const counts = getCallCounts();
  const backfillMode = isBackfillMode(unenrichedCount);

  // Determine per-run limit based on mode
  const maxPerRun = backfillMode ? LIMITS.backfillMaxPerRun : LIMITS.maxEnrichmentsPerRun;

  // Check per-run limit
  if (counts.thisSession + count > maxPerRun) {
    return {
      allowed: false,
      reason: `Per-run limit: ${counts.thisSession}/${maxPerRun} already enriched${backfillMode ? ' (backfill mode)' : ''}`,
      limits: LIMITS,
    };
  }

  return {
    allowed: true,
    limits: LIMITS,
    backfillMode,
    counts,
  };
}

/**
 * Check if a specific distributor can make more calls
 */
function checkDistributorLimit(distributor) {
  // Check circuit breaker first
  const circuit = checkCircuitBreaker(distributor);
  if (circuit.open) {
    return { allowed: false, reason: circuit.reason };
  }

  const counts = getCallCounts();
  const limit = LIMITS.maxCallsPerDistributorPerHour[distributor] || 100;
  const current = counts.perDistributor[distributor] || 0;

  if (current >= limit) {
    return {
      allowed: false,
      reason: `${distributor} hourly limit: ${current}/${limit} calls in last 60 min`,
    };
  }

  return { allowed: true };
}

/**
 * Record that we enriched N RFQs (call BEFORE enriching)
 */
function recordEnrichmentAttempt(count) {
  _sessionEnrichments += count;
}

/**
 * Record API calls to a distributor
 */
function recordDistributorCalls(distributor, count) {
  const state = loadState();

  state.calls.push({
    timestamp: Date.now(),
    distributor: distributor.toLowerCase(),
    count: count,
  });

  saveState();
}

/**
 * Record a successful distributor call (resets circuit breaker)
 */
function recordDistributorSuccess(distributor) {
  const state = loadState();
  const dist = distributor.toLowerCase();

  if (state.circuitBreakers[dist]) {
    state.circuitBreakers[dist].consecutiveFailures = 0;
    state.circuitBreakers[dist].openUntil = null;
  }

  saveState();
}

/**
 * Record a 429 failure (increments circuit breaker)
 */
function recordDistributor429(distributor) {
  const state = loadState();
  const dist = distributor.toLowerCase();

  if (!state.circuitBreakers[dist]) {
    state.circuitBreakers[dist] = { consecutiveFailures: 0, openUntil: null };
  }

  state.circuitBreakers[dist].consecutiveFailures++;

  if (state.circuitBreakers[dist].consecutiveFailures >= LIMITS.circuitBreakerThreshold) {
    state.circuitBreakers[dist].openUntil = Date.now() + LIMITS.circuitBreakerCooldown;
    console.error(
      `[enrichment-rate-limiter] ${distributor} circuit breaker OPEN after ` +
      `${state.circuitBreakers[dist].consecutiveFailures} 429s. ` +
      `Paused for ${LIMITS.circuitBreakerCooldown / 60000} minutes.`
    );
  }

  saveState();
}

/**
 * Get recommended delay between enrichments based on mode
 */
function getRecommendedDelay(unenrichedCount = 0) {
  const backfillMode = isBackfillMode(unenrichedCount);
  return backfillMode ? LIMITS.backfillDelayMs : 0; // 500ms vs 0ms
}

/**
 * Reset session counters (call at start of new execution)
 */
function resetSession() {
  _sessionEnrichments = 0;
  _sessionStartTime = Date.now();
}

/**
 * Get current status for logging
 */
function getStatus() {
  const counts = getCallCounts();
  const circuits = {};

  const state = loadState();
  for (const dist in state.circuitBreakers) {
    const cb = checkCircuitBreaker(dist);
    if (cb.open) circuits[dist] = 'OPEN';
  }

  return {
    sessionEnrichments: counts.thisSession,
    sessionDuration: Math.round((Date.now() - _sessionStartTime) / 1000),
    distributorCallsLastHour: counts.perDistributor,
    circuitBreakers: circuits,
    limits: LIMITS,
  };
}

module.exports = {
  checkEnrichmentLimit,
  checkDistributorLimit,
  recordEnrichmentAttempt,
  recordDistributorCalls,
  recordDistributorSuccess,
  recordDistributor429,
  getRecommendedDelay,
  isBackfillMode,
  resetSession,
  getStatus,
  checkCircuitBreaker,
  LIMITS,
};
