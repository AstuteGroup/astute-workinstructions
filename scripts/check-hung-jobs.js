#!/usr/bin/env node
/**
 * check-hung-jobs.js — detect jobs that have been running too long.
 *
 * Checks for:
 *   1. Lock files older than their job's timeout (hung processes)
 *   2. Lock files held by dead PIDs (should be auto-reclaimed, but verify)
 *
 * Run at session start or manually to detect problems.
 *
 * Usage:
 *   node scripts/check-hung-jobs.js          # report only
 *   node scripts/check-hung-jobs.js --fix    # report + clean stale locks
 *
 * Created 2026-07-07 after stockrfq-cq-agent caused OT crash by running 69 min.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listLocks, LOCK_DIR } = require('../shared/lockfile');
const REGISTRY = require('../cron-jobs');

// Default thresholds (matching cron-runner.js)
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min
const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Warning threshold: 80% of timeout
const WARNING_THRESHOLD = 0.8;

function getJobTimeout(jobName) {
  const job = REGISTRY.find(j => j.name === jobName);
  if (!job) return DEFAULT_JOB_TIMEOUT_MS;
  return job.timeoutMs || (job.tier === 'agent' ? DEFAULT_AGENT_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS);
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const quiet = args.includes('--quiet');

  const locks = listLocks();
  const issues = [];
  const warnings = [];

  for (const lock of locks) {
    if (lock.error) {
      issues.push({ type: 'corrupt', name: lock.name, message: 'Corrupt lock file' });
      continue;
    }

    const timeout = getJobTimeout(lock.name);
    const alive = isPidAlive(lock.pid);

    // Dead PID — should be auto-reclaimed but flag it
    if (!alive) {
      issues.push({
        type: 'dead-pid',
        name: lock.name,
        pid: lock.pid,
        age: formatDuration(lock.ageMs),
        message: `Lock held by dead PID ${lock.pid} for ${formatDuration(lock.ageMs)}`,
      });
      continue;
    }

    // Exceeded timeout — hung process
    if (lock.ageMs > timeout) {
      issues.push({
        type: 'hung',
        name: lock.name,
        pid: lock.pid,
        age: formatDuration(lock.ageMs),
        timeout: formatDuration(timeout),
        message: `HUNG: ${lock.name} (PID ${lock.pid}) running ${formatDuration(lock.ageMs)}, exceeds ${formatDuration(timeout)} timeout`,
      });
      continue;
    }

    // Approaching timeout — warning
    if (lock.ageMs > timeout * WARNING_THRESHOLD) {
      warnings.push({
        type: 'approaching-timeout',
        name: lock.name,
        pid: lock.pid,
        age: formatDuration(lock.ageMs),
        timeout: formatDuration(timeout),
        message: `WARNING: ${lock.name} (PID ${lock.pid}) running ${formatDuration(lock.ageMs)}, approaching ${formatDuration(timeout)} timeout`,
      });
    }
  }

  // Report findings
  if (issues.length === 0 && warnings.length === 0) {
    if (!quiet) console.log('✓ No hung jobs detected');
    process.exit(0);
  }

  if (issues.length > 0) {
    console.log(`\n⚠️  HUNG JOBS DETECTED (${issues.length}):\n`);
    for (const issue of issues) {
      console.log(`  ${issue.message}`);
    }

    if (fix) {
      console.log('\nApplying fixes...');
      for (const issue of issues) {
        const lockPath = path.join(LOCK_DIR, `${issue.name}.lock`);
        if (issue.type === 'hung') {
          // Kill the hung process
          console.log(`  Killing PID ${issue.pid} (${issue.name})...`);
          try {
            process.kill(issue.pid, 'SIGTERM');
            setTimeout(() => {
              try { process.kill(issue.pid, 'SIGKILL'); } catch (e) { /* already dead */ }
            }, 5000);
          } catch (e) {
            console.log(`    Could not kill: ${e.message}`);
          }
        }
        // Remove stale lock file
        if (fs.existsSync(lockPath)) {
          console.log(`  Removing lock: ${lockPath}`);
          try { fs.unlinkSync(lockPath); } catch (e) { /* ignore */ }
        }
      }
      console.log('Done.\n');
    } else {
      console.log('\nRun with --fix to kill hung processes and clean locks.\n');
    }
  }

  if (warnings.length > 0) {
    console.log(`\n⚡ Jobs approaching timeout (${warnings.length}):\n`);
    for (const warn of warnings) {
      console.log(`  ${warn.message}`);
    }
    console.log('');
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main();
