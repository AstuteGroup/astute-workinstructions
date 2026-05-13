#!/usr/bin/env node
/**
 * Deferred API Retry Worker — Bucket A
 *
 * Reads ~/workspace/.deferred-api-queue.json, finds entries that are:
 *   - status === 'pending'
 *   - blocked_until <= now
 *   - attempts < max_attempts
 *
 * Runs each item's command (a shell command line). On exit code 0 → mark
 * success. On non-zero → increment attempts, record error, leave pending
 * for the next run unless attempts >= max_attempts (then mark exhausted).
 *
 * RUN MODE: cron, every 30 minutes (installed 2026-04-08).
 *
 *   every-30-min cron: see crontab -l for the exact entry
 *
 * Verify with `crontab -l`. Manual on-demand runs are also fine — the
 * worker is idempotent and stateless (state lives in the JSON file only).
 *
 * Why cron and not the Claude `schedule` skill: the schedule skill creates
 * REMOTE agents in Anthropic's cloud that have no access to local files.
 * Cron runs locally as analytics_user and can read/write the queue file
 * directly. (An earlier version of this docstring claimed cron was blocked
 * by rbash — that was wrong. Cron works fine here, as evidenced by the
 * existing vortex-poller, lam-kitting-runner, and inventory-cleanup
 * cron jobs in the same crontab.)
 *
 * On exhausted items the worker emails the operator (see notifyExhausted
 * below). On successful retries it cascades — other pending items with
 * the same `kind` get fast-tracked so they're picked up on the next run
 * instead of waiting out their full blocked_until window.
 *
 * Idempotent — safe to run repeatedly. Stateful via the JSON file only.
 *
 * USAGE:
 *
 *   # One-off (interactive)
 *   node ~/workspace/astute-workinstructions/scripts/process-api-queue.js
 *
 *   # Scheduled trigger (via the `schedule` skill or any cron-equivalent)
 *   node ~/workspace/astute-workinstructions/scripts/process-api-queue.js
 *
 *   # Dry-run (show what would run, don't execute)
 *   node ~/workspace/astute-workinstructions/scripts/process-api-queue.js --dry-run
 *
 *   # Reset a specific item back to pending (e.g., after fixing the underlying issue)
 *   node ~/workspace/astute-workinstructions/scripts/process-api-queue.js --reset <id>
 *
 * EXIT CODES:
 *   0 — completed normally (zero or more items processed)
 *   1 — fatal error (queue file unreadable, invalid JSON, etc.)
 *
 * STATUS LIFECYCLE:
 *   pending  → success     (command exited 0)
 *   pending  → pending     (command exited non-zero, attempts < max)
 *   pending  → exhausted   (command exited non-zero, attempts >= max)
 *
 * Items in success or exhausted state are NEVER re-run. Operator can
 * delete them from the queue file or use --reset to retry.
 *
 * QUEUE FILE FORMAT:
 *
 *   {
 *     "items": [
 *       {
 *         "id": "unique-string",
 *         "kind": "smoke-test" | "verify" | "ad-hoc" | etc,
 *         "command": "shell command line",
 *         "blocked_until": "ISO8601 timestamp",
 *         "reason": "human-readable why-blocked",
 *         "created": "ISO8601",
 *         "attempts": 0,
 *         "max_attempts": 5,
 *         "status": "pending" | "success" | "exhausted",
 *         "last_attempt": "ISO8601 | null",
 *         "last_error": "string | null"
 *       },
 *       ...
 *     ]
 *   }
 *
 * The `_format` and `_added_by` keys at the top level are documentation
 * comments — preserved across writes.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const QUEUE_PATH = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.deferred-api-queue.json');
const LOG_PATH = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.deferred-api-queue.log');

// Optional dependency on the retry-policy classifier. If present, retries
// inherit the policy's per-category backoff (e.g., MaxCallPerDay → next
// midnight Chicago). If absent, we fall back to the legacy exponential.
let classify = null;
let hoursUntilNextChicagoMidnight = null;
try {
  const policy = require(path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/astute-workinstructions/shared/api-retry-policy'));
  classify = policy.classify;
  hoursUntilNextChicagoMidnight = policy.hoursUntilNextChicagoMidnight;
} catch { /* policy module not available — retries fall back to exponential */ }

