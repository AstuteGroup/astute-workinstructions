#!/usr/bin/env node
//
// RFQ Loading — Daily Digest
//
// Scheduled daily at 8am EST. Surfaces the previous 24 hours of RFQ
// loading activity to the operator for review.
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
const RFQ_LOAD_QUEUE = path.join(process.env.HOME, 'workspace', '.rfq-load-queue.json');
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

// Load failed jobs from the RFQ load queue
function loadFailedQueueItems() {
  if (!fs.existsSync(RFQ_LOAD_QUEUE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(RFQ_LOAD_QUEUE, 'utf8'));
    const items = data.items || [];
    return items.filter(item => item.status === 'error').map(item => ({
      id: item.id,
      trackingId: item.trackingId || item.payload?.trackingId || '(none)',
      enqueuedAt: item.enqueuedAt,
      lineCount: item.lineCount || item.payload?.lines?.length || 0,
      errors: item.errors || [],
      lastError: item.lastError,
      bpartnerId: item.payload?.bpartnerId,
      description: item.payload?.description,
      originalSender: item.payload?.originalSender,
    }));
  } catch (_) {
    return [];
  }
}

// Render failed jobs section as HTML
function renderFailedJobs(failedItems) {
  const rows = failedItems.map(item => {
    const errorText = item.lastError || (item.errors[0] || '').substring(0, 100);
    const enqueuedDate = item.enqueuedAt ? new Date(item.enqueuedAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
    return `<tr>
<td><b>${esc(item.trackingId)}</b></td>
<td>${esc(enqueuedDate)}</td>
<td style="text-align:right">${item.lineCount}</td>
<td style="color:#800;font-size:11px">${esc(errorText)}${errorText.length >= 100 ? '...' : ''}</td>
<td>${esc(item.originalSender || '(unknown)')}</td>
</tr>`;
  }).join('\n');

  return `
<h3 style="margin-bottom:4px;color:#b00">⚠️ FAILED QUEUE JOBS (${failedItems.length})</h3>
<p style="margin-top:0;color:#b00;font-size:12px"><b>These RFQs were NOT loaded and require manual intervention.</b></p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%;background:#fff5f5">
<thead style="background:#fdd"><tr><th>Tracking</th><th>Enqueued</th><th>Lines</th><th>Error</th><th>Sender</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px">Review via: <code>cat ~/.rfq-load-queue.json | jq '.items[] | select(.status=="error")'</code></p>
`;
}

// Look up RFQ metadata from OT using searchKeys — authoritative source
function pullRfqMetadataBySearchKeys(searchKeys) {
  if (!searchKeys || searchKeys.length === 0) return new Map();
  const escaped = searchKeys.map(k => `'${String(k).replace(/'/g, "''")}'`).join(',');
  const sql =
    `SELECT r.value AS search_key, bp.name AS customer, u.name AS salesrep, ` +
    `rt.name AS rfq_type, ` +
    `(SELECT COUNT(*) FROM adempiere.chuboe_rfq_line rl WHERE rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y') AS lines ` +
    `FROM adempiere.chuboe_rfq r ` +
    `LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = r.c_bpartner_id ` +
    `LEFT JOIN adempiere.ad_user u ON u.ad_user_id = r.salesrep_id ` +
    `LEFT JOIN adempiere.chuboe_rfq_type rt ON rt.chuboe_rfq_type_id = r.chuboe_rfq_type_id ` +
    `WHERE r.value IN (${escaped});`;  // Include deactivated for historical accuracy
  const out = psqlPipe(sql);
  const result = new Map();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [searchKey, customer, salesrep, rfqType, lines] = line.split('|');
    result.set(searchKey, {
      customer: customer || '(unknown)',
      salesrep: salesrep || '(unknown)',
      rfqType: rfqType || '(unknown)',
      lines: Number(lines) || 0,
    });
  }
  return result;
}

