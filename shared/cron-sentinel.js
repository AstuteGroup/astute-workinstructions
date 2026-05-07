/**
 * Cron Sentinel — per-job state file recording last-success + next-due.
 *
 * Purpose: lets jobs run on a frequent cron schedule (e.g., hourly) but only
 * actually execute when the sentinel says they're due. If a tick is skipped
 * because OT was down, the next tick after recovery sees nextDue is in the
 * past and runs the catch-up automatically.
 *
 * State location: ~/workspace/.cron-sentinels/{jobName}.json
 *
 * Sentinel shape:
 *   {
 *     "jobName": "lam-kitting-runner",
 *     "lastSuccess": "2026-04-27T12:00:00.000Z",
 *     "lastAttempt": "2026-05-04T12:00:47.000Z",
 *     "lastFailureReason": "OT 503",
 *     "nextDue": "2026-05-04T12:00:00.000Z",
 *     "successCount": 12,
 *     "failureCount": 1
 *   }
 *
 * For sub-hourly jobs (every 5m, every 15m, etc.) the sentinel is essentially
 * a no-op — the cron schedule itself enforces cadence and the sentinel just
 * records last-success for visibility. shouldRun() always returns true.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SENTINEL_DIR = path.join(process.env.HOME || '/home/analytics_user', 'workspace', '.cron-sentinels');

function ensureDir() {
  if (!fs.existsSync(SENTINEL_DIR)) {
    fs.mkdirSync(SENTINEL_DIR, { recursive: true });
  }
}

function sentinelPath(jobName) {
  return path.join(SENTINEL_DIR, `${jobName}.json`);
}

function readSentinel(jobName) {
  const p = sentinelPath(jobName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return null; // corrupt sentinel = treat as missing (next run will recreate)
  }
}

function writeSentinel(jobName, state) {
  ensureDir();
  fs.writeFileSync(sentinelPath(jobName), JSON.stringify(state, null, 2));
}

/**
 * Should this job run on the current tick?
 *
 * For weekly/daily jobs: returns true if now >= nextDue OR no sentinel exists
 * (first-run case).
 *
 * For sub-hourly jobs: returns true unconditionally (cron expression already
 * enforces cadence).
 *
 * @param {string} jobName
 * @param {string} cadence  'weekly' | 'daily' | 'every Nm'
 * @returns {{run: boolean, reason: string, sentinel: object|null}}
 */
function shouldRun(jobName, cadence) {
  const isSubHourly = /^every \d+m$/.test(cadence);
  if (isSubHourly) {
    return { run: true, reason: 'sub-hourly cadence — runs every tick', sentinel: readSentinel(jobName) };
  }
  // 'fixed' = fire at exact cron schedule, no sentinel gating (digests, time-of-day reports)
  if (cadence === 'fixed') {
    return { run: true, reason: 'fixed cadence — runs whenever cron fires', sentinel: readSentinel(jobName) };
  }

  const sentinel = readSentinel(jobName);
  if (!sentinel) {
    return { run: true, reason: 'no sentinel — first run', sentinel: null };
  }

  const now = Date.now();
  const nextDue = sentinel.nextDue ? new Date(sentinel.nextDue).getTime() : 0;
  if (now >= nextDue) {
    const overdueMs = now - nextDue;
    const overdueMin = Math.round(overdueMs / 60000);
    return {
      run: true,
      reason: overdueMs > 0 ? `due (${overdueMin}m overdue)` : 'due',
      sentinel,
    };
  }

  const dueIn = Math.round((nextDue - now) / 60000);
  return {
    run: false,
    reason: `next run in ${dueIn}m`,
    sentinel,
  };
}

/**
 * Record a successful run. Advances nextDue by `cadenceMs` from now.
 */
function markSuccess(jobName, cadenceMs) {
  const prev = readSentinel(jobName) || {};
  const now = new Date();
  writeSentinel(jobName, {
    jobName,
    lastSuccess: now.toISOString(),
    lastAttempt: now.toISOString(),
    lastFailureReason: null,
    nextDue: new Date(now.getTime() + cadenceMs).toISOString(),
    successCount: (prev.successCount || 0) + 1,
    failureCount: prev.failureCount || 0,
  });
}

/**
 * Record a failed attempt. nextDue is NOT advanced — the next tick will retry.
 */
function markFailure(jobName, reason, cadenceMs) {
  const prev = readSentinel(jobName) || {};
  const now = new Date();
  writeSentinel(jobName, {
    jobName,
    lastSuccess: prev.lastSuccess || null,
    lastAttempt: now.toISOString(),
    lastFailureReason: reason,
    nextDue: prev.nextDue || new Date(now.getTime() + cadenceMs).toISOString(), // preserve existing nextDue
    successCount: prev.successCount || 0,
    failureCount: (prev.failureCount || 0) + 1,
  });
}

/**
 * For diagnostics / drift check.
 */
function listSentinels() {
  ensureDir();
  return fs.readdirSync(SENTINEL_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSentinel(f.replace(/\.json$/, '')))
    .filter(Boolean);
}

module.exports = {
  shouldRun,
  markSuccess,
  markFailure,
  readSentinel,
  listSentinels,
  SENTINEL_DIR,
};
