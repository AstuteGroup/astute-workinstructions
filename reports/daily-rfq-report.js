#!/usr/bin/env node
//
// RFQ Creation — Daily Digest
//
// Scheduled daily to surface the previous 24 hours of RFQ creation activity.
//
// What the digest contains:
//   1. Summary metrics — total RFQs, lines, MPNs, unique customers
//   2. Activity by RFQ type — distribution of RFQs across types
//   3. Activity by salesperson — which salespeople are creating RFQs
//   4. Top customers — who's requesting quotes
//   5. Detailed RFQ list — all RFQs created in the window
//
// Usage:
//   node daily-rfq-report.js               # preview to stdout (no send)
//   node daily-rfq-report.js --send        # email operator
//   node daily-rfq-report.js --since 24    # custom window in hours
//   node daily-rfq-report.js --since 48    # backfill 2 days

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Weekend gate — skip Sat/Sun EST to reduce noise
const { exitIfWeekend } = require('../shared/weekend-gate');
exitIfWeekend();

const { execSync } = require('child_process');
const { createNotifier } = require('../shared/notifier');
const { isKnownBuyer, isKnownSupport } = require('../shared/partner-lookup');

const CLAUDE_USER_ID = 1049524;

const RECIPIENTS = [
  'justin.oberhofer@astutegroup.com',
];

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const sinceIdx = args.indexOf('--since');
const SINCE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : 24;

