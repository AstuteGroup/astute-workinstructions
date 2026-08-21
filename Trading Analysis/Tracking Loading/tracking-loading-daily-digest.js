#!/usr/bin/env node
//
// Tracking Loading — Daily Digest
//
// Unlike the VQ/RFQ Loading digests (which are scoped to what the Claude
// agent itself wrote, via breadcrumbs), this digest queries OT directly for
// ANY tracking number written to a purchase order line in the window —
// by the agent, by a buyer typing it in manually, by anyone. Breadcrumbs are
// only used for the secondary "agent activity" section (escalations +
// NeedsReview backlog snapshot).
//
// Also includes a Tracking Compliance by Buyer section: open (docstatus='IP')
// PO lines whose promise date has passed with still no tracking number,
// grouped by c_order.SalesRep_ID (the PO's buyer of record, not the VQ's —
// per operator: the PO is what matters). Claude Harris (autonomous LAM
// Kitting purchasing) is split into its own monitored-not-scored bucket.
// Lead list, not a violation list — see the in-email caveat re: OT not
// tracking actual receipts.
//
// Usage:
//   node tracking-loading-daily-digest.js               # preview to stdout
//   node tracking-loading-daily-digest.js --send        # email operator
//   node tracking-loading-daily-digest.js --since 24     # custom activity window (hours)
//   node tracking-loading-daily-digest.js --compliance-days 30  # custom compliance window (days)

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const { ImapFlow } = require('imapflow');
const { createNotifier } = require('../../shared/notifier');

const BREADCRUMBS = path.join(process.env.HOME, 'workspace', '.offer-pipeline', 'breadcrumbs.jsonl');
const RECIPIENTS = ['jake.harris@astutegroup.com'];
const CLAUDE_USER_ID = 1049524;

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const sinceIdx = args.indexOf('--since');
const SINCE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : 24;
const complianceDaysIdx = args.indexOf('--compliance-days');
const COMPLIANCE_DAYS = complianceDaysIdx >= 0 ? Number(args[complianceDaysIdx + 1]) : 30;

