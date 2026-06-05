#!/usr/bin/env node
//
// Ivy Song — Daily VQ Loading Digest
//
// Sends a per-loader digest of VQs that Ivy Song (ad_user_id 1013784) wrote
// since the last successful digest. Scheduled daily at 6 PM Shenzhen local
// (UTC+8, no DST) = 10:00 UTC. Recipients: Ivy + Jake.
//
// Window: sentinel-driven ("since last digest"). State stored at
//   ~/workspace/.ivy-vq-digest-state.json   { lastDigestTs: ISO }
// On first run (no state file), defaults to last 24h. On --send success the
// state advances to the window end. A successful send with 0 VQs also advances
// state, so an empty day doesn't roll all the next day's activity into one
// double-sized digest.
//
// Output:
//   - HTML inline table (skim view, sorted newest first)
//   - xlsx attachment (full audit, one row per VQ)
//
// Columns per the operator's spec: RFQ, Seller, MPN, Price, Date Code, Notes,
// Buyer. Plus Created (CT) for ordering and Currency next to Price since some
// of Ivy's VQs are non-USD.
//
// Usage:
//   node ivy-vq-digest.js              # preview to stdout, no email, no state update
//   node ivy-vq-digest.js --send       # email + advance state
//   node ivy-vq-digest.js --since 48   # override window to N hours (does NOT advance state)
//   node ivy-vq-digest.js --reset-state # discard state file (next run = default 24h)

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
const { ImapFlow } = require('imapflow');
const { createNotifier } = require('../../../shared/notifier');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.ivy-vq-digest-state.json');
const BREADCRUMBS = path.join(process.env.HOME, 'workspace', '.offer-pipeline', 'breadcrumbs.jsonl');
const ATTRIBUTION_LOG = path.join(process.env.HOME, 'workspace', '.vq-batch-attribution.jsonl');
const IVY_USER_ID = 1013784;
const IVY_EMAIL = 'ivy.song@astutegroup.com';
const RECIPIENTS = ['jake.harris@astutegroup.com', 'ivy.song@astutegroup.com'];
const MAX_WINDOW_HOURS = 14 * 24; // safety cap if state file is very stale

// System-placeholder vendors that get auto-stamped to RFQ lines but are NOT
// quotes Ivy actually sourced. Confirmed 2026-05-21:
//   1009435 StockCQ          — Calcuquote Customer Excess auto-match
//   1008101 CalcuQuote       — CalcuQuote integration parent partner
// Excluded from the digest so it only shows quotes she actively requested.
const SYSTEM_VENDOR_IDS = [1009435, 1008101];

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const RESET_STATE = args.includes('--reset-state');
const sinceIdx = args.indexOf('--since');
const SINCE_OVERRIDE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : null;

