#!/usr/bin/env node
//
// RFQ Loading — Daily Digest
//
// Scheduled daily at 8am EST (~12 UTC during DST, 13 UTC standard — DST drift
// acceptable per ops convention). Surfaces the previous 24 hours of RFQ
// loading activity to the operator for review.
//
// What the digest contains:
//   1. Summary stats — RFQs loaded by source (stock vs customer)
//   2. Stock RFQs — loaded by stockrfq-agent from NetComponents/broker emails
//   3. Customer RFQs — loaded via rfqloading@ inbox
//   4. Activity by loader — who loaded RFQs (Claude, support, salesreps)
//   5. Escalations — pending need_info/needs_review
//
// Usage:
//   node rfq-loading-daily-digest.js               # preview to stdout (no send)
//   node rfq-loading-daily-digest.js --send        # email operator
//   node rfq-loading-daily-digest.js --since 24    # custom window in hours

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

// Weekend gate — skip Sat/Sun EST to reduce noise
const { exitIfWeekend } = require('../../shared/weekend-gate');
exitIfWeekend();

const fs = require('fs');
const { execSync } = require('child_process');
const { createNotifier } = require('../../shared/notifier');
const { isKnownBuyer, isKnownSupport, isKnownRfqSupport } = require('../../shared/partner-lookup');

const BREADCRUMBS = path.join(process.env.HOME, 'workspace', '.offer-pipeline', 'breadcrumbs.jsonl');
const PENDING_DIR = path.join(process.env.HOME, 'workspace', '.rfq-loading-pending');
const RECIPIENTS = [
  'jake.harris@astutegroup.com',
];
const CLAUDE_USER_ID = 1049524;

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const sinceIdx = args.indexOf('--since');
const SINCE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : 24;

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

