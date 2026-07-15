#!/usr/bin/env node
/**
 * check-cron-drift.js — diff `crontab -l` against the cron-jobs.js registry.
 *
 * Surfaces:
 *   • Raw cron lines (don't go through cron-runner.js) — someone hand-edited
 *   • Registry entries missing from the installed crontab
 *   • Sentinels for jobs no longer in the registry (orphan state)
 *   • Jobs whose lastSuccess is much older than their cadence (stale)
 *
 * Output is concise and intended for the session greeting. Exits 0 always
 * (informational, not blocking) so the greeting can run other checks.
 *
 * Usage:
 *   node scripts/check-cron-drift.js          # human-readable
 *   node scripts/check-cron-drift.js --json   # machine-readable
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const REGISTRY = require('../cron-jobs');
const { cadenceToMs } = require('../cron-jobs');
const { listSentinels, SENTINEL_DIR } = require('../shared/cron-sentinel');

const RUNNER_NAME = 'cron-runner.js';
const CRON_USER = os.userInfo().username; // scope registry expectations to this account

function getInstalledCrontab() {
  try {
    return execSync('crontab -l', { encoding: 'utf8' });
  } catch (err) {
    return '';
  }
}

function parseCronLines(crontab) {
  return crontab.split('\n')
    .map((l, i) => ({ raw: l, lineNo: i + 1 }))
    .filter((l) => l.raw.trim() && !l.raw.trim().startsWith('#') && !/^[A-Z_]+\s*=/.test(l.raw.trim()));
}

function detectDrift() {
  const issues = [];
  const installed = getInstalledCrontab();
  const cronLines = parseCronLines(installed);
  const registryNames = REGISTRY.filter((j) => typeof j === 'object' && j.name && (j.owner || 'analytics_user') === CRON_USER).map((j) => j.name);

  // 1. Raw cron lines not going through cron-runner
  for (const line of cronLines) {
    if (!line.raw.includes(RUNNER_NAME)) {
      issues.push({
        severity: 'error',
        kind: 'raw-cron-line',
        message: `Cron line bypasses cron-runner (line ${line.lineNo}): ${line.raw.slice(0, 100)}`,
      });
    }
  }

  // 2. Registry entries missing from crontab
  for (const name of registryNames) {
    const found = cronLines.some((l) => l.raw.includes(`--job=${name}`));
    if (!found) {
      issues.push({
        severity: 'error',
        kind: 'missing-from-crontab',
        message: `Registry entry '${name}' not installed — run \`node scripts/install-crons.js --apply\``,
      });
    }
  }

  // 3. Crontab entries not in registry (someone added a runner-wrapped line manually)
  for (const line of cronLines) {
    const m = /--job=([\w-]+)/.exec(line.raw);
    if (m && !registryNames.includes(m[1])) {
      issues.push({
        severity: 'error',
        kind: 'crontab-not-in-registry',
        message: `Crontab references job '${m[1]}' which is not in cron-jobs.js`,
      });
    }
  }

  // 4. Orphan sentinels
  const sentinels = listSentinels();
  for (const s of sentinels) {
    if (!registryNames.includes(s.jobName)) {
      issues.push({
        severity: 'info',
        kind: 'orphan-sentinel',
        message: `Sentinel for '${s.jobName}' exists but job not in registry — safe to delete ${path.join(SENTINEL_DIR, s.jobName + '.json')}`,
      });
    }
  }

  // 5. Stale jobs — lastSuccess older than 2× cadence
  for (const job of REGISTRY) {
    if (typeof job !== 'object' || !job.name) continue;
    if ((job.owner || 'analytics_user') !== CRON_USER) continue;
    if (job.cadence === 'fixed') continue; // fixed jobs fire only at cron times; cadenceToMs is a 60s placeholder, so the 2× heuristic doesn't apply
    const sentinel = sentinels.find((s) => s.jobName === job.name);
    if (!sentinel || !sentinel.lastSuccess) continue; // never run yet — handled at install
    const lastMs = new Date(sentinel.lastSuccess).getTime();
    const ageMs = Date.now() - lastMs;
    const cadenceMs = cadenceToMs(job.cadence);
    if (ageMs > 2 * cadenceMs) {
      const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
      issues.push({
        severity: 'warn',
        kind: 'stale',
        message: `Job '${job.name}' last succeeded ${days}d ago (cadence: ${job.cadence}; failures since: ${sentinel.failureCount || 0}; last reason: ${sentinel.lastFailureReason || 'n/a'})`,
      });
    }
  }

  // 6. Enrich-poller watermark staleness — job may "succeed" but not actually process anything
  //    Added 2026-06-22 after 20-day outage where poller ran successfully but rate limiter blocked all work.
  const watermarkFile = path.join(process.env.HOME || '/home/analytics_user', 'workspace/.last-rfq-enrich');
  try {
    if (fs.existsSync(watermarkFile)) {
      const watermark = fs.readFileSync(watermarkFile, 'utf8').trim();
      const watermarkMs = new Date(watermark).getTime();
      const ageMs = Date.now() - watermarkMs;
      const ageHours = Math.round(ageMs / (60 * 60 * 1000));
      const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
      // Alert if watermark is >2 hours behind (normal backfill should clear in ~1h)
      if (ageHours > 2) {
        issues.push({
          severity: ageHours > 24 ? 'error' : 'warn',
          kind: 'enrich-watermark-stale',
          message: `Enrich-poller watermark is ${ageDays > 0 ? ageDays + 'd' : ageHours + 'h'} behind (${watermark.slice(0, 19)}Z) — RFQs are not being enriched!`,
        });
      }
    }
  } catch (err) {
    // Ignore read errors — watermark file might not exist on fresh install
  }

  return issues;
}

function main() {
  const issues = detectDrift();
  const json = process.argv.includes('--json');

  if (json) {
    console.log(JSON.stringify(issues, null, 2));
    return;
  }

  if (issues.length === 0) {
    console.log('Cron drift check: ✓ OK — registry, crontab, and sentinels in sync');
    return;
  }

  console.log('Cron drift check found issues:');
  for (const issue of issues) {
    const tag = issue.severity === 'error' ? '✗' : issue.severity === 'warn' ? '⚠' : 'ℹ';
    console.log(`  ${tag} [${issue.kind}] ${issue.message}`);
  }
}

main();
