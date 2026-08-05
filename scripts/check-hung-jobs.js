#!/usr/bin/env node
/**
 * check-hung-jobs.js — detect jobs that have been running too long.
 *
 * Checks for:
 *   1. Lock files older than their job's timeout (hung processes)
 *   2. Lock files held by dead PIDs (should be auto-reclaimed, but verify)
 *   3. Daemon PID files for long-running daemons (e.g., rfq-loader-daemon)
 *
 * Run at session start or manually to detect problems.
 *
 * Usage:
 *   node scripts/check-hung-jobs.js          # report only
 *   node scripts/check-hung-jobs.js --fix    # report + clean stale locks
 *   node scripts/check-hung-jobs.js --quiet  # suppress "no issues" output
 *   node scripts/check-hung-jobs.js --json   # output JSON for digest integration
 *
 * Created 2026-07-07 after stockrfq-cq-agent caused OT crash by running 69 min.
 * Extended 2026-08-04 to check daemon PID files after rfq-loader-daemon hung for 29 days.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listLocks, LOCK_DIR } = require('../shared/lockfile');
const REGISTRY = require('../cron-jobs');

// Default thresholds (matching cron-runner.js)
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min
const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_DAEMON_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours for daemons

// Warning threshold: 80% of timeout
const WARNING_THRESHOLD = 0.8;

// Daemon PID files to monitor (path relative to HOME, timeout in ms)
// These are long-running processes with their own PID files separate from cron locks
const DAEMON_PID_FILES = [
  {
    name: 'rfq-loader-daemon',
    pidFile: 'workspace/.rfq-loader-daemon.pid',
    timeoutMs: DEFAULT_DAEMON_TIMEOUT_MS,
    description: 'RFQ Loading queue processor',
  },
  // Add more daemons here as needed
];

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
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

/**
 * Check daemon PID files for hung processes.
 * Returns array of issues found.
 */
function checkDaemonPidFiles() {
  const HOME = process.env.HOME || '/home/analytics_user';
  const issues = [];

  for (const daemon of DAEMON_PID_FILES) {
    const pidPath = path.join(HOME, daemon.pidFile);

    if (!fs.existsSync(pidPath)) continue;

    let pid, stat;
    try {
      pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      stat = fs.statSync(pidPath);
    } catch (e) {
      issues.push({
        type: 'corrupt-pid-file',
        name: daemon.name,
        pidFile: pidPath,
        message: `Corrupt PID file: ${pidPath}`,
      });
      continue;
    }

    const alive = isPidAlive(pid);
    const ageMs = Date.now() - stat.mtimeMs;

    if (!alive) {
      // PID file exists but process is dead — stale file
      issues.push({
        type: 'stale-pid-file',
        name: daemon.name,
        pid,
        pidFile: pidPath,
        age: formatDuration(ageMs),
        ageMs,
        message: `Stale PID file: ${daemon.name} (PID ${pid} is dead, file ${formatDuration(ageMs)} old)`,
      });
      continue;
    }

    // Process is alive — check if it's been running too long
    if (ageMs > daemon.timeoutMs) {
      issues.push({
        type: 'hung-daemon',
        name: daemon.name,
        pid,
        pidFile: pidPath,
        age: formatDuration(ageMs),
        ageMs,
        timeout: formatDuration(daemon.timeoutMs),
        message: `HUNG DAEMON: ${daemon.name} (PID ${pid}) running ${formatDuration(ageMs)}, exceeds ${formatDuration(daemon.timeoutMs)} timeout`,
      });
    }
  }

  return issues;
}

/**
 * Check all hung jobs — cron locks AND daemon PID files.
 * Exported for use by digest-builder.js.
 *
 * @returns {{ issues: Array, warnings: Array }}
 */
function detectHungJobs() {
  const issues = [];
  const warnings = [];

  // 1. Check cron locks
  const locks = listLocks();
  for (const lock of locks) {
    if (lock.error) {
      issues.push({ type: 'corrupt', name: lock.name, message: 'Corrupt lock file' });
      continue;
    }

    const timeout = getJobTimeout(lock.name);
    const alive = isPidAlive(lock.pid);

    if (!alive) {
      issues.push({
        type: 'dead-pid',
        name: lock.name,
        pid: lock.pid,
        age: formatDuration(lock.ageMs),
        ageMs: lock.ageMs,
        message: `Lock held by dead PID ${lock.pid} for ${formatDuration(lock.ageMs)}`,
      });
      continue;
    }

    if (lock.ageMs > timeout) {
      issues.push({
        type: 'hung',
        name: lock.name,
        pid: lock.pid,
        age: formatDuration(lock.ageMs),
        ageMs: lock.ageMs,
        timeout: formatDuration(timeout),
        message: `HUNG: ${lock.name} (PID ${lock.pid}) running ${formatDuration(lock.ageMs)}, exceeds ${formatDuration(timeout)} timeout`,
      });
      continue;
    }

    if (lock.ageMs > timeout * WARNING_THRESHOLD) {
      warnings.push({
        type: 'approaching-timeout',
        name: lock.name,
        pid: lock.pid,
        age: formatDuration(lock.ageMs),
        ageMs: lock.ageMs,
        timeout: formatDuration(timeout),
        message: `WARNING: ${lock.name} (PID ${lock.pid}) running ${formatDuration(lock.ageMs)}, approaching ${formatDuration(timeout)} timeout`,
      });
    }
  }

  // 2. Check daemon PID files
  const daemonIssues = checkDaemonPidFiles();
  issues.push(...daemonIssues);

  return { issues, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const quiet = args.includes('--quiet');
  const jsonOutput = args.includes('--json');

  const { issues, warnings } = detectHungJobs();

  // JSON output mode for digest integration
  if (jsonOutput) {
    console.log(JSON.stringify({ issues, warnings }));
    process.exit(issues.length > 0 ? 1 : 0);
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
        // Handle hung processes (both cron locks and daemons)
        if (issue.type === 'hung' || issue.type === 'hung-daemon') {
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

        // Remove stale cron lock file
        if (issue.type === 'hung' || issue.type === 'dead-pid' || issue.type === 'corrupt') {
          const lockPath = path.join(LOCK_DIR, `${issue.name}.lock`);
          if (fs.existsSync(lockPath)) {
            console.log(`  Removing lock: ${lockPath}`);
            try { fs.unlinkSync(lockPath); } catch (e) { /* ignore */ }
          }
        }

        // Remove stale daemon PID file
        if (issue.type === 'stale-pid-file' || issue.type === 'hung-daemon' || issue.type === 'corrupt-pid-file') {
          if (issue.pidFile && fs.existsSync(issue.pidFile)) {
            console.log(`  Removing PID file: ${issue.pidFile}`);
            try { fs.unlinkSync(issue.pidFile); } catch (e) { /* ignore */ }
          }
        }
      }
      console.log('Done.\n');
    } else {
      console.log('\nRun with --fix to kill hung processes and clean locks/PID files.\n');
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

// Export for use by digest-builder.js
module.exports = { detectHungJobs, formatDuration, DAEMON_PID_FILES };

// Run main if executed directly
if (require.main === module) {
  main();
}
