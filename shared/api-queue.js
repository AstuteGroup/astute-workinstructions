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
 * WORKER:        ~/workspace/scripts/process-api-queue.js (cron: */30 * * * *)
 * GREETING:      Bucket A items do NOT surface in the SessionStart greeting
 *                routinely — they run autonomously via cron. Only surface
 *                in greeting if cron is missing the entry, log shows
 *                failures, or queue has unattended exhausted items.
 *
 * SCHEDULING (corrected 2026-04-08):
 *   Worker runs via cron every 30 min. Verify with `crontab -l` — should
 *   include the line:
 *     */30 * * * * /usr/bin/node "/home/analytics_user/workspace/scripts/process-api-queue.js" >> /tmp/api-queue-worker.log 2>&1
 *
 *   Earlier docstrings claimed cron was blocked by rbash and that the
 *   Claude `schedule` skill was the autonomous path. Both wrong:
 *     - Cron works fine here (proven by existing vortex-poller, lam-kitting-runner,
 *       inventory-cleanup cron jobs in the same crontab).
 *     - The Claude `schedule` skill creates REMOTE agents in Anthropic's
 *       cloud that have no access to local files — useless for driving a
 *       local worker that reads/writes a local JSON queue.
 *
 *   On exhausted items the worker emails the operator (jake.harris@... by
 *   default, override via OPERATOR_EMAIL env var). On successful retries
 *   it cascades — other pending items with the same `kind` get fast-tracked
 *   so they're picked up on the next run instead of waiting out their full
 *   blocked_until window.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO WIRE A NEW DISTRIBUTOR MODULE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Each franchise distributor module under
 *   `Trading Analysis/RFQ Sourcing/franchise_check/{name}.js`
 * should detect its own rate-limit / quota / transient errors and call
 * enqueueRetry() so the failed call can be retried later. Two patterns
 * exist depending on how the API signals failure:
 *
 * PATTERN 1 — explicit HTTP status (most APIs)
 * Examples already wired: digikey.js (429 + 5xx), mouser.js (Rate limited
 * + 5xx string detection)
 *
 *   const path = require('path');
 *   let _enqueueRetry = null;
 *   function enqueueRetrySafe(opts) {
 *     try {
 *       if (!_enqueueRetry) {
 *         _enqueueRetry = require(path.resolve(__dirname, '../../../shared/api-queue')).enqueueRetry;
 *       }
 *       return _enqueueRetry(opts);
 *     } catch (e) { return false; }
 *   }
 *
 *   // Inside searchPart's HTTP response handler:
 *   if (res.statusCode === 429) {
 *     enqueueRetrySafe({
 *       id: '<distributor>-' + mpn + '-' + Date.now(),
 *       kind: 'api-retry-<distributor>',
 *       command: `node -e "require('${__dirname}/<distributor>').searchPart('${mpn.replace(/'/g, "\\\\'")}', ${rfqQty}).then(r => console.log('OK', r.found)).catch(e => { console.error(e.message); process.exit(1); })"`,
 *       blocked_until_hours: 1,  // adjust per the API's typical reset window
 *       reason: `<Distributor> 429 rate limit on ${mpn}`,
 *     });
 *     reject(new Error('<Distributor> rate limit (429) — enqueued for retry'));
 *     return;
 *   }
 *
 * PATTERN 2 — silent failure (200 OK with empty results, no error)
 * Some APIs (DigiKey OAuth/quota issue) return HTTP 200 with empty
 * Products[] when throttled. Indistinguishable from a legit empty result
 * on a single call. Detection requires session-wide context. See
 * digikey.js `checkForSilentThrottle` + `runSentinel` for the reference
 * implementation:
 *
 *   1. Track total calls + empty results in module-level state
 *   2. When threshold hit (>=5 calls AND >50% empty), run ONE sentinel
 *      call against a known-good MPN to verify
 *   3. If sentinel returns results → false alarm, mark session healthy
 *   4. If sentinel ALSO returns empty → confirmed throttle, enqueue +
 *      mark session throttled (subsequent empties auto-enqueue without
 *      re-running sentinel)
 *   5. Sentinel cooldown (5 min) prevents thrashing
 *
 * Use Pattern 2 only when the API actually exhibits silent throttling.
 * Most APIs return 429 cleanly and Pattern 1 is sufficient.
 *
 * STATUS — wiring coverage as of 2026-04-08:
 *   ✅ digikey.js — Pattern 1 (429/5xx) + Pattern 2 (silent throttle B+C)
 *   ✅ mouser.js  — Pattern 1 (Rate limited / 5xx detected via thrown error)
 *   ⏳ master.js, future.js, newark.js, tti.js, sager.js, waldom.js,
 *      arrow.js, rutronik.js, oemsecrets.js — not yet wired. Operator
 *      adds Pattern 1 wiring as needed; document in `~/workspace/deferred-work.md`
 *      if a particular distributor's rate limit becomes painful.
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
