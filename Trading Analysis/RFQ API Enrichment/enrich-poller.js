#!/usr/bin/env node
/**
 * RFQ API Enrichment Poller — cron-driven automation
 *
 * Runs on a schedule (default every 15 min). Reads a watermark timestamp from
 * ~/workspace/.last-rfq-enrich, queries adempiere.chuboe_rfq for rows created
 * since then, and routes each new RFQ through enrichRFQ(). Advances the
 * watermark atomically after the batch completes. On error, emails Jake.
 *
 * First run (no watermark): processes RFQs created in the last 1 hour only.
 * This workflow does NOT backfill historical RFQs on first run.
 *
 * Usage:
 *   node enrich-poller.js            # normal cron invocation
 *   node enrich-poller.js --dry-run  # query only, no enrichment, no watermark update
 *   node enrich-poller.js --since '2026-04-08 16:00:00'  # override watermark for backfill
 *
 * Cron entry (install with `crontab -e`):
 *   See rfq-api-enrichment.md § Cron install for the exact line (star-slash-15
 *   every 15 min, logging to ~/workspace/logs/enrich-poller.log).
 *
 * See rfq-api-enrichment.md for the full workflow spec.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { enrichRFQ } = require('./enrich-rfq');

const WATERMARK_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.last-rfq-enrich');
const JAKE_EMAIL = 'jake.harris@astutegroup.com';
const FROM_EMAIL = process.env.VORTEX_EMAIL || 'vortex@orangetsunami.com';

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
 * in creation order. We also skip anything with zero active line-MPNs — there's
 * nothing to enrich.
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
function renderSummaryHtml(batchResults, sinceIso, untilIso) {
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

  // Anomaly warnings — collect across all RFQs in the batch.
  // SILENT_NO_VQS / LOW_VQ_YIELD patterns get surfaced as a banner BEFORE
  // the per-RFQ table so the operator can't miss them when scanning the
  // email. The 2026-04-09 17:30 cron tick was the canonical example: 24
  // RFQs processed, "0 errors" reported, but only a handful of VQs landed.
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

  const rows = batchResults.map(r => `
    <tr>
      <td>${r.rfq}</td>
      <td>${r.customer || '?'}</td>
      <td>${r.rfqType || '?'}</td>
      <td style="text-align:right">${r.ttlDaysApplied}d</td>
      <td style="text-align:right">${r.lines}</td>
      <td style="text-align:right">${r.apiCalls}</td>
      <td style="text-align:right">${r.cacheHits}</td>
      <td style="text-align:right">${r.apiResultRowsWritten}</td>
      <td style="text-align:right">${r.vqsWritten}</td>
      <td style="text-align:right">${r.qtyMatches}/${r.partialCoverage}/${r.noCoverage}</td>
      <td style="text-align:right">${r.errors?.length || 0}</td>
    </tr>
  `).join('');

  return `
    <html><body style="font-family:Arial,sans-serif">
    <h3>RFQ API Enrichment — batch summary</h3>
    <p>Window: ${sinceIso} → ${untilIso}</p>
    ${warningBanner}
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#f0f0f0"><th colspan="2">Totals</th></tr>
      <tr><td>RFQs processed</td><td style="text-align:right">${totalRfqs}</td></tr>
      <tr><td>Line-MPNs</td><td style="text-align:right">${totalLines.toLocaleString()}</td></tr>
      <tr><td>Live API calls</td><td style="text-align:right">${totalApiCalls.toLocaleString()}</td></tr>
      <tr><td>Cache hits</td><td style="text-align:right">${totalCacheHits.toLocaleString()} (${cacheHitPct}%)</td></tr>
      <tr><td>api_result rows written</td><td style="text-align:right">${totalRows.toLocaleString()}</td></tr>
      <tr><td>VQs written</td><td style="text-align:right">${totalVqs.toLocaleString()}</td></tr>
      <tr><td>VQs flagged</td><td style="text-align:right">${totalFlagged.toLocaleString()}</td></tr>
      <tr><td>Errors</td><td style="text-align:right">${totalErrors}</td></tr>
      <tr><td>Duration</td><td style="text-align:right">${totalDurationSec.toFixed(1)}s</td></tr>
    </table>
    <br/>
    <h4>Per RFQ</h4>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#f0f0f0">
        <th>RFQ</th><th>Customer</th><th>Type</th><th>TTL</th>
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

  if (newRFQs.length === 0) {
    log('No new RFQs. Nothing to do.');
    if (!DRY_RUN) writeWatermark(untilIso);
    await pool.end();
    return;
  }

  log(`Found ${newRFQs.length} new RFQ(s):`);
  for (const r of newRFQs) {
    log(`  ${r.rfq_number} — ${r.customer || '?'} (${r.rfq_type}) — ${r.line_mpns} line-MPNs`);
  }

  if (DRY_RUN) {
    log('DRY RUN — skipping enrichment and watermark update');
    await pool.end();
    return;
  }

  // Process each RFQ
  const batchResults = [];
  for (const r of newRFQs) {
    log(`Enriching ${r.rfq_number} (${r.rfq_type}, ${r.line_mpns} line-MPNs)...`);
    try {
      const result = await enrichRFQ(String(r.rfq_number));
      batchResults.push(result);
      log(`  done: ${result.apiCalls} API calls, ${result.cacheHits} cache hits, ${result.apiResultRowsWritten} rows, ${result.vqsWritten} VQs, ${result.errors?.length || 0} errors`);
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      batchResults.push({
        rfq: r.rfq_number,
        customer: r.customer,
        rfqType: r.rfq_type,
        error: err.message,
        lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
        vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
        errors: [{ stage: 'enrich', message: err.message }],
        durationMs: 0,
      });
    }
  }

  // Send summary email — surface anomaly warnings in the SUBJECT so the
  // operator notices in their inbox without opening the message.
  try {
    const totalErrors = batchResults.reduce((s, r) => s + (r.errors?.length || 0), 0);
    const totalWarnings = batchResults.reduce((s, r) => s + (r.warnings?.length || 0), 0);
    let subject;
    if (totalWarnings > 0) {
      subject = `⚠ RFQ API Enrichment — ${batchResults.length} RFQs, ${totalWarnings} ANOMALY WARNING${totalWarnings === 1 ? '' : 'S'} (${totalErrors} errors)`;
    } else if (totalErrors > 0) {
      subject = `RFQ API Enrichment — ${batchResults.length} RFQs, ${totalErrors} errors`;
    } else {
      subject = `RFQ API Enrichment — ${batchResults.length} RFQs processed`;
    }
    const html = renderSummaryHtml(batchResults, sinceIso, untilIso);
    await sendEmail(subject, html);
    log('Summary email sent');
  } catch (err) {
    log('WARN: email send failed:', err.message);
  }

  // Advance watermark only after everything completes. We use the "until" time
  // captured at query-start (not Date.now()) so any RFQs created during the run
  // are picked up on the next pass.
  writeWatermark(untilIso);
  log(`Watermark advanced to ${untilIso}`);

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
