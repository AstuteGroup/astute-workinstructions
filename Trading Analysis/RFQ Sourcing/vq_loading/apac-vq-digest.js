#!/usr/bin/env node
//
// APAC Team — Daily VQ Loading Digest
//
// Sends a daily digest of VQs loaded by the APAC buying team (8 buyers + 2 support).
// Scheduled daily at 6 PM Shenzhen local (UTC+8, no DST) = 10:00 UTC.
//
// Team roster:
//   Buyers:  Ivy Song, Serena Zhang, Feong Chang, Elaine Liang,
//            May Wu, Tracy Xie, Betty Song, Grace Zheng
//   Support: Gopalakrishnan, Lathis (load VQs on behalf of APAC buyers)
//
// Window: sentinel-driven ("since last digest"). State stored at
//   ~/workspace/.apac-vq-digest-state.json   { lastDigestTs: ISO }
// On first run (no state file), defaults to last 24h. On --send success the
// state advances to the window end. A successful send with 0 VQs also advances
// state, so an empty day doesn't roll all the next day's activity into one
// double-sized digest.
//
// Output:
//   - HTML inline table (skim view, grouped by Customer → RFQ → CPC)
//   - xlsx attachment (full audit, one row per VQ)
//
// Usage:
//   node apac-vq-digest.js              # preview to stdout, no email, no state update
//   node apac-vq-digest.js --send       # email + advance state
//   node apac-vq-digest.js --since 48   # override window to N hours (does NOT advance state)
//   node apac-vq-digest.js --reset-state # discard state file (next run = default 24h)

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
const { ImapFlow } = require('imapflow');
const { createNotifier } = require('../../../shared/notifier');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.apac-vq-digest-state.json');
const BREADCRUMBS = path.join(process.env.HOME, 'workspace', '.offer-pipeline', 'breadcrumbs.jsonl');
const ATTRIBUTION_LOG = path.join(process.env.HOME, 'workspace', '.vq-batch-attribution.jsonl');

// ─── APAC Team Roster ───────────────────────────────────────────────────────
// Buyers: their VQs appear in the digest; their forwards to vq@ are tracked
// Support: load VQs on behalf of buyers; their createdby VQs appear in digest
const APAC_TEAM = {
  buyers: [
    { id: 1013784, name: 'Ivy Song',      email: 'ivy.song@astutegroup.com' },
    { id: 1018538, name: 'Serena Zhang',  email: 'serena.zhang@astutegroup.com' },
    { id: 1005190, name: 'Feong Chang',   email: 'feong.chang@astutegroup.com' },
    { id: 1006326, name: 'Elaine Liang',  email: 'elaine.liang@astutegroup.com' },
    { id: 1019425, name: 'May Wu',        email: 'may.wu@astutegroup.com' },
    { id: 1009477, name: 'Tracy Xie',     email: 'tracy.xie@astutegroup.com' },
    { id: 1011159, name: 'Betty Song',    email: 'betty.song@astutegroup.com' },
    { id: 1034720, name: 'Grace Zheng',   email: 'grace.zheng@astutegroup.com' },
  ],
  support: [
    { id: 1016166, name: 'Gopalakrishnan', email: null },
    { id: 1016167, name: 'Lathis',         email: null },
  ],
};

// All user IDs whose createdby VQs should appear in the digest (loaders)
const APAC_USER_IDS = [
  ...APAC_TEAM.buyers.map(b => b.id),
  ...APAC_TEAM.support.map(s => s.id),
];

// Buyer IDs for filtering by assigned buyer (chuboe_buyer_id)
const APAC_BUYER_IDS = APAC_TEAM.buyers.map(b => b.id);

// Buyer emails for forwarder detection (support don't forward to vq@)
const APAC_EMAILS = APAC_TEAM.buyers.map(b => b.email.toLowerCase());

// Recipients (Jake + Ivy for now)
const RECIPIENTS = ['jake.harris@astutegroup.com', 'ivy.song@astutegroup.com'];

const MAX_WINDOW_HOURS = 14 * 24; // safety cap if state file is very stale

