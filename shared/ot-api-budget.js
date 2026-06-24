/**
 * shared/ot-api-budget.js
 *
 * Global OT API budget manager - coordinates rate limiting across ALL agents
 * and writers to prevent overwhelming the OT API.
 *
 * Problem solved: Individual rate limiters (vq-writer, enrichment-rate-limiter)
 * don't coordinate. Stock RFQ + VQ + Enrichment could all hit OT simultaneously,
 * totaling 600+ writes in 15 minutes even though each is within its own limit.
 *
 * Solution: Single source of truth for API budget. All writers check here first.
 *
 * Created: 2026-06-02
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.ot-api-budget.json');
const RATE_LIMIT_LOG = path.join(process.env.HOME, 'workspace', '.ot-rate-limit-events.ndjson');

// ─── RATE LIMIT EVENT LOGGING ────────────────────────────────────────────────

/**
 * Log a rate limit event to persistent storage for historical analysis.
 * Uses NDJSON format (one JSON object per line) for easy parsing.
 *
 * @param {object} event - Rate limit event details
 * @param {string} event.caller - Agent that was rate limited
 * @param {string} event.table - Target table
 * @param {number} event.requestedCount - How many writes were requested
 * @param {string} event.reason - Why the request was denied
 * @param {number} event.priority - Caller's priority level
 * @param {string} event.limitType - Which limit was hit (5min, 15min, hourly, daily, table)
 */
function logRateLimitEvent(event) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      ts: Date.now(),
      ...event,
    };
    fs.appendFileSync(RATE_LIMIT_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    // Don't let logging failures break the budget system
    console.warn(`[ot-api-budget] Could not log rate limit event: ${e.message}`);
  }
}

/**
 * Read rate limit events from the log file.
 * @param {number} days - How many days of history to load (default: 14)
 * @returns {Array} Array of rate limit events
 */
function getRateLimitHistory(days = 14) {
  try {
    if (!fs.existsSync(RATE_LIMIT_LOG)) return [];

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const content = fs.readFileSync(RATE_LIMIT_LOG, 'utf8');
    const events = content
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(e => e && e.ts > cutoff);

    return events;
  } catch (e) {
    console.warn(`[ot-api-budget] Could not read rate limit history: ${e.message}`);
    return [];
  }
}

/**
 * Rotate the rate limit log file (keep last 30 days).
 * Called automatically during state cleanup.
 */
