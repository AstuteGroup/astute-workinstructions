/**
 * Cron Job Registry — single source of truth for all scheduled activities.
 *
 * To add a new scheduled activity:
 *   1. Add an entry below.
 *   2. Run `node scripts/install-crons.js` to regenerate crontab.
 *   3. The Resilience Checklist will be printed for your new entry.
 *
 * NEVER hand-edit `crontab -e`. The drift check at session start will surface it.
 *
 * Field reference:
 *   name         — unique identifier; also used for the sentinel filename and log tag
 *   cadence      — 'weekly' | 'daily' | 'every Nm' (where N is minutes < 60)
 *   cadenceCron  — cron expression for *when to first attempt*. For weekly/daily,
 *                  the runner additionally checks hourly so a missed window catches up.
 *                  For sub-hourly (every Nm), this matches the cadence directly.
 *   command      — the actual node invocation (relative to `cwd`)
 *   cwd          — working directory (absolute path)
 *   needsOT      — true if the job writes to iDempiere REST API. Triggers OT health gate.
 *   logFile      — where the job's stdout/stderr is appended
 *   description  — one-line human-readable summary (shown in install output)
 */

'use strict';

const HOME = process.env.HOME || '/home/analytics_user';
const WORKSPACE = `${HOME}/workspace`;
const ASTUTE = `${WORKSPACE}/astute-workinstructions`;

module.exports = [
  {
    name: 'inventory-cleanup',
    cadence: 'weekly',
    cadenceCron: '0 11 * * 1',
    command: `node "${ASTUTE}/Trading Analysis/Inventory File Cleanup/inventory_cleanup.js" fetch`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/inventory-cleanup.log',
    description: 'Mon 11 UTC — pull Infor xlsx, clean, write offers via OT API',
  },
  {
    name: 'lam-kitting-runner',
    cadence: 'weekly',
    cadenceCron: '0 12 * * 1',
    command: `node "${ASTUTE}/Trading Analysis/LAM Kitting Reorder/lam-kitting-runner.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: `${ASTUTE}/Trading Analysis/LAM Kitting Reorder/data/cron.log`,
    description: 'Mon 12 UTC — LAM Kitting reorder alerts + franchise sourcing + RFQ writes',
  },
  {
    name: 'vortex-poller',
    cadence: 'every 20m',
    cadenceCron: '*/20 * * * *',
    command: `node "${ASTUTE}/Trading Analysis/Vortex Matches/vortex-poller.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/vortex-poller.log',
    description: 'Every 20m — poll vortex@ inbox, return matches via email',
  },
  {
    name: 'process-api-queue',
    cadence: 'every 30m',
    cadenceCron: '*/30 * * * *',
    command: `node "${WORKSPACE}/scripts/process-api-queue.js"`,
    cwd: WORKSPACE,
    needsOT: false,
    logFile: '/tmp/api-queue-worker.log',
    description: 'Every 30m — retry deferred franchise API calls (Mouser/DigiKey rate-limit queue)',
  },
  {
    name: 'enrich-poller',
    cadence: 'every 15m',
    cadenceCron: '*/15 * * * *',
    command: `node "${ASTUTE}/Trading Analysis/RFQ API Enrichment/enrich-poller.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/enrich-poller.log',
    description: 'Every 15m — run franchise APIs on unenriched RFQ lines, write VQ enrichment',
  },
  {
    name: 'rfq-loader-daemon',
    cadence: 'every 5m',
    cadenceCron: '*/5 * * * *',
    command: `node "${ASTUTE}/scripts/rfq-loader-daemon.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/rfq-loader-daemon.log',
    description: 'Every 5m — poll stockRFQ@ inbox, write incoming RFQs via OT API',
  },
  {
    name: 'mfr-reconciler',
    cadence: 'daily',
    cadenceCron: '0 6 * * *',
    command: `node "${ASTUTE}/Trading Analysis/MFR Reconciler/mfr-reconciler.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/mfr-reconciler.log',
    description: 'Daily 6 UTC — backfill Chuboe_MFR_ID FK on rows where text is set but FK is null',
  },
  {
    name: 'vq-enrichment-roi-tracker',
    cadence: 'weekly',
    cadenceCron: '0 7 * * 1',
    command: `node "${ASTUTE}/scripts/vq-enrichment-roi-tracker.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/vq-enrichment-roi.log',
    description: 'Mon 7 UTC — report on VQ enrichment ROI (read-only, replica DB)',
  },
];

// Helper: convert cadence string to milliseconds (used by sentinel + runner).
module.exports.cadenceToMs = function cadenceToMs(cadence) {
  if (cadence === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (cadence === 'daily') return 24 * 60 * 60 * 1000;
  const m = /^every (\d+)m$/.exec(cadence);
  if (m) return parseInt(m[1], 10) * 60 * 1000;
  throw new Error(`Unrecognized cadence: ${cadence}`);
};

// Helper: which cron expression to actually install for this job.
// For sub-hourly cadences, the cadence cron is sufficient (job self-heals on tick).
// For weekly/daily, we install hourly checks so a missed window catches up promptly.
module.exports.installCron = function installCron(job) {
  if (job.cadence === 'weekly' || job.cadence === 'daily') {
    return '0 * * * *'; // hourly check; sentinel decides whether to actually run
  }
  return job.cadenceCron;
};