// System-placeholder vendors that get auto-stamped to RFQ lines but are NOT
// quotes the team actually sourced:
//   1009435 StockCQ          — Calcuquote Customer Excess auto-match
//   1008101 CalcuQuote       — CalcuQuote integration parent partner
const SYSTEM_VENDOR_IDS = [1009435, 1008101];

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const RESET_STATE = args.includes('--reset-state');
const TEST_MODE = args.includes('--test');  // Use 24h window ending at scheduled send time (10:00 UTC)
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

// UTC Date → CT-naive timestamp string. CDT = UTC-5 during DST.
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

  // --test mode: use 24h window ending at scheduled send time (10:00 UTC)
  if (TEST_MODE) {
    const today10UTC = new Date();
    today10UTC.setUTCHours(10, 0, 0, 0);
    // If it's before 10:00 UTC today, use yesterday's 10:00 UTC as the end
    const untilMs = today10UTC.getTime() <= now ? today10UTC.getTime() : today10UTC.getTime() - 24 * 3600 * 1000;
    const sinceMs = untilMs - 24 * 3600 * 1000;
    return { sinceMs, untilMs, source: '--test (24h ending at scheduled 10:00 UTC)' };
  }

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

// ─── Forwarder-scope: VQs the agent loaded from emails APAC buyers forwarded to vq@ ──
//
// The agent stamps `createdby = Claude (1049524)` on these, so the
// createdby-only filter misses them. We detect APAC-forwarded emails via:
//   1. breadcrumb.outerFrom or senderEmail matches an APAC buyer email
//   2. IMAP cross-ref by messageId for the outer envelope From
//   3. Date-proximity fallback for older breadcrumbs without messageId

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