function rotateRateLimitLog() {
  try {
    if (!fs.existsSync(RATE_LIMIT_LOG)) return;

    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const content = fs.readFileSync(RATE_LIMIT_LOG, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    const kept = lines.filter(line => {
      try {
        const e = JSON.parse(line);
        return e.ts > cutoff;
      } catch { return false; }
    });

    if (kept.length < lines.length) {
      fs.writeFileSync(RATE_LIMIT_LOG, kept.join('\n') + (kept.length ? '\n' : ''));
    }
  } catch (e) {
    // Non-critical, ignore
  }
}

// ─── GLOBAL LIMITS ───────────────────────────────────────────────────────────

const LIMITS = {
  // Hard caps across ALL agents/writers (data-driven from operational history)
  // Analysis showed: system handles 1,657 VQs/hour and 672/15min routinely
  // June 1 crash: 252 VQs in 5 minutes sustained (50/min rate)
  // June 10: 256k writes/day worked fine (two 118k inventory offers + normal traffic)
  // June 12: Rebalanced limits to match 300k daily capacity
  // Math: 300k/day = 12.5k/hour = 3.1k/15min = 1k/5min
  // Keep 5-min conservative as burst protection (June 1 crashed at 252 sustained)
  maxWritesPer5Min: 600,            // Burst protection - below sustained crash threshold
  maxWritesPer15Min: 4000,          // 12.5k/hour ÷ 4 = 3.1k, rounded up
  maxWritesPerHour: 15000,          // 300k/day ÷ 24 = 12.5k, with headroom
  maxWritesPerDay: 300000,          // 256k proven safe June 10

  // Priority tiers (higher number = higher priority)
  // When budget is constrained, higher-priority callers get preference
  priorities: {
    'rfq-loading-agent': 4,         // Highest - customer-facing RFQs
    'rfq-fast-loader': 4,           // Same tier as rfq-loading
    'vq-loading-agent': 3,          // Second - vendor quotes
    'excess-agent': 2,              // Third - market offers
    'stockrfq-agent': 1,            // Broker data capture
    'stockrfq-cq-agent': 1,         // Same as stockrfq
    'enrich-poller': 2,             // Same as excess (market intel - writes chuboe_pricing_api_result)
    'offer-writeback': 0,           // LOWEST - bulk inventory offers, throttle first (can be 15k+ lines)
    'inventory-cleanup': 2,         // Non-urgent automation
  },

  // Reserved budget for high-priority callers
  // Even if lower-priority agents consumed most budget, always keep this much for P4/P3
  // ~5% of hourly for P4, ~2.5% for P3
  reservedForPriority: {
    4: 750,   // Always reserve 750 writes for RFQ agents
    3: 400,   // Always reserve 400 writes for VQ agent
  },

  // Backfill coordination - only ONE agent in backfill mode at a time
  maxConcurrentBackfills: 1,

  // Backfill mode limits (when catching up after cron pause)
  // June 12: Scaled to match 15k/hour global limit
  backfill: {
    maxPerAgentRun: 2000,           // Large batches OK with higher limits
    maxWritesPer5Min: 300,          // Half the normal burst limit (600/2)
    delayBetweenWrites: 50,         // 50ms pacing
  },

  // Per-table limits (prevent one table from dominating the budget)
  // June 12: Scaled to match 15k/hour global limit
  perTable: {
    chuboe_rfq: { maxPerHour: 3000 },
    chuboe_rfq_line: { maxPerHour: 8000 },
    chuboe_rfq_line_mpn: { maxPerHour: 8000 },
    chuboe_vq_line: { maxPerHour: 12000 },
    chuboe_cq_line: { maxPerHour: 6000 },
    chuboe_offer: { maxPerHour: 3000 },
    chuboe_offer_line: { maxPerHour: 15000 },     // Full headroom for bulk inventory
    chuboe_offer_line_mpn: { maxPerHour: 8000 },
    chuboe_pricing_api_result: { maxPerHour: 5000 },
  },

  // Global circuit breaker (affects ALL agents)
  circuitBreaker: {
    consecutiveFailures: 20,        // 20 failures across all agents
    cooldownMs: 900000,             // 15 minutes
  },
};

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────

let _state = null;

function loadState() {
  if (_state) return _state;

  try {
    if (fs.existsSync(STATE_FILE)) {
      _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      _state = {
        writes: [],                  // Array of {timestamp, table, count, caller, success}
        reservations: [],            // Array of {timestamp, table, count, caller, expiresAt}
        backfills: [],               // Array of {caller, startedAt}
        circuitBreaker: {
          consecutiveFailures: 0,
          openUntil: null,
        },
      };
    }
  } catch (e) {
    console.warn(`[ot-api-budget] Could not load state: ${e.message}`);
    _state = { writes: [], reservations: [], backfills: [], circuitBreaker: { consecutiveFailures: 0, openUntil: null } };
  }

  // Clean old writes outside 24h window
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  _state.writes = _state.writes.filter(w => w.timestamp > dayAgo);

  // Clean expired reservations (older than 10 minutes)
  const now = Date.now();
  _state.reservations = _state.reservations.filter(r => r.expiresAt > now);

  // Clean stale backfills (older than 2 hours)
  const twoHoursAgo = now - (2 * 60 * 60 * 1000);
  _state.backfills = _state.backfills.filter(b => b.startedAt > twoHoursAgo);

  // Rotate rate limit log occasionally (1% chance per load to avoid overhead)
  if (Math.random() < 0.01) {
    rotateRateLimitLog();
  }

  return _state;
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    console.warn(`[ot-api-budget] Could not save state: ${e.message}`);
  }
}

// ─── CIRCUIT BREAKER ─────────────────────────────────────────────────────────

function checkCircuitBreaker() {
  const state = loadState();
  const cb = state.circuitBreaker;

  if (cb.openUntil && Date.now() < cb.openUntil) {
    const minutesLeft = Math.ceil((cb.openUntil - Date.now()) / 60000);
    return {
      open: true,
      reason: `Global circuit breaker open (${minutesLeft} min remaining after ${cb.consecutiveFailures} consecutive failures)`,
    };
  }

  return { open: false };
}

function recordSuccess() {
  const state = loadState();
  state.circuitBreaker.consecutiveFailures = 0;
  state.circuitBreaker.openUntil = null;
  saveState();
}

