#!/usr/bin/env node
/**
 * RFQ API Enrichment Poller — cron-driven automation with tiered priority.
 *
 * Runs on a schedule (default every 15 min). Reads a watermark timestamp from
 * ~/workspace/.last-rfq-enrich, queries adempiere.chuboe_rfq for rows created
 * since then, classifies each by tier, and processes accordingly:
 *
 *   Tier 1: Non-PPV (Shortage, EOL/LTB, Stock, etc.) — all regions → immediate
 *   Tier 2: PPV + APAC/EMEA contact → immediate
 *   Tier 3: PPV + MX contact → immediate
 *   Tier 4: PPV + US/CA contact (or unknown) → backlog, drained rolling
 *
 * Region is determined from the RFQ contact's location:
 *   chuboe_rfq.chuboe_user_id → ad_user.c_bpartner_location_id →
 *   c_bpartner_location → c_location → c_country
 *
 * Tier 4 backlog drains on every tick (oldest first) as long as DigiKey
 * daily quota allows. Weekends naturally clear the backlog faster.
 *
 * Usage:
 *   node enrich-poller.js            # normal cron invocation
 *   node enrich-poller.js --dry-run  # query only, no enrichment, no watermark update
 *   node enrich-poller.js --since '2026-04-08 16:00:00'  # override watermark for backfill
 *
 * Cron entry (install with `crontab -e`):
 *   See rfq-api-enrichment.md for the exact line (every 15 min).
 *
 * See rfq-api-enrichment.md for the full workflow spec.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { enrichRFQ } = require('./enrich-rfq');
const { assignPriority, isImmediate, PRIORITY } = require('./rfq-priority');
const { readQuotaState, isQuotaBlocked, hasAdequateQuota } = require('./rfq-quota-state');
const { addToBacklog, nextBatch, markAttempted, pruneBacklog, backlogStats } = require('./rfq-backlog');

const WATERMARK_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.last-rfq-enrich');
const JAKE_EMAIL = 'jake.harris@astutegroup.com';
const FROM_EMAIL = process.env.VORTEX_EMAIL || 'vortex@orangetsunami.com';

// How many Tier 4 backlog items to drain per tick. Aggressive so backlog
// doesn't accumulate — cache hits mean most won't burn much quota.
const BACKLOG_BATCH_SIZE = 10;
// Stop draining backlog when DigiKey remaining calls drops below this.
const QUOTA_FLOOR = 50;

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function readWatermark() {
  try {
    if (!fs.existsSync(WATERMARK_FILE)) return null;
    const txt = fs.readFileSync(WATERMARK_FILE, 'utf-8').trim();
    return txt || null;
  } catch (err) {
    log('WARN: failed to read watermark:', err.message);
    return null;
  }
}

function writeWatermark(iso) {
  try {
    fs.writeFileSync(WATERMARK_FILE, iso, 'utf-8');
  } catch (err) {
    log('WARN: failed to write watermark:', err.message);
  }
}

/**
 * Select RFQs created after the watermark. Returns newest-last so we process
 * in creation order. Priority is assigned later based on rfq_type + line_mpns
 * (no region/country — J8 model). Size + type drive dispatch.
 */
async function findNewRFQs(sinceIso) {
  const { rows } = await pool.query(`
    SELECT r.value AS rfq_number,
           r.chuboe_rfq_id,
           r.created,
           bp.name AS customer,
           rt.name AS rfq_type,
           COUNT(rlm.chuboe_rfq_line_mpn_id) AS line_mpns
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_rfq_line rl
           ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm
           ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
          AND rlm.isactive='Y'
          AND rlm.chuboe_mpn_clean IS NOT NULL
          AND rlm.chuboe_mpn_clean <> ''
    WHERE r.isactive='Y'
      AND r.created > $1
    GROUP BY r.value, r.chuboe_rfq_id, r.created, bp.name, rt.name
    HAVING COUNT(rlm.chuboe_rfq_line_mpn_id) > 0
    ORDER BY r.created ASC
  `, [sinceIso]);
  return rows;
}

/**
 * Render the batch summary as simple HTML for the notification email.
 */