// IMAP-search for emails from any APAC buyer to vq@ within the window
async function searchApacEmailsInWindow(sinceMs) {
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
          // Search for emails from any APAC buyer (by domain, then filter)
          const uids = await client.search({ from: '@astutegroup.com', since }, { uid: true });
          if (!uids || uids.length === 0) continue;
          for (const u of uids) {
            try {
              const m = await client.fetchOne(String(u), { envelope: true }, { uid: true });
              if (!m || !m.envelope) continue;
              const fromAddr = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
              // Only keep if from an APAC buyer
              if (!APAC_EMAILS.includes(fromAddr.toLowerCase())) continue;
              const mid = m.envelope.messageId || null;
              const date = m.envelope.date;
              if (mid && seenMids.has(mid)) continue;
              if (mid) seenMids.add(mid);
              result.push({
                messageId: mid,
                date: date ? date.getTime() : null,
                subject: m.envelope.subject || '',
                folder,
                fromEmail: fromAddr.toLowerCase(),
              });
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
  //  (a) breadcrumb.outerFrom = APAC buyer email
  //  (b) breadcrumb.senderEmail = APAC buyer email
  const apacUids = new Set();
  let viaFast = 0;
  for (const b of bcs) {
    const outer = (b.outerFrom || '').toLowerCase();
    const sender = (b.senderEmail || '').toLowerCase();
    if (APAC_EMAILS.includes(outer) || APAC_EMAILS.includes(sender)) {
      if (Number.isFinite(b.sourceUid)) { apacUids.add(b.sourceUid); viaFast++; }
    }
  }

  // Pass 2 — IMAP messageId cross-ref for unresolved breadcrumbs with a known mid.
  const unresolved = bcs.filter(b => !apacUids.has(b.sourceUid));
  const withMid = unresolved.filter(b => b.messageId);
  const lookupMids = [...new Set(withMid.map(b => b.messageId))];
  const mid2info = lookupMids.length ? await fetchOuterFromForMessageIds(lookupMids) : new Map();
  let viaMid = 0;
  for (const b of withMid) {
    const info = mid2info.get(b.messageId);
    if (info && APAC_EMAILS.includes(info.outerFrom)) {
      if (Number.isFinite(b.sourceUid)) { apacUids.add(b.sourceUid); viaMid++; }
    }
  }

  // Pass 3 — date-proximity backfill for unresolved breadcrumbs whose messageId
  // is null (older breadcrumbs from before the upstream outerFrom fix).
  const stillUnresolved = bcs.filter(b => !apacUids.has(b.sourceUid) && !b.messageId);
  let viaDate = 0;
  if (stillUnresolved.length > 0) {
    const apacEmails = await searchApacEmailsInWindow(sinceMs);
    const PROX_MS = 60 * 60 * 1000;
    for (const b of stillUnresolved) {
      const bts = Date.parse(b.ts);
      if (!Number.isFinite(bts)) continue;
      for (const e of apacEmails) {
        if (!e.date) continue;
        if (bts >= e.date && bts <= e.date + PROX_MS) {
          if (Number.isFinite(b.sourceUid)) { apacUids.add(b.sourceUid); viaDate++; }
          break;
        }
      }
    }
  }

  // Collect vqLineIds from attribution log for matched sourceUids.
  const attrib = loadJsonlSince(ATTRIBUTION_LOG, sinceMs);
  const ids = new Set();
  for (const a of attrib) {
    if (apacUids.has(a.sourceUid) && Number.isFinite(a.vqLineId)) ids.add(a.vqLineId);
  }
  return { ids, uids: apacUids, via: { fastPath: viaFast, mid: viaMid, dateProx: viaDate } };
}

// Map user ID to name for source column display
const USER_ID_TO_NAME = new Map([
  ...APAC_TEAM.buyers.map(b => [b.id, b.name]),
  ...APAC_TEAM.support.map(s => [s.id, s.name]),
]);

function pullVQs(sinceTs, untilTs, forwardedIds) {
  const scrub = (col) => `REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), E'[\\\\r\\\\n]+', ' ', 'g'), '\\\\|', '/', 'g')`;

  // Union of two scopes:
  //  (A) APAC team as direct loaders → v.createdby IN (APAC_USER_IDS)
  //  (B) APAC buyers as forwarders   → v.chuboe_vq_line_id IN forwardedIds
  const idClause = forwardedIds && forwardedIds.size > 0
    ? `OR v.chuboe_vq_line_id IN (${[...forwardedIds].join(',')})`
    : '';
  const sql =
    `SELECT v.chuboe_vq_line_id, r.value, ${scrub('rt.name')}, ${scrub('cust.name')}, ${scrub('rl.chuboe_cpc')}, ${scrub('bp.name')}, ${scrub('v.chuboe_mpn')}, ` +
    `       v.cost, COALESCE(c.iso_code, ''), v.qty, ${scrub('v.chuboe_date_code')}, ${scrub('v.chuboe_lead_time')}, ` +
    `       ${scrub('v.chuboe_note_public')}, ${scrub('v.chuboe_note_private')}, ` +
    `       ${scrub('v.chuboe_note_user')}, ${scrub('ub.name')}, ${scrub('us.name')}, v.created, v.createdby, ` +
    `       v.chuboe_rfq_line_id, v.c_bpartner_id ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `LEFT JOIN adempiere.chuboe_rfq_type rt ON rt.chuboe_rfq_type_id = r.chuboe_rfq_type_id ` +
    `JOIN adempiere.c_bpartner cust ON r.c_bpartner_id = cust.c_bpartner_id ` +
    `JOIN adempiere.c_bpartner bp ON v.c_bpartner_id = bp.c_bpartner_id ` +
    `LEFT JOIN adempiere.c_currency c ON c.c_currency_id = v.c_currency_id ` +
    `LEFT JOIN adempiere.ad_user ub ON ub.ad_user_id = v.chuboe_buyer_id ` +
    `LEFT JOIN adempiere.ad_user us ON us.ad_user_id = r.salesrep_id ` +
    `WHERE v.isactive = 'Y' ` +
    `  AND v.c_bpartner_id NOT IN (${SYSTEM_VENDOR_IDS.join(',')}) ` +
    `  AND v.created >= '${sinceTs}'::timestamp ` +
    `  AND v.created <  '${untilTs}'::timestamp ` +
    `  AND v.chuboe_buyer_id IN (${APAC_BUYER_IDS.join(',')}) ` +
    `ORDER BY cust.name, r.value, rl.chuboe_cpc, NULLIF(v.cost, 0) ASC NULLS LAST, v.created DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [vqId, rfq, rfqType, customer, cpc, vendor, mpn, cost, currency, qty, dateCode, leadTime, noteP, noteX, noteU, buyer, seller, created, createdby, rfqLineId, vendorId] = line.split('|');
    const notes = [noteP, noteX, noteU].filter(Boolean).join(' | ').replace(/\r?\n/g, ' ').trim();
    const createdbyId = Number(createdby);
    // Source: show loader name if APAC team member, otherwise 'Buyer → Claude' (forwarded to vq@ for Claude to load)
    const loaderName = USER_ID_TO_NAME.get(createdbyId);
    const source = loaderName || 'Buyer → Claude';
    return {
      vqId: Number(vqId),
      rfq,
      rfqType: rfqType || '',
      customer, cpc, vendor, mpn,
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
      createdbyId,
      rfqLineId: Number(rfqLineId),
      vendorId: Number(vendorId),
    };
  });
}