function recordFailure() {
  const state = loadState();
  state.circuitBreaker.consecutiveFailures++;

  if (state.circuitBreaker.consecutiveFailures >= LIMITS.circuitBreaker.consecutiveFailures) {
    state.circuitBreaker.openUntil = Date.now() + LIMITS.circuitBreaker.cooldownMs;
    console.error(
      `[ot-api-budget] GLOBAL CIRCUIT BREAKER OPEN after ${state.circuitBreaker.consecutiveFailures} failures. ` +
      `ALL OT writes paused for ${LIMITS.circuitBreaker.cooldownMs / 60000} minutes.`
    );
  }

  saveState();
}

// ─── BUDGET TRACKING ─────────────────────────────────────────────────────────

function getWriteCounts() {
  const state = loadState();
  const now = Date.now();
  const fiveMinAgo = now - (5 * 60 * 1000);
  const fifteenMinAgo = now - (15 * 60 * 1000);
  const hourAgo = now - (60 * 60 * 1000);
  const dayAgo = now - (24 * 60 * 60 * 1000);

  // Include both actual writes and active reservations
  const allWrites = [...state.writes, ...state.reservations];

  const counts = {
    last5Min: allWrites.filter(w => w.timestamp > fiveMinAgo).reduce((sum, w) => sum + w.count, 0),
    last15Min: allWrites.filter(w => w.timestamp > fifteenMinAgo).reduce((sum, w) => sum + w.count, 0),
    lastHour: allWrites.filter(w => w.timestamp > hourAgo).reduce((sum, w) => sum + w.count, 0),
    lastDay: allWrites.filter(w => w.timestamp > dayAgo).reduce((sum, w) => sum + w.count, 0),
    perTable: {},
  };

  // Per-table counts (hourly window)
  for (const table in LIMITS.perTable) {
    counts.perTable[table] = allWrites
      .filter(w => w.timestamp > hourAgo && w.table === table)
      .reduce((sum, w) => sum + w.count, 0);
  }

  return counts;
}

// ─── BACKFILL COORDINATION ───────────────────────────────────────────────────

function checkBackfillSlot(caller) {
  const state = loadState();

  // Check if this caller already has a backfill slot
  const existingSlot = state.backfills.find(b => b.caller === caller);
  if (existingSlot) {
    return { allowed: true, reason: 'Already in backfill mode' };
  }

  // Check if someone else is backfilling
  if (state.backfills.length >= LIMITS.maxConcurrentBackfills) {
    const blocker = state.backfills[0];
    const minutesAgo = Math.floor((Date.now() - blocker.startedAt) / 60000);
    return {
      allowed: false,
      reason: `Backfill slot occupied by ${blocker.caller} (started ${minutesAgo} min ago)`,
    };
  }

  return { allowed: true };
}

function claimBackfillSlot(caller) {
  const state = loadState();
  state.backfills.push({ caller, startedAt: Date.now() });
  saveState();
}

function releaseBackfillSlot(caller) {
  const state = loadState();
  state.backfills = state.backfills.filter(b => b.caller !== caller);
  saveState();
}

// ─── BUDGET CHECK ────────────────────────────────────────────────────────────

/**
 * Check if the caller can make N writes to the specified table.
 *
 * Priority-aware: higher-priority callers get preference when budget is tight.
 *
 * @param {object} opts - Options
 * @param {string} opts.table - Table name (e.g., 'chuboe_vq_line')
 * @param {number} opts.count - Number of writes requested
 * @param {string} opts.caller - Caller identifier (for logging/debugging)
 * @param {boolean} opts.isBackfill - Whether this is backfill mode (optional)
 * @returns {{allowed: boolean, reason?: string, limits: object, priority?: number}}
 */