function renderSummaryHtml(batchResults, sinceIso, untilIso, backlog, quotaState) {
  const totalRfqs = batchResults.length;
  const totalLines = batchResults.reduce((s, r) => s + (r.lines || 0), 0);
  const totalApiCalls = batchResults.reduce((s, r) => s + (r.apiCalls || 0), 0);
  const totalCacheHits = batchResults.reduce((s, r) => s + (r.cacheHits || 0), 0);
  const totalRows = batchResults.reduce((s, r) => s + (r.apiResultRowsWritten || 0), 0);
  const totalVqs = batchResults.reduce((s, r) => s + (r.vqsWritten || 0), 0);
  const totalFlagged = batchResults.reduce((s, r) => s + (r.vqsFlagged || 0), 0);
  const totalErrors = batchResults.reduce((s, r) => s + (r.errors?.length || 0), 0);
  const totalDurationSec = batchResults.reduce((s, r) => s + ((r.durationMs || 0) / 1000), 0);
  const cacheHitPct = totalLines > 0 ? Math.round(100 * totalCacheHits / totalLines) : 0;

  // Priority breakdown
  const priorityCounts = { P1: 0, P2: 0, P3: 0, P3B: 0 };
  for (const r of batchResults) {
    if (r._fromBacklog) priorityCounts.P3B++;
    else priorityCounts[r._priority || 'P1']++;
  }

  // Anomaly warnings
  const allWarnings = batchResults.flatMap(r =>
    (r.warnings || []).map(w => ({ ...w, rfq: r.rfq, customer: r.customer }))
  );
  const warningBanner = allWarnings.length === 0 ? '' : `
    <div style="border:2px solid #c00;padding:10px 14px;background:#fff5f5;margin-bottom:14px;font-size:13px">
      <b style="color:#c00;font-size:14px">⚠ ${allWarnings.length} ANOMALY WARNING${allWarnings.length === 1 ? '' : 'S'} — investigate before next tick</b>
      <ul style="margin:6px 0 0 18px;padding:0">
        ${allWarnings.map(w => `<li><b>[${w.severity}] ${w.pattern}</b> — RFQ ${w.rfq} (${w.customer || '?'}): ${w.detail}</li>`).join('')}
      </ul>
    </div>
  `;

  const rows = batchResults.map(r => {
    const tierLabel = r._fromBacklog ? 'P3(B)' : (r._priority || '?');
    // "Distributors touched" — how many distinct distributors we actually called
    // for this RFQ. Cache hits don't count. 0 = we skipped APIs entirely
    // (all-cache run or run aborted). 7 = we exercised the full distributor set.
    const distTouched = r.distributorStats ? Object.keys(r.distributorStats).length : 0;
    const distErrored = r.distributorStats
      ? Object.values(r.distributorStats).filter(s => s.errors > 0).length
      : 0;
    const distCell = distTouched === 0
      ? '<span style="color:#888">0 (cache only)</span>'
      : (distErrored > 0
          ? `${distTouched} <span style="color:#c00">(${distErrored} err)</span>`
          : `${distTouched}`);
    return `
    <tr>
      <td>${r.rfq}</td>
      <td>${r.customer || '?'}</td>
      <td>${r.rfqType || '?'}</td>
      <td>${tierLabel}</td>
      <td style="text-align:right">${r.ttlDaysApplied}d</td>
      <td style="text-align:right">${r.lines}</td>
      <td style="text-align:right">${r.apiCalls}</td>
      <td style="text-align:right">${r.cacheHits}</td>
      <td style="text-align:center">${distCell}</td>
      <td style="text-align:right">${r.apiResultRowsWritten}</td>
      <td style="text-align:right">${r.vqsWritten}</td>
      <td style="text-align:right">${r.qtyMatches}/${r.partialCoverage}/${r.noCoverage}</td>
      <td style="text-align:right">${r.errors?.length || 0}</td>
    </tr>
  `}).join('');

  // Quota + backlog info
  const quotaRemaining = quotaState?.remainingCalls != null ? quotaState.remainingCalls : '?';
  const quotaUpdated = quotaState?.updatedAt ? new Date(quotaState.updatedAt).toISOString().slice(11, 16) : '?';

  // Per-distributor health — aggregate across all RFQs in this batch
  const distAgg = {};
  for (const r of batchResults) {
    if (!r.distributorStats) continue;
    for (const [name, s] of Object.entries(r.distributorStats)) {
      if (!distAgg[name]) distAgg[name] = { calls: 0, found: 0, withStock: 0, errors: 0 };
      distAgg[name].calls += s.calls;
      distAgg[name].found += s.found;
      distAgg[name].withStock += s.withStock;
      distAgg[name].errors += s.errors;
    }
  }
  const distRows = Object.entries(distAgg)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([name, s]) => {
      const errPct = s.calls > 0 ? Math.round(100 * s.errors / s.calls) : 0;
      const foundPct = s.calls > 0 ? Math.round(100 * s.found / s.calls) : 0;
      const errFlag = errPct >= 50 ? ` <span style="color:#c00">⚠ ${errPct}% errors</span>` : '';
      return `<tr><td>${name}</td><td style="text-align:right">${s.calls.toLocaleString()}</td><td style="text-align:right">${s.found.toLocaleString()} (${foundPct}%)</td><td style="text-align:right">${s.withStock.toLocaleString()}</td><td style="text-align:right">${s.errors}${errFlag}</td></tr>`;
    }).join('');
  const distHealthSection = Object.keys(distAgg).length === 0 ? '' : `
    <br/><h4>Distributor health (live API calls only — cache hits not counted)</h4>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#f0f0f0"><th>Distributor</th><th>Calls</th><th>Found (carrying)</th><th>With stock</th><th>Errors</th></tr>
      ${distRows}
    </table>`;

  return `
    <html><body style="font-family:Arial,sans-serif">
    <h3>RFQ API Enrichment — batch summary</h3>
    <p>Window: ${sinceIso} → ${untilIso}</p>
    ${warningBanner}
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#f0f0f0"><th colspan="2">Totals</th></tr>
      <tr><td>RFQs processed</td><td style="text-align:right">${totalRfqs}</td></tr>
      <tr><td>Priorities</td><td style="text-align:right">P1(express):${priorityCounts.P1} P2(main):${priorityCounts.P2} P3(backlog-new):${priorityCounts.P3} P3(backlog-drain):${priorityCounts.P3B}</td></tr>
      <tr><td>Line-MPNs</td><td style="text-align:right">${totalLines.toLocaleString()}</td></tr>
      <tr><td>Live API calls</td><td style="text-align:right">${totalApiCalls.toLocaleString()}</td></tr>
      <tr><td>Cache hits</td><td style="text-align:right">${totalCacheHits.toLocaleString()} (${cacheHitPct}%)</td></tr>
      <tr><td>api_result rows written</td><td style="text-align:right">${totalRows.toLocaleString()}</td></tr>
      <tr><td>VQs written</td><td style="text-align:right">${totalVqs.toLocaleString()}</td></tr>
      <tr><td>VQs flagged</td><td style="text-align:right">${totalFlagged.toLocaleString()}</td></tr>
      <tr><td>Errors</td><td style="text-align:right">${totalErrors}</td></tr>
      <tr><td>Duration</td><td style="text-align:right">${totalDurationSec.toFixed(1)}s</td></tr>
      <tr><td>DigiKey quota</td><td style="text-align:right">${quotaRemaining} remaining (as of ${quotaUpdated} UTC)</td></tr>
      <tr><td>Tier 4 backlog</td><td style="text-align:right">${backlog.pending} pending (${backlog.totalLineMpns} MPNs, oldest ${backlog.oldestAgeHours}h)</td></tr>
    </table>
    <br/>
    <h4>Per RFQ</h4>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#f0f0f0">
        <th>RFQ</th><th>Customer</th><th>Type</th><th>Tier</th><th>TTL</th>
        <th>Lines</th><th>API</th><th>Cache</th><th>Dist&nbsp;hit</th><th>Rows</th><th>VQs</th>
        <th>FULL/PART/NONE</th><th>Err</th>
      </tr>
      ${rows}
    </table>
    ${distHealthSection}
    </body></html>
  `;
}