if (RESET_STATE) {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  console.log(`Removed ${STATE_FILE}`);
  process.exit(0);
}

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// UTC Date → CT-naive timestamp string. CDT = UTC-5 during May 2026 (DST).
// DST drift is acceptable per the existing vq-loading-daily-digest convention.
function utcToCTNaive(d) {
  const ct = new Date(d.getTime() - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ct.getUTCFullYear()}-${pad(ct.getUTCMonth() + 1)}-${pad(ct.getUTCDate())} ${pad(ct.getUTCHours())}:${pad(ct.getUTCMinutes())}:${pad(ct.getUTCSeconds())}`;
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function determineWindow() {
  const now = Date.now();
  if (SINCE_OVERRIDE_HOURS != null) {
    return { sinceMs: now - SINCE_OVERRIDE_HOURS * 3600 * 1000, untilMs: now, source: `--since ${SINCE_OVERRIDE_HOURS}h` };
  }
  const state = readState();
  if (!state || !state.lastDigestTs) {
    return { sinceMs: now - 24 * 3600 * 1000, untilMs: now, source: 'first run (default 24h)' };
  }
  const last = Date.parse(state.lastDigestTs);
  const oldest = now - MAX_WINDOW_HOURS * 3600 * 1000;
  const sinceMs = Math.max(last, oldest);
  return { sinceMs, untilMs: now, source: sinceMs === oldest ? `state stale — capped at ${MAX_WINDOW_HOURS}h` : 'since last digest' };
}

// ─── Forwarder-scope: VQs the agent loaded from emails Ivy forwarded to vq@ ──
//
// The agent stamps `createdby = Claude (1049524)` on these, so the
// createdby-only filter misses them. The breadcrumb's `senderEmail` is the
// DEEPER actor (Tier-A chain walk per [[feedback_forwarder_vs_owner_pattern]])
// — when Ivy forwards Serena's quotes to vq@, the breadcrumb resolves to Serena
// and the load is attributed to Serena's buyer ID. To capture Ivy-as-forwarder
// we need the OUTER envelope From, which means an IMAP cross-ref by messageId.
//
// Pipeline:
//   1. Filter breadcrumbs to vq-loading-agent loaded events in window
//   2. IMAP-fetch outer-From for each unique messageId
//   3. Keep only breadcrumbs whose outer-From = ivy.song@astutegroup.com
//   4. From attribution.jsonl, collect vqLineIds for those sourceUids
//   5. Pull those vqLineIds into the main VQ query

function loadJsonlSince(filepath, sinceMs) {
  if (!fs.existsSync(filepath)) return [];
  const raw = fs.readFileSync(filepath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = Date.parse(obj.ts);
      if (Number.isFinite(ts) && ts >= sinceMs) out.push(obj);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

async function fetchOuterFromForMessageIds(messageIds) {
  if (!messageIds || messageIds.length === 0) return new Map();
  const result = new Map();
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    for (const folder of ['Processed', 'INBOX', 'NeedsReview', 'NoBid']) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          for (const mid of messageIds) {
            if (result.has(mid)) continue;
            try {
              const uids = await client.search({ header: { 'message-id': mid } }, { uid: true });
              if (!uids || uids.length === 0) continue;
              const msg = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
              if (!msg) continue;
              const from = (msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '';
              result.set(mid, { outerFrom: from.toLowerCase(), subject: msg.envelope.subject || '', folder });
            } catch (_) { /* skip per-message errors */ }
          }
        } finally { lock.release(); }
      } catch (_) { /* skip folder not accessible */ }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

// IMAP-search Ivy's outbound to vq@ within the window and return list of
// {messageId, date, subject}. Used as the source of truth for "did Ivy forward
// anything", and as the date-proximity fallback for breadcrumbs whose
// messageId is null (upstream agent path that doesn't populate it).
async function searchIvyEmailsInWindow(sinceMs) {
  const since = new Date(sinceMs);
  const result = [];
  const seenMids = new Set();
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    for (const folder of ['Processed', 'INBOX', 'NeedsReview', 'NoBid', 'NeedsVendor']) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await client.search({ from: 'ivy.song', since }, { uid: true });
          if (!uids || uids.length === 0) continue;
          for (const u of uids) {
            try {
              const m = await client.fetchOne(String(u), { envelope: true }, { uid: true });
              if (!m || !m.envelope) continue;
              const mid = m.envelope.messageId || null;
              const date = m.envelope.date;
              if (mid && seenMids.has(mid)) continue;
              if (mid) seenMids.add(mid);
              result.push({ messageId: mid, date: date ? date.getTime() : null, subject: m.envelope.subject || '', folder });
            } catch (_) { /* skip */ }
          }
        } finally { lock.release(); }
      } catch (_) { /* skip folder */ }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

async function collectForwardedVqIds(sinceMs) {
  const bcs = loadJsonlSince(BREADCRUMBS, sinceMs)
    .filter(b => b.cog === 'vq-loading-agent' && b.event === 'loaded');
  if (bcs.length === 0) return { ids: new Set(), uids: new Set(), via: { fastPath: 0, mid: 0, dateProx: 0 } };

  // Pass 1 — fast paths (no IMAP):
  //  (a) breadcrumb.outerFrom = Ivy   (after upstream 2026-05-21 fix lands)
  //  (b) breadcrumb.senderEmail = Ivy (Tier-A chain resolved to Ivy directly)
  const ivyUids = new Set();
  let viaFast = 0;
  for (const b of bcs) {
    const outer = (b.outerFrom || '').toLowerCase();
    const sender = (b.senderEmail || '').toLowerCase();
    if (outer === IVY_EMAIL || sender === IVY_EMAIL) {
      if (Number.isFinite(b.sourceUid)) { ivyUids.add(b.sourceUid); viaFast++; }
    }
  }

  // Pass 2 — IMAP messageId cross-ref for unresolved breadcrumbs with a known mid.
  const unresolved = bcs.filter(b => !ivyUids.has(b.sourceUid));
  const withMid = unresolved.filter(b => b.messageId);
  const lookupMids = [...new Set(withMid.map(b => b.messageId))];
  const mid2info = lookupMids.length ? await fetchOuterFromForMessageIds(lookupMids) : new Map();
  let viaMid = 0;
  for (const b of withMid) {
    const info = mid2info.get(b.messageId);
    if (info && info.outerFrom === IVY_EMAIL) {
      if (Number.isFinite(b.sourceUid)) { ivyUids.add(b.sourceUid); viaMid++; }
    }
  }

  // Pass 3 — date-proximity backfill for unresolved breadcrumbs whose messageId
  // is null (older breadcrumbs from before the upstream outerFrom fix). Search
  // vq@ for Ivy emails in window and match by (envelope.date ≤ breadcrumb.ts ≤
  // envelope.date + 60min). The agent runs every 5-15 min so loads typically
  // happen within ~30 min of the email landing. ±60 min is conservative.
  // Best-effort — won't catch every case but covers the common pattern.
  const stillUnresolved = bcs.filter(b => !ivyUids.has(b.sourceUid) && !b.messageId);
  let viaDate = 0;
  if (stillUnresolved.length > 0) {
    const ivyEmails = await searchIvyEmailsInWindow(sinceMs);
    const PROX_MS = 60 * 60 * 1000;
    for (const b of stillUnresolved) {
      const bts = Date.parse(b.ts);
      if (!Number.isFinite(bts)) continue;
      for (const e of ivyEmails) {
        if (!e.date) continue;
        if (bts >= e.date && bts <= e.date + PROX_MS) {
          if (Number.isFinite(b.sourceUid)) { ivyUids.add(b.sourceUid); viaDate++; }
          break;
        }
      }
    }
  }

  // Collect vqLineIds from attribution log for matched sourceUids.
  const attrib = loadJsonlSince(ATTRIBUTION_LOG, sinceMs);
  const ids = new Set();
  for (const a of attrib) {
    if (ivyUids.has(a.sourceUid) && Number.isFinite(a.vqLineId)) ids.add(a.vqLineId);
  }
  return { ids, uids: ivyUids, via: { fastPath: viaFast, mid: viaMid, dateProx: viaDate } };
}

function pullVQs(sinceTs, untilTs, forwardedIds) {
  // Source columns:
  //   r.value              → RFQ#
  //   cust.name            → Customer (RFQ seller - who we're quoting to)
  //   rl.chuboe_cpc        → Customer Part Code
  //   bp.name              → Vendor (supplier who quoted)
  //   v.chuboe_mpn         → MPN (as quoted by supplier)
  //   v.cost + c.iso_code  → Price + Currency
  //   v.chuboe_date_code   → Date Code
  //   v.chuboe_lead_time   → Lead Time (added — useful context alongside DC)
  //   v.chuboe_note_public / private / user → Notes (concatenated, public first)
  //   ub.name              → Buyer (chuboe_buyer_id, NOT createdby)
  //   v.created            → Created (CT)
  // Strip newlines + collapse pipes in any free-text field — psql's pipe-delimited
  // output breaks rows on embedded \n and confuses columns on embedded |.
  const scrub = (col) => `REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), E'[\\\\r\\\\n]+', ' ', 'g'), '\\\\|', '/', 'g')`;

  // Union of two scopes:
  //  (A) Ivy as direct loader  → v.createdby = IVY_USER_ID (excluding system vendors)
  //  (B) Ivy as forwarder      → v.chuboe_vq_line_id IN forwardedIds (collected
  //      via IMAP outer-From cross-ref before this function ran)
  const idClause = forwardedIds && forwardedIds.size > 0
    ? `OR v.chuboe_vq_line_id IN (${[...forwardedIds].join(',')})`
    : '';
  const sql =
    `SELECT v.chuboe_vq_line_id, r.value, ${scrub('cust.name')}, ${scrub('rl.chuboe_cpc')}, ${scrub('bp.name')}, ${scrub('v.chuboe_mpn')}, ` +
    `       v.cost, COALESCE(c.iso_code, ''), v.qty, ${scrub('v.chuboe_date_code')}, ${scrub('v.chuboe_lead_time')}, ` +
    `       ${scrub('v.chuboe_note_public')}, ${scrub('v.chuboe_note_private')}, ` +
    `       ${scrub('v.chuboe_note_user')}, ${scrub('ub.name')}, ${scrub('us.name')}, v.created, v.createdby ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `JOIN adempiere.c_bpartner cust ON r.c_bpartner_id = cust.c_bpartner_id ` +
    `JOIN adempiere.c_bpartner bp ON v.c_bpartner_id = bp.c_bpartner_id ` +
    `LEFT JOIN adempiere.c_currency c ON c.c_currency_id = v.c_currency_id ` +
    `LEFT JOIN adempiere.ad_user ub ON ub.ad_user_id = v.chuboe_buyer_id ` +
    `LEFT JOIN adempiere.ad_user us ON us.ad_user_id = r.salesrep_id ` +
    `WHERE v.isactive = 'Y' ` +
    `  AND v.c_bpartner_id NOT IN (${SYSTEM_VENDOR_IDS.join(',')}) ` +
    `  AND v.created >= '${sinceTs}'::timestamp ` +
    `  AND v.created <  '${untilTs}'::timestamp ` +
    `  AND (v.createdby = ${IVY_USER_ID} ${idClause}) ` +
    `ORDER BY cust.name, r.value, rl.chuboe_cpc, NULLIF(v.cost, 0) ASC NULLS LAST, v.created DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [vqId, rfq, customer, cpc, vendor, mpn, cost, currency, qty, dateCode, leadTime, noteP, noteX, noteU, buyer, seller, created, createdby] = line.split('|');
    const notes = [noteP, noteX, noteU].filter(Boolean).join(' | ').replace(/\r?\n/g, ' ').trim();
    const source = Number(createdby) === IVY_USER_ID ? 'manual' : 'forwarded';
    return {
      vqId: Number(vqId),
      rfq, customer, cpc, vendor, mpn,
      cost: cost ? Number(cost) : null,
      currency,
      qty: qty ? Number(qty) : null,
      dateCode: dateCode || '',
      leadTime: leadTime || '',
      notes,
      buyer: buyer || '',
      seller: seller || '',
      created,
      source,
    };
  });
}

function fmtPrice(cost, currency) {
  if (cost == null || !Number.isFinite(cost)) return '';
  // 4 decimal places for sub-dollar prices, 2 otherwise — passive prices look ridiculous at $0.05
  const decimals = cost < 1 ? 4 : 2;
  const formatted = cost.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const prefix = currency === 'USD' ? '$' : '';
  const suffix = currency && currency !== 'USD' ? ` ${currency}` : '';
  return `${prefix}${formatted}${suffix}`;
}

async function buildXlsx(vqs, windowStr) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ivy VQ Digest';
  wb.created = new Date();

  const ws = wb.addWorksheet('VQs');

  const cols = [
    { header: 'Customer',     key: 'customer',  width: 28 },
    { header: 'RFQ',          key: 'rfq',       width: 10 },
    { header: 'CPC',          key: 'cpc',       width: 24 },
    { header: 'Created (CT)', key: 'created',   width: 19 },
    { header: 'Source',       key: 'source',    width: 11 },
    { header: 'Vendor',       key: 'vendor',    width: 32 },
    { header: 'MPN',          key: 'mpn',       width: 24 },
    { header: 'Qty',          key: 'qty',       width: 10 },
    { header: 'Price',        key: 'cost',      width: 12 },
    { header: 'Curr',         key: 'currency',  width: 6  },
    { header: 'Date Code',    key: 'dateCode',  width: 12 },
    { header: 'Lead Time',    key: 'leadTime',  width: 14 },
    { header: 'Buyer',        key: 'buyer',     width: 18 },
    { header: 'Seller',       key: 'seller',    width: 18 },
    { header: 'Notes',        key: 'notes',     width: 50 },
    { header: 'VQ ID',        key: 'vqId',      width: 12 },
  ];
  ws.columns = cols;

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEFF' } };

  for (const v of vqs) {
    const row = ws.addRow({
      customer: v.customer,
      rfq: v.rfq,
      cpc: v.cpc,
      created: v.created || '',
      source: v.source,
      vendor: v.vendor,
      mpn: v.mpn,
      qty: v.qty,
      cost: v.cost,
      currency: v.currency,
      dateCode: v.dateCode,
      leadTime: v.leadTime,
      buyer: v.buyer,
      seller: v.seller,
      notes: v.notes,
      vqId: v.vqId,
    });
    if (v.source === 'forwarded') {
      row.getCell('source').font = { italic: true, color: { argb: 'FF888888' } };
    }
    if (v.qty != null) row.getCell('qty').numFmt = '#,##0';
    // Currency-aware price format
    const priceCell = row.getCell('cost');
    if (v.cost != null) {
      if (v.currency === 'USD' || !v.currency) {
        priceCell.numFmt = v.cost < 1 ? '$#,##0.0000' : '$#,##0.00';
      } else {
        priceCell.numFmt = v.cost < 1 ? '#,##0.0000' : '#,##0.00';
      }
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildHtml(vqs, windowStr, sourceLabel) {
  const sumByRfq = new Map();
  const sumByVendor = new Map();
  const sumByCustomer = new Map();
  let manualCount = 0, forwardedCount = 0;
  for (const v of vqs) {
    sumByRfq.set(v.rfq, (sumByRfq.get(v.rfq) || 0) + 1);
    sumByVendor.set(v.vendor, (sumByVendor.get(v.vendor) || 0) + 1);
    sumByCustomer.set(v.customer, (sumByCustomer.get(v.customer) || 0) + 1);
    if (v.source === 'manual') manualCount++; else forwardedCount++;
  }
  const distinctRfqs = sumByRfq.size;
  const distinctVendors = sumByVendor.size;
  const distinctCustomers = sumByCustomer.size;

  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">Ivy Song — Daily VQ Digest</h2>
<p style="margin-top:0;color:#666">${esc(windowStr)} · <i>${esc(sourceLabel)}</i></p>
<p style="margin:6px 0">
  <b>${vqs.length}</b> VQ${vqs.length === 1 ? '' : 's'} (${manualCount} manual + ${forwardedCount} forwarded) ·
  <b>${distinctCustomers}</b> customer${distinctCustomers === 1 ? '' : 's'} ·
  <b>${distinctRfqs}</b> RFQ${distinctRfqs === 1 ? '' : 's'} ·
  <b>${distinctVendors}</b> vendor${distinctVendors === 1 ? '' : 's'}
</p>`;

  if (vqs.length === 0) {
    html += `<p style="color:#999"><i>No VQs in this window.</i></p>`;
  } else {
    // Group by customer → RFQ → CPC (sorted lowest to highest price)
    let lastCustomer = null;
    let lastRfq = null;
    let lastCpc = null;

    html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr>
  <th align="left">Customer</th>
  <th align="left">RFQ</th>
  <th align="left">CPC</th>
  <th align="left">MPN</th>
  <th align="left">Vendor</th>
  <th align="right">Price</th>
  <th align="right">Qty</th>
  <th align="left">Date Code</th>
  <th align="left">Lead Time</th>
  <th align="left">Source</th>
  <th align="left">Buyer</th>
  <th align="left">Seller</th>
  <th align="left">Created (CT)</th>
  <th align="left">Notes</th>
</tr></thead>
<tbody>
${vqs.map((v, idx) => {
  const created = (v.created || '').slice(0, 19);
  const sourceCell = v.source === 'forwarded'
    ? `<i style="color:#888">fwd</i>`
    : `man`;

  // Visual breaks between groups
  const newCustomer = v.customer !== lastCustomer;
  const newRfq = v.rfq !== lastRfq;
  const newCpc = v.cpc !== lastCpc;

  // Heavy break for customer/RFQ change, light break for CPC change
  let rowStyle = '';
  if ((newCustomer || newRfq) && idx > 0) {
    rowStyle = ' style="border-top:3px solid #555"';
  } else if (newCpc && idx > 0) {
    rowStyle = ' style="border-top:1px solid #ccc"';
  }

  lastCustomer = v.customer;
  lastRfq = v.rfq;
  lastCpc = v.cpc;

  // Show customer/RFQ/CPC labels only on first row of each group
  const customerCell = newCustomer || newRfq ? `<b>${esc(v.customer)}</b>` : '';
  const rfqCell = newRfq ? `<b>${esc(v.rfq)}</b>` : '';
  const cpcCell = newCpc ? `<b>${esc(v.cpc || '')}</b>` : '';

  return `<tr${rowStyle}>
  <td>${customerCell}</td>
  <td>${rfqCell}</td>
  <td>${cpcCell}</td>
  <td>${esc(v.mpn)}</td>
  <td>${esc(v.vendor)}</td>
  <td align="right">${esc(fmtPrice(v.cost, v.currency))}</td>
  <td align="right">${v.qty != null ? v.qty.toLocaleString('en-US') : ''}</td>
  <td>${esc(v.dateCode)}</td>
  <td>${esc(v.leadTime)}</td>
  <td>${sourceCell}</td>
  <td style="font-size:10px">${esc(v.buyer || '?')}</td>
  <td style="font-size:10px">${esc(v.seller || '?')}</td>
  <td style="font-size:10px">${esc(created.slice(5))}</td>
  <td style="font-size:10px">${esc(v.notes)}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:6px"><i>Grouped by Customer → RFQ → CPC (sorted low→high price within each CPC). Heavy line = new customer/RFQ, light line = new CPC. Full audit in attached xlsx.</i></p>`;
  }

  html += `<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by ivy-vq-digest.js · Scheduled daily 10:00 UTC = 6 PM Shenzhen (Asia/Shanghai).<br/>
Loader scope: <code>createdby = ${IVY_USER_ID}</code> (Ivy Song).<br/>
Window labelled CT (chuboe_*.created storage convention).
</p></body></html>`;
  return html;
}

(async () => {
  const { sinceMs, untilMs, source } = determineWindow();
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(untilMs));
  const windowStr = `${sinceTs} CT → ${untilTs} CT`;

  console.log(`Window: ${windowStr} (${source})`);

  const { ids: forwardedIds, uids: forwardedUids, via } = await collectForwardedVqIds(sinceMs);
  if (forwardedIds.size > 0 || forwardedUids.size > 0) {
    console.log(`Ivy-forwarded UIDs: ${forwardedUids.size} (fast=${via.fastPath} mid=${via.mid} dateProx=${via.dateProx}) · forwarded vqLineIds: ${forwardedIds.size}`);
  }

  const vqs = pullVQs(sinceTs, untilTs, forwardedIds);
  const manual = vqs.filter(v => v.source === 'manual').length;
  const forwarded = vqs.length - manual;
  console.log(`VQs in window: ${vqs.length} (${manual} manual + ${forwarded} forwarded)`);

  const html = buildHtml(vqs, windowStr, source);
  const xlsxBuf = await buildXlsx(vqs, windowStr);

  if (!SEND) {
    const previewPath = path.join(__dirname, 'output', `ivy-vq-digest-preview-${Date.now()}.xlsx`);
    if (!fs.existsSync(path.dirname(previewPath))) fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, xlsxBuf);
    console.log(`Preview xlsx written: ${previewPath}`);
    console.log('--- HTML preview (first 2000 chars) ---');
    console.log(html.slice(0, 2000));
    console.log('(Preview only — pass --send to email and advance state)');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `ivy-vq-digest-${today}.xlsx`;

  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'Ivy VQ Digest',
  });

  const ok = await notifier.sendWithAttachment(
    RECIPIENTS.join(','),
    `Ivy VQ Digest — ${vqs.length} VQ${vqs.length === 1 ? '' : 's'} (${today})`,
    html,
    [{ filename, content: xlsxBuf }],
    { html: true },
  );

  if (!ok) {
    console.error('Email send failed — state NOT advanced');
    process.exit(1);
  }

  // Advance state only on successful send. Use the untilMs from THIS run as
  // the next run's lower bound — so anything created at-or-after untilMs lands
  // in the next digest. Empty windows also advance to avoid a runaway window.
  writeState({ lastDigestTs: new Date(untilMs).toISOString(), lastSentVqCount: vqs.length });
  console.log(`Sent to ${RECIPIENTS.join(', ')} — state advanced to ${new Date(untilMs).toISOString()}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
