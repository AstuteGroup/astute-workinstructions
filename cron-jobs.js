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
// Headless email-workflow agents run from here so they auto-load only the lean
// ~/agent-runtime/CLAUDE.md (operational invariants) instead of the two full
// interactive CLAUDE.md files (~76KB / ~19K tokens) that Claude Code would
// otherwise walk up and ingest from cwd=ASTUTE on every launch. Agent prompts
// use absolute paths, so cwd does not affect their file access. See the
// startup/ingestion optimization (2026-05-26).
const AGENT_CWD = `${HOME}/agent-runtime`;

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
    command: `node "${ASTUTE}/Trading Analysis/LAM 3PL/lam-kitting-runner.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: `${ASTUTE}/Trading Analysis/LAM 3PL/data/cron.log`,
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
    command: `node "${ASTUTE}/scripts/process-api-queue.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/api-queue-worker.log',
    description: 'Every 30m — retry deferred franchise API calls (Mouser/DigiKey rate-limit queue)',
  },
  {
    // Watermark-based sweep: every hour, find chuboe_rfq rows newly-flipped
    // to isactive='N' since last sweep, write a cancel manifest per RFQ, and
    // purge matching items from the api retry queue. Catches the OT-direct
    // inactivation case the gate-rejection hook misses (gate hook covers
    // approve/reject replies; this covers any other path that marks an RFQ
    // inactive — manual DB flip, automated cleanup, etc.).
    name: 'cancel-inactive-rfq-retries',
    cadence: 'every 60m',
    cadenceCron: '15 * * * *',  // :15 past — out of the way of the :00 process-api-queue tick
    command: `node "${ASTUTE}/scripts/cancel-inactive-rfq-retries.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/cancel-inactive-rfq-retries.log',
    description: 'Every 60m :15 — sweep newly-inactivated RFQs, write cancel manifests, purge their in-flight retries from the api queue',
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
    tier: 'agent',  // Claude-powered — paused by .cron-agents-paused
    // Tiered: 5m burst when any pending large-offer sentinel or
    // clarify_partner sidecar exists within the last 10m, else steady at
    // :00/:45. Gate short-circuits claude -p when not running.
    cadence: 'every 5m',
    cadenceCron: '*/5 * * * *',
    // `if gate; then agent; fi` — gate's exit 1 = "skip this tick" (NOT a failure).
    // Plain `&&` would propagate the gate's exit 1 to cron-runner and get counted
    // as a job failure on every skipped tick (which is most of them). The if-form
    // returns 0 on gate-skip so only real agent crashes register as failures.
    command: `if node "${ASTUTE}/scripts/should-run-excess-agent.js"; then /home/analytics_user/.local/bin/claude -p --model sonnet --permission-mode bypassPermissions --max-turns 80 < "${ASTUTE}/Trading Analysis/Customer Excess Analysis/agent-prompt.txt"; fi`,
    cwd: AGENT_CWD,
    needsOT: true,
    logFile: '/tmp/excess-agent.log',
    description: 'Tiered (5m burst / 45m steady) — agent reads excess@ per customer-excess-analysis.md, writes offers via OT API. Burst window triggered by large-offer sentinel or clarify_partner sidecar.',
  },

  {
    name: 'stockrfq-agent',
    tier: 'agent',  // Claude-powered — paused by .cron-agents-paused
    // Hourly, no burst (2026-05-26). Stock RFQs are 1-2 line data-capture loads
    // with no live-decision pressure, so the 5m-burst / 15m-steady tiering was
    // removed: burst's only trigger here was the large-stockrfq approval
    // sidecar, which tiny stock RFQs almost never trip (it fired 0× in the
    // token-usage data). Runs claude directly once an hour. should-run-stockrfq-agent.js
    // is now unused by cron (kept on disk for history / possible reinstatement).
    // Revisit cadence if inbound latency becomes an issue or the workflow changes.
    cadence: 'every 1h',
    cadenceCron: '0 * * * *',
    command: `/home/analytics_user/.local/bin/claude -p --model sonnet --permission-mode bypassPermissions --max-turns 80 < "${ASTUTE}/Trading Analysis/Stock RFQ Loading/agent-prompt.txt"`,
    cwd: AGENT_CWD,
    needsOT: true,
    logFile: '/tmp/stockrfq-agent.log',
    description: 'Hourly (:00), no burst — agent reads stockRFQ@ per stock-rfq-loading.md, writes RFQs via OT API. Stock RFQs are small data-capture loads; cadence relaxed from 15m to 1h on 2026-05-26 (burst removed) since there is no live-decision latency requirement.',
  },

  {
    name: 'stockrfq-cq-agent',
    tier: 'agent',  // Claude-powered — paused by .cron-agents-paused
    // Hourly at :05 (offset by 5 from inbound stockrfq-agent's :00 so the
    // inbound load lands before CQ reads OutboundPending). Relaxed from 15m to
    // 1h on 2026-05-26 alongside the inbound agent — CQ is outbound data
    // capture with no live-decision pressure. Still content-gated, so an empty
    // OutboundPending hour costs zero LLM launches.
    cadence: 'every 1h',
    cadenceCron: '5 * * * *',
    command: `if node "${ASTUTE}/scripts/should-run-stockrfq-cq-agent.js"; then /home/analytics_user/.local/bin/claude -p --model sonnet --permission-mode bypassPermissions --max-turns 120 < "${ASTUTE}/Trading Analysis/Stock RFQ Loading/cq-agent-prompt.txt"; fi`,
    cwd: AGENT_CWD,
    needsOT: true,
    logFile: '/tmp/stockrfq-cq-agent.log',
    description: 'Hourly (:05) — content-gated by should-run-stockrfq-cq-agent.js (peeks OutboundPending via poller list; skips the LLM launch when 0 unseen, fail-open on gate error). Agent reads OutboundPending folder of stockRFQ@ per stock-rfq-cq-loading.md, writes CQ rows via OT API. Idempotency via pre-write chuboe_cq_line lookup. Cadence relaxed from 15m to 1h on 2026-05-26 (no live-decision latency requirement).',
  },

  {
    name: 'rfqloading-agent',
    tier: 'agent',  // Claude-powered — paused by .cron-agents-paused
    // Cron fires every 5m. The gate script exits 1 (skip) unless either
    // (a) a large-RFQ sentinel was queued within the last 10m (BURST —
    // operator might be replying right now), or (b) the current minute
    // is on the 30-min steady boundary (0 or 30). Net effect: every-5m
    // polling for ~10m after an approval email goes out, then drops to
    // every-30m. Tunable via RFQLOADING_BURST_WINDOW_MIN env.
    cadence: 'every 5m',
    cadenceCron: '*/5 * * * *',
    command: `if node "${ASTUTE}/scripts/should-run-rfqloading-agent.js"; then /home/analytics_user/.local/bin/claude -p --model sonnet --permission-mode bypassPermissions --max-turns 80 < "${ASTUTE}/Trading Analysis/RFQ Loading/agent-prompt.txt"; fi`,
    cwd: AGENT_CWD,
    needsOT: true,
    logFile: '/tmp/rfqloading-agent.log',
    description: 'Tiered (5m burst / 30m steady) — agent reads rfqloading@ per rfq-loading.md, routes customer RFQs (enqueue / need_info / needs_review / not_rfq) AND large-RFQ approval replies (approve_large_rfq / reject_large_rfq). Burst window triggered by recently-queued large-RFQ sentinels for fast approval pickup.',
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
    name: 'vq-loading-agent',
    tier: 'agent',  // Claude-powered — paused by .cron-agents-paused
    cadence: 'every 5m',
    cadenceCron: '*/5 * * * *',
    command: `if node "${ASTUTE}/scripts/should-run-vq-loading-agent.js"; then /home/analytics_user/.local/bin/claude -p --model sonnet --permission-mode bypassPermissions --max-turns 120 < "${ASTUTE}/Trading Analysis/RFQ Sourcing/vq_loading/agent-prompt.txt"; fi`,
    cwd: AGENT_CWD,
    needsOT: true,
    logFile: '/tmp/vq-loading-agent.log',
    description: 'Tiered (5m burst / 15m steady) — agent reads vq@ per vq-loading.md, runs Two-Agent Validation (extractor → sub-Agent verifier → reconcile), writes VQs via OT API. Burst window triggered by clarify_vendor / need_info_vendor / needs_vendor sidecar fresh in last 10m.',
  },

  {
    name: 'vq-watchlist',
    cadence: 'every 15m',
    cadenceCron: '7,22,37,52 * * * *',
    command: `node "${ASTUTE}/scripts/vq-watchlist.js" --notify`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/vq-watchlist.log',
    description: 'Every 15m (offset +7 from quarter so it does not race vq-loading-agent ticks at :00/:15/:30/:45) — surfaces three shakeout milestones for the cron VQ agent: first fresh complex Type 2 multi-vendor load, first partial_clarify reply stitch, and MFR-resolver overreach detections on recent VQs. Anomaly-immediate email on first firing; state in ~/workspace/.vq-watchlist-state.json keeps it idempotent.',
  },

  {
    name: 'vq-loading-resumer',
    cadence: 'every 10m',
    // Offset +4 from the quarter-hour so we don't race vq-loading-agent
    // (at :00/:05/:10/...) and don't race vq-watchlist (at :07/:22/:37/:52).
    cadenceCron: '4,14,24,34,44,54 * * * *',
    command: `node "${ASTUTE}/scripts/vq-loading-resumer.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/vq-loading-resumer.log',
    description: 'Every 10m — picks up parked VQ loads after rfq-loading creates a new RFQ. Walks ~/workspace/.vq-loading-pending/ for `kind=waiting_for_new_rfq` sidecars, correlates each against rfq-loader-daemon `rfq-loaded` breadcrumbs by Message-ID, and calls loadBulkSummary against the new RFQ\'s searchKey. Closes the cross-workflow vq→rfq forward-and-park loop. Idempotent: load-bulk-summary dedups via PRE_EXISTING_DUPLICATE so accidental double-fires write 0 dups. Sidecars past 7d TTL surface to operator via email.',
  },

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
    name: 'vq-loading-daily-digest',
    cadence: 'fixed',
    // 12:00 UTC = 8am EDT (May–Nov) / 7am EST (Nov–Mar). DST drift acceptable
    // per ops convention. Runs after :25 stock-rfq-activity-digest so the
    // 24h window naturally includes overnight loading activity.
    cadenceCron: '0 12 * * *',
    command: `node "${ASTUTE}/Trading Analysis/RFQ Sourcing/vq_loading/vq-loading-daily-digest.js" --send`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/vq-loading-daily-digest.log',
    description: 'Daily 8am EDT (12:00 UTC) — VQ Loading digest to operator (jake.harris@). 24h window. Activity-by-loader (mixed counting: Claude-as-buyer distinct, others raw) + per-batch detail (outer-From via IMAP cross-ref / buyer / RFQs / outstanding / subject reference) + escalations.',
  },

  {
    name: 'ivy-vq-digest',
    cadence: 'fixed',
    // 6 PM Shenzhen local (UTC+8, no DST) = 10:00 UTC. Per-loader VQ digest
    // for Ivy Song — includes VQs she manually loaded (createdby=1013784)
    // PLUS VQs the agent loaded from emails she forwarded to vq@ (outerFrom
    // breadcrumb match with IMAP / date-proximity fallback). State-driven
    // window: ~/workspace/.ivy-vq-digest-state.json. Sends HTML inline +
    // xlsx attachment to jake.harris@ + ivy.song@.
    cadenceCron: '0 10 * * *',
    command: `node "${ASTUTE}/Trading Analysis/RFQ Sourcing/vq_loading/ivy-vq-digest.js" --send`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/ivy-vq-digest.log',
    description: 'Daily 10:00 UTC (6 PM Shenzhen, no DST) — Ivy Song per-loader VQ digest. Window driven by .ivy-vq-digest-state.json (since-last-digest). Manual + agent-forwarded scopes both included.',
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

  {
    name: 'heilind-producer',
    // 'fixed' — fire at EXACTLY 12:00 UTC daily, no sentinel catch-up. The
    // previous 'daily' cadence used hourly-tick + sentinel gating, which
    // introduced ~12s drift per day (sentinel advances from actual run time,
    // not from cron anchor) and caused the 12:00 UTC tick to skip when it
    // landed 1-2s before the sentinel's stored nextDue. Job doesn't write
    // to OT, doesn't need catch-up resilience — it just needs to fire once
    // a day at a predictable time so the desktop pickup at 12:30 UTC can
    // rely on it.
    cadence: 'fixed',
    // 12:00 UTC = 08:00 EDT — matches operator workday start
    cadenceCron: '0 12 * * *',
    command: `node ${WORKSPACE}/heilind-rfq-candidates.js`,
    cwd: WORKSPACE,
    needsOT: false,
    logFile: '/tmp/heilind-producer.log',
    description: 'Daily 12 UTC (08 EDT) — build Heilind BOM tool upload (linecard × 30d demand, cache-filtered ±25% qty), stage to outbox/heilind/, email operator',
  },
  {
    name: 'scrape-inbox-watcher',
    cadence: 'every 15m',
    cadenceCron: '*/15 * * * *',
    command: `node "${ASTUTE}/Trading Analysis/Distributor Scrape Loading/inbox-watcher.js"`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/scrape-inbox-watcher.log',
    description: 'Every 15m — scan inbox/<source>/, dispatch via mappers/<source>.js, write VQs + pricing cache + negative cache, move to done/. Anomaly email on flagged/errored.',
  },

  // ─── MARKET INTELLIGENCE ───────────────────────────────────────────────────
  // Two complementary workflows: Market Profiling (scrape-only, continuous)
  // and Active Sourcing (full RFQ submission, 2×/week).
  // See Trading Analysis/Market Profiling/market-profiling.md

  {
    name: 'market-profiler',
    cadence: 'every 60m',
    cadenceCron: '0 * * * *',
    command: `node "${ASTUTE}/Trading Analysis/Market Profiling/market-profiler.js" --commit`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/market-profiler.log',
    description: 'Hourly — Market profiling: NC check-only scrape for unprofiled inventory MPNs (~50/tick), loads $0 availability VQs. Does NOT send RFQ emails.',
  },

  {
    name: 'active-sourcing',
    cadence: 'fixed',
    // Mon + Thu at 13:30 UTC (8:30 AM CT) — after inventory upload + market profiler
    cadenceCron: '30 13 * * 1,4',
    command: `node "${ASTUTE}/Trading Analysis/Market Profiling/active-sourcing-runner.js" --limit 200 --commit`,
    cwd: ASTUTE,
    needsOT: true,
    logFile: '/tmp/active-sourcing.log',
    description: 'Mon/Thu 13:30 UTC (8:30am CT) — Active Sourcing: select 200 priority MPNs, exclude from NC upload, send real RFQs via NC. Vendor responses come via VQ Loading.',
  },

  {
    name: 'inventory-gate-poller',
    cadence: 'fixed',
    // Mon/Thu hourly from 12-20 UTC (7am-3pm CT) — check for Jake's inventory confirmation
    // Starts 1 hour after inventory upload email (Monday 11 UTC), polls until confirmation received
    cadenceCron: '0 12-20 * * 1,4',
    command: `node "${ASTUTE}/Trading Analysis/Market Profiling/inventory-gate-poller.js"`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/inventory-gate-poller.log',
    description: 'Mon/Thu hourly 12-20 UTC — poll stockrfq@ for Jake\'s inventory confirmation, set gate for Active Sourcing',
  },

  {
    name: 'exclusion-cleanup',
    cadence: 'weekly',
    // Sunday 03:00 UTC — cleanup expired exclusions (should be redundant; TTL handles it)
    cadenceCron: '0 3 * * 0',
    command: `node "${ASTUTE}/Trading Analysis/Market Profiling/exclusion-manager.js" cleanup`,
    cwd: ASTUTE,
    needsOT: false,
    logFile: '/tmp/exclusion-cleanup.log',
    description: 'Sunday 03 UTC — remove expired sourcing exclusions from .sourcing-exclusions.json',
  },
];

// Helper: convert cadence string to milliseconds (used by sentinel + runner).
module.exports.cadenceToMs = function cadenceToMs(cadence) {
  if (cadence === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (cadence === 'daily') return 24 * 60 * 60 * 1000;
  if (cadence === 'fixed') return 60 * 1000; // placeholder; sentinel never gates 'fixed'
  const m = /^every (\d+)m$/.exec(cadence);
  if (m) return parseInt(m[1], 10) * 60 * 1000;
  const h = /^every (\d+)h$/.exec(cadence);
  if (h) return parseInt(h[1], 10) * 60 * 60 * 1000;
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
