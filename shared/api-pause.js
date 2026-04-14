/**
 * API Pause — cross-process coordination for enricher vs foreground workflows
 *
 * The enrich-poller cron runs opportunistic background API enrichment. When a
 * user-initiated (foreground) workflow runs, it should be able to yield the
 * enricher so its own calls don't compete for DigiKey quota, iDempiere
 * connection pool, etc.
 *
 * This module provides a file-based lock (pause file) that:
 *   - Foreground workflows call `claimPause()` before they start
 *   - The enricher calls `isPaused()` at every MPN boundary
 *   - If paused, the enricher sleeps briefly and re-checks
 *   - Long-running foreground workflows call `refreshPause()` periodically
 *   - Short/small foreground workflows call `releasePause()` on exit
 *   - TTL ensures a crashed foreground process doesn't block the enricher forever
 *
 * SIZE-BASED RULE:
 *   Foreground workflows with >= PAUSE_SIZE_THRESHOLD MPNs should NOT pause.
 *   Large batches run alongside the enricher — cache hits dedupe most work,
 *   and deferring indefinitely would break workflow SLAs (e.g., LAM Kitting
 *   Reorder can't wait 2 days for a Honeywell backlog to finish).
 *
 *   Use `shouldPause(sizeMpns)` to check before calling `claimPause()`.
 *
 * USAGE (foreground workflow):
 *   const pause = require('../shared/api-pause');
 *
 *   if (pause.shouldPause(lineCount)) {
 *     pause.claimPause('lam-kitting-source', lineCount);
 *     // optionally, for long-running jobs:
 *     const refreshInterval = setInterval(() => pause.refreshPause(), 5 * 60 * 1000);
 *     try {
 *       await doWork();
 *     } finally {
 *       clearInterval(refreshInterval);
 *       pause.releasePause();
 *     }
 *   } else {
 *     // Large batch — run alongside, don't pause
 *     await doWork();
 *   }
 *
 * USAGE (enricher):
 *   while (moreWork) {
 *     await pause.waitIfPaused();  // sleeps 30s+ if active
 *     await processOneMpn();
 *   }
 */

const fs = require('fs');
const path = require('path');

const PAUSE_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.api-pause');

// Size threshold: small (< this) = pause eligible; large (>=) = run alongside
const PAUSE_SIZE_THRESHOLD = 100;

// TTL for a pause claim: how long until the claim is considered stale
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// How often the enricher polls the pause file while sleeping
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Should a foreground workflow of this size claim the pause? Returns false
 * for large batches (they run alongside) and true for small ones.
 *
 * @param {number} sizeMpns - Number of MPNs in the foreground batch
 * @returns {boolean}
 */
function shouldPause(sizeMpns) {
  return sizeMpns > 0 && sizeMpns < PAUSE_SIZE_THRESHOLD;
}

/**
 * Write the pause file. Called by foreground workflows before starting work.
 *
 * @param {string} owner - Identifier for the workflow (e.g., 'lam-kitting-source')
 * @param {number} sizeMpns - Number of MPNs in the batch (for reporting)
 * @param {number} [ttlMs=DEFAULT_TTL_MS] - TTL in milliseconds
 * @returns {object} The pause record
 */
function claimPause(owner, sizeMpns, ttlMs = DEFAULT_TTL_MS) {
  if (!owner) throw new Error('api-pause: owner is required');
  const now = Date.now();
  const record = {
    owner: String(owner),
    size: Number(sizeMpns) || 0,
    createdAt: new Date(now).toISOString(),
    until: new Date(now + ttlMs).toISOString(),
  };
  fs.writeFileSync(PAUSE_FILE, JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

/**
 * Refresh the TTL on an existing pause. Called periodically by long-running
 * foreground workflows so the pause doesn't expire mid-run.
 *
 * @param {number} [ttlMs=DEFAULT_TTL_MS] - New TTL from now
 * @returns {object|null} Updated record, or null if no active pause
 */
function refreshPause(ttlMs = DEFAULT_TTL_MS) {
  const current = readPause();
  if (!current) return null;
  current.until = new Date(Date.now() + ttlMs).toISOString();
  fs.writeFileSync(PAUSE_FILE, JSON.stringify(current, null, 2), 'utf-8');
  return current;
}

/**
 * Remove the pause file. Called by foreground workflows on exit.
 * No-op if file doesn't exist.
 */
function releasePause() {
  try {
    fs.unlinkSync(PAUSE_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/**
 * Read the pause file, or null if none/stale.
 * @returns {object|null}
 */
function readPause() {
  try {
    const raw = fs.readFileSync(PAUSE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Is there an active (non-expired) pause?
 * @returns {object|false} Active record, or false
 */
function isPaused() {
  const rec = readPause();
  if (!rec) return false;
  if (!rec.until) return false;
  const until = new Date(rec.until).getTime();
  if (isNaN(until)) return false;
  if (until <= Date.now()) return false; // expired
  return rec;
}

/**
 * Block until the pause is released (or expired). Used by the enricher at
 * MPN boundaries. Logs activity via optional logger callback.
 *
 * @param {object} [opts]
 * @param {Function} [opts.log] - Logger function (called on sleep + wake)
 * @param {number} [opts.maxWaitMs] - Max total wait (safety cap). Default 30 min.
 * @returns {Promise<boolean>} true if we waited, false if not paused
 */
async function waitIfPaused(opts = {}) {
  const { log = null, maxWaitMs = 30 * 60 * 1000 } = opts;
  const active = isPaused();
  if (!active) return false;

  const startWait = Date.now();
  if (log) log(`Paused by '${active.owner}' (size ${active.size}, until ${active.until}) — yielding`);

  while (true) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const stillPaused = isPaused();
    if (!stillPaused) {
      if (log) log(`Pause released (was owned by '${active.owner}') — resuming`);
      return true;
    }
    if (Date.now() - startWait > maxWaitMs) {
      if (log) log(`Pause wait exceeded ${maxWaitMs / 1000}s — force-resuming (stale pause by '${stillPaused.owner}')`);
      return true;
    }
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  shouldPause,
  claimPause,
  refreshPause,
  releasePause,
  isPaused,
  readPause,
  waitIfPaused,
  PAUSE_FILE,
  PAUSE_SIZE_THRESHOLD,
  DEFAULT_TTL_MS,
};
