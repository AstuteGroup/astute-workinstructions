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
const { classifyRegion, assignTier } = require('./rfq-region');
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
 * Select RFQs created after the watermark, including the contact's country
 * for tier classification. Returns newest-last so we process in creation order.
 */
async function findNewRFQs(sinceIso) {
  const { rows } = await pool.query(`
    SELECT r.value AS rfq_number,
           r.chuboe_rfq_id,
           r.created,
           bp.name AS customer,
           rt.name AS rfq_type,
           co.name AS contact_country,
           COUNT(rlm.chuboe_rfq_line_mpn_id) AS line_mpns
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.ad_user u ON r.chuboe_user_id = u.ad_user_id
    LEFT JOIN adempiere.c_bpartner_location bpl
           ON u.c_bpartner_location_id = bpl.c_bpartner_location_id
    LEFT JOIN adempiere.c_location loc ON bpl.c_location_id = loc.c_location_id
    LEFT JOIN adempiere.c_country co ON loc.c_country_id = co.c_country_id
    LEFT JOIN adempiere.chuboe_rfq_line rl
           ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm
           ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
          AND rlm.isactive='Y'
          AND rlm.chuboe_mpn_clean IS NOT NULL
          AND rlm.chuboe_mpn_clean <> ''
    WHERE r.isactive='Y'
      AND r.created > $1
    GROUP BY r.value, r.chuboe_rfq_id, r.created, bp.name, rt.name, co.name
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

  // Tier breakdown
  const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0, '4B': 0 };
  for (const r of batchResults) {
    if (r._fromBacklog) tierCounts['4B']++;
    else tierCounts[r._tier || 1]++;
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
    const tierLabel = r._fromBacklog ? 'T4(B)' : `T${r._tier || '?'}`;
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
      <td style="text-align:right">${r.apiResultRowsWritten}</td>
      <td style="text-align:right">${r.vqsWritten}</td>
      <td style="text-align:right">${r.qtyMatches}/${r.partialCoverage}/${r.noCoverage}</td>
      <td style="text-align:right">${r.errors?.length || 0}</td>
    </tr>
  `}).join('');

  // Quota + backlog info
  const quotaRemaining = quotaState?.remainingCalls != null ? quotaState.remainingCalls : '?';
  const quotaUpdated = quotaState?.updatedAt ? new Date(quotaState.updatedAt).toISOString().slice(11, 16) : '?';

  return `
    <html><body style="font-family:Arial,sans-serif">
    <h3>RFQ API Enrichment — batch summary</h3>
    <p>Window: ${sinceIso} → ${untilIso}</p>
    ${warningBanner}
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#f0f0f0"><th colspan="2">Totals</th></tr>
      <tr><td>RFQs processed</td><td style="text-align:right">${totalRfqs}</td></tr>
      <tr><td>Tiers</td><td style="text-align:right">T1:${tierCounts[1]} T2:${tierCounts[2]} T3:${tierCounts[3]} T4:${tierCounts[4]} T4(backlog):${tierCounts['4B']}</td></tr>
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
        <th>Lines</th><th>API</th><th>Cache</th><th>Rows</th><th>VQs</th>
        <th>FULL/PART/NONE</th><th>Err</th>
      </tr>
      ${rows}
    </table>
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

  // Phase 1: Classify new RFQs into tiers
  for (const r of newRFQs) {
    r.region = classifyRegion(r.contact_country);
    r.tier = assignTier(r.rfq_type, r.region);
  }

  const immediate = newRFQs.filter(r => r.tier <= 3);
  const tier4New = newRFQs.filter(r => r.tier === 4);

  if (newRFQs.length > 0) {
    log(`Found ${newRFQs.length} new RFQ(s): T1-3=${immediate.length}, T4=${tier4New.length}`);
    for (const r of newRFQs) {
      log(`  ${r.rfq_number} — ${r.customer || '?'} (${r.rfq_type}) T${r.tier} [${r.region}] — ${r.line_mpns} MPNs`);
    }
  } else {
    log('No new RFQs.');
  }

  // Phase 2: Queue new Tier 4 to backlog
  if (tier4New.length > 0) {
    const added = addToBacklog(tier4New);
    log(`Queued ${added} new Tier 4 RFQ(s) to backlog`);
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
    log(`Enriching ${r.rfq_number} (${r.rfq_type} T${r.tier} [${r.region}], ${r.line_mpns} MPNs)...`);
    try {
      const result = await enrichRFQ(String(r.rfq_number));
      result._tier = r.tier;
      batchResults.push(result);
      log(`  done: ${result.apiCalls} API, ${result.cacheHits} cache, ${result.vqsWritten} VQs, ${result.errors?.length || 0} err`);
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      batchResults.push({
        rfq: r.rfq_number, customer: r.customer, rfqType: r.rfq_type,
        _tier: r.tier, error: err.message,
        lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
        vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
        errors: [{ stage: 'enrich', message: err.message }], durationMs: 0,
      });
    }
  }

  // Phase 4: Drain Tier 4 backlog with remaining quota
  if (!isQuotaBlocked()) {
    const candidates = nextBatch(BACKLOG_BATCH_SIZE);
    if (candidates.length > 0) {
      log(`Draining Tier 4 backlog: ${candidates.length} candidate(s)...`);
    }
    for (const item of candidates) {
      if (!hasAdequateQuota(QUOTA_FLOOR)) {
        const qs = readQuotaState();
        log(`  Quota low (${qs?.remainingCalls ?? '?'} remaining) — pausing backlog drain`);
        break;
      }
      log(`  Backlog: enriching ${item.rfq_number} (${item.customer}, ${item.line_mpns} MPNs, queued ${item.queuedAt})...`);
      try {
        const result = await enrichRFQ(String(item.rfq_number));
        result._tier = 4;
        result._fromBacklog = true;
        batchResults.push(result);
        markAttempted(item.rfq_number, 'success');
        log(`    done: ${result.apiCalls} API, ${result.cacheHits} cache, ${result.vqsWritten} VQs`);
      } catch (err) {
        log(`    ERROR: ${err.message}`);
        markAttempted(item.rfq_number, 'error');
        batchResults.push({
          rfq: item.rfq_number, customer: item.customer, rfqType: item.rfq_type,
          _tier: 4, _fromBacklog: true, error: err.message,
          lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
          vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
          errors: [{ stage: 'enrich', message: err.message }], durationMs: 0,
        });
      }
    }
  } else {
    log('DigiKey quota blocked (429 Retry-After active) — skipping backlog drain');
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
    // No new RFQs and nothing from backlog — check if backlog has items we should mention
    const bl = backlogStats();
    if (bl.pending > 0 && isQuotaBlocked()) {
      log(`Backlog has ${bl.pending} items but quota is blocked — will drain on next tick`);
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
