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
    description: 'Every 5m — drain rfq-load-queue (general RFQ Loading workflow); does NOT poll stockRFQ@ — that job belongs to stockrfq-agent',
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

  // ── Customer Excess pipeline (universal offer parser + writeback + analysis) ──
  // Architecture: cog 1 (poller) → cog 2 (writeback) → cog 3 (router) → cog 4
  // (analysis stub) / data-capture cogs → cog 7 (digest) ← cog 8 (reply parser)
  // Breadcrumbs at every step, single JSONL at ~/workspace/.offer-pipeline/.
  // Reports go to operator only in V1; distribution expands once tuned.

  // Email-workflow agents (claude -p invocations following the agent pattern in
  // email-workflow-architecture.md). Each tick reads the workflow .md, lists
  // unseen messages, applies the per-message decision tree, and dispatches via
  // shared/email-workflow-poller.js. Replaces the 5/7-buggy static
  // offer-poller-excess (which is now retired).
  //
  // --max-turns 80 is the cost circuit-breaker. --permission-mode bypassPermissions
  // is required for headless tool use (no operator to approve).
  {
    name: 'excess-agent',
    cadence: 'every 30m',
    cadenceCron: '*/30 * * * *',
    command: `/home/analytics_user/.local/bin/claude -p --permission-mode bypassPermissions --max-turns 80 < "${ASTUTE}/Trading Analysis/Customer Excess Analysis/agent-prompt.txt"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/excess-agent.log',
    description: 'Every 30m — agent reads excess@ per customer-excess-analysis.md, writes offers via OT API',
  },

  {
    name: 'stockrfq-agent',
    cadence: 'every 30m',
    cadenceCron: '*/30 * * * *',
    command: `/home/analytics_user/.local/bin/claude -p --permission-mode bypassPermissions --max-turns 80 < "${ASTUTE}/Trading Analysis/Stock RFQ Loading/agent-prompt.txt"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/stockrfq-agent.log',
    description: 'Every 30m — agent reads stockRFQ@ per stock-rfq-loading.md, writes RFQs via OT API',
  },

  // PLACEHOLDER for second inbox (broker / franchise) — disabled until the
  // operator supplies the real inbox name. To enable:
  //   1. Add the email to ACCOUNT_TO_EMAIL in shared/offer-poller.js
  //   2. Uncomment this entry and re-run scripts/install-crons.js --apply
  //
  // {
  //   name: 'offer-poller-broker',
  //   cadence: 'every 30m',
  //   cadenceCron: '*/30 * * * *',
  //   command: `node "${ASTUTE}/Trading Analysis/Market Offer Loading/run-poller.js" --account broker`,
  //   cwd: ASTUTE,
  //   needsOT: true,
  //   logFile: '/tmp/offer-poller-broker.log',
  //   description: 'Every 30m — poll broker@ inbox, parse offers, writeOffer to OT, dispatch to type router',
  // },

  {
    name: 'offer-reply-parser',
    cadence: 'every 30m',
    // Offset by 5 min from poller so we're not fighting for the inbox lock
    cadenceCron: '5,35 * * * *',
    command: `node "${ASTUTE}/Trading Analysis/Customer Excess Analysis/reply-parser.js" --account excess`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/offer-reply-parser.log',
    description: 'Every 30m (offset +5) — parse operator replies, apply PARTNER/INTENT/SKIP overrides',
  },

  // 7am / 12pm / 4pm EDT = 11 / 16 / 20 UTC (during DST). EST (winter) = 12 / 17 / 21 UTC.
  // DST flips twice/year; re-check around Mar (spring forward) and Nov (fall back) and bump
  // the cron expressions one hour later if needed. Single combined entry below; the digest
  // builder is idempotent (state-tracked window) so all three fires produce non-overlapping
  // digests.
  {
    name: 'offer-digest',
    cadence: 'fixed',
    // :25 past so sub-hourly agents (excess-agent, stockrfq-agent) that fire at :00
    // have ~25 min of runway to write their breadcrumbs before the digest reads.
    // Was '0 11,16,20 * * *' until 2026-05-08 — caused empty-window digests.
    cadenceCron: '25 11,16,20 * * *',
    command: `node "${ASTUTE}/Trading Analysis/Customer Excess Analysis/digest-builder.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/offer-digest.log',
    description: '11:25/16:25/20:25 UTC — Operations Digest 3×/day (cron + email-workflow agents + open queue)',
  },

  {
    name: 'stock-rfq-activity-digest',
    cadence: 'fixed',
    // :25 past so stockrfq-agent (fires at :00 / :30) has runway to write its
    // RFQs before the digest reads.
    cadenceCron: '25 0,4,8,12,16,20 * * *',
    command: `node "${ASTUTE}/Trading Analysis/Stock RFQ Loading/stock-rfq-activity-digest.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/stock-rfq-activity-digest.log',
    description: 'Every 4h — Stock RFQ activity digest (top concentrated MPNs + customers, real-vs-bogus heuristic). Cumulative window resets at 00 ET.',
  },

  {
    name: 'offer-breadcrumbs-prune',
    cadence: 'weekly',
    // Sunday 02:00 UTC — quiet window
    cadenceCron: '0 2 * * 0',
    command: `node -e "require('${ASTUTE}/shared/breadcrumbs').prune()"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/offer-breadcrumbs-prune.log',
    description: 'Sunday 02 UTC — drop offer-pipeline breadcrumbs older than 7 days',
  },
];

// Helper: convert cadence string to milliseconds (used by sentinel + runner).
module.exports.cadenceToMs = function cadenceToMs(cadence) {
  if (cadence === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (cadence === 'daily') return 24 * 60 * 60 * 1000;
  if (cadence === 'fixed') return 60 * 1000; // placeholder; sentinel never gates 'fixed'
  const m = /^every (\d+)m$/.exec(cadence);
  if (m) return parseInt(m[1], 10) * 60 * 1000;
  throw new Error(`Unrecognized cadence: ${cadence}`);
};

// Helper: which cron expression to actually install for this job.
//
// Cadence semantics:
//   'weekly'     — install hourly catch-up; sentinel gates so a missed window
//                  fires at the next hourly tick after the cadence elapses.
//   'daily'      — same catch-up pattern, daily cadence.
//   'every Nm'   — sub-hourly; cron schedule directly drives the runs. No
//                  sentinel gating (job self-heals each tick).
//   'fixed'      — fire at EXACTLY the times in cadenceCron (e.g., '0 11,16,20 * * *').
//                  Sentinel does not gate; if the cron fires, the job runs.
//                  Use this for time-of-day reports / digests where catch-up
//                  semantics would land at the wrong clock hour.
module.exports.installCron = function installCron(job) {
  if (job.cadence === 'weekly' || job.cadence === 'daily') {
    return '0 * * * *'; // hourly check; sentinel decides whether to actually run
  }
  return job.cadenceCron;
};
