/**
 * API Retry Queue Helper — Bucket A enqueue API
 *
 * Lets distributor modules / writers push failed API calls into the
 * deferred retry queue when they hit rate limits / quotas / transient
 * errors. The worker at ~/workspace/scripts/process-api-queue.js picks
 * them up on its next scheduled run and retries when blocked_until
 * has passed.
 *
 * USAGE:
 *
 *   const { enqueueRetry } = require('../shared/api-queue');
 *
 *   try {
 *     const result = await someApiCall();
 *     return result;
 *   } catch (err) {
 *     if (err.statusCode === 429 || err.message.includes('rate limit')) {
 *       enqueueRetry({
 *         id: 'digikey-' + mpn + '-' + Date.now(),
 *         command: 'node -e "..."',  // command to re-run later
 *         blocked_until_hours: 24,    // retry tomorrow
 *         reason: 'DigiKey 429 rate limit on ' + mpn,
 *       });
 *     }
 *     throw err;
 *   }
 *
 * The enqueue is fire-and-forget — failures to write the queue file are
 * logged but never thrown. The original API failure should still propagate
 * to the caller so they can decide how to handle it (skip the row, return
 * cached data, etc.).
 *
 * QUEUE LOCATION: ~/workspace/.deferred-api-queue.json
 * WORKER:        ~/workspace/scripts/process-api-queue.js
 * GREETING:      Bucket A items do NOT surface in the SessionStart greeting —
 *                they run autonomously. The greeting only mentions Bucket A
 *                if the worker is broken or has stale exhausted items.
 */

const fs = require('fs');
const path = require('path');

const QUEUE_PATH = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.deferred-api-queue.json');

/**
 * Append a new retry item to the queue file. Idempotent on `id` — if an
 * item with the same id already exists, no-op (caller's retry will be
 * picked up by the existing entry).
 *
 * @param {object} opts
 * @param {string} opts.id - Unique identifier for the retry item
 * @param {string} opts.command - Shell command to run when ready
 * @param {string} [opts.kind='api-retry'] - Category tag (kind of work)
 * @param {string} [opts.blocked_until] - ISO8601 timestamp when item becomes ready
 * @param {number} [opts.blocked_until_hours] - Convenience: hours from now (alternative to blocked_until)
 * @param {string} [opts.reason] - Human-readable why-blocked
 * @param {number} [opts.max_attempts=5] - Max retry attempts before exhaustion
 * @returns {boolean} true if added, false if already exists or write failed
 */
function enqueueRetry(opts) {
  if (!opts || !opts.id || !opts.command) {
    console.error('[api-queue] enqueueRetry: missing required id or command');
    return false;
  }

  let blockedUntil = opts.blocked_until;
  if (!blockedUntil && Number.isFinite(opts.blocked_until_hours)) {
    const ms = Date.now() + (opts.blocked_until_hours * 60 * 60 * 1000);
    blockedUntil = new Date(ms).toISOString();
  }
  if (!blockedUntil) {
    // Default: retry in 1 hour
    blockedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }

  let queue;
  try {
    if (fs.existsSync(QUEUE_PATH)) {
      queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
    } else {
      queue = { items: [] };
    }
  } catch (err) {
    console.error(`[api-queue] Failed to read queue: ${err.message}`);
    return false;
  }

  if (!Array.isArray(queue.items)) queue.items = [];

  // Idempotent on id — don't double-enqueue
  if (queue.items.some(i => i.id === opts.id)) {
    return false;
  }

  queue.items.push({
    id: opts.id,
    kind: opts.kind || 'api-retry',
    command: opts.command,
    blocked_until: blockedUntil,
    reason: opts.reason || 'unspecified',
    created: new Date().toISOString(),
    attempts: 0,
    max_attempts: opts.max_attempts || 5,
    status: 'pending',
    last_attempt: null,
    last_error: null,
  });

  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n', 'utf-8');
    return true;
  } catch (err) {
    console.error(`[api-queue] Failed to write queue: ${err.message}`);
    return false;
  }
}

/**
 * List queue items, optionally filtered by status.
 * @param {object} [opts]
 * @param {string} [opts.status] - Filter by status: 'pending' | 'success' | 'exhausted'
 * @returns {Array<object>} Matching items (empty array if queue file missing)
 */
function listQueue(opts = {}) {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
    if (!Array.isArray(queue.items)) return [];
    if (opts.status) return queue.items.filter(i => i.status === opts.status);
    return queue.items;
  } catch (err) {
    return [];
  }
}

module.exports = {
  enqueueRetry,
  listQueue,
  QUEUE_PATH,
};