// Concurrency-safe queue I/O helpers from shared/api-queue. If available, the
// worker uses them so its loadQueue / saveQueue cooperate with enqueueRetry
// calls from other processes (enrich-poller, vortex-poller, etc.). Without
// these, the worker's bulk-rewrite at end-of-tick CLOBBERS any enqueueRetry
// writes that happened during the tick — losing newly-enqueued items.
let queueIO = null;
try {
  queueIO = require(path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/astute-workinstructions/shared/api-queue'));
} catch { /* helpers not available — fall back to direct fs.writeFileSync */ }

// After this many same-cog MaxCallPerDay errors within a tick (cumulative,
// not necessarily consecutive — robust if priority sort interleaves items
// across cogs), bail on remaining items for that cog and push their
// blocked_until to the reset window so other ticks don't re-burn.
// Threshold of 3 absorbs the occasional false signal but reacts quickly to
// a genuinely exhausted quota.
const QUOTA_BAIL_THRESHOLD = 3;
const DAILY_QUOTA_PATTERN = /MaxCallPerDay|daily quota/i;

// Per-tick caps so one tick can't hog the cron schedule. Tunable via env.
// Default 500 items / 15-min wall-clock — comfortable under a 30-min cadence
// even at the worst-case ~2s/item (the surveyed 3.4s figure includes the
// queue file I/O, which is no longer in the hot path per-item).
const MAX_ITEMS_PER_TICK = Number(process.env.API_QUEUE_MAX_ITEMS) || 500;
const MAX_WALL_CLOCK_MS = (Number(process.env.API_QUEUE_MAX_WALL_MIN) || 15) * 60 * 1000;

const now = () => new Date().toISOString();

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, reset: null, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--reset') opts.reset = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
  }
  return opts;
}

// ─── QUEUE I/O ───────────────────────────────────────────────────────────────

function loadQueue() {
  // Use readQueueSafe when available — retry-on-parse-fail handles transient
  // torn reads from concurrent writers without a queue lock on the reader side.
  if (queueIO?.readQueueSafe) {
    try { return queueIO.readQueueSafe(); }
    catch (e) {
      console.error(`Failed to parse queue file: ${e.message}`);
      return null;
    }
  }
  if (!fs.existsSync(QUEUE_PATH)) {
    console.error(`Queue file not found: ${QUEUE_PATH}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
  } catch (e) {
    console.error(`Failed to parse queue file: ${e.message}`);
    return null;
  }
}

function saveQueue(workerQueue) {
  // Merge-on-write under the shared queue lock:
  //   - Re-read DISK state at write time (other processes may have enqueued
  //     new items via enqueueRetry during this tick).
  //   - For each disk item: if the worker has a same-id version in memory,
  //     publish the worker's version (attempts++, blocked_until, status).
  //     Otherwise keep the disk version (it's a newly-added item from another
  //     process — must not be clobbered).
  //   - Atomic rename to publish.
  if (queueIO?.withQueueLock && queueIO?.readQueueSafe && queueIO?.writeQueueAtomic) {
    try {
      queueIO.withQueueLock(() => {
        const disk = queueIO.readQueueSafe();
        if (!Array.isArray(disk.items)) disk.items = [];
        const workerById = new Map(workerQueue.items.map(i => [i.id, i]));
        const seenIds = new Set();
        const merged = { ...disk };
        merged.items = disk.items.map(diskItem => {
          seenIds.add(diskItem.id);
          return workerById.has(diskItem.id) ? workerById.get(diskItem.id) : diskItem;
        });
        // Items the worker has that aren't on disk — defensive: shouldn't happen
        // (worker started by reading disk), but cover the edge case anyway.
        for (const wItem of workerQueue.items) {
          if (!seenIds.has(wItem.id)) merged.items.push(wItem);
        }
        queueIO.writeQueueAtomic(merged);
      });
      return;
    } catch (e) {
      console.error(`saveQueue: merge-on-write failed (${e.message}) — falling back to direct write`);
      // Fall through to the direct write — better to publish stale-merge than
      // to lose this tick's progress entirely.
    }
  }
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(workerQueue, null, 2) + '\n', 'utf-8');
}

function appendLog(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${now()} ${line}\n`, 'utf-8');
  } catch (e) {
    // Best effort — don't crash the worker on log failure
  }
}

