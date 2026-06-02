/**
 * Rate Limiter - Prevents API overload during backfill and normal operations
 *
 * Usage:
 *   const rateLimiter = require('../shared/rate-limiter');
 *
 *   // Check if we can write more VQs
 *   const canWrite = await rateLimiter.checkVQLimit(50); // want to write 50
 *   if (!canWrite.allowed) {
 *     console.log(`Rate limit: ${canWrite.reason}`);
 *     return;
 *   }
 *
 *   // After writing, record it
 *   rateLimiter.recordVQWrites(50);
 *
 * Created: 2026-06-02 (response to June 1 incident - 3455 VQs crashed API)
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.vq-write-rate.json');

// Rate limits
const LIMITS = {
  // Per-execution limits
  maxVQsPerRun: 500,              // Hard cap per script execution

  // Rolling window limits
  maxVQsPerHour: 1500,            // Rolling 60-minute window
  maxVQsPerDay: 5000,             // Rolling 24-hour window

  // Backfill mode (when catching up after pause)
  backfillThreshold: 20,          // If >20 unseen emails, enter backfill mode
  backfillMaxPerRun: 300,         // Lower cap during backfill
  backfillDelayMs: 200,           // Double the normal delay

  // Circuit breaker
  circuitBreakerThreshold: 15,    // Consecutive failures before opening circuit
  circuitBreakerCooldown: 900000, // 15 minutes
};

// State management
let _state = null;
let _sessionWrites = 0;
let _sessionStartTime = Date.now();

function loadState() {
  if (_state) return _state;

  try {
    if (fs.existsSync(STATE_FILE)) {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      _state = {
        writes: [],              // Array of {timestamp, count}
        consecutiveFailures: 0,
        circuitOpenUntil: null,
      };
    }
  } catch (e) {
    console.warn(`[rate-limiter] Could not load state: ${e.message}`);
    _state = { writes: [], consecutiveFailures: 0, circuitOpenUntil: null };
  }

  // Clean old writes outside 24h window
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  _state.writes = _state.writes.filter(w => w.timestamp > dayAgo);

  return _state;
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    console.warn(`[rate-limiter] Could not save state: ${e.message}`);
  }
}

/**
 * Check if circuit breaker is open
 */
function checkCircuitBreaker() {
  const state = loadState();

  if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) {
    const minutesLeft = Math.ceil((state.circuitOpenUntil - Date.now()) / 60000);
    return {
      open: true,
      reason: `Circuit breaker open (${minutesLeft} min remaining after ${state.consecutiveFailures} failures)`,
    };
  }

  return { open: false };
}

/**
 * Check if we're in backfill mode based on unseen email count
 */
function isBackfillMode(unseenCount) {
  return unseenCount >= LIMITS.backfillThreshold;
}

/**
 * Get current write counts in various windows
 */
function getWriteCounts() {
  const state = loadState();
  const now = Date.now();

  const hourAgo = now - (60 * 60 * 1000);
  const dayAgo = now - (24 * 60 * 60 * 1000);

  const lastHour = state.writes
    .filter(w => w.timestamp > hourAgo)
    .reduce((sum, w) => sum + w.count, 0);

  const lastDay = state.writes
    .filter(w => w.timestamp > dayAgo)
    .reduce((sum, w) => sum + w.count, 0);

  return {
    thisSession: _sessionWrites,
    lastHour,
    lastDay,
  };
}

/**
 * Check if we can write N more VQs
 *
 * @param {number} count - How many VQs we want to write
 * @param {object} opts - Options
 * @param {number} opts.unseenEmailCount - For backfill mode detection
 * @returns {{allowed: boolean, reason?: string, limits: object}}
 */
function checkVQLimit(count, opts = {}) {
  const { unseenEmailCount = 0 } = opts;

  // Check circuit breaker first
  const circuit = checkCircuitBreaker();
  if (circuit.open) {
    return { allowed: false, reason: circuit.reason, limits: LIMITS };
  }

  const counts = getWriteCounts();
  const backfillMode = isBackfillMode(unseenEmailCount);

  // Determine per-run limit based on mode
  const maxPerRun = backfillMode ? LIMITS.backfillMaxPerRun : LIMITS.maxVQsPerRun;

  // Check per-run limit
  if (counts.thisSession + count > maxPerRun) {
    return {
      allowed: false,
      reason: `Per-run limit: ${counts.thisSession}/${maxPerRun} already written${backfillMode ? ' (backfill mode)' : ''}`,
      limits: LIMITS,
    };
  }

  // Check hourly limit
  if (counts.lastHour + count > LIMITS.maxVQsPerHour) {
    return {
      allowed: false,
      reason: `Hourly limit: ${counts.lastHour}/${LIMITS.maxVQsPerHour} in last 60 min`,
      limits: LIMITS,
    };
  }

  // Check daily limit
  if (counts.lastDay + count > LIMITS.maxVQsPerDay) {
    return {
      allowed: false,
      reason: `Daily limit: ${counts.lastDay}/${LIMITS.maxVQsPerDay} in last 24 hours`,
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
 * Record that we wrote N VQs
 */
function recordVQWrites(count) {
  const state = loadState();

  state.writes.push({
    timestamp: Date.now(),
    count: count,
  });

  _sessionWrites += count;

  saveState();
}

/**
 * Record a successful write (resets circuit breaker)
 */
function recordSuccess() {
  const state = loadState();
  state.consecutiveFailures = 0;
  state.circuitOpenUntil = null;
  saveState();
}

/**
 * Record a failed write (increments circuit breaker)
 */
function recordFailure() {
  const state = loadState();
  state.consecutiveFailures++;

  if (state.consecutiveFailures >= LIMITS.circuitBreakerThreshold) {
    state.circuitOpenUntil = Date.now() + LIMITS.circuitBreakerCooldown;
    console.error(
      `[rate-limiter] Circuit breaker OPEN after ${state.consecutiveFailures} failures. ` +
      `Paused for ${LIMITS.circuitBreakerCooldown / 60000} minutes.`
    );
  }

  saveState();
}

/**
 * Get recommended delay between writes based on mode
 */
function getRecommendedDelay(unseenEmailCount = 0) {
  const backfillMode = isBackfillMode(unseenEmailCount);
  return backfillMode ? LIMITS.backfillDelayMs : 100; // 200ms vs 100ms
}

/**
 * Reset session counters (call at start of new execution)
 */
function resetSession() {
  _sessionWrites = 0;
  _sessionStartTime = Date.now();
}

/**
 * Get current status for logging
 */
function getStatus() {
  const counts = getWriteCounts();
  const circuit = checkCircuitBreaker();

  return {
    sessionWrites: counts.thisSession,
    sessionDuration: Math.round((Date.now() - _sessionStartTime) / 1000),
    lastHourWrites: counts.lastHour,
    lastDayWrites: counts.lastDay,
    circuitBreakerOpen: circuit.open,
    limits: LIMITS,
  };
}

module.exports = {
  checkVQLimit,
  recordVQWrites,
  recordSuccess,
  recordFailure,
  getRecommendedDelay,
  isBackfillMode,
  resetSession,
  getStatus,
  checkCircuitBreaker,
  LIMITS,
};
