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
 * WORKER:        ~/workspace/scripts/process-api-queue.js (cron: every 30 min)
 * GREETING:      Bucket A items do NOT surface in the SessionStart greeting
 *                routinely — they run autonomously via cron. Only surface
 *                in greeting if cron is missing the entry, log shows
 *                failures, or queue has unattended exhausted items.
 *
 * SCHEDULING (corrected 2026-04-08):
 *   Worker runs via cron every 30 min. Verify with `crontab -l` — the entry
 *   uses minute "every 30" (the cron syntax cannot be reproduced inline here
 *   because the slash-asterisk pair would terminate this JSDoc block comment;
 *   that exact bug silently broke this file's parse from creation through
 *   2026-05-06, hiding all enqueue calls behind the lazy-require try/catch
 *   in every cog. Fixed 2026-05-06 by paraphrasing).
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
const LOCK_PATH = QUEUE_PATH + '.lock';

// ─── Concurrency-safe queue I/O ─────────────────────────────────────────────
//
// The queue file is a single ~10MB JSON blob written by multiple processes:
// enrich-poller, vortex-poller, stockrfq-agent, the lam-kitting cron, and the
// worker (process-api-queue.js) itself. Two races we have to defend against:
//
//   1. Writer-writer — two enqueueRetry calls race on read-modify-write and
//      one writer's update is lost. Lost = a failed API call never gets
//      retried. Hard to detect after the fact.
//
//   2. Writer-reader — a reader catches a writer mid-fs.writeFileSync on the
//      10MB blob. fs.writeFileSync is NOT atomic for files > PIPE_BUF (4KB)
//      so this is the everyday case. Symptom: SyntaxError 'Unterminated
//      string in JSON at position ...'. Observed twice this session.
//
// Fix:
//   - acquireQueueLock / releaseQueueLock — advisory file lock at QUEUE_PATH.lock
//     using O_EXCL semantics. 30s stale-after for crashed lock holders. Same
//     pattern as shared/api-throttle.js's state-file lock.
//   - readQueueSafe — read with retry-on-parse-fail (50ms × 10). Defends
//     against torn reads even when the writer isn't using atomic-rename yet.
//   - writeQueueAtomic — write to tmpfile + fs.renameSync. POSIX rename is
//     atomic within a filesystem. Readers see either the OLD or NEW full
//     file, never a partial.
//   - withQueueLock(fn) — convenience wrapper for the read-modify-write
//     pattern. Acquires lock, runs fn, releases lock on any exit path.
//
// Throughput note: measured 2026-05-13 on a 12.5MB / 18k-item queue file:
//   readFileSync       ~2.0s
//   JSON.parse         ~2.5s
//   JSON.stringify     ~2.8s
//   writeFileSync      ~1.5s
//   full enqueueRetry  ~3.4s end-to-end
// At this scale the single-JSON-file design is the bottleneck. The lock
// budget below covers ~9 concurrent writers (30s / 3.4s); higher concurrency
// will surface as enqueueRetry returning false with a "failed to acquire
// queue lock" message. Long-term fix is to migrate to SQLite or per-item
// files — tracked as a separate concern in MEMORY.

function acquireQueueLock() {
  // 30s budget — large enough to absorb realistic contention given a 3.4s
  // critical section per writer (see throughput note above). Stale-after
  // remains 60s so a truly crashed lock-holder doesn't pin everyone.
  for (let i = 0; i < 1200; i++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      // Stale-lock detection — if the lock is older than 60s, force-take.
      // Crashed lock-holders shouldn't block the world. Bumped from 30s to
      // 60s so a slow-but-legitimate writer isn't force-evicted mid-write.
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 60 * 1000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch { /* lock just got released — retry */ }
      // Spin-sleep ~25ms then retry. 1200 retries × ~25ms = ~30s max wait.
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}

function releaseQueueLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* already released — fine */ }
}