// Detect duplicate VQs: same RFQ line + vendor + MPN loaded by both Claude and a manual loader
const CLAUDE_USER_ID = 1049524;
function detectDuplicates(vqs) {
  // Group by rfqLineId + vendorId + normalized MPN
  const groups = new Map();
  for (const v of vqs) {
    const key = `${v.rfqLineId}|${v.vendorId}|${(v.mpn || '').toUpperCase().replace(/[-\s]/g, '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  // Find groups with both Claude-loaded and manually-loaded VQs
  const duplicates = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const hasClaudeLoaded = group.some(v => v.createdbyId === CLAUDE_USER_ID);
    const hasManualLoaded = group.some(v => v.createdbyId !== CLAUDE_USER_ID);
    if (hasClaudeLoaded && hasManualLoaded) {
      // Sort by created timestamp to determine who loaded first
      const sorted = [...group].sort((a, b) => (a.created || '').localeCompare(b.created || ''));
      const first = sorted[0];
      const rest = sorted.slice(1);
      duplicates.push({
        key,
        vqs: group,
        rfq: group[0].rfq,
        cpc: group[0].cpc,
        vendor: group[0].vendor,
        mpn: group[0].mpn,
        firstLoader: first.source,
        duplicatedBy: [...new Set(rest.map(v => v.source))].join(', '),
      });
    }
  }
  return duplicates;
}

function fmtPrice(cost, currency) {
  if (cost == null || !Number.isFinite(cost)) return '';
  const decimals = cost < 1 ? 4 : 2;
  const formatted = cost.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const prefix = currency === 'USD' ? '$' : '';
  const suffix = currency && currency !== 'USD' ? ` ${currency}` : '';
  return `${prefix}${formatted}${suffix}`;
}

async function buildXlsx(vqs, windowStr) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'APAC VQ Digest';
  wb.created = new Date();

  const ws = wb.addWorksheet('VQs');

  const cols = [
    { header: 'Customer',     key: 'customer',  width: 28 },
    { header: 'RFQ',          key: 'rfq',       width: 10 },
    { header: 'RFQ Type',     key: 'rfqType',   width: 12 },
    { header: 'CPC',          key: 'cpc',       width: 24 },
    { header: 'Vendor',       key: 'vendor',    width: 32 },
    { header: 'MPN',          key: 'mpn',       width: 24 },
    { header: 'Qty',          key: 'qty',       width: 10 },
    { header: 'Price',        key: 'cost',      width: 12 },
    { header: 'Curr',         key: 'currency',  width: 6  },
    { header: 'Date Code',    key: 'dateCode',  width: 12 },
    { header: 'Lead Time',    key: 'leadTime',  width: 14 },
    { header: 'Notes',        key: 'notes',     width: 50 },
    { header: 'Buyer',        key: 'buyer',     width: 18 },
    { header: 'Seller',       key: 'seller',    width: 18 },
    { header: 'Loader',       key: 'source',    width: 16 },
    { header: 'VQ ID',        key: 'vqId',      width: 12 },
    { header: 'Created (CT)', key: 'created',   width: 19 },
  ];
  ws.columns = cols;

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEFF' } };

  for (const v of vqs) {
    const row = ws.addRow({
      customer: v.customer,
      rfq: v.rfq,
      rfqType: v.rfqType,
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
    // Style forwarded rows differently
    if (v.source === 'forwarded') {
      row.getCell('source').font = { italic: true, color: { argb: 'FF888888' } };
    }
    if (v.qty != null) row.getCell('qty').numFmt = '#,##0';
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

function buildHtml(vqs, windowStr, sourceLabel, duplicates = []) {
  // Summary stats (buyer + loader activity focus)
  const sumByRfq = new Set();        // unique RFQs
  const sumByVendor = new Set();     // unique vendors
  const sumByCustomer = new Set();   // unique customers
  const sumByLoader = new Map();     // loader -> count
  const sumByBuyer = new Map();      // buyer -> count
  for (const v of vqs) {
    sumByRfq.add(v.rfq);
    sumByCustomer.add(v.customer);
    sumByVendor.add(v.vendor);
    sumByLoader.set(v.source, (sumByLoader.get(v.source) || 0) + 1);
    if (v.buyer) sumByBuyer.set(v.buyer, (sumByBuyer.get(v.buyer) || 0) + 1);
  }

  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">APAC Team — Daily VQ Digest</h2>
<p style="margin-top:0;color:#666">${esc(windowStr)} · <i>${esc(sourceLabel)}</i></p>
<p style="margin:6px 0">
  <b>${vqs.length}</b> VQ${vqs.length === 1 ? '' : 's'} ·
  <b>${sumByCustomer.size}</b> customer${sumByCustomer.size === 1 ? '' : 's'} ·
  <b>${sumByRfq.size}</b> RFQ${sumByRfq.size === 1 ? '' : 's'} ·
  <b>${sumByVendor.size}</b> vendor${sumByVendor.size === 1 ? '' : 's'}
</p>`;

  // Show duplicate warning if any
  if (duplicates.length > 0) {
    html += `
<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:8px 12px;margin:12px 0">
  <b style="color:#856404">⚠ ${duplicates.length} potential duplicate${duplicates.length === 1 ? '' : 's'}</b>
  <span style="color:#856404;font-size:12px"> — same RFQ line + vendor + MPN loaded twice</span>
  <table border="0" cellpadding="4" cellspacing="0" style="margin-top:8px;font-size:11px;color:#856404">
    <tr style="font-weight:bold"><td>RFQ</td><td>CPC</td><td>Vendor</td><td>MPN</td><td>First</td><td>Duplicated by</td></tr>
${duplicates.slice(0, 10).map(d => `    <tr><td>${esc(d.rfq)}</td><td>${esc(d.cpc)}</td><td>${esc(d.vendor)}</td><td>${esc(d.mpn)}</td><td>${esc(d.firstLoader)}</td><td style="color:#c00">${esc(d.duplicatedBy)}</td></tr>`).join('\n')}
${duplicates.length > 10 ? `    <tr><td colspan="6" style="color:#666"><i>...and ${duplicates.length - 10} more</i></td></tr>` : ''}
  </table>
</div>`;
  }

  if (vqs.length === 0) {
    html += `<p style="color:#999"><i>No VQs in this window.</i></p>`;
  } else {
    // Buyers sorted by VQ count
    const buyerRows = [...sumByBuyer.entries()]
      .sort((a, b) => b[1] - a[1]);

    // Loaders sorted by VQ count
    const loaderRows = [...sumByLoader.entries()]
      .sort((a, b) => b[1] - a[1]);

    html += `
<h3 style="margin:16px 0 8px 0;color:#333">VQs by Buyer</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr>
  <th align="left">Buyer</th>
  <th align="right">VQs</th>
</tr></thead>
<tbody>
${buyerRows.map(([name, count]) => `<tr><td>${esc(name)}</td><td align="right">${count}</td></tr>`).join('\n')}
</tbody>
</table>

<h3 style="margin:16px 0 8px 0;color:#333">VQs by Loader</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr>
  <th align="left">Loader</th>
  <th align="right">VQs</th>
</tr></thead>
<tbody>
${loaderRows.map(([name, count]) => `<tr><td>${esc(name)}</td><td align="right">${count}</td></tr>`).join('\n')}
</tbody>
</table>

<p style="color:#666;font-size:11px;margin-top:12px"><i>Full detail in attached xlsx (${vqs.length.toLocaleString()} rows).</i></p>`;
  }

  const teamList = APAC_TEAM.buyers.map(b => b.name).join(', ');
  const supportList = APAC_TEAM.support.map(s => s.name).join(', ');
  html += `<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by apac-vq-digest.js · Scheduled daily 10:00 UTC = 6 PM Shenzhen (Asia/Shanghai).<br/>
<b>Buyers:</b> ${esc(teamList)}<br/>
<b>Support:</b> ${esc(supportList)}<br/>
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
  console.log(`APAC team: ${APAC_TEAM.buyers.length} buyers + ${APAC_TEAM.support.length} support = ${APAC_USER_IDS.length} users`);

  const { ids: forwardedIds, uids: forwardedUids, via } = await collectForwardedVqIds(sinceMs);
  if (forwardedIds.size > 0 || forwardedUids.size > 0) {
    console.log(`APAC-forwarded UIDs: ${forwardedUids.size} (fast=${via.fastPath} mid=${via.mid} dateProx=${via.dateProx}) · forwarded vqLineIds: ${forwardedIds.size}`);
  }

  const vqs = pullVQs(sinceTs, untilTs, forwardedIds);

  // Count by source type
  const byLoader = new Map();
  for (const v of vqs) {
    byLoader.set(v.source, (byLoader.get(v.source) || 0) + 1);
  }
  const breakdown = [...byLoader.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`VQs in window: ${vqs.length} (${breakdown})`);

  // Detect duplicates (same RFQ line + vendor + MPN loaded by both Claude and manual loader)
  const duplicates = detectDuplicates(vqs);
  if (duplicates.length > 0) {
    console.log(`Potential duplicates: ${duplicates.length} (Claude + manual loader on same line/vendor/MPN)`);
  }

  const html = buildHtml(vqs, windowStr, source, duplicates);
  const xlsxBuf = await buildXlsx(vqs, windowStr);

  if (!SEND) {
    const previewPath = path.join(__dirname, 'output', `apac-vq-digest-preview-${Date.now()}.xlsx`);
    if (!fs.existsSync(path.dirname(previewPath))) fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, xlsxBuf);
    console.log(`Preview xlsx written: ${previewPath}`);
    console.log('--- HTML preview (first 2500 chars) ---');
    console.log(html.slice(0, 2500));
    console.log('(Preview only — pass --send to email and advance state)');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `apac-vq-digest-${today}.xlsx`;

  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'APAC VQ Digest',
  });

  const ok = await notifier.sendWithAttachment(
    RECIPIENTS.join(','),
    `APAC VQ Digest — ${vqs.length} VQ${vqs.length === 1 ? '' : 's'} (${today})`,
    html,
    [{ filename, content: xlsxBuf }],
    { html: true },
  );

  if (!ok) {
    console.error('Email send failed — state NOT advanced');
    process.exit(1);
  }

  // Don't advance state in test mode - allows repeated testing on same window
  if (TEST_MODE) {
    console.log(`Sent to ${RECIPIENTS.join(', ')} — state NOT advanced (test mode)`);
  } else {
    writeState({ lastDigestTs: new Date(untilMs).toISOString(), lastSentVqCount: vqs.length });
    console.log(`Sent to ${RECIPIENTS.join(', ')} — state advanced to ${new Date(untilMs).toISOString()}`);
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
