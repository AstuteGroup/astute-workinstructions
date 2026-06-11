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

// ─── GLOBAL LIMITS ───────────────────────────────────────────────────────────

const LIMITS = {
  // Hard caps across ALL agents/writers (data-driven from operational history)
  // Analysis showed: system handles 1,657 VQs/hour and 672/15min routinely
  // June 1 crash: 252 VQs in 5 minutes sustained (50/min rate)
  // June 10: 256k writes/day worked fine (two 118k inventory offers + normal traffic)
  maxWritesPer5Min: 200,            // CRITICAL - prevents sustained burst (June 1 hit 252 and crashed)
  maxWritesPer15Min: 800,           // 20% buffer above proven 672 peak
  maxWritesPerHour: 2000,           // 20% buffer above proven 1,657 peak
  maxWritesPerDay: 300000,          // Raised from 30k — 256k proven safe June 10; burst limits are real protection

  // Priority tiers (higher number = higher priority)
  // When budget is constrained, higher-priority callers get preference
  priorities: {
    'rfq-loading-agent': 4,         // Highest - customer-facing RFQs
    'rfq-fast-loader': 4,           // Same tier as rfq-loading
    'vq-loading-agent': 3,          // Second - vendor quotes
    'excess-agent': 2,              // Third - market offers
    'stockrfq-agent': 1,            // Lowest - broker data capture
    'stockrfq-cq-agent': 1,         // Same as stockrfq
    'enrich-poller': 2,             // Same as excess (market intel - writes chuboe_pricing_api_result)
    'offer-writeback': 2,           // Same as excess
    'inventory-cleanup': 2,         // Non-urgent automation
  },

  // Reserved budget for high-priority callers
  // Even if lower-priority agents consumed most budget, always keep this much for P4/P3
  reservedForPriority: {
    4: 100,   // Always reserve 100 writes for RFQ agents
    3: 50,    // Always reserve 50 writes for VQ agent
  },

  // Backfill coordination - only ONE agent in backfill mode at a time
  maxConcurrentBackfills: 1,

  // Backfill mode limits (when catching up after cron pause)
  backfill: {
    maxPerAgentRun: 500,            // Can handle large batches (system proven at 672/15min)
    maxWritesPer5Min: 100,          // Half the normal burst limit during backfill
    delayBetweenWrites: 100,        // 100ms pacing to prevent API hammering
  },

  // Per-table limits (prevent one table from dominating the budget)
  // These are MORE generous than before based on actual data
  perTable: {
    chuboe_rfq: { maxPerHour: 400 },              // Doubled from 200
    chuboe_rfq_line: { maxPerHour: 1000 },        // Doubled from 500
    chuboe_rfq_line_mpn: { maxPerHour: 1000 },    // Doubled from 500
    chuboe_vq_line: { maxPerHour: 1800 },         // Tripled from 600 (handles peak 1,657)
    chuboe_cq_line: { maxPerHour: 800 },          // Doubled from 400
    chuboe_offer: { maxPerHour: 400 },            // Doubled from 200
    chuboe_offer_line: { maxPerHour: 1000 },      // Doubled from 500
    chuboe_offer_line_mpn: { maxPerHour: 1000 },  // Doubled from 500
    chuboe_pricing_api_result: { maxPerHour: 600 }, // Doubled from 300
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
    return { allowed: false, reason: circuit.reason, limits: LIMITS, priority };
  }

  // Check backfill coordination
  if (isBackfill) {
    const backfillCheck = checkBackfillSlot(caller);
    if (!backfillCheck.allowed) {
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
      return {
        allowed: false,
        reason: `Global 5-min burst limit: ${counts.last5Min}/${limit5Min} (prevents sustained overload, P4 exempt)${isBackfill ? ' [backfill mode]' : ''}`,
        limits: LIMITS,
        priority,
      };
    }
  }

  // Priority-aware 15-min check
  // High-priority callers can use reserved budget even when limit appears hit
  const reserved15Min = LIMITS.reservedForPriority[priority] || 0;
  const effectiveLimit15Min = LIMITS.maxWritesPer15Min - reserved15Min;

  if (counts.last15Min + count > LIMITS.maxWritesPer15Min) {
    // Hard limit - even high-priority blocked
    return {
      allowed: false,
      reason: `Global 15-min HARD limit: ${counts.last15Min}/${LIMITS.maxWritesPer15Min} (priority ${priority})`,
      limits: LIMITS,
      priority,
    };
  } else if (counts.last15Min + count > effectiveLimit15Min && priority < 3) {
    // Soft limit - only block low-priority (< P3)
    return {
      allowed: false,
      reason: `Global 15-min limit: ${counts.last15Min}/${effectiveLimit15Min} (reserved for P3+ callers, you are P${priority})`,
      limits: LIMITS,
      priority,
    };
  }

  // Priority-aware hourly check
  const reservedHourly = LIMITS.reservedForPriority[priority] || 0;
  const effectiveLimitHourly = LIMITS.maxWritesPerHour - reservedHourly;

  if (counts.lastHour + count > LIMITS.maxWritesPerHour) {
    return {
      allowed: false,
      reason: `Global hourly HARD limit: ${counts.lastHour}/${LIMITS.maxWritesPerHour} (priority ${priority})`,
      limits: LIMITS,
      priority,
    };
  } else if (counts.lastHour + count > effectiveLimitHourly && priority < 3) {
    return {
      allowed: false,
      reason: `Global hourly limit: ${counts.lastHour}/${effectiveLimitHourly} (reserved for P3+ callers, you are P${priority})`,
      limits: LIMITS,
      priority,
    };
  }

  // Check daily window
  // P4 callers (RFQ loading) are EXEMPT from daily limit - customer-facing, always allowed
  // Other callers still subject to hard cap to prevent runaway automation
  if (priority < 4 && counts.lastDay + count > LIMITS.maxWritesPerDay) {
    return {
      allowed: false,
      reason: `Global daily limit: ${counts.lastDay}/${LIMITS.maxWritesPerDay} already used (P4 exempt, you are P${priority})`,
      limits: LIMITS,
      priority,
    };
  }

  // Check per-table limit (no priority - prevents one table from dominating)
  if (table && LIMITS.perTable[table]) {
    const tableCount = counts.perTable[table] || 0;
    const tableLimit = LIMITS.perTable[table].maxPerHour;
    if (tableCount + count > tableLimit) {
      return {
        allowed: false,
        reason: `Table ${table} hourly limit: ${tableCount}/${tableLimit} already used`,
        limits: LIMITS,
        priority,
      };
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
};
