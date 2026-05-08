#!/usr/bin/env node
/**
 * cron-runner.js — universal wrapper around every scheduled job.
 *
 * Cron invokes this with `--job=<name>`. The runner:
 *   1. Looks up the job in cron-jobs.js
 *   2. Asks the sentinel: should we run? (no for weekly/daily not-yet-due jobs)
 *   3. If needsOT: probes OT health. On 503/down, exits cleanly without touching the sentinel.
 *   4. Execs the job's command. Captures exit code.
 *   5. Exit 0 → markSuccess (advances nextDue). Non-zero → markFailure (preserves nextDue).
 *
 * Logs structured events to /tmp/cron-runner.log.
 *
 * Usage:
 *   node cron-runner.js --job=lam-kitting-runner
 *   node cron-runner.js --job=lam-kitting-runner --force   # bypass sentinel + health
 *   node cron-runner.js --job=lam-kitting-runner --dry-run # show what would happen
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REGISTRY = require('../cron-jobs');
const { cadenceToMs } = require('../cron-jobs');
const { shouldRun, markSuccess, markFailure } = require('../shared/cron-sentinel');
const { probeOT } = require('../shared/ot-health');
const breadcrumbs = require('../shared/breadcrumbs');

function crumb(jobName, event, detail) {
  try {
    breadcrumbs.write({ cog: 'cron-runner', event, job: jobName, ...detail });
  } catch (e) { /* breadcrumbs are advisory; never fail a run on crumb write */ }
}

const RUNNER_LOG = '/tmp/cron-runner.log';

function logEvent(jobName, event, detail) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    job: jobName,
    event,
    ...detail,
  });
  fs.appendFileSync(RUNNER_LOG, line + '\n');
}

function parseArgs(argv) {
  const args = { force: false, dryRun: false, job: null };
  for (const a of argv.slice(2)) {
    if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--job=')) args.job = a.slice('--job='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.job) {
    console.error('cron-runner: missing --job=<name>');
    process.exit(2);
  }

  const job = REGISTRY.find((j) => j.name === args.job);
  if (!job) {
    console.error(`cron-runner: job '${args.job}' not in registry`);
    logEvent(args.job, 'error', { reason: 'not-in-registry' });
    process.exit(2);
  }

  const cadenceMs = cadenceToMs(job.cadence);

  // ─── Sentinel gate ─────────────────────────────────────────────────────
  if (!args.force) {
    const decision = shouldRun(job.name, job.cadence);
    if (!decision.run) {
      logEvent(job.name, 'skip', { reason: decision.reason });
      crumb(job.name, 'job-skip-not-due', { reason: decision.reason });
      // Silent exit — no console output for the common skip case so cron logs stay clean.
      process.exit(0);
    }
    logEvent(job.name, 'consider', { reason: decision.reason });
  }

  // ─── OT health gate ────────────────────────────────────────────────────
  if (job.needsOT && !args.force) {
    const health = await probeOT();
    if (!health.up) {
      logEvent(job.name, 'skip-ot-down', { statusCode: health.statusCode, reason: health.reason });
      crumb(job.name, 'job-skip-ot-down', { statusCode: health.statusCode, reason: health.reason });
      // Don't markFailure — this isn't a job-logic failure. nextDue stays put,
      // next hourly tick retries when OT is back.
      console.error(`cron-runner: OT unavailable (${health.reason}) — skipping ${job.name}, will retry next tick`);
      process.exit(0);
    }
    logEvent(job.name, 'ot-up', { ms: health.ms, statusCode: health.statusCode });
  }

  // ─── Dry run early exit ────────────────────────────────────────────────
  if (args.dryRun) {
    console.log(`[dry-run] would exec: cd "${job.cwd}" && ${job.command}`);
    process.exit(0);
  }

  // ─── Execute the job ───────────────────────────────────────────────────
  const startedAt = Date.now();
  logEvent(job.name, 'start', { command: job.command });

  const result = spawnSync('bash', ['-c', job.command], {
    cwd: job.cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  const durationMs = Date.now() - startedAt;
  const exitCode = result.status;

  if (exitCode === 0) {
    markSuccess(job.name, cadenceMs);
    logEvent(job.name, 'success', { durationMs });
    crumb(job.name, 'job-success', { durationMs });
    process.exit(0);
  } else {
    const reason = result.signal
      ? `signal ${result.signal}`
      : `exit ${exitCode}`;
    markFailure(job.name, reason, cadenceMs);
    logEvent(job.name, 'failure', { durationMs, exitCode, signal: result.signal });
    crumb(job.name, 'job-failure', { durationMs, exitCode, signal: result.signal, reason });
    process.exit(exitCode || 1);
  }
}

main().catch((err) => {
  console.error('cron-runner: unhandled error:', err);
  logEvent(parseArgs(process.argv).job || '?', 'unhandled-error', { message: err.message });
  process.exit(1);
});