// Activity by loader from OT (all RFQs)
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
function roleFor(userId) {
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

  // Load breadcrumbs
  const allBcs = loadBreadcrumbsSince(sinceMs);

  // Stock RFQ emails (stockrfq-agent)
  const stockBcs = allBcs.filter(b => b.cog === 'stockrfq-agent');
  const stockEmails = new Set(stockBcs.map(b => b.uid)).size;
  const stockLoaded = stockBcs.filter(b => b.event === 'loaded').length;

  // Customer RFQ emails (rfqloading-agent + daemon)
  const agentBcs = allBcs.filter(b => b.cog === 'rfq-loading-agent');
  const daemonBcs = allBcs.filter(b => b.cog === 'rfq-loader-daemon');
  const customerEmails = new Set(agentBcs.map(b => b.uid)).size;

  const needInfo = agentBcs.filter(b => b.event === 'escalated-need_info');
  const needsReview = agentBcs.filter(b => b.event === 'escalated-needs_review');
  const externalNeedInfo = agentBcs.filter(b => b.event === 'external-need-info-sent');
  const daemonLoads = daemonBcs.filter(b => b.event === 'rfq-loaded');
  const confirmationsSent = daemonBcs.filter(b => b.event === 'confirmation-sent');

  // Total emails processed
  const totalEmails = stockEmails + customerEmails;

  // Activity by loader from OT
  const loaderActivity = pullActivityByLoader(sinceTs, untilTs);
  const totalRfqs = loaderActivity.reduce((a, l) => a + l.rfqs, 0);
  const totalLines = loaderActivity.reduce((a, l) => a + l.lines, 0);

  // Group by role
  const byRole = new Map();
  for (const l of loaderActivity) {
    const role = roleFor(l.userId);
    if (!byRole.has(role)) byRole.set(role, { rfqs: 0, lines: 0, loaders: [] });
    byRole.get(role).rfqs += l.rfqs;
    byRole.get(role).lines += l.lines;
    byRole.get(role).loaders.push(l);
  }

  // Pending sidecars
  const pendingSidecars = loadPendingSidecars();

  // Failed queue items — CRITICAL, show prominently
  const failedQueueItems = loadFailedQueueItems();

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;

  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#25a;margin-bottom:4px">RFQ Loading — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)}</p>

<h3 style="margin-bottom:4px">Summary</h3>
<table border="0" cellpadding="4" cellspacing="0" style="font-size:13px">
<tr><td><b>RFQs created:</b></td><td>${totalRfqs}</td></tr>
<tr><td><b>Lines written:</b></td><td>${totalLines.toLocaleString()}</td></tr>
<tr><td><b>Emails processed:</b></td><td>${totalEmails} (stock: ${stockEmails}, customer: ${customerEmails})</td></tr>
${failedQueueItems.length > 0 ? `<tr><td><b style="color:#b00">⚠️ Failed jobs:</b></td><td style="color:#b00"><b>${failedQueueItems.length}</b> (see below)</td></tr>` : ''}
</table>

${failedQueueItems.length > 0 ? renderFailedJobs(failedQueueItems) : ''}

<h3 style="margin-bottom:4px">Activity by Loader</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:500px">
<thead style="background:#eef"><tr><th align="left">Loader</th><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th></tr></thead>
<tbody>
${loaderActivity.map(l => {
  const role = roleFor(l.userId);
  const roleColor = role === 'Claude' ? '#4a4' : role === 'Support' ? '#88c' : role === 'Buyer' ? '#ca4' : '#222';
  const nameDisplay = l.userId === CLAUDE_USER_ID ? `<b>${esc(l.name)}</b>` : esc(l.name);
  return `<tr><td>${nameDisplay}</td><td style="color:${roleColor}"><i>${esc(role)}</i></td><td style="text-align:right">${l.rfqs}</td><td style="text-align:right">${l.lines.toLocaleString()}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td colspan="2"><b>Total</b></td><td style="text-align:right"><b>${totalRfqs}</b></td><td style="text-align:right"><b>${totalLines.toLocaleString()}</b></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Legend: <span style="color:#4a4">Claude</span> = agent-loaded (stock + customer) · <span style="color:#88c">Support</span> = RFQ support staff · <span style="color:#222">Salesrep</span> = direct entry</i></p>

<h3 style="margin-bottom:4px">Activity by Role</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">Role</th><th align="right">RFQs</th><th align="right">Lines</th><th align="right">%</th></tr></thead>
<tbody>
${[...byRole.entries()].sort((a, b) => b[1].rfqs - a[1].rfqs).map(([role, data]) => {
  const pct = totalRfqs > 0 ? Math.round(100 * data.rfqs / totalRfqs) : 0;
  const roleColor = role === 'Claude' ? '#4a4' : role === 'Support' ? '#88c' : role === 'Buyer' ? '#ca4' : '#222';
  return `<tr><td style="color:${roleColor}"><b>${esc(role)}</b></td><td style="text-align:right">${data.rfqs}</td><td style="text-align:right">${data.lines.toLocaleString()}</td><td style="text-align:right">${pct}%</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;

  // Customer RFQ confirmations — look up authoritative data from OT
  if (confirmationsSent.length > 0) {
    const searchKeys = confirmationsSent.slice(0, 20).map(c => c.searchKey).filter(Boolean);
    const rfqMetadata = pullRfqMetadataBySearchKeys(searchKeys);

    html += `
<h3 style="margin-bottom:4px">Customer RFQs Loaded (via rfqloading@)</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr><th>RFQ</th><th>Customer</th><th>Type</th><th>Lines</th><th>Salesrep</th></tr></thead>
<tbody>
${confirmationsSent.slice(0, 20).map(c => {
  const meta = rfqMetadata.get(c.searchKey) || {};
  return `<tr>
<td><b>${esc(c.searchKey)}</b></td>
<td>${esc(meta.customer || c.customer || '(unknown)')}</td>
<td>${esc(meta.rfqType || c.rfqType || '(unknown)')}</td>
<td style="text-align:right">${meta.lines || c.linesLoaded || 0}</td>
<td>${esc(meta.salesrep || c.seller || '(unknown)')}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
${confirmationsSent.length > 20 ? `<p style="color:#666;font-size:11px"><i>Showing first 20 of ${confirmationsSent.length}</i></p>` : ''}
`;
  }

  // Escalations
  if (needInfo.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b80">Need Info (${needInfo.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#fff3e0"><tr><th>UID</th><th>Tracking</th><th>Missing</th><th>External?</th></tr></thead>
<tbody>
${needInfo.slice(0, 10).map(n => {
  const ext = externalNeedInfo.find(e => e.uid === n.uid);
  return `<tr><td>${n.uid}</td><td>${esc(n.trackingId)}</td><td>${esc((n.missing || []).join(', '))}</td><td>${ext ? 'Yes' : 'No'}</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  }

  if (needsReview.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#b00">Needs Review (${needsReview.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#fee"><tr><th>UID</th><th>Tracking</th><th>Reason</th></tr></thead>
<tbody>
${needsReview.slice(0, 10).map(n => `<tr><td>${n.uid}</td><td>${esc(n.trackingId)}</td><td>${esc(n.reason || '')}</td></tr>`).join('\n')}
</tbody>
</table>
`;
  }

  if (pendingSidecars.length > 0) {
    html += `
<h3 style="margin-bottom:4px;color:#666">Pending Sidecars (${pendingSidecars.length})</h3>
<p style="margin-top:0;color:#666;font-size:11px">Escalations awaiting response</p>
`;
  }

  html += `
<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by rfq-loading-daily-digest.js · Window: ${esc(dispWindow)}
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`RFQs: ${totalRfqs} · Lines: ${totalLines}`);
    console.log(`Emails: ${totalEmails} (stock: ${stockEmails}, customer: ${customerEmails})`);
    console.log(`By role: ${[...byRole.entries()].map(([r, d]) => `${r}=${d.rfqs}`).join(' / ')}`);
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
  console.log(`RFQs: ${totalRfqs} · By role: ${[...byRole.entries()].map(([r, d]) => `${r}=${d.rfqs}`).join(' / ')}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