async function sendEmail(subject, html) {
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) {
    log('WARN: WORKMAIL_PASS not set — skipping email');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: true,
    auth: { user: FROM_EMAIL, pass },
  });
  await transporter.sendMail({
    from: FROM_EMAIL,
    to: JAKE_EMAIL,
    subject,
    html,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const DRY_RUN = argv.includes('--dry-run');
  const sinceOverrideIdx = argv.indexOf('--since');
  const sinceOverride = sinceOverrideIdx >= 0 ? argv[sinceOverrideIdx + 1] : null;

  // Phase 0: Prune backlog (drop items >7 days old and completed items)
  const pruned = pruneBacklog();
  if (pruned > 0) log(`Pruned ${pruned} stale/completed backlog items`);

  // Resolve watermark. First run (no watermark, no override) → last 1 hour.
  let sinceIso;
  if (sinceOverride) {
    sinceIso = sinceOverride;
  } else {
    sinceIso = readWatermark();
    if (!sinceIso) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      sinceIso = oneHourAgo.toISOString();
      log('No watermark — using last 1 hour:', sinceIso);
    }
  }
  const untilIso = new Date().toISOString();
  log(`Polling for RFQs created after ${sinceIso}`);

  let newRFQs;
  try {
    newRFQs = await findNewRFQs(sinceIso);
  } catch (err) {
    log('FATAL: query failed:', err.message);
    await pool.end();
    process.exit(1);
  }

  // Phase 1: Assign priority (P1 Express / P2 Main / P3 Backlog) based on
  // size + type. Region is no longer a signal — Astute operates 24/7 across
  // Mexico, Texas, China, India, Singapore, South Korea so there are no true
  // "off hours" to defer to. See Section J8 of trading-analysis-roadmap.md.
  for (const r of newRFQs) {
    r.priority = assignPriority(r.rfq_type, r.line_mpns);
  }

  // Sort immediate work so P1 (express) runs before P2 (main), FIFO within tier
  const immediate = newRFQs
    .filter(r => isImmediate(r.priority))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
      return new Date(a.created) - new Date(b.created);
    });
  const backlogNew = newRFQs.filter(r => r.priority === PRIORITY.BACKLOG);

  if (newRFQs.length > 0) {
    const pCounts = newRFQs.reduce((acc, r) => { acc[r.priority] = (acc[r.priority] || 0) + 1; return acc; }, {});
    log(`Found ${newRFQs.length} new RFQ(s): P1=${pCounts.P1 || 0}, P2=${pCounts.P2 || 0}, P3=${pCounts.P3 || 0}`);
    for (const r of newRFQs) {
      log(`  ${r.rfq_number} — ${r.customer || '?'} (${r.rfq_type}) ${r.priority} — ${r.line_mpns} MPNs`);
    }
  } else {
    log('No new RFQs.');
  }

  // Phase 2: Queue new Tier 4 to backlog
  if (backlogNew.length > 0) {
    const added = addToBacklog(backlogNew);
    log(`Queued ${added} new P3 RFQ(s) to backlog`);
  }

  if (DRY_RUN) {
    const bl = backlogStats();
    log(`DRY RUN — skipping enrichment. Backlog: ${bl.pending} pending (${bl.totalLineMpns} MPNs)`);
    await pool.end();
    return;
  }

  // Phase 3: Process Tier 1-3 immediately
  const batchResults = [];
  for (const r of immediate) {
    log(`Enriching ${r.rfq_number} (${r.rfq_type} ${r.priority}, ${r.line_mpns} MPNs)...`);
    try {
      const result = await enrichRFQ(String(r.rfq_number));
      result._priority = r.priority;
      batchResults.push(result);
      log(`  done: ${result.apiCalls} API, ${result.cacheHits} cache, ${result.vqsWritten} VQs, ${result.errors?.length || 0} err`);
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      batchResults.push({
        rfq: r.rfq_number, customer: r.customer, rfqType: r.rfq_type,
        _priority: r.priority, error: err.message,
        lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
        vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
        errors: [{ stage: 'enrich', message: err.message }], durationMs: 0,
      });
    }
  }

  // Phase 4: Drain Tier 4 backlog
  //
  // Important: we ALWAYS attempt the drain. The DigiKey quota state is one
  // signal among many — if DigiKey is throttled, the other 6 distributors
  // (Mouser, TTI, Newark, Farnell, Arrow, Future) still have independent
  // quotas. searchAllDistributors gracefully handles per-distributor errors
  // (captured in distributorHealth), so a 429 on DigiKey just means that
  // particular distributor returns no data — the rest of the run proceeds.
  //
  // We log the DigiKey state as a heads-up but do NOT use it to gate.
  const dkBlocked = isQuotaBlocked();
  const dkQuota = readQuotaState();
  const dkRemaining = dkQuota?.remainingCalls ?? '?';

  const candidates = nextBatch(BACKLOG_BATCH_SIZE);
  if (candidates.length > 0) {
    const dkNote = dkBlocked
      ? ` (note: DigiKey 429-blocked — other 6 distributors will still run)`
      : ` (DigiKey: ${dkRemaining} remaining)`;
    log(`Draining Tier 4 backlog: ${candidates.length} candidate(s)${dkNote}`);
  }
  for (const item of candidates) {
    log(`  Backlog: enriching ${item.rfq_number} (${item.customer}, ${item.line_mpns} MPNs, queued ${item.queuedAt})...`);
    try {
      const result = await enrichRFQ(String(item.rfq_number));
      result._priority = 'P3';
      result._fromBacklog = true;
      batchResults.push(result);
      markAttempted(item.rfq_number, 'success');
      log(`    done: ${result.apiCalls} API, ${result.cacheHits} cache, ${result.vqsWritten} VQs`);
    } catch (err) {
      log(`    ERROR: ${err.message}`);
      markAttempted(item.rfq_number, 'error');
      batchResults.push({
        rfq: item.rfq_number, customer: item.customer, rfqType: item.rfq_type,
        _priority: 'P3', _fromBacklog: true, error: err.message,
        lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
        vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
        errors: [{ stage: 'enrich', message: err.message }], durationMs: 0,
      });
    }
  }

  // Phase 5: Send summary email (only if we processed anything)
  if (batchResults.length > 0) {
    try {
      const totalErrors = batchResults.reduce((s, r) => s + (r.errors?.length || 0), 0);
      const totalWarnings = batchResults.reduce((s, r) => s + (r.warnings?.length || 0), 0);
      const bl = backlogStats();
      let subject;
      if (totalWarnings > 0) {
        subject = `⚠ RFQ API Enrichment — ${batchResults.length} RFQs, ${totalWarnings} ANOMALY WARNING${totalWarnings === 1 ? '' : 'S'} (${totalErrors} errors)`;
      } else if (totalErrors > 0) {
        subject = `RFQ API Enrichment — ${batchResults.length} RFQs, ${totalErrors} errors`;
      } else {
        subject = `RFQ API Enrichment — ${batchResults.length} RFQs processed`;
      }
      if (bl.pending > 0) {
        subject += ` [backlog: ${bl.pending}]`;
      }
      const quotaState = readQuotaState();
      const html = renderSummaryHtml(batchResults, sinceIso, untilIso, bl, quotaState);
      await sendEmail(subject, html);
      log('Summary email sent');
    } catch (err) {
      log('WARN: email send failed:', err.message);
    }
  } else if (newRFQs.length === 0) {
    // No new RFQs and nothing from backlog drained this tick.
    const bl = backlogStats();
    if (bl.pending > 0) {
      const dkNote = isQuotaBlocked() ? ' (DigiKey 429-blocked, but other distributors should still be running)' : '';
      log(`Backlog has ${bl.pending} items pending${dkNote}`);
    }
  }

  // Advance watermark after everything completes.
  if (!DRY_RUN) {
    writeWatermark(untilIso);
    log(`Watermark advanced to ${untilIso}`);
  }

  await pool.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    log('FATAL:', err.stack || err.message);
    try {
      await sendEmail(
        'RFQ API Enrichment — FATAL ERROR',
        `<pre>${(err.stack || err.message || String(err)).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`
      );
    } catch (_) { /* best effort */ }
    process.exit(1);
  });
}