function psqlPipe(sql) {
  // Explicitly use OS user to override PGUSER env var set by cron
  // (cron sets PGUSER=analytics_user for write jobs, but this is read-only)
  const user = require('os').userInfo().username;
  return execSync(`psql -U ${user} -d idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Returns 'Buyer' / 'Support' / 'Untagged' / '(Claude)' for the role column
function roleFor(creatorName, userId) {
  if (userId === CLAUDE_USER_ID) return '(Claude)';
  if (isKnownBuyer(userId)) return 'Buyer';
  if (isKnownSupport(userId)) return 'Support';
  return 'Untagged';
}

// Convert UTC Date → CT-naive timestamp string
function utcToCTNaive(d) {
  const ct = new Date(d.getTime() - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ct.getUTCFullYear()}-${pad(ct.getUTCMonth() + 1)}-${pad(ct.getUTCDate())} ${pad(ct.getUTCHours())}:${pad(ct.getUTCMinutes())}:${pad(ct.getUTCSeconds())}`;
}

(async () => {
  const now = Date.now();
  const sinceMs = now - SINCE_HOURS * 3600 * 1000;
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(now));

  // Activity by Creator (who created the RFQ)
  const byCreatorQuery = `
    WITH creator_salesperson_lines AS (
      SELECT
        COALESCE(creator.name, 'Unknown') AS creator_name,
        creator.ad_user_id AS creator_id,
        COALESCE(salesrep.name, 'Unassigned') AS salesperson,
        COUNT(DISTINCT r.chuboe_rfq_id) AS rfq_count,
        COUNT(DISTINCT rl.chuboe_rfq_line_id) AS line_count,
        COUNT(DISTINCT rlm.chuboe_rfq_line_mpn_id) AS mpn_count
      FROM adempiere.chuboe_rfq r
      LEFT JOIN adempiere.ad_user creator ON r.createdby = creator.ad_user_id
      LEFT JOIN adempiere.ad_user salesrep ON r.salesrep_id = salesrep.ad_user_id
      LEFT JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id AND rl.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id AND rlm.isactive = 'Y'
      WHERE r.isactive = 'Y'
        AND r.created >= '${sinceTs}'::timestamp
        AND r.created < '${untilTs}'::timestamp
      GROUP BY creator.name, creator.ad_user_id, salesrep.name
    )
    SELECT
      creator_name,
      creator_id,
      SUM(rfq_count) AS rfq_count,
      SUM(line_count) AS line_count,
      SUM(mpn_count) AS mpn_count,
      STRING_AGG(salesperson || ' (' || line_count || ')', ', ' ORDER BY line_count DESC, salesperson) AS salespeople
    FROM creator_salesperson_lines
    GROUP BY creator_name, creator_id
    ORDER BY SUM(rfq_count) DESC;
  `;

  // Seller activity breakdown (how each salesperson's RFQs were created)
  const sellerBreakdownQuery = `
    WITH categorized AS (
      SELECT
        COALESCE(salesrep.name, 'Unassigned') AS salesperson,
        salesrep.ad_user_id AS salesrep_id,
        r.createdby,
        CASE
          WHEN r.createdby = ${CLAUDE_USER_ID} THEN 'claude'
          WHEN r.createdby = salesrep.ad_user_id THEN 'self'
          ELSE 'support'
        END AS creator_type,
        COUNT(DISTINCT rl.chuboe_rfq_line_id) AS line_count
      FROM adempiere.chuboe_rfq r
      LEFT JOIN adempiere.ad_user salesrep ON r.salesrep_id = salesrep.ad_user_id
      LEFT JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id AND rl.isactive = 'Y'
      WHERE r.isactive = 'Y'
        AND r.created >= '${sinceTs}'::timestamp
        AND r.created < '${untilTs}'::timestamp
      GROUP BY salesrep.name, salesrep.ad_user_id, r.createdby
    )
    SELECT
      salesperson,
      salesrep_id,
      SUM(CASE WHEN creator_type = 'claude' THEN line_count ELSE 0 END) AS by_claude,
      SUM(CASE WHEN creator_type = 'support' THEN line_count ELSE 0 END) AS by_support,
      SUM(CASE WHEN creator_type = 'self' THEN line_count ELSE 0 END) AS by_self,
      SUM(line_count) AS total
    FROM categorized
    GROUP BY salesperson, salesrep_id
    ORDER BY total DESC;
  `;

  // Execute queries
  const byCreatorOut = psqlPipe(byCreatorQuery).trim().split('\n').filter(Boolean);
  const byCreator = byCreatorOut.map(line => {
    const [creator_name, creator_id, rfq_count, line_count, mpn_count, salespeople] = line.split('|');
    return {
      creator_name,
      creator_id: Number(creator_id),
      rfq_count: Number(rfq_count),
      line_count: Number(line_count),
      mpn_count: Number(mpn_count),
      salespeople: salespeople || ''
    };
  });

  const sellerBreakdownOut = psqlPipe(sellerBreakdownQuery).trim().split('\n').filter(Boolean);
  const sellerBreakdown = sellerBreakdownOut.map(line => {
    const [salesperson, salesrep_id, by_claude, by_support, by_self, total] = line.split('|');
    return {
      salesperson,
      salesrep_id: Number(salesrep_id),
      by_claude: Number(by_claude) || 0,
      by_support: Number(by_support) || 0,
      by_self: Number(by_self) || 0,
      total: Number(total) || 0
    };
  });

  const totalRfqs = byCreator.reduce((sum, row) => sum + row.rfq_count, 0);
  const totalLines = byCreator.reduce((sum, row) => sum + row.line_count, 0);
  const totalMpns = byCreator.reduce((sum, row) => sum + row.mpn_count, 0);

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">RFQ Creation — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)}</p>

<h3 style="margin-bottom:4px">Activity by Creator</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:750px">
<thead style="background:#eef"><tr><th align="left">Creator</th><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th><th align="right">MPNs</th><th align="left">% of Total</th><th align="left">Salespeople</th></tr></thead>
<tbody>
${byCreator.map(row => {
  const pct = totalLines > 0 ? Math.round(100 * row.line_count / totalLines) : 0;
  const barWidth = 100;
  const barFill = Math.round(barWidth * row.line_count / totalLines);
  const bar = `<span style="display:inline-block;width:${barWidth}px;height:12px;background:#eee;border-radius:2px;overflow:hidden">` +
    `<span style="display:inline-block;width:${barFill}px;height:100%;background:#48c"></span>` +
    `</span> ${pct}%`;
  const role = roleFor(row.creator_name, row.creator_id);
  const roleColor = role === 'Support' ? '#888' : role === 'Untagged' ? '#b00' : '#222';
  return `<tr><td>${esc(row.creator_name)}</td><td style="color:${roleColor}"><i>${esc(role)}</i></td><td style="text-align:right">${row.rfq_count}</td><td style="text-align:right">${row.line_count}</td><td style="text-align:right">${row.mpn_count}</td><td>${bar}</td><td style="font-size:11px">${esc(row.salespeople)}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td><b>Total</b></td><td></td><td style="text-align:right"><b>${totalRfqs}</b></td><td style="text-align:right"><b>${totalLines}</b></td><td style="text-align:right"><b>${totalMpns}</b></td><td></td><td></td></tr>
</tbody>
</table>

<h3 style="margin-bottom:4px;margin-top:16px">Seller Activity Breakdown</h3>
<p style="margin-top:0;color:#666;font-size:11px">For each salesperson, how their RFQ lines were created: by Claude, by support staff, or by themselves.</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:600px">
<thead style="background:#eef"><tr><th align="left">Salesperson</th><th align="right">By Claude</th><th align="right">By Support</th><th align="right">By Self</th><th align="right">Total Lines</th><th align="left">Mix</th></tr></thead>
<tbody>
${sellerBreakdown.filter(s => s.total > 0).slice(0, 20).map(s => {
  const claudePct = s.total > 0 ? Math.round(100 * s.by_claude / s.total) : 0;
  const supportPct = s.total > 0 ? Math.round(100 * s.by_support / s.total) : 0;
  const selfPct = s.total > 0 ? Math.round(100 * s.by_self / s.total) : 0;
  // Visual bar showing proportions
  const barWidth = 100;
  const claudeW = Math.round(barWidth * s.by_claude / s.total);
  const supportW = Math.round(barWidth * s.by_support / s.total);
  const selfW = barWidth - claudeW - supportW;
  const bar = `<span style="display:inline-block;width:${barWidth}px;height:12px;background:#eee;border-radius:2px;overflow:hidden">` +
    (claudeW > 0 ? `<span style="display:inline-block;width:${claudeW}px;height:100%;background:#4a4" title="Claude ${claudePct}%"></span>` : '') +
    (supportW > 0 ? `<span style="display:inline-block;width:${supportW}px;height:100%;background:#88c" title="Support ${supportPct}%"></span>` : '') +
    (selfW > 0 ? `<span style="display:inline-block;width:${selfW}px;height:100%;background:#ca4" title="Self ${selfPct}%"></span>` : '') +
    `</span>`;
  return `<tr><td>${esc(s.salesperson)}</td><td style="text-align:right;color:#4a4">${s.by_claude || '—'}</td><td style="text-align:right;color:#88c">${s.by_support || '—'}</td><td style="text-align:right;color:#ca4">${s.by_self || '—'}</td><td style="text-align:right"><b>${s.total}</b></td><td>${bar}</td></tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Legend: <span style="color:#4a4">■ Claude</span> · <span style="color:#88c">■ Support</span> · <span style="color:#ca4">■ Self</span>. "Self" = salesperson created their own RFQ lines. Top 20 salespeople by total lines shown.</i></p>

<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by daily-rfq-report.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)} (CT-naive per chuboe_*.created convention).<br/>
Only active RFQs (isactive='Y') are counted.
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`Total RFQs: ${totalRfqs}`);
    console.log(`Total Lines: ${totalLines}`);
    console.log(`Total MPNs: ${totalMpns}`);
    console.log(`Creators: ${byCreator.length}`);
    console.log('(Preview only — pass --send to email)');
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'RFQ Creation — Daily Digest',
  });
  const today = new Date().toISOString().slice(0, 10);
  await notifier.sendEmail(
    RECIPIENTS,
    `RFQ Creation — Daily Digest (${today})`,
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENTS.join(', ')}`);
  console.log(`Summary: ${totalRfqs} RFQs, ${totalLines} lines, ${totalMpns} MPNs`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