// row_to_json → one JSON object per line. Immune to embedded newlines/pipes
// in free-text fields (observed: some Chuboe_TrackingNumbers values contain
// pasted multi-line shipment notes, not just tracking tokens).
function psqlJsonRows(innerSql) {
  const sql = `SELECT row_to_json(t) FROM (${innerSql}) t;`;
  const out = execSync(`psql -U analytics_user -d idempiere_replica -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convert UTC Date → CT-naive timestamp string (matches chuboe_*.created/updated
// column storage convention — see shared/data-model.md § Time-Zone Convention).
function utcToCTNaive(d) {
  const ct = new Date(d.getTime() - 5 * 3600 * 1000); // CDT = UTC-5; DST drift acceptable per ops convention
  const pad = (n) => String(n).padStart(2, '0');
  return `${ct.getUTCFullYear()}-${pad(ct.getUTCMonth() + 1)}-${pad(ct.getUTCDate())} ${pad(ct.getUTCHours())}:${pad(ct.getUTCMinutes())}:${pad(ct.getUTCSeconds())}`;
}

function fmtCT(tsStr) {
  return tsStr ? `${tsStr} CT` : '';
}

// Lightweight display-only carrier guess — NOT the source of truth for
// extraction (that's done live by the agent reading the email). Just used
// to make the digest table readable.
function guessCarrier(token) {
  const t = String(token || '').trim().toUpperCase();
  if (/^1Z/.test(t)) return 'UPS';
  if (/^SF\d+$/.test(t)) return 'SF Express';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'FedEx';
  if (/^\d{20,22}$/.test(t)) return 'FedEx Ground';
  if (/^\d{10}$/.test(t)) return 'DHL';
  if (/^9\d{19,21}$/.test(t)) return 'USPS';
  return '?';
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

// All PO lines where a tracking number was written/changed in the window —
// regardless of who or what wrote it. This is the DB-truth source for the
// digest; it is NOT scoped to the Claude agent.
function pullTrackingActivity(sinceTs, untilTs) {
  const sql =
    `SELECT o.documentno, ol.chuboe_po_string AS pov, bp.name AS vendor, ol.chuboe_mpn AS mpn, ` +
    `       ol.chuboe_trackingnumbers AS tracking, ol.updated, ol.updatedby, COALESCE(u.name, 'unknown') AS "updatedByName" ` +
    `FROM adempiere.c_orderline ol ` +
    `JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id ` +
    `JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id ` +
    `LEFT JOIN adempiere.ad_user u ON u.ad_user_id = ol.updatedby ` +
    `WHERE o.issotrx = 'N' AND o.isactive = 'Y' AND ol.isactive = 'Y' ` +
    `  AND ol.chuboe_trackingnumbers IS NOT NULL AND ol.chuboe_trackingnumbers != '' ` +
    `  AND ol.updated >= '${sinceTs}'::timestamp AND ol.updated < '${untilTs}'::timestamp ` +
    `ORDER BY ol.updated DESC`;
  return psqlJsonRows(sql).map(r => ({
    documentno: r.documentno, pov: r.pov || null, vendor: r.vendor, mpn: r.mpn,
    tracking: r.tracking, updated: r.updated,
    updatedby: r.updatedby != null ? Number(r.updatedby) : null,
    updatedByName: r.updatedByName,
  }));
}

// Tracking compliance: open (docstatus='IP') PO lines whose promise date has
// already passed and which STILL have no tracking number. Grouped by
// c_order.salesrep_id — the buyer of record on the PO itself (NOT the VQ;
// per operator: PO is what matters, and VQ.chuboe_buyer_id is frequently
// unpopulated). Claude Harris (autonomous LAM Kitting purchasing) is split
// into its own bucket — legitimate buyer there, monitored not scored.
//
// Caveat (carried in the digest footer): OT does not track actual receipts
// (shared/data-model.md), so some of these lines may already be physically
// received without ever getting a tracking number logged — this is a lead
// list, not a violation list. Also scoped to a rolling recent window so it
// reflects current behavior, not the multi-year historical backlog (which
// is a separate one-time cleanup problem, not ongoing buyer accountability).
function pullTrackingCompliance(complianceDays) {
  const sql =
    `SELECT o.salesrep_id, COALESCE(u.name, '(no salesrep)') AS buyer, ` +
    `       o.documentno, ol.chuboe_mpn AS mpn, ol.datepromised::date AS promised, ` +
    `       (CURRENT_DATE - ol.datepromised::date) AS days_overdue ` +
    `FROM adempiere.c_orderline ol ` +
    `JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id ` +
    `LEFT JOIN adempiere.ad_user u ON u.ad_user_id = o.salesrep_id ` +
    `WHERE o.issotrx = 'N' AND o.isactive = 'Y' AND ol.isactive = 'Y' AND o.docstatus = 'IP' ` +
    `  AND ol.datepromised IS NOT NULL ` +
    `  AND ol.datepromised::date BETWEEN CURRENT_DATE - INTERVAL '${complianceDays} days' AND CURRENT_DATE ` +
    `  AND (ol.chuboe_trackingnumbers IS NULL OR ol.chuboe_trackingnumbers = '') ` +
    `ORDER BY days_overdue DESC`;
  return psqlJsonRows(sql).map(r => ({
    salesrepId: r.salesrep_id != null ? Number(r.salesrep_id) : null,
    buyer: r.buyer,
    documentno: r.documentno,
    mpn: r.mpn,
    promised: r.promised,
    daysOverdue: Number(r.days_overdue),
  }));
}

// Folder census: live total backlog per outcome folder, PLUS how many
// messages in NotTracking landed there within the window. (NeedsReview/
// Processed counts-in-window come from breadcrumbs instead, since those
// actions have handlers that log an event; not_tracking is move-only with
// no handler, so it leaves no breadcrumb — IMAP date is the only signal.)
async function pullFolderCensus(sinceMs) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'tracking@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const result = { backlog: {}, notTrackingInWindow: 0 };
  try {
    for (const folder of ['NeedsReview', 'NotTracking', 'Processed']) {
      try {
        const status = await client.status(folder, { messages: true });
        result.backlog[folder] = status.messages;
      } catch (_) { result.backlog[folder] = null; }
    }
    try {
      const lock = await client.getMailboxLock('NotTracking');
      try {
        const uids = await client.search({ all: true }, { uid: true });
        for (const uid of uids || []) {
          const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
          if (msg && msg.envelope && msg.envelope.date && msg.envelope.date.getTime() >= sinceMs) {
            result.notTrackingInWindow += 1;
          }
        }
      } finally { lock.release(); }
    } catch (_) { /* folder inaccessible — leave at 0 */ }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

(async () => {
  const now = Date.now();
  const sinceMs = now - SINCE_HOURS * 3600 * 1000;
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(now));

  const rows = pullTrackingActivity(sinceTs, untilTs);

  // Activity by loader (DB truth — includes anyone, not just Claude)
  const byLoader = new Map();
  for (const r of rows) {
    const key = r.updatedby === CLAUDE_USER_ID ? 'Claude (tracking-loading-agent)' : r.updatedByName;
    if (!byLoader.has(key)) byLoader.set(key, 0);
    byLoader.set(key, byLoader.get(key) + 1);
  }
  const loaderRows = [...byLoader.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.length;

  // Tracking compliance: overdue-and-untracked open PO lines, human buyers
  // vs Claude-autonomous, over a rolling window (default 30d).
  const complianceRows = pullTrackingCompliance(COMPLIANCE_DAYS);
  const complianceByBuyer = new Map(); // salesrepId -> { name, lines: [] }
  for (const r of complianceRows) {
    const key = r.salesrepId;
    if (!complianceByBuyer.has(key)) complianceByBuyer.set(key, { name: r.buyer, lines: [] });
    complianceByBuyer.get(key).lines.push(r);
  }
  const claudeCompliance = complianceByBuyer.get(CLAUDE_USER_ID) || null;
  const humanComplianceRows = [...complianceByBuyer.entries()]
    .filter(([id]) => id !== CLAUDE_USER_ID)
    .map(([id, v]) => ({ salesrepId: id, buyer: v.name, count: v.lines.length }))
    .sort((a, b) => b.count - a.count);

  // Activity by route (mirrors RFQ/VQ digest's "activity by route" section):
  // how many messages the agent routed to each outcome folder in this window.
  const bcs = loadBreadcrumbsSince(sinceMs).filter(b => b.cog === 'tracking-loading-agent');
  const escalated = bcs.filter(b => b.event && b.event.startsWith('escalated'));
  const processedByAgent = bcs.filter(b => ['tracking-loaded', 'tracking-loaded-multi', 'tracking-already-present'].includes(b.event));

  let census = { backlog: {}, notTrackingInWindow: 0 };
  try { census = await pullFolderCensus(sinceMs); } catch (_) { /* non-fatal */ }

  const routeRows = [
    { route: 'Processed', inWindow: processedByAgent.length, backlog: census.backlog.Processed },
    { route: 'NeedsReview', inWindow: escalated.length, backlog: census.backlog.NeedsReview },
    { route: 'NotTracking', inWindow: census.notTrackingInWindow, backlog: census.backlog.NotTracking },
  ];

  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">Tracking Loading — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)} · ${total} tracking number${total === 1 ? '' : 's'} written to OT (any source)</p>

<h3 style="margin-bottom:4px">Loaded by</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:400px">
<thead style="background:#eef"><tr><th align="left">Loader</th><th align="right">Tracking #s</th></tr></thead>
<tbody>
${loaderRows.map(([name, count]) => {
  const isClaude = name.startsWith('Claude');
  return `<tr><td>${isClaude ? '<b>' + esc(name) + '</b>' : esc(name)}</td><td style="text-align:right">${count}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td><b>Total</b></td><td style="text-align:right"><b>${total}</b></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Source: c_orderline.Chuboe_TrackingNumbers directly (updated timestamp in window) — includes manual entry by buyers, not just agent-driven loads.</i></p>
`;

  if (rows.length > 0) {
    html += `<h3 style="margin-bottom:4px">Detail</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr><th>PO</th><th>POV</th><th>Vendor</th><th>MPN</th><th>Tracking</th><th>Carrier</th><th>Loaded by</th><th>When</th></tr></thead>
<tbody>
${rows.map(r => {
  const tokens = r.tracking.split(',').map(s => s.trim()).filter(Boolean);
  const lastToken = tokens[tokens.length - 1]; // most recently appended
  const carrier = guessCarrier(lastToken);
  const loaderDisplay = r.updatedby === CLAUDE_USER_ID ? '<b>Claude</b>' : esc(r.updatedByName);
  return `<tr>
<td>${esc(r.documentno)}</td>
<td>${esc(r.pov || '')}</td>
<td>${esc(r.vendor)}</td>
<td>${esc(r.mpn)}</td>
<td>${esc(r.tracking).replace(/\n/g, '<br/>')}</td>
<td>${esc(carrier)}</td>
<td>${loaderDisplay}</td>
<td>${esc(fmtCT(r.updated))}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Carrier is a display-only guess from the last tracking token's format — not authoritative.</i></p>
`;
  } else {
    html += `<p style="color:#999"><i>No tracking numbers written to OT in this window.</i></p>`;
  }

  html += `<h3 style="margin-bottom:4px">Tracking Compliance by Buyer</h3>
<p style="margin-top:0;color:#666;font-size:11px">Open (in-progress) PO lines with a promise date in the last ${COMPLIANCE_DAYS} days that has already passed, and still no tracking number — by the PO's buyer of record (<code>c_order.SalesRep_ID</code>).</p>
`;

  if (humanComplianceRows.length > 0) {
    html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:400px">
<thead style="background:#eef"><tr><th align="left">Buyer</th><th align="right">Overdue, untracked lines</th></tr></thead>
<tbody>
${humanComplianceRows.map(b => `<tr><td>${esc(b.buyer)}</td><td style="text-align:right">${b.count}</td></tr>`).join('\n')}
</tbody>
</table>`;
  } else {
    html += `<p style="color:#4a4"><b>✓ No overdue untracked lines for any human buyer in this window.</b></p>`;
  }

  if (claudeCompliance) {
    html += `<p style="margin-top:8px;color:#666"><i>Claude (autonomous LAM Kitting purchasing) — monitored separately, not scored as buyer non-compliance: <b>${claudeCompliance.lines.length}</b> overdue, untracked line(s).</i></p>`;
  }

  html += `<p style="color:#666;font-size:11px;margin-top:4px"><i>Lead list, not a violation list — OT does not track actual receipts (see shared/data-model.md), so some of these lines may already be physically received without the tracking number ever getting logged. Scoped to a rolling ${COMPLIANCE_DAYS}-day window intentionally — older open lines reflect historical OT/Infor sync debt, not current buyer behavior, and are tracked separately.</i></p>
`;

  html += `<h3 style="margin-bottom:4px">Activity by route (tracking@orangetsunami.com)</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:500px">
<thead style="background:#eef"><tr><th align="left">Route</th><th align="right">In window</th><th align="right">Current backlog</th></tr></thead>
<tbody>
${routeRows.map(r => {
  const rowColor = r.route === 'NeedsReview' && r.backlog > 0 ? 'color:#b00' : '';
  return `<tr><td style="${rowColor}">${esc(r.route)}</td><td style="text-align:right">${r.inWindow}</td><td style="text-align:right;${rowColor}">${r.backlog == null ? '?' : r.backlog}</td></tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>"In window" = messages routed there in the last ${SINCE_HOURS}h (Processed/NeedsReview from agent breadcrumbs; NotTracking from IMAP envelope date, since that action has no handler to log a breadcrumb). "Current backlog" = live folder count, independent of window — a growing NeedsReview backlog across digests is the signal to look at.</i></p>
`;

  if (escalated.length > 0) {
    html += `<h4 style="margin-bottom:4px">Escalated to NeedsReview today</h4><ul>`;
    for (const e of escalated) {
      html += `<li><b>UID ${esc(e.uid)}</b> — ${esc(e.reason || e.event)}</li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by tracking-loading-daily-digest.js.<br/>
Window: ${esc(dispWindow)} (CT-naive per chuboe_*.updated convention).
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`Total: ${total} · Loaders: ${loaderRows.map(([n, c]) => `${n}=${c}`).join(' / ')}`);
    console.log(`Routes: ${routeRows.map(r => `${r.route} in-window=${r.inWindow} backlog=${r.backlog}`).join(' / ')}`);
    console.log(`Compliance (${COMPLIANCE_DAYS}d): ${humanComplianceRows.map(b => `${b.buyer}=${b.count}`).join(' / ') || 'none'} · Claude=${claudeCompliance ? claudeCompliance.lines.length : 0}`);
    console.log('(Preview only — pass --send to email)');
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'tracking@orangetsunami.com',
    fromName: 'Tracking Loading — Daily Digest',
  });
  const today = new Date().toISOString().slice(0, 10);
  await notifier.sendEmail(
    RECIPIENTS,
    `Tracking Loading — Daily Digest (${today})`,
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENTS.join(', ')}`);
  console.log(`Total: ${total} · Routes: ${routeRows.map(r => `${r.route} in-window=${r.inWindow} backlog=${r.backlog}`).join(' / ')}`);
  console.log(`Compliance (${COMPLIANCE_DAYS}d): ${humanComplianceRows.map(b => `${b.buyer}=${b.count}`).join(' / ') || 'none'} · Claude=${claudeCompliance ? claudeCompliance.lines.length : 0}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