// ─── EMAIL NOTIFICATION ──────────────────────────────────────────────────────
//
// When the worker runs unattended (cron) the operator only learns about
// failures if we email them. Send ONE email per run summarizing all
// exhausted items — never per-item, that would be unbearable.
//
// Uses the shared notifier (which loads ~/workspace/.env via dotenv).
// Falls back to log-only if the notifier or its credentials are missing
// (e.g., running outside the normal environment).

const NOTIFY_RECIPIENT = process.env.OPERATOR_EMAIL || 'jake.harris@Astutegroup.com';

async function notifyExhausted(exhaustedItems) {
  let createNotifier;
  try {
    ({ createNotifier } = require(path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/astute-workinstructions/shared/notifier')));
  } catch (e) {
    console.error('[notify] notifier module not available:', e.message);
    appendLog(`NOTIFY-SKIP no notifier: ${exhaustedItems.length} exhausted items`);
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'API Retry Queue Worker',
  });

  const subject = `[API Queue] ${exhaustedItems.length} exhausted item${exhaustedItems.length === 1 ? '' : 's'} need attention`;
  const lines = [
    'The deferred API retry queue worker has marked the following items as exhausted',
    '(reached max_attempts without succeeding).',
    '',
    'Each item has been retried multiple times and is no longer being processed.',
    'Investigate the underlying cause; once fixed you can reset items via:',
    '',
    '  node ~/workspace/astute-workinstructions/scripts/process-api-queue.js --reset <item-id>',
    '',
    '─'.repeat(72),
    '',
  ];
  for (const item of exhaustedItems) {
    lines.push(`ID:       ${item.id}`);
    lines.push(`Kind:     ${item.kind || 'unknown'}`);
    lines.push(`Reason:   ${item.reason || 'unspecified'}`);
    lines.push(`Attempts: ${item.attempts}/${item.max_attempts || 5}`);
    lines.push(`Created:  ${item.created || 'unknown'}`);
    lines.push(`Last err: ${(item.last_error || 'none').substring(0, 240)}`);
    lines.push('');
  }
  lines.push('─'.repeat(72));
  lines.push('');
  lines.push(`Queue file: ${QUEUE_PATH}`);
  lines.push(`Worker log: ${LOG_PATH}`);
  lines.push('');
  lines.push('— deferred API retry queue worker (~/workspace/astute-workinstructions/scripts/process-api-queue.js)');

  const ok = await notifier.sendEmail(NOTIFY_RECIPIENT, subject, lines.join('\n'));
  if (ok) {
    console.log(`[notify] emailed ${NOTIFY_RECIPIENT}: ${exhaustedItems.length} exhausted items`);
    appendLog(`NOTIFY-OK ${exhaustedItems.length} exhausted items emailed to ${NOTIFY_RECIPIENT}`);
  } else {
    appendLog(`NOTIFY-FAIL email send returned false for ${exhaustedItems.length} items`);
  }
}

// ─── RUN ITEM ────────────────────────────────────────────────────────────────

function runItem(item) {
  const start = Date.now();
  try {
    const out = execSync(item.command, {
      cwd: path.resolve(process.env.HOME || '/home/analytics_user', 'workspace'),
      encoding: 'utf-8',
      timeout: 5 * 60 * 1000,  // 5 min hard timeout per item
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const elapsed = Date.now() - start;
    return { ok: true, output: out.toString().substring(0, 500), elapsedMs: elapsed };
  } catch (e) {
    const elapsed = Date.now() - start;
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    return {
      ok: false,
      error: (stderr || stdout || e.message || 'unknown error').substring(0, 500),
      elapsedMs: elapsed,
    };
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  if (opts.help) {
    const header = fs.readFileSync(__filename, 'utf-8').split('\n').slice(1, 50).join('\n');
    console.log(header);
    return 0;
  }

  const queue = loadQueue();
  if (!queue) return 1;
  if (!Array.isArray(queue.items)) {
    console.error('Queue file has no items array');
    return 1;
  }

  // --reset flag: flip a specific item back to pending
  if (opts.reset) {
    const item = queue.items.find(i => i.id === opts.reset);
    if (!item) {
      console.error(`No item with id: ${opts.reset}`);
      return 1;
    }
    item.status = 'pending';
    item.attempts = 0;
    item.last_error = null;
    item.last_attempt = null;
    saveQueue(queue);
    console.log(`Reset ${opts.reset} → pending`);
    return 0;
  }

  const nowMs = Date.now();
  const ready = queue.items.filter(i => {
    if (i.status !== 'pending') return false;
    const blockedUntilMs = new Date(i.blocked_until).getTime();
    if (Number.isFinite(blockedUntilMs) && blockedUntilMs > nowMs) return false;
    if (i.attempts >= (i.max_attempts || 5)) return false;
    return true;
  });

  // Sort ready items by dispatch priority (P1 < P2 < P3), FIFO within tier.
  // Items missing a priority field (legacy entries created before priority
  // capture was wired through franchise-api.js) default to P2 — middle tier.
  // Result: small / user-waiting RFQ retries process before P3 backlog drain,
  // and within a quota-constrained tick the quota-bail logic fires on
  // lower-priority items first because the higher-priority items got their
  // shot earlier in the iteration.
  ready.sort((a, b) => {
    const ap = a.priority || 'P2';
    const bp = b.priority || 'P2';
    if (ap !== bp) return ap.localeCompare(bp); // 'P1' < 'P2' < 'P3'
    const at = a.created ? new Date(a.created).getTime() : 0;
    const bt = b.created ? new Date(b.created).getTime() : 0;
    return at - bt;
  });

  const priorityCounts = ready.reduce((acc, i) => {
    const p = i.priority || 'P2';
    acc[p] = (acc[p] || 0) + 1;
    return acc;
  }, {});
  const pSummary = Object.keys(priorityCounts).sort().map(p => `${p}=${priorityCounts[p]}`).join(' ');
  console.log(`Queue: ${queue.items.length} total, ${ready.length} ready to run (priority: ${pSummary})`);
  if (ready.length === 0) {
    return 0;
  }

  // Track per-kind successes for cascading cleanup, and exhausted items for notification
  const cascadeTriggers = new Set();  // kinds that just had a successful retry
  const exhaustedThisRun = [];

  // Per-tick quota state. When a cog returns MaxCallPerDay (Mouser today; any
  // cog that adopts a daily-quota error message in the future) repeatedly,
  // continuing to call it just burns our attempts counter while still hitting
  // the quota wall. After QUOTA_BAIL_THRESHOLD same-cog daily-quota errors
  // (cumulative across the tick, not necessarily consecutive — robust against
  // priority-sort interleaving), bail: skip remaining same-cog items in this
  // tick AND push their blocked_until to the reset boundary so the next cron
  // tick doesn't re-burn the first N calls all over again.
  const cumulativeQuotaErrs = {};         // { mouser: 3 } — cumulative across tick
  const outForTickCogs = new Set();       // cogs that bailed this tick

  // Per-tick caps — see MAX_ITEMS_PER_TICK / MAX_WALL_CLOCK_MS at top of file.
  const tickStartedAt = Date.now();
  let processedThisTick = 0;
  let cappedReason = null;

  for (const item of ready) {
    // Per-tick caps — guarantee the tick finishes before the next cron cadence.
    if (processedThisTick >= MAX_ITEMS_PER_TICK) {
      cappedReason = `max items (${MAX_ITEMS_PER_TICK}) reached`;
      break;
    }
    if (Date.now() - tickStartedAt >= MAX_WALL_CLOCK_MS) {
      cappedReason = `max wall-clock (${Math.round(MAX_WALL_CLOCK_MS / 60000)}min) reached`;
      break;
    }

    const cog = (item.kind || '').replace(/^api-retry-/, '');

    // Quota short-circuit — leave the item completely untouched
    if (outForTickCogs.has(cog)) {
      continue;
    }

    console.log(`\n[${item.id}] running: ${item.command.substring(0, 100)}${item.command.length > 100 ? '...' : ''}`);
    if (opts.dryRun) {
      console.log('  (dry-run, skipping)');
      processedThisTick++; // dry-run still counts toward caps so testing reflects real behavior
      continue;
    }

    const result = runItem(item);
    item.attempts++;
    item.last_attempt = now();
    processedThisTick++;

    if (result.ok) {
      item.status = 'success';
      item.last_error = null;
      console.log(`  ✓ success (${result.elapsedMs}ms): ${result.output.substring(0, 200)}`);
      appendLog(`SUCCESS ${item.id} after ${item.attempts} attempts: ${result.output.substring(0, 200)}`);
      // Mark this kind as recovered so we cascade-cleanup other items below
      if (item.kind) cascadeTriggers.add(item.kind);
      // Cog is healthy this tick — reset its cumulative-quota counter so a
      // future error within the same tick has to clear the bar from scratch.
      cumulativeQuotaErrs[cog] = 0;
    } else {
      item.last_error = result.error;

      // Track cumulative daily-quota errors per cog for the short-circuit below.
      const isDailyQuota = DAILY_QUOTA_PATTERN.test(result.error || '');
      if (isDailyQuota) {
        cumulativeQuotaErrs[cog] = (cumulativeQuotaErrs[cog] || 0) + 1;
      }
      // Note: non-quota errors don't reset the cumulative counter. A 429
      // mixed in with MaxCallPerDay errors shouldn't make us forget the
      // quota signal — they both indicate cog-level distress on the cog.

      if (item.attempts >= (item.max_attempts || 5)) {
        item.status = 'exhausted';
        console.log(`  ✗ exhausted after ${item.attempts} attempts: ${result.error.substring(0, 200)}`);
        appendLog(`EXHAUSTED ${item.id}: ${result.error.substring(0, 200)}`);
        exhaustedThisRun.push(item);
      } else {
        // Consult the centralized retry policy on every retry, not just the
        // initial enqueue. Falls back to legacy exponential (1h → 2h → 4h →
        // 8h → 16h) if the policy module isn't loaded or returns UNKNOWN.
        let backoffHours;
        let backoffReason;
        if (classify) {
          const verdict = classify(result.error);
          if (verdict.category === 'UNKNOWN' || !Number.isFinite(verdict.blockedHours)) {
            backoffHours = Math.pow(2, item.attempts - 1);
            backoffReason = `exponential fallback (UNKNOWN category)`;
          } else {
            backoffHours = verdict.blockedHours;
            backoffReason = verdict.reason;
          }
        } else {
          backoffHours = Math.pow(2, item.attempts - 1);
          backoffReason = `exponential fallback (policy module unavailable)`;
        }
        item.blocked_until = new Date(Date.now() + backoffHours * 60 * 60 * 1000).toISOString();
        const backoffLabel = backoffHours < 1 ? `${(backoffHours * 60).toFixed(0)}min` : `${backoffHours.toFixed(2)}h`;
        console.log(`  ✗ failed (attempt ${item.attempts}/${item.max_attempts || 5}), retry in ${backoffLabel} [${backoffReason}]: ${result.error.substring(0, 200)}`);
        appendLog(`FAILED ${item.id} attempt ${item.attempts}, backoff ${backoffLabel} [${backoffReason}]: ${result.error.substring(0, 200)}`);
      }

      // Quota short-circuit: after threshold same-cog daily-quota errors
      // (cumulative across the tick), skip remaining same-cog ready items
      // this tick AND push their blocked_until to the reset boundary. Saves
      // the next 30-min cron tick from re-burning the first N calls.
      if (isDailyQuota && cumulativeQuotaErrs[cog] >= QUOTA_BAIL_THRESHOLD && !outForTickCogs.has(cog)) {
        outForTickCogs.add(cog);
        const resetHours = hoursUntilNextChicagoMidnight ? hoursUntilNextChicagoMidnight() : 6;
        const resetIso = new Date(Date.now() + resetHours * 60 * 60 * 1000).toISOString();
        let pushed = 0;
        for (const other of ready) {
          if (other === item) continue;
          if (other.status !== 'pending') continue;
          if ((other.kind || '').replace(/^api-retry-/, '') !== cog) continue;
          // Only push items whose current blocked_until is already in the past
          // (i.e., would have been processed this tick). Don't shorten a longer wait.
          const cur = new Date(other.blocked_until).getTime();
          if (Number.isFinite(cur) && cur >= Date.now() + resetHours * 60 * 60 * 1000) continue;
          other.blocked_until = resetIso;
          pushed++;
        }
        const msg = `⚠ ${cog}: ${cumulativeQuotaErrs[cog]} daily-quota errors this tick — bailing on this cog; pushed ${pushed} more ${cog} items to ${resetIso}`;
        console.log(`  ${msg}`);
        appendLog(`QUOTA-BAIL ${msg}`);
      }
    }
  }

  // Per-tick cap report. If we hit either cap, surface clearly. Items not
  // reached this tick simply stay pending for the next cron tick (cap is a
  // pause, not a status change).
  if (cappedReason) {
    const remaining = ready.length - processedThisTick - Array.from(outForTickCogs).reduce((sum, cog) => {
      return sum + ready.filter(i => (i.kind || '').replace(/^api-retry-/, '') === cog && i.status === 'pending').length;
    }, 0);
    const wallSec = ((Date.now() - tickStartedAt) / 1000).toFixed(1);
    const msg = `Tick capped: ${cappedReason} (processed ${processedThisTick} items in ${wallSec}s; ~${Math.max(0, remaining)} ready items deferred to next tick)`;
    console.log(`\n  ${msg}`);
    appendLog(`TICK-CAP ${msg}`);
  }

  // ─── CASCADING CLEANUP ─────────────────────────────────────────────────────
  // When an item with kind X just succeeded, we have proof that the
  // underlying API/distributor is healthy again. Fast-track all other
  // pending items with the same kind by setting blocked_until=now so the
  // NEXT worker run picks them up immediately. (We don't run them in the
  // current loop to keep this run bounded — they get picked up on the next
  // 30-min tick. If you need immediate cascade execution, run the worker
  // again manually.)
  let cascaded = 0;
  if (cascadeTriggers.size > 0) {
    const nowIso = now();
    for (const item of queue.items) {
      if (item.status !== 'pending') continue;
      if (!cascadeTriggers.has(item.kind)) continue;
      const blockedUntilMs = new Date(item.blocked_until).getTime();
      if (Number.isFinite(blockedUntilMs) && blockedUntilMs <= nowMs) continue; // already ready
      item.blocked_until = nowIso;
      cascaded++;
    }
    if (cascaded > 0) {
      const kindsList = Array.from(cascadeTriggers).join(', ');
      console.log(`\n  ↪ Cascading cleanup: ${cascaded} other items for ${kindsList} fast-tracked (${cascadeTriggers.size} kinds confirmed healthy)`);
      appendLog(`CASCADE ${cascaded} items fast-tracked for kinds: ${kindsList}`);
    }
  }

  // ─── EMAIL NOTIFICATION ────────────────────────────────────────────────────
  // When the worker is running unattended (cron) the operator only learns
  // about exhausted items if we tell them. Send a single email per run
  // summarizing what got exhausted, NOT individual emails per item.
  if (exhaustedThisRun.length > 0) {
    notifyExhausted(exhaustedThisRun).catch(err => {
      console.error(`Failed to send exhausted-items notification: ${err.message}`);
      appendLog(`NOTIFY-FAIL: ${err.message}`);
    });
  }

  saveQueue(queue);

  // Summary
  const summary = queue.items.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nQueue state after run: ${JSON.stringify(summary)}`);
  return 0;
}

process.exit(main());
