/**
 * shared/lockfile.js — per-job lockfile to prevent overlapping cron runs.
 *
 * USAGE:
 *   const { acquireLock, releaseLock } = require('../shared/lockfile');
 *
 *   const lock = acquireLock('offer-poller-excess');
 *   if (!lock.acquired) {
 *     console.log(`previous run still active (held since ${lock.heldSince}); skipping`);
 *     process.exit(0);
 *   }
 *   try {
 *     // ... do work ...
 *   } finally {
 *     releaseLock('offer-poller-excess');
 *   }
 *
 * Lockfiles live in ~/workspace/.cron-locks/{name}.lock and contain the
 * acquiring process's PID and start timestamp.
 *
 * STALE LOCKS: if a lock has been held longer than `staleAfterMs` (default
 * 60 minutes) AND the process holding it no longer exists, acquireLock
 * forcibly takes over. This prevents a crashed process from blocking forever.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_DIR = path.join(process.env.HOME || '/home/analytics_user', 'workspace', '.cron-locks');
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000; // 60 minutes

function ensureDir() {
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
}

function lockPath(name) {
  return path.join(LOCK_DIR, `${name}.lock`);
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 = test only
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours — still alive
  }
}

/**
 * Try to acquire the lock for `name`. Returns:
 *   { acquired: true, path }                 — lock taken
 *   { acquired: false, heldSince, pid, ageMs } — lock held by someone else
 */
function acquireLock(name, opts = {}) {
  ensureDir();
  const staleAfterMs = opts.staleAfterMs || DEFAULT_STALE_AFTER_MS;
  const p = lockPath(name);

  if (fs.existsSync(p)) {
    let prev;
    try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { prev = null; }
    if (prev && prev.pid && prev.acquiredAt) {
      const age = Date.now() - Date.parse(prev.acquiredAt);
      const alive = isPidAlive(prev.pid);
      if (alive && age < staleAfterMs) {
        return { acquired: false, heldSince: prev.acquiredAt, pid: prev.pid, ageMs: age };
      }
      // Stale: process gone OR too old. Force-take.
    }
    // Either unparseable or stale — proceed to overwrite below.
  }

  fs.writeFileSync(p, JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: process.argv.slice(0, 3),
  }, null, 2));
  return { acquired: true, path: p };
}

function releaseLock(name) {
  const p = lockPath(name);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
}

/**
 * For diagnostics: list active lockfiles + ages.
 */
function listLocks() {
  ensureDir();
  return fs.readdirSync(LOCK_DIR)
    .filter(f => f.endsWith('.lock'))
    .map(f => {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8'));
        return {
          name: f.replace(/\.lock$/, ''),
          ...obj,
          ageMs: Date.now() - Date.parse(obj.acquiredAt),
          alive: isPidAlive(obj.pid),
        };
      } catch (e) {
        return { name: f.replace(/\.lock$/, ''), error: 'corrupt' };
      }
    });
}

module.exports = { acquireLock, releaseLock, listLocks, LOCK_DIR };