// Convert UTC Date → CT-naive timestamp string
function utcToCTNaive(d) {
  const ct = new Date(d.getTime() - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ct.getUTCFullYear()}-${pad(ct.getUTCMonth() + 1)}-${pad(ct.getUTCDate())} ${pad(ct.getUTCHours())}:${pad(ct.getUTCMinutes())}:${pad(ct.getUTCSeconds())}`;
}

function loadBreadcrumbsSince(sinceMs) {
  if (!fs.existsSync(BREADCRUMBS)) return [];
  const raw = fs.readFileSync(BREADCRUMBS, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = Date.parse(obj.ts);
      if (ts >= sinceMs) out.push(obj);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

function loadPendingSidecars() {
  if (!fs.existsSync(PENDING_DIR)) return [];
  const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
  const sidecars = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
      sidecars.push({ filename: f, ...data });
    } catch (_) { /* skip malformed */ }
  }
  return sidecars;
}

// ─── Activity by loader (from OT database) ───────────────────────────────────
// Queries chuboe_rfq for RFQs created in the window, groups by createdby.
// Excludes Stock RFQs (type 1000000) since those are tracked separately.
function pullActivityByLoaderNonStock(sinceTs, untilTs) {
  const sql =
    `SELECT u.ad_user_id, u.name, COUNT(*) AS rfqs, SUM(line_count) AS lines ` +
    `FROM ( ` +
    `  SELECT r.createdby, ` +
    `         (SELECT COUNT(*) FROM adempiere.chuboe_rfq_line rl ` +
    `          WHERE rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y') AS line_count ` +
    `  FROM adempiere.chuboe_rfq r ` +
    `  WHERE r.created >= '${sinceTs}'::timestamp AND r.created < '${untilTs}'::timestamp ` +
    `  AND r.isactive='Y' ` +
    `  AND r.chuboe_rfq_type_id != 1000000 ` +  // Exclude Stock RFQs
    `) sub ` +
    `JOIN adempiere.ad_user u ON u.ad_user_id = sub.createdby ` +
    `GROUP BY u.ad_user_id, u.name ` +
    `ORDER BY rfqs DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [userId, name, rfqs, lines] = line.split('|');
    return {
      userId: Number(userId),
      name: name || '(unknown)',
      rfqs: Number(rfqs) || 0,
      lines: Number(lines) || 0,
    };
  });
}

// Get salesrep breakdown for Stock RFQs from OT
function pullStockRfqSalesreps(sinceTs, untilTs) {
  const sql =
    `SELECT u.name AS salesrep, COUNT(*) AS rfqs, SUM(line_count) AS lines ` +
    `FROM ( ` +
    `  SELECT r.salesrep_id, ` +
    `         (SELECT COUNT(*) FROM adempiere.chuboe_rfq_line rl ` +
    `          WHERE rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y') AS line_count ` +
    `  FROM adempiere.chuboe_rfq r ` +
    `  WHERE r.created >= '${sinceTs}'::timestamp AND r.created < '${untilTs}'::timestamp ` +
    `  AND r.isactive='Y' ` +
    `  AND r.chuboe_rfq_type_id = 1000000 ` +  // Stock RFQs only
    `) sub ` +
    `LEFT JOIN adempiere.ad_user u ON u.ad_user_id = sub.salesrep_id ` +
    `GROUP BY u.name ` +
    `ORDER BY rfqs DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [salesrep, rfqs, lines] = line.split('|');
    return {
      salesrep: salesrep || '(unassigned)',
      rfqs: Number(rfqs) || 0,
      lines: Number(lines) || 0,
    };
  });
}

// Classify loader role
function roleFor(userId, name) {
  if (userId === CLAUDE_USER_ID) return 'Claude';
  if (isKnownSupport(userId) || isKnownRfqSupport(userId)) return 'Support';
  if (isKnownBuyer(userId)) return 'Buyer';
  return 'Salesrep';
}

(async () => {
  const now = Date.now();
  const sinceMs = now - SINCE_HOURS * 3600 * 1000;
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(now));

  // Load breadcrumbs in window
  const allBcs = loadBreadcrumbsSince(sinceMs);

  // ─── STOCK RFQs (stockrfq-agent) ─────────────────────────────────────────
  const stockBcs = allBcs.filter(b => b.cog === 'stockrfq-agent');
  const stockLoaded = stockBcs.filter(b => b.event === 'loaded');
  const stockNotRfq = stockBcs.filter(b => b.event === 'not-rfq');
  const stockOutboundPending = stockBcs.filter(b => b.event === 'outbound-pending');
  const stockTotalEmails = new Set(stockBcs.map(b => b.uid)).size;
  const stockTotalLines = stockLoaded.reduce((a, b) => a + (b.linesWritten || 0), 0);

  // Stock RFQ salesrep breakdown from OT
  const stockSalesreps = pullStockRfqSalesreps(sinceTs, untilTs);
  const stockTotalFromDb = stockSalesreps.reduce((a, s) => a + s.rfqs, 0);

  // ─── CUSTOMER RFQs (rfqloading-agent + daemon) ───────────────────────────
  const agentBcs = allBcs.filter(b => b.cog === 'rfq-loading-agent');
  const daemonBcs = allBcs.filter(b => b.cog === 'rfq-loader-daemon');

  const needInfo = agentBcs.filter(b => b.event === 'escalated-need_info');
  const needsReview = agentBcs.filter(b => b.event === 'escalated-needs_review');
  const directLoads = agentBcs.filter(b => b.event === 'rfq-loaded');
  const externalNeedInfo = agentBcs.filter(b => b.event === 'external-need-info-sent');
  const alreadyLoadedSkips = agentBcs.filter(b => b.event === 'already-loaded-skip');

  const daemonLoads = daemonBcs.filter(b => b.event === 'rfq-loaded');
  const confirmationsSent = daemonBcs.filter(b => b.event === 'confirmation-sent');
  const highFailureRates = daemonBcs.filter(b => b.event === 'high-failure-rate');

  const customerRfqsLoaded = daemonLoads.length + directLoads.length;
  const customerLinesWritten = [...daemonLoads, ...directLoads].reduce((a, b) => a + (b.linesWritten || 0), 0);
  const customerEmailsProcessed = new Set(agentBcs.map(b => b.uid)).size;

  // Activity by loader (non-stock RFQs from OT)
  const loaderActivity = pullActivityByLoaderNonStock(sinceTs, untilTs);
  const nonStockFromDb = loaderActivity.reduce((a, l) => a + l.rfqs, 0);
  const nonStockLinesFromDb = loaderActivity.reduce((a, l) => a + l.lines, 0);

  // Group by role
  const byRole = new Map();
  for (const l of loaderActivity) {
    const role = roleFor(l.userId, l.name);
    if (!byRole.has(role)) byRole.set(role, { rfqs: 0, lines: 0, loaders: [] });
    byRole.get(role).rfqs += l.rfqs;
    byRole.get(role).lines += l.lines;
    byRole.get(role).loaders.push(l);
  }

  // Customer breakdown from confirmations
  const customerCounts = new Map();
  for (const load of confirmationsSent) {
    const customer = load.customer || '(unknown)';
    customerCounts.set(customer, (customerCounts.get(customer) || 0) + 1);
  }
  const topCustomers = [...customerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Salesrep breakdown from confirmations
  const salesrepCounts = new Map();
  for (const load of confirmationsSent) {
    const seller = load.seller || '(unknown)';
    salesrepCounts.set(seller, (salesrepCounts.get(seller) || 0) + 1);
  }
  const topSalesreps = [...salesrepCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // RFQ type breakdown
  const typeCounts = new Map();
  for (const load of confirmationsSent) {
    const rfqType = load.rfqType || '(unknown)';
    typeCounts.set(rfqType, (typeCounts.get(rfqType) || 0) + 1);
  }

  // Pending sidecars
  const pendingSidecars = loadPendingSidecars();

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  const totalRfqs = stockTotalFromDb + nonStockFromDb;

  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#25a;margin-bottom:4px">RFQ Loading — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)}</p>

<h3 style="margin-bottom:4px">Summary</h3>
<table border="0" cellpadding="4" cellspacing="0" style="font-size:13px">
<tr><td><b>Total RFQs created:</b></td><td><b>${totalRfqs}</b></td></tr>
<tr><td style="padding-left:20px">Stock RFQs (broker demand):</td><td>${stockTotalFromDb}</td></tr>
<tr><td style="padding-left:20px">Customer RFQs:</td><td>${nonStockFromDb}</td></tr>
</table>

<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">

<h2 style="color:#4a4;margin-bottom:4px">Stock RFQs (stockrfq-agent)</h2>
<p style="margin-top:0;color:#666;font-size:12px">Broker demand signals from NetComponents, direct emails, etc. All loaded by Claude.</p>

<table border="0" cellpadding="4" cellspacing="0" style="font-size:13px">
<tr><td><b>RFQs loaded:</b></td><td>${stockLoaded.length}</td></tr>
<tr><td><b>Emails processed:</b></td><td>${stockTotalEmails}</td></tr>
<tr><td><b>Lines written:</b></td><td>${stockTotalLines}</td></tr>
<tr><td><b>Not-RFQ (skipped):</b></td><td>${stockNotRfq.length}</td></tr>
<tr><td><b>Outbound pending:</b></td><td>${stockOutboundPending.length}</td></tr>
</table>
`;

  // Stock RFQs by salesrep
  if (stockSalesreps.length > 0) {
    html += `
<h3 style="margin-bottom:4px">Stock RFQs by Salesrep</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#e8f5e9"><tr><th align="left">Salesrep</th><th align="right">RFQs</th><th align="right">Lines</th></tr></thead>
<tbody>
${stockSalesreps.map(s => `<tr><td>${esc(s.salesrep)}</td><td style="text-align:right">${s.rfqs}</td><td style="text-align:right">${s.lines}</td></tr>`).join('\n')}
<tr style="background:#e8f5e9"><td><b>Total</b></td><td style="text-align:right"><b>${stockTotalFromDb}</b></td><td style="text-align:right"><b>${stockSalesreps.reduce((a, s) => a + s.lines, 0)}</b></td></tr>
</tbody>
</table>
`;
  }

  html += `
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">

<h2 style="color:#25a;margin-bottom:4px">Customer RFQs (rfqloading@)</h2>
<p style="margin-top:0;color:#666;font-size:12px">Customer RFQ requests forwarded to rfqloading@ inbox.</p>

<table border="0" cellpadding="4" cellspacing="0" style="font-size:13px">
<tr><td><b>RFQs loaded:</b></td><td>${customerRfqsLoaded}</td></tr>
<tr><td><b>Emails processed:</b></td><td>${customerEmailsProcessed}</td></tr>
<tr><td><b>Lines written:</b></td><td>${customerLinesWritten}</td></tr>
<tr><td><b>Need info:</b></td><td style="color:#b80">${needInfo.length}</td></tr>
<tr><td><b>Needs review:</b></td><td style="color:#b00">${needsReview.length}</td></tr>
</table>
`;

  // Activity by loader (non-stock)
  if (loaderActivity.length > 0) {
    html += `
<h3 style="margin-bottom:4px">Customer RFQs by Loader</h3>
<p style="margin-top:0;color:#666;font-size:11px">Who created non-stock RFQs (direct OT entry, rfqloading@, or other means).</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:500px">
<thead style="background:#eef"><tr><th align="left">Loader</th><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th></tr></thead>
<tbody>
${loaderActivity.map(l => {
  const role = roleFor(l.userId, l.name);
  const roleColor = role === 'Claude' ? '#4a4' : role === 'Support' ? '#88c' : role === 'Buyer' ? '#ca4' : '#222';
  const nameDisplay = l.userId === CLAUDE_USER_ID ? `<b>${esc(l.name)}</b>` : esc(l.name);
  return `<tr><td>${nameDisplay}</td><td style="color:${roleColor}"><i>${esc(role)}</i></td><td style="text-align:right">${l.rfqs}</td><td style="text-align:right">${l.lines.toLocaleString()}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td colspan="2"><b>Total</b></td><td style="text-align:right"><b>${nonStockFromDb}</b></td><td style="text-align:right"><b>${nonStockLinesFromDb.toLocaleString()}</b></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Legend: <span style="color:#4a4">Claude</span> = agent-loaded · <span style="color:#88c">Support</span> = RFQ support staff · <span style="color:#222">Salesrep</span> = direct entry</i></p>
`;
  }

  // Role summary
  if (byRole.size > 0) {
    html += `
<h3 style="margin-bottom:4px">Customer RFQs by Role</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th><th align="right">%</th></tr></thead>
<tbody>
${[...byRole.entries()].sort((a, b) => b[1].rfqs - a[1].rfqs).map(([role, data]) => {
  const pct = nonStockFromDb > 0 ? Math.round(100 * data.rfqs / nonStockFromDb) : 0;
  const roleColor = role === 'Claude' ? '#4a4' : role === 'Support' ? '#88c' : role === 'Buyer' ? '#ca4' : '#222';
  return `<tr><td style="color:${roleColor}"><b>${esc(role)}</b></td><td style="text-align:right">${data.rfqs}</td><td style="text-align:right">${data.lines.toLocaleString()}</td><td style="text-align:right">${pct}%</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  }

  // Loaded RFQs detail (confirmations)
  if (confirmationsSent.length > 0) {
    html += `
<h3 style="margin-bottom:4px">Loaded via rfqloading@ (Confirmations Sent)</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr><th>RFQ</th><th>Customer</th><th>Type</th><th>Lines</th><th>Salesrep</th></tr></thead>
<tbody>
${confirmationsSent.slice(0, 20).map(c => `<tr>
<td><b>${esc(c.searchKey)}</b></td>
<td>${esc(c.customer)}</td>
<td>${esc(c.rfqType)}</td>
<td style="text-align:right">${c.linesLoaded || 0}</td>
<td>${esc(c.seller)}</td>
</tr>`).join('\n')}
</tbody>
</table>
${confirmationsSent.length > 20 ? `<p style="color:#666;font-size:11px"><i>Showing first 20 of ${confirmationsSent.length}</i></p>` : ''}
`;
  }

  // Escalations
  if (needInfo.length > 0 || needsReview.length > 0) {
    html += `<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">`;
  }

  if (needInfo.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b80">Need Info (${needInfo.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#fff3e0"><tr><th>UID</th><th>Tracking</th><th>Missing</th><th>External Sent?</th></tr></thead>
<tbody>
${needInfo.slice(0, 10).map(n => {
  const extSent = externalNeedInfo.find(e => e.uid === n.uid);
  return `<tr>
<td>${n.uid}</td>
<td>${esc(n.trackingId)}</td>
<td>${esc((n.missing || []).join(', '))}</td>
<td>${extSent ? `Yes → ${esc(extSent.to)}` : '<i style="color:#999">No</i>'}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
${needInfo.length > 10 ? `<p style="color:#666;font-size:11px"><i>Showing first 10 of ${needInfo.length}</i></p>` : ''}
`;
  }

  if (needsReview.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b00">Needs Review (${needsReview.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#fee"><tr><th>UID</th><th>Tracking</th><th>Reason</th></tr></thead>
<tbody>
${needsReview.slice(0, 10).map(n => `<tr>
<td>${n.uid}</td>
<td>${esc(n.trackingId)}</td>
<td>${esc(n.reason || '(no reason)')}</td>
</tr>`).join('\n')}
</tbody>
</table>
`;
  }

  // Pending sidecars
  if (pendingSidecars.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#666">Pending Sidecars (${pendingSidecars.length})</h3>
<p style="margin-top:0;color:#666;font-size:11px">Escalations awaiting response in <code>~/.rfq-loading-pending/</code></p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:11px">
<thead style="background:#f5f5f5"><tr><th>Tracking</th><th>Missing/Reason</th><th>Age</th></tr></thead>
<tbody>
${pendingSidecars.slice(0, 15).map(s => {
  const age = s.ts ? Math.round((now - Date.parse(s.ts)) / (1000 * 60 * 60 * 24)) : '?';
  const info = s.missing ? (s.missing || []).join(', ') : (s.reason || '');
  return `<tr><td>${esc(s.trackingId || s.tracking_id || '?')}</td><td>${esc(info)}</td><td>${age}d</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  }

  html += `
<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by rfq-loading-daily-digest.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)}
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`Total RFQs: ${totalRfqs} (Stock: ${stockTotalFromDb}, Customer: ${nonStockFromDb})`);
    console.log(`Stock: ${stockLoaded.length} loaded from ${stockTotalEmails} emails`);
    console.log(`Customer: ${customerRfqsLoaded} loaded from ${customerEmailsProcessed} emails`);
    console.log(`By role (non-stock): ${[...byRole.entries()].map(([r, d]) => `${r}=${d.rfqs}`).join(' / ')}`);
    console.log('(Preview only — pass --send to email)');
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'rfqloading@orangetsunami.com',
    fromName: 'RFQ Loading — Daily Digest',
  });
  const today = new Date().toISOString().slice(0, 10);
  await notifier.sendEmail(
    RECIPIENTS,
    `RFQ Loading — Daily Digest (${today})`,
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENTS.join(', ')}`);
  console.log(`Total: ${totalRfqs} (Stock: ${stockTotalFromDb}, Customer: ${nonStockFromDb})`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