function checkBudget(opts = {}) {
  const { table, count, caller, isBackfill = false } = opts;

  // Get caller priority (default to 0 for unknown callers)
  const priority = LIMITS.priorities[caller] || 0;

  // Check circuit breaker first
  const circuit = checkCircuitBreaker();
  if (circuit.open) {
    logRateLimitEvent({ caller, table, requestedCount: count, reason: circuit.reason, priority, limitType: 'circuit-breaker' });
    return { allowed: false, reason: circuit.reason, limits: LIMITS, priority };
  }

  // Check backfill coordination
  if (isBackfill) {
    const backfillCheck = checkBackfillSlot(caller);
    if (!backfillCheck.allowed) {
      logRateLimitEvent({ caller, table, requestedCount: count, reason: backfillCheck.reason, priority, limitType: 'backfill-slot' });
      return { allowed: false, reason: backfillCheck.reason, limits: LIMITS, priority };
    }
  }

  const counts = getWriteCounts();

  // CRITICAL: 5-minute burst check (prevents June 1 crash scenario)
  // P4 callers (RFQ loading) are EXEMPT - customer-facing RFQs must always get through
  // Other callers subject to burst limit to prevent sustained high write rate
  const limit5Min = isBackfill ? LIMITS.backfill.maxWritesPer5Min : LIMITS.maxWritesPer5Min;

  if (counts.last5Min + count > limit5Min) {
    if (priority >= 4) {
      // P4 exempt but log for monitoring
      console.warn(`[ot-api-budget] P4 caller ${caller} bypassing 5-min burst limit: ${counts.last5Min + count}/${limit5Min}`);
    } else {
      const reason = `Global 5-min burst limit: ${counts.last5Min}/${limit5Min} (prevents sustained overload, P4 exempt)${isBackfill ? ' [backfill mode]' : ''}`;
      logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: '5min', current: counts.last5Min, limit: limit5Min });
      return { allowed: false, reason, limits: LIMITS, priority };
    }
  }

  // Priority-aware 15-min check
  // High-priority callers can use reserved budget even when limit appears hit
  const reserved15Min = LIMITS.reservedForPriority[priority] || 0;
  const effectiveLimit15Min = LIMITS.maxWritesPer15Min - reserved15Min;

  if (counts.last15Min + count > LIMITS.maxWritesPer15Min) {
    // Hard limit - even high-priority blocked
    const reason = `Global 15-min HARD limit: ${counts.last15Min}/${LIMITS.maxWritesPer15Min} (priority ${priority})`;
    logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: '15min-hard', current: counts.last15Min, limit: LIMITS.maxWritesPer15Min });
    return { allowed: false, reason, limits: LIMITS, priority };
  } else if (counts.last15Min + count > effectiveLimit15Min && priority < 3) {
    // Soft limit - only block low-priority (< P3)
    const reason = `Global 15-min limit: ${counts.last15Min}/${effectiveLimit15Min} (reserved for P3+ callers, you are P${priority})`;
    logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: '15min-soft', current: counts.last15Min, limit: effectiveLimit15Min });
    return { allowed: false, reason, limits: LIMITS, priority };
  }

  // Priority-aware hourly check
  const reservedHourly = LIMITS.reservedForPriority[priority] || 0;
  const effectiveLimitHourly = LIMITS.maxWritesPerHour - reservedHourly;

  if (counts.lastHour + count > LIMITS.maxWritesPerHour) {
    const reason = `Global hourly HARD limit: ${counts.lastHour}/${LIMITS.maxWritesPerHour} (priority ${priority})`;
    logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: 'hourly-hard', current: counts.lastHour, limit: LIMITS.maxWritesPerHour });
    return { allowed: false, reason, limits: LIMITS, priority };
  } else if (counts.lastHour + count > effectiveLimitHourly && priority < 3) {
    const reason = `Global hourly limit: ${counts.lastHour}/${effectiveLimitHourly} (reserved for P3+ callers, you are P${priority})`;
    logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: 'hourly-soft', current: counts.lastHour, limit: effectiveLimitHourly });
    return { allowed: false, reason, limits: LIMITS, priority };
  }

  // Check daily window
  // P4 callers (RFQ loading) are EXEMPT from daily limit - customer-facing, always allowed
  // Other callers still subject to hard cap to prevent runaway automation
  if (priority < 4 && counts.lastDay + count > LIMITS.maxWritesPerDay) {
    const reason = `Global daily limit: ${counts.lastDay}/${LIMITS.maxWritesPerDay} already used (P4 exempt, you are P${priority})`;
    logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: 'daily', current: counts.lastDay, limit: LIMITS.maxWritesPerDay });
    return { allowed: false, reason, limits: LIMITS, priority };
  }

  // Check per-table limit (no priority - prevents one table from dominating)
  if (table && LIMITS.perTable[table]) {
    const tableCount = counts.perTable[table] || 0;
    const tableLimit = LIMITS.perTable[table].maxPerHour;
    if (tableCount + count > tableLimit) {
      const reason = `Table ${table} hourly limit: ${tableCount}/${tableLimit} already used`;
      logRateLimitEvent({ caller, table, requestedCount: count, reason, priority, limitType: 'per-table', current: tableCount, limit: tableLimit });
      return { allowed: false, reason, limits: LIMITS, priority };
    }
  }

  return { allowed: true, limits: LIMITS, priority };
}

