#!/usr/bin/env node
//
// RFQ Loading — Daily Digest
//
// Scheduled daily at 8am EST (~12 UTC during DST, 13 UTC standard — DST drift
// acceptable per ops convention). Surfaces the previous 24 hours of RFQ
// loading activity to the operator for review.
//
// What the digest contains:
//   1. Summary stats — RFQs loaded, lines written, emails processed
//   2. Activity by loader — who loaded RFQs (Claude, support, salesreps)
//   3. Activity by route — enqueue→loaded, need_info, needs_review, not_rfq
//   4. Loaded RFQs table — per-RFQ detail (customer, type, lines, salesrep)
//   5. Customer breakdown — which customers had RFQs loaded
//   6. Pending escalations — need_info/needs_review sidecars awaiting response
//
// Usage:
//   node rfq-loading-daily-digest.js               # preview to stdout (no send)
//   node rfq-loading-daily-digest.js --send        # email operator
//   node rfq-loading-daily-digest.js --since 24    # custom window in hours
//   node rfq-loading-daily-digest.js --since 48    # backfill 2 days

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
  // CDT = UTC-5 during DST. Hard-coded for now — DST drift is OK.
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
function pullActivityByLoader(sinceTs, untilTs) {
  const sql =
    `SELECT u.ad_user_id, u.name, COUNT(*) AS rfqs, SUM(line_count) AS lines ` +
    `FROM ( ` +
    `  SELECT r.createdby, ` +
    `         (SELECT COUNT(*) FROM adempiere.chuboe_rfq_line rl ` +
    `          WHERE rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y') AS line_count ` +
    `  FROM adempiere.chuboe_rfq r ` +
    `  WHERE r.created >= '${sinceTs}'::timestamp AND r.created < '${untilTs}'::timestamp ` +
    `  AND r.isactive='Y' ` +
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

// Classify loader role
function roleFor(userId, name) {
  if (userId === CLAUDE_USER_ID) return 'Claude';
  // Check both VQ support AND RFQ support registries
  if (isKnownSupport(userId) || isKnownRfqSupport(userId)) return 'Support';
  if (isKnownBuyer(userId)) return 'Buyer';
  // Assume salesreps are everyone else who's not Claude/Support/Buyer
  return 'Salesrep';
}

(async () => {
  const now = Date.now();
  const sinceMs = now - SINCE_HOURS * 3600 * 1000;
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(now));

  // Load breadcrumbs in window
  const allBcs = loadBreadcrumbsSince(sinceMs);

  // Filter by cog
  const agentBcs = allBcs.filter(b => b.cog === 'rfq-loading-agent');
  const daemonBcs = allBcs.filter(b => b.cog === 'rfq-loader-daemon');

  // Categorize agent events
  const needInfo = agentBcs.filter(b => b.event === 'escalated-need_info');
  const needsReview = agentBcs.filter(b => b.event === 'escalated-needs_review');
  const directLoads = agentBcs.filter(b => b.event === 'rfq-loaded');
  const externalNeedInfo = agentBcs.filter(b => b.event === 'external-need-info-sent');
  const alreadyLoadedSkips = agentBcs.filter(b => b.event === 'already-loaded-skip');

  // Daemon events
  const daemonLoads = daemonBcs.filter(b => b.event === 'rfq-loaded');
  const confirmationsSent = daemonBcs.filter(b => b.event === 'confirmation-sent');
  const highFailureRates = daemonBcs.filter(b => b.event === 'high-failure-rate');

  // Total RFQs loaded (daemon + direct agent loads)
  const allLoads = [...daemonLoads, ...directLoads];
  const totalRfqsLoaded = allLoads.length;
  const totalLinesWritten = allLoads.reduce((a, b) => a + (b.linesWritten || 0), 0);

  // Activity by loader (from OT)
  const loaderActivity = pullActivityByLoader(sinceTs, untilTs);
  const totalFromDb = loaderActivity.reduce((a, l) => a + l.rfqs, 0);
  const totalLinesFromDb = loaderActivity.reduce((a, l) => a + l.lines, 0);

  // Group by role
  const byRole = new Map();
  for (const l of loaderActivity) {
    const role = roleFor(l.userId, l.name);
    if (!byRole.has(role)) byRole.set(role, { rfqs: 0, lines: 0, loaders: [] });
    byRole.get(role).rfqs += l.rfqs;
    byRole.get(role).lines += l.lines;
    byRole.get(role).loaders.push(l);
  }

  // Activity by route
  const routeCounts = {
    'enqueue → loaded': daemonLoads.length,
    'direct load (agent)': directLoads.length,
    'need_info': needInfo.length,
    'needs_review': needsReview.length,
    'already-loaded (skip)': alreadyLoadedSkips.length,
  };

  // Customer breakdown from loads
  const customerCounts = new Map();
  for (const load of confirmationsSent) {
    const customer = load.customer || '(unknown)';
    customerCounts.set(customer, (customerCounts.get(customer) || 0) + 1);
  }
  const topCustomers = [...customerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Salesrep breakdown
  const salesrepCounts = new Map();
  for (const load of confirmationsSent) {
    const seller = load.seller || '(unknown)';
    salesrepCounts.set(seller, (salesrepCounts.get(seller) || 0) + 1);
  }
  const topSalesreps = [...salesrepCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // RFQ type breakdown
  const typeCounts = new Map();
  for (const load of confirmationsSent) {
    const rfqType = load.rfqType || '(unknown)';
    typeCounts.set(rfqType, (typeCounts.get(rfqType) || 0) + 1);
  }

  // Pending sidecars (escalations awaiting response)
  const pendingSidecars = loadPendingSidecars();

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#25a;margin-bottom:4px">RFQ Loading — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)}</p>

<h3 style="margin-bottom:4px">Summary</h3>
<table border="0" cellpadding="4" cellspacing="0" style="font-size:13px">
<tr><td><b>RFQs created (OT):</b></td><td>${totalFromDb}</td></tr>
<tr><td><b>Lines written (OT):</b></td><td>${totalLinesFromDb.toLocaleString()}</td></tr>
<tr><td><b>Confirmations sent:</b></td><td>${confirmationsSent.length}</td></tr>
<tr><td><b>Emails processed:</b></td><td>${agentBcs.length}</td></tr>
</table>

<h3 style="margin-bottom:4px">Activity by Loader</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:500px">
<thead style="background:#eef"><tr><th align="left">Loader</th><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th></tr></thead>
<tbody>
${loaderActivity.map(l => {
  const role = roleFor(l.userId, l.name);
  const roleColor = role === 'Claude' ? '#4a4' : role === 'Support' ? '#88c' : role === 'Buyer' ? '#ca4' : '#222';
  const nameDisplay = l.userId === CLAUDE_USER_ID ? `<b>${esc(l.name)}</b>` : esc(l.name);
  return `<tr><td>${nameDisplay}</td><td style="color:${roleColor}"><i>${esc(role)}</i></td><td style="text-align:right">${l.rfqs}</td><td style="text-align:right">${l.lines.toLocaleString()}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td colspan="2"><b>Total</b></td><td style="text-align:right"><b>${totalFromDb}</b></td><td style="text-align:right"><b>${totalLinesFromDb.toLocaleString()}</b></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Legend: <span style="color:#4a4">Claude</span> = agent-loaded · <span style="color:#88c">Support</span> = RFQ support staff · <span style="color:#ca4">Buyer</span> = buyer manually created RFQ · <span style="color:#222">Salesrep</span> = salesrep direct entry. Based on chuboe_rfq.createdby.</i></p>
`;

  // Role summary
  if (byRole.size > 0) {
    html += `
<h3 style="margin-bottom:4px">Activity by Role</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th><th align="right">% of RFQs</th></tr></thead>
<tbody>
${[...byRole.entries()].sort((a, b) => b[1].rfqs - a[1].rfqs).map(([role, data]) => {
  const pct = totalFromDb > 0 ? Math.round(100 * data.rfqs / totalFromDb) : 0;
  const roleColor = role === 'Claude' ? '#4a4' : role === 'Support' ? '#88c' : role === 'Buyer' ? '#ca4' : '#222';
  return `<tr><td style="color:${roleColor}"><b>${esc(role)}</b></td><td style="text-align:right">${data.rfqs}</td><td style="text-align:right">${data.lines.toLocaleString()}</td><td style="text-align:right">${pct}%</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  }

  html += `
<h3 style="margin-bottom:4px">Activity by Route (Agent)</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Route</th><th align="right">Count</th></tr></thead>
<tbody>
${Object.entries(routeCounts).filter(([_, v]) => v > 0).map(([route, count]) => {
  const color = route.includes('loaded') ? '#2a5' : route === 'need_info' ? '#b80' : route === 'needs_review' ? '#b00' : '#666';
  return `<tr><td>${esc(route)}</td><td style="text-align:right;color:${color}"><b>${count}</b></td></tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Routes from rfqloading-agent breadcrumbs. "enqueue → loaded" = agent triaged + daemon wrote to OT.</i></p>
`;

  // Loaded RFQs detail
  if (confirmationsSent.length > 0) {
    html += `
<h3 style="margin-bottom:4px">Loaded RFQs (Confirmations Sent)</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr><th>RFQ</th><th>Customer</th><th>Type</th><th>Lines</th><th>Salesrep</th><th>Notified</th></tr></thead>
<tbody>
${confirmationsSent.slice(0, 30).map(c => {
  const notified = [c.to, ...(c.cc || [])].filter(Boolean).join(', ');
  return `<tr>
<td><b>${esc(c.searchKey)}</b></td>
<td>${esc(c.customer)}</td>
<td>${esc(c.rfqType)}</td>
<td style="text-align:right">${c.linesLoaded || 0}</td>
<td>${esc(c.seller)}</td>
<td style="font-size:11px">${esc(notified)}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
${confirmationsSent.length > 30 ? `<p style="color:#666;font-size:11px"><i>Showing first 30 of ${confirmationsSent.length} RFQs</i></p>` : ''}
`;
  } else {
    html += `<p style="color:#999"><i>No confirmation emails sent in this window.</i></p>`;
  }

  // Customer breakdown
  if (topCustomers.length > 0) {
    html += `
<h3 style="margin-bottom:4px">Top Customers</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Customer</th><th align="right">RFQs</th></tr></thead>
<tbody>
${topCustomers.map(([customer, count]) => `<tr><td>${esc(customer)}</td><td style="text-align:right"><b>${count}</b></td></tr>`).join('\n')}
</tbody>
</table>
`;
  }

  // Salesrep breakdown (from confirmations)
  if (topSalesreps.length > 0) {
    html += `
<h3 style="margin-bottom:4px">By Salesrep (Agent-Loaded)</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Salesrep</th><th align="right">RFQs</th></tr></thead>
<tbody>
${topSalesreps.map(([seller, count]) => `<tr><td>${esc(seller)}</td><td style="text-align:right"><b>${count}</b></td></tr>`).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Salesrep attribution from agent-loaded RFQs only (who the RFQ was loaded FOR).</i></p>
`;
  }

  // RFQ type breakdown
  if (typeCounts.size > 0) {
    html += `
<h3 style="margin-bottom:4px">By RFQ Type</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Type</th><th align="right">RFQs</th></tr></thead>
<tbody>
${[...typeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `<tr><td>${esc(type)}</td><td style="text-align:right"><b>${count}</b></td></tr>`).join('\n')}
</tbody>
</table>
`;
  }

  // Need info escalations in window
  if (needInfo.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b80">Need Info (${needInfo.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#fff3e0"><tr><th>UID</th><th>Tracking</th><th>Missing</th><th>External Sent?</th></tr></thead>
<tbody>
${needInfo.slice(0, 15).map(n => {
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
${needInfo.length > 15 ? `<p style="color:#666;font-size:11px"><i>Showing first 15 of ${needInfo.length}</i></p>` : ''}
`;
  }

  // Needs review escalations in window
  if (needsReview.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b00">Needs Review (${needsReview.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#fee"><tr><th>UID</th><th>Tracking</th><th>Reason</th></tr></thead>
<tbody>
${needsReview.slice(0, 15).map(n => `<tr>
<td>${n.uid}</td>
<td>${esc(n.trackingId)}</td>
<td>${esc(n.reason || '(no reason)')}</td>
</tr>`).join('\n')}
</tbody>
</table>
${needsReview.length > 15 ? `<p style="color:#666;font-size:11px"><i>Showing first 15 of ${needsReview.length}</i></p>` : ''}
`;
  }

  // Pending sidecars (awaiting response)
  if (pendingSidecars.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#666">Pending Sidecars (${pendingSidecars.length} awaiting response)</h3>
<p style="margin-top:0;color:#666;font-size:11px">These are need_info/needs_review escalations that haven't been resolved yet. Located in <code>~/.rfq-loading-pending/</code></p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:11px;width:100%">
<thead style="background:#f5f5f5"><tr><th>File</th><th>Tracking</th><th>Missing / Reason</th><th>Age</th></tr></thead>
<tbody>
${pendingSidecars.slice(0, 20).map(s => {
  const age = s.ts ? Math.round((now - Date.parse(s.ts)) / (1000 * 60 * 60 * 24)) : '?';
  const missingOrReason = s.missing ? (s.missing || []).join(', ') : (s.reason || '');
  return `<tr>
<td style="font-family:monospace;font-size:10px">${esc(s.filename.slice(0, 30))}...</td>
<td>${esc(s.trackingId || s.tracking_id || '')}</td>
<td>${esc(missingOrReason)}</td>
<td>${age}d</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
${pendingSidecars.length > 20 ? `<p style="color:#666;font-size:11px"><i>Showing first 20 of ${pendingSidecars.length}</i></p>` : ''}
`;
  }

  // High failure rate warnings
  if (highFailureRates.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b00">High Failure Rate Warnings</h3>
<ul style="font-size:12px">
${highFailureRates.map(h => `<li>RFQ ${esc(h.searchKey)}: ${esc(h.reason)} (severity: ${esc(h.severity)})</li>`).join('\n')}
</ul>
`;
  }

  html += `
<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by rfq-loading-daily-digest.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)} (CT-naive per chuboe_*.created convention).
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`RFQs (OT): ${totalFromDb} · Lines: ${totalLinesFromDb}`);
    console.log(`By role: ${[...byRole.entries()].map(([r, d]) => `${r}=${d.rfqs}`).join(' / ')}`);
    console.log(`Routes: enqueue→loaded=${daemonLoads.length} direct=${directLoads.length} need_info=${needInfo.length} needs_review=${needsReview.length}`);
    console.log(`Pending sidecars: ${pendingSidecars.length}`);
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
  console.log(`RFQs: ${totalFromDb} · By role: ${[...byRole.entries()].map(([r, d]) => `${r}=${d.rfqs}`).join(' / ')}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