function readQueueSafe() {
  // Retry-on-parse-fail. With writeQueueAtomic in place these retries should
  // be rare, but readers in the wild (digests, monitoring) might still race
  // a writer that hasn't been refactored yet. Defensive.
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      if (!fs.existsSync(QUEUE_PATH)) return { items: [] };
      return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
    } catch (err) {
      lastErr = err;
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastErr;
}

function writeQueueAtomic(queue) {
  // Tmpfile in same directory so rename is atomic (cross-fs rename is not).
  // pid + ms timestamp + random — collision-safe even if multiple writers
  // somehow skip the lock.
  const tmp = `${QUEUE_PATH}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, QUEUE_PATH);
}

function withQueueLock(fn) {
  if (!acquireQueueLock()) {
    throw new Error('[api-queue] failed to acquire queue lock after ~2s — another process holds it. Check for stale holder if persistent.');
  }
  try {
    return fn();
  } finally {
    releaseQueueLock();
  }
}

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
 * @param {string} [opts.priority='P2'] - 'P1' | 'P2' | 'P3' — dispatch priority
 *   captured at enqueue. P1 = small RFQ / user-waiting express, P2 = main
 *   immediate, P3 = backlog drain. process-api-queue.js sorts ready items
 *   P1 → P2 → P3 each tick. Default P2 keeps legacy callers in the middle tier.
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

  // Read-modify-write under advisory lock. Without this, two concurrent
  // enqueueRetry calls would clobber each other's update (last-writer-wins
  // on the full 10MB file).
  try {
    return withQueueLock(() => {
      let queue;
      try { queue = readQueueSafe(); } catch (err) {
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
        priority: opts.priority || 'P2',
        last_attempt: null,
        last_error: null,
      });

      try {
        writeQueueAtomic(queue);
        return true;
      } catch (err) {
        console.error(`[api-queue] Failed to write queue: ${err.message}`);
        return false;
      }
    });
  } catch (err) {
    // Lock acquisition failure — log and treat as enqueue failure. The caller
    // sees `false` and decides whether to retry / log / give up. Surfacing
    // here lets us spot a stuck lock-holder via the failure trace.
    console.error(`[api-queue] enqueueRetry: ${err.message}`);
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

// ─── CANCELLATION MANIFESTS ─────────────────────────────────────────────────
//
// When an RFQ (or any other gated record) is rejected or marked inactive, any
// items already in the retry queue for that record's MPNs must stop —
// otherwise they keep grinding through 5 attempts of rate-limited API calls
// for work the operator already said no to. (Real incident: RFQ 1134261
// rejected 2026-05-13, 14,783 in-flight items kept retrying through 2026-05-14.)
//
// The mechanism: a rejection writes a JSON manifest next to the gate sentinel
// listing the MPNs that should be cancelled. The worker (process-api-queue.js)
// reads all manifests at the top of each tick and flips matching pending items
// to status='cancelled' before processing.
//
// Manifest format ({sentinelDir}/{id}.cancel-mpns.json):
//   {
//     "id": "1134261",
//     "kind": "rfq",
//     "reason": "rejected via large-rfq-gate 5/13",
//     "written_at": "ISO8601",
//     "mpns_normalized": ["TKC1350TL40", "GLCBXU60", ...]
//   }
//
// MPNs in the manifest are already normalized (uppercase + alphanumeric only)
// — same normalization applied to queue MPNs at match time. Caller is
// responsible for normalization before writing.

const DEFAULT_MANIFEST_DIRS = [
  path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.large-rfq-pending'),
];

/**
 * Normalize an MPN for cancel-manifest matching. Strict — uppercase + strip
 * anything that isn't A-Z 0-9. Same form on both manifest write and queue
 * match so a "BCM857BS,235" in the queue and "BCM857BS235" in the manifest
 * match cleanly.
 */
function normalizeMpnForCancel(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Decode the MPN from a queue item's `command` field. Items are enqueued
 * with `command = "API_RETRY_IN_FLIGHT=1 API_RETRY_ARGS_B64=<b64-json> node ..."`
 * where the b64-json carries `{ distributor, mpn, qty }`. Returns null on
 * decode failure / missing MPN.
 */
function decodeItemMpn(item) {
  if (!item || !item.command) return null;
  const m = item.command.match(/API_RETRY_ARGS_B64=(\S+)/);
  if (!m) return null;
  try {
    const args = JSON.parse(Buffer.from(m[1], 'base64').toString('utf-8'));
    return args && args.mpn ? normalizeMpnForCancel(args.mpn) : null;
  } catch { return null; }
}

/**
 * Read every cancel manifest under the configured directories. Returns a
 * Map<normalizedMpn, reasonLabel> — when two manifests share an MPN the
 * later-read one wins (we don't try to merge reasons; first-cause is fine).
 *
 * Failure modes:
 *   - Dir missing → skip (no manifests yet)
 *   - File unparseable → log + skip THAT file, never throw
 *   - mpns_normalized missing/not-array → skip THAT file
 *
 * The worker calls this once per tick and applies the result before
 * processing.
 */
function loadCancelManifests({ dirs } = {}) {
  const scanDirs = Array.isArray(dirs) && dirs.length ? dirs : DEFAULT_MANIFEST_DIRS;
  const mpnReasons = new Map();
  const sources = [];
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.cancel-mpns.json')) continue;
      const filePath = path.join(dir, f);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch (err) {
        console.error(`[api-queue] cancel manifest unreadable: ${filePath} — ${err.message}`);
        continue;
      }
      if (!Array.isArray(manifest.mpns_normalized)) continue;
      const reason = `${manifest.kind || 'gate'} ${manifest.id || f}: ${manifest.reason || 'rejected'}`;
      sources.push({ file: filePath, id: manifest.id, count: manifest.mpns_normalized.length });
      for (const mpn of manifest.mpns_normalized) {
        const n = normalizeMpnForCancel(mpn);
        if (!n) continue;
        if (!mpnReasons.has(n)) mpnReasons.set(n, reason);
      }
    }
  }
  return { mpnsToCancel: mpnReasons, sources };
}

/**
 * Walk queue.items and flip status='cancelled' on any pending item whose
 * decoded MPN appears in mpnsToCancel. Mutates queue.items in place.
 *
 * Items in other statuses (success / exhausted / cancelled) are left alone.
 * Idempotent — re-running with the same manifest is a no-op.
 *
 * Returns { cancelled, perReason: Map<reason, count> }.
 */
function applyCancelManifests(queue, mpnsToCancel) {
  if (!queue || !Array.isArray(queue.items) || !mpnsToCancel || mpnsToCancel.size === 0) {
    return { cancelled: 0, perReason: new Map() };
  }
  const perReason = new Map();
  let cancelled = 0;
  const nowIso = new Date().toISOString();
  for (const item of queue.items) {
    if (item.status !== 'pending') continue;
    const mpn = decodeItemMpn(item);
    if (!mpn) continue;
    const reason = mpnsToCancel.get(mpn);
    if (!reason) continue;
    item.status = 'cancelled';
    item.last_attempt = nowIso;
    item.last_error = `cancelled: ${reason}`;
    cancelled++;
    perReason.set(reason, (perReason.get(reason) || 0) + 1);
  }
  return { cancelled, perReason };
}

module.exports = {
  enqueueRetry,
  listQueue,
  QUEUE_PATH,
  // Concurrency-safe queue I/O — for callers that need their own
  // read-modify-write under the same advisory lock (e.g., the worker's
  // saveQueue, manage-queue CLIs, ad-hoc maintenance scripts).
  withQueueLock,
  readQueueSafe,
  writeQueueAtomic,
  // Cancellation manifests — for rejection / inactive handlers and the
  // worker's per-tick cancel pass.
  normalizeMpnForCancel,
  decodeItemMpn,
  loadCancelManifests,
  applyCancelManifests,
  DEFAULT_MANIFEST_DIRS,
};