/**
 * Reserve budget for upcoming writes (before actual API calls).
 * Prevents race conditions where multiple agents check budget simultaneously.
 * Reservations expire after 10 minutes.
 */
function reserve(table, count, caller) {
  const state = loadState();
  state.reservations.push({
    timestamp: Date.now(),
    table,
    count,
    caller,
    expiresAt: Date.now() + (10 * 60 * 1000), // 10 min expiry
  });
  saveState();
}

/**
 * Record actual writes (after API calls complete).
 * Removes the reservation and records the actual usage.
 */
function recordWrites(table, count, opts = {}) {
  const { caller, success = true, durationMs = null } = opts;

  const state = loadState();

  // Remove matching reservation
  state.reservations = state.reservations.filter(r =>
    !(r.table === table && r.caller === caller && r.count === count)
  );

  // Record actual write
  state.writes.push({
    timestamp: Date.now(),
    table,
    count,
    caller,
    success,
    durationMs,
  });

  // Update circuit breaker
  if (success) {
    state.circuitBreaker.consecutiveFailures = 0;
    state.circuitBreaker.openUntil = null;
  } else {
    state.circuitBreaker.consecutiveFailures++;
    if (state.circuitBreaker.consecutiveFailures >= LIMITS.circuitBreaker.consecutiveFailures) {
      state.circuitBreaker.openUntil = Date.now() + LIMITS.circuitBreaker.cooldownMs;
      console.error(
        `[ot-api-budget] GLOBAL CIRCUIT BREAKER OPEN after ${state.circuitBreaker.consecutiveFailures} failures. ` +
        `ALL OT writes paused for ${LIMITS.circuitBreaker.cooldownMs / 60000} minutes.`
      );
    }
  }

  saveState();
}

/**
 * Cancel a reservation (if writes were skipped/failed before starting)
 */
function cancelReservation(table, count, caller) {
  const state = loadState();
  state.reservations = state.reservations.filter(r =>
    !(r.table === table && r.caller === caller && r.count === count)
  );
  saveState();
}

/**
 * Get current status for logging/debugging
 */
function getStatus() {
  const counts = getWriteCounts();
  const circuit = checkCircuitBreaker();
  const state = loadState();

  return {
    globalBudget: {
      last5Min: `${counts.last5Min}/${LIMITS.maxWritesPer5Min}`,
      last15Min: `${counts.last15Min}/${LIMITS.maxWritesPer15Min}`,
      lastHour: `${counts.lastHour}/${LIMITS.maxWritesPerHour}`,
      lastDay: `${counts.lastDay}/${LIMITS.maxWritesPerDay}`,
    },
    perTable: Object.keys(LIMITS.perTable).reduce((acc, table) => {
      const count = counts.perTable[table] || 0;
      const limit = LIMITS.perTable[table].maxPerHour;
      acc[table] = `${count}/${limit}`;
      return acc;
    }, {}),
    circuitBreaker: circuit.open ? 'OPEN' : 'CLOSED',
    circuitBreakerReason: circuit.reason || null,
    activeBackfills: state.backfills.map(b => ({
      caller: b.caller,
      minutesAgo: Math.floor((Date.now() - b.startedAt) / 60000),
    })),
    activeReservations: state.reservations.length,
    limits: LIMITS,
  };
}

/**
 * Reset state (for testing or manual intervention)
 */
function reset() {
  _state = {
    writes: [],
    reservations: [],
    backfills: [],
    circuitBreaker: { consecutiveFailures: 0, openUntil: null },
  };
  saveState();
}

module.exports = {
  checkBudget,
  reserve,
  recordWrites,
  cancelReservation,
  checkBackfillSlot,
  claimBackfillSlot,
  releaseBackfillSlot,
  recordSuccess,
  recordFailure,
  getStatus,
  reset,
  LIMITS,
  // Rate limit history
  getRateLimitHistory,
  rotateRateLimitLog,
  RATE_LIMIT_LOG,
};
