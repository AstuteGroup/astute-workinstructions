#!/usr/bin/env node
//
// Per-Seller VQ Digest (APAC Team Only)
//
// Sends each seller (salesrep) their own daily email with VQs loaded by the APAC
// buying team for their RFQs. Sellers wake up to see overnight sourcing activity.
// Each RFQ gets its own Excel tab. Buyers with VQs for that seller are CC'd.
//
// SCOPE: Only VQs where chuboe_buyer_id is an APAC buyer (8 buyers).
//
// Schedule: Daily at 10:05 UTC (5 min after APAC digest = 6:05 PM Shenzhen)
//
// TO:  Seller's email (from ad_user.email via chuboe_rfq.salesrep_id)
// CC:  All buyers (chuboe_buyer_id) with VQs for this seller's RFQs,
//      plus ivy.song@astutegroup.com and jake.harris@astutegroup.com
//
// Attachment: Excel file with one worksheet per RFQ
// Columns:    Same as APAC digest (Customer, RFQ, RFQ Type, CPC, Vendor, MPN,
//             Qty, Price, Curr, Date Code, Lead Time, Notes, Buyer, Loader, VQ ID, Created)
//
// Window: Sentinel-driven (since last successful send). State stored at
//   ~/workspace/.seller-vq-digest-state.json   { lastDigestTs: ISO }
//
// Usage:
//   node per-seller-vq-digest.js              # preview to stdout + xlsx files, no email
//   node per-seller-vq-digest.js --send       # email + advance state
//   node per-seller-vq-digest.js --send --test # send all to jake@ instead of sellers (for review)
//   node per-seller-vq-digest.js --since 48   # override window to N hours (no state advance)
//   node per-seller-vq-digest.js --limit 2    # only process first N sellers (for testing)

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
const { createNotifier } = require('../../../shared/notifier');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.seller-vq-digest-state.json');

// Always CC Ivy + Jake on all seller digests
const ALWAYS_CC = ['jake.harris@astutegroup.com', 'ivy.song@astutegroup.com'];

// System-placeholder vendors that get auto-stamped to RFQ lines but are NOT
// quotes the team actually sourced:
//   1009435 StockCQ          — Calcuquote Customer Excess auto-match
//   1008101 CalcuQuote       — CalcuQuote integration parent partner
const SYSTEM_VENDOR_IDS = [1009435, 1008101];

// APAC buyer IDs — only VQs from these buyers appear in the digest
// (same roster as apac-vq-digest.js)
const APAC_BUYER_IDS = [
  1013784,  // Ivy Song
  1018538,  // Serena Zhang
  1005190,  // Feong Chang
  1006326,  // Elaine Liang
  1019425,  // May Wu
  1009477,  // Tracy Xie
  1011159,  // Betty Song
  1034720,  // Grace Zheng
];

const MAX_WINDOW_HOURS = 14 * 24; // safety cap if state file is very stale

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const TEST_MODE = args.includes('--test');  // Send all digests to jake@ for review
const RESET_STATE = args.includes('--reset-state');
const sellerIdx = args.indexOf('--seller');
const SELLER_FILTER = sellerIdx >= 0 ? args[sellerIdx + 1]?.toLowerCase() : null;
const sinceIdx = args.indexOf('--since');
const SINCE_OVERRIDE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : null;
const limitIdx = args.indexOf('--limit');
const LIMIT_SELLERS = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

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

// Check if email is internal (@astutegroup.com or @orangetsunami.com)
function isInternalEmail(email) {
  if (!email) return false;
  const domain = email.toLowerCase().split('@')[1];
  return domain === 'astutegroup.com' || domain === 'orangetsunami.com';
}

// Sanitize string for Excel sheet name (max 31 chars, no special chars)
function sanitizeSheetName(name) {
  if (!name) return 'Sheet';
  // Replace invalid chars: / \ ? * [ ] :
  let clean = String(name).replace(/[/\\?*[\]:]/g, '_');
  // Excel sheet names max 31 chars
  if (clean.length > 31) clean = clean.slice(0, 31);
  return clean || 'Sheet';
}

// Pull APAC-buyer VQs in window, grouped by seller
function pullVQsGroupedBySeller(sinceTs, untilTs) {
  const scrub = (col) => `REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), E'[\\\\r\\\\n]+', ' ', 'g'), '\\\\|', '/', 'g')`;

  const sql =
    `SELECT v.chuboe_vq_line_id, r.value AS rfq, r.salesrep_id,
            ${scrub('rt.name')} AS rfq_type, ${scrub('cust.name')} AS customer,
            ${scrub('rl.chuboe_cpc')} AS cpc, ${scrub('bp.name')} AS vendor,
            ${scrub('v.chuboe_mpn')} AS mpn, v.cost,
            COALESCE(c.iso_code, '') AS currency, v.qty,
            ${scrub('v.chuboe_date_code')} AS date_code,
            ${scrub('v.chuboe_lead_time')} AS lead_time,
            ${scrub('v.chuboe_note_public')} AS note_p,
            ${scrub('v.chuboe_note_private')} AS note_x,
            ${scrub('v.chuboe_note_user')} AS note_u,
            ${scrub('ub.name')} AS buyer, ub.ad_user_id AS buyer_id,
            ub.email AS buyer_email,
            ${scrub('us.name')} AS seller, us.email AS seller_email,
            v.created, v.createdby,
            ${scrub('ul.name')} AS loader
     FROM adempiere.chuboe_vq_line v
     JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
     JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
     LEFT JOIN adempiere.chuboe_rfq_type rt ON rt.chuboe_rfq_type_id = r.chuboe_rfq_type_id
     JOIN adempiere.c_bpartner cust ON r.c_bpartner_id = cust.c_bpartner_id
     JOIN adempiere.c_bpartner bp ON v.c_bpartner_id = bp.c_bpartner_id
     LEFT JOIN adempiere.c_currency c ON v.c_currency_id = c.c_currency_id
     LEFT JOIN adempiere.ad_user ub ON v.chuboe_buyer_id = ub.ad_user_id
     LEFT JOIN adempiere.ad_user us ON r.salesrep_id = us.ad_user_id
     LEFT JOIN adempiere.ad_user ul ON v.createdby = ul.ad_user_id
     WHERE v.isactive = 'Y'
       AND v.c_bpartner_id NOT IN (${SYSTEM_VENDOR_IDS.join(',')})
       AND v.chuboe_buyer_id IN (${APAC_BUYER_IDS.join(',')})
       AND v.created >= '${sinceTs}'::timestamp
       AND v.created <  '${untilTs}'::timestamp
       AND us.email IS NOT NULL
     ORDER BY r.salesrep_id, r.value, rl.chuboe_cpc;`;

  const out = psqlPipe(sql);
  const rows = out.trim().split('\n').filter(Boolean);

  // Group by seller
  const sellerMap = new Map();

  for (const line of rows) {
    const parts = line.split('|');
    const [vqId, rfq, salesrepId, rfqType, customer, cpc, vendor, mpn, cost, currency, qty,
           dateCode, leadTime, noteP, noteX, noteU, buyer, buyerId, buyerEmail,
           seller, sellerEmail, created, createdby, loader] = parts;

    const notes = [noteP, noteX, noteU].filter(Boolean).join(' | ').replace(/\r?\n/g, ' ').trim();

    const vq = {
      vqId: Number(vqId),
      rfq,
      rfqType: rfqType || '',
      customer,
      cpc,
      vendor,
      mpn,
      cost: cost ? Number(cost) : null,
      currency,
      qty: qty ? Number(qty) : null,
      dateCode: dateCode || '',
      leadTime: leadTime || '',
      notes,
      buyer: buyer || '',
      buyerId: buyerId ? Number(buyerId) : null,
      buyerEmail: buyerEmail || '',
      created,
      loader: loader || '',
    };

    const key = salesrepId;
    if (!sellerMap.has(key)) {
      sellerMap.set(key, {
        sellerId: Number(salesrepId),
        sellerName: seller || '',
        sellerEmail: sellerEmail || '',
        vqs: [],
        buyerEmails: new Set(),
      });
    }
    const sellerData = sellerMap.get(key);
    sellerData.vqs.push(vq);

    // Collect buyer emails for CC
    if (buyerEmail && isInternalEmail(buyerEmail)) {
      sellerData.buyerEmails.add(buyerEmail.toLowerCase());
    }
  }

  return sellerMap;
}

async function buildSellerXlsx(sellerData) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Per-Seller VQ Digest';
  wb.created = new Date();

  // Group VQs by RFQ
  const rfqMap = new Map();
  for (const vq of sellerData.vqs) {
    if (!rfqMap.has(vq.rfq)) rfqMap.set(vq.rfq, []);
    rfqMap.get(vq.rfq).push(vq);
  }

  // Safety: cap at 250 RFQs (Excel limit is 255 sheets)
  const rfqList = [...rfqMap.keys()].slice(0, 250);

  // Columns spec
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
    { header: 'Loader',       key: 'loader',    width: 16 },
    { header: 'VQ ID',        key: 'vqId',      width: 12 },
    { header: 'Created (CT)', key: 'created',   width: 19 },
  ];

  for (const rfq of rfqList) {
    const sheetName = sanitizeSheetName(rfq);
    const ws = wb.addWorksheet(sheetName);
    ws.columns = cols;

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle' };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEFF' } };

    const vqs = rfqMap.get(rfq) || [];
    for (const v of vqs) {
      const row = ws.addRow({
        customer: v.customer,
        rfq: v.rfq,
        rfqType: v.rfqType,
        cpc: v.cpc,
        vendor: v.vendor,
        mpn: v.mpn,
        qty: v.qty,
        cost: v.cost,
        currency: v.currency,
        dateCode: v.dateCode,
        leadTime: v.leadTime,
        notes: v.notes,
        buyer: v.buyer,
        loader: v.loader,
        vqId: v.vqId,
        created: v.created || '',
      });

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
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildSellerHtml(sellerData, windowStr) {
  // Group by RFQ for summary table
  const rfqMap = new Map();
  for (const vq of sellerData.vqs) {
    if (!rfqMap.has(vq.rfq)) {
      rfqMap.set(vq.rfq, { customer: vq.customer, count: 0, buyers: new Set() });
    }
    const entry = rfqMap.get(vq.rfq);
    entry.count++;
    if (vq.buyer) entry.buyers.add(vq.buyer);
  }

  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">APAC Overnight Sourcing — ${esc(sellerData.sellerName)}</h2>
<p style="margin-top:0;color:#666">${esc(windowStr)}</p>
<p style="margin:6px 0">
  <b>${sellerData.vqs.length}</b> VQ${sellerData.vqs.length === 1 ? '' : 's'} from APAC buyers across
  <b>${rfqMap.size}</b> RFQ${rfqMap.size === 1 ? '' : 's'}
</p>

<h3 style="margin:16px 0 8px 0;color:#333">Summary by RFQ</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr>
  <th align="left">RFQ</th>
  <th align="left">Customer</th>
  <th align="right">VQs</th>
  <th align="left">Buyers</th>
</tr></thead>
<tbody>
${[...rfqMap.entries()].map(([rfq, data]) =>
  `<tr><td>${esc(rfq)}</td><td>${esc(data.customer)}</td><td align="right">${data.count}</td><td>${esc([...data.buyers].join(', '))}</td></tr>`
).join('\n')}
</tbody>
</table>

<p style="color:#666;font-size:11px;margin-top:12px"><i>Full detail in attached xlsx (one tab per RFQ).</i></p>

<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by per-seller-vq-digest.js · Scheduled daily 10:05 UTC (6:05 PM Shenzhen).<br/>
Scope: VQs loaded by APAC buying team (Ivy, Serena, Feong, Elaine, May, Tracy, Betty, Grace).<br/>
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

  const sellerMap = pullVQsGroupedBySeller(sinceTs, untilTs);

  // Early exit if no VQs at all — no emails sent, but state advances
  if (sellerMap.size === 0) {
    console.log('No VQs from APAC buyers in window — nothing to send.');
    if (SEND && !TEST_MODE && !SINCE_OVERRIDE_HOURS) {
      writeState({ lastDigestTs: new Date(untilMs).toISOString(), sellersSent: 0, totalVqs: 0 });
      console.log(`State advanced to ${new Date(untilMs).toISOString()}`);
    }
    return;
  }

  console.log(`Sellers found: ${sellerMap.size}${LIMIT_SELLERS ? ` (limiting to ${LIMIT_SELLERS})` : ''}`);

  let totalVqs = 0;
  let sellersSent = 0;
  let sellersSkipped = 0;

  for (const [sellerId, data] of sellerMap) {
    // Check limit
    if (LIMIT_SELLERS && sellersSent >= LIMIT_SELLERS) {
      console.log(`  (stopping at --limit ${LIMIT_SELLERS})`);
      break;
    }
    // Filter by seller name if --seller flag provided
    if (SELLER_FILTER && !data.sellerName.toLowerCase().includes(SELLER_FILTER)) {
      continue;
    }
    // Skip sellers without email (shouldn't happen due to WHERE clause, but defensive)
    if (!data.sellerEmail) {
      console.log(`  SKIP: ${data.sellerName || sellerId} — no email`);
      sellersSkipped++;
      continue;
    }

    // Skip sellers with 0 VQs (shouldn't happen, but defensive)
    if (data.vqs.length === 0) {
      console.log(`  SKIP: ${data.sellerName} — 0 VQs`);
      sellersSkipped++;
      continue;
    }

    totalVqs += data.vqs.length;

    // Build CC list
    // Remove seller from CC if they're also a buyer on their own RFQs
    data.buyerEmails.delete(data.sellerEmail.toLowerCase());
    const ccList = [...data.buyerEmails, ...ALWAYS_CC];

    console.log(`  ${data.sellerName} <${data.sellerEmail}>: ${data.vqs.length} VQ${data.vqs.length === 1 ? '' : 's'}, CC: ${ccList.length} recipients`);

    const html = buildSellerHtml(data, windowStr);
    const xlsxBuf = await buildSellerXlsx(data);

    if (!SEND) {
      // Preview mode: write xlsx to output/
      const previewPath = path.join(__dirname, 'output', `seller-vq-digest-${data.sellerName.replace(/\s+/g, '-')}-${Date.now()}.xlsx`);
      if (!fs.existsSync(path.dirname(previewPath))) fs.mkdirSync(path.dirname(previewPath), { recursive: true });
      fs.writeFileSync(previewPath, xlsxBuf);
      console.log(`    → Preview: ${previewPath}`);
      sellersSent++;
      continue;
    }

    // Send mode
    const today = new Date().toISOString().slice(0, 10);
    const filename = `vq-digest-${data.sellerName.replace(/\s+/g, '-')}-${today}.xlsx`;

    const notifier = createNotifier({
      fromEmail: 'vq@orangetsunami.com',
      fromName: 'APAC VQ Digest',
    });

    // In test mode, send to jake@ instead of the actual seller
    const toAddr = TEST_MODE ? 'jake.harris@astutegroup.com' : data.sellerEmail;
    const subject = TEST_MODE
      ? `[TEST] APAC Overnight — ${data.sellerName} — ${data.vqs.length} VQs (${today})`
      : `APAC Overnight — ${data.vqs.length} VQ${data.vqs.length === 1 ? '' : 's'} (${today})`;

    const ok = await notifier.sendWithAttachment(
      toAddr,
      subject,
      html,
      [{ filename, content: xlsxBuf }],
      { html: true, cc: TEST_MODE ? [] : ccList },
    );

    if (!ok) {
      console.error(`    ✗ Email send failed for ${data.sellerName}`);
      // Continue with other sellers
    } else {
      console.log(`    ✓ Sent to ${toAddr}`);
      sellersSent++;
    }

    // Rate-limit: 2s delay between emails to avoid SMTP "421 too many commands"
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nTotal: ${totalVqs} VQs, ${sellersSent} seller${sellersSent === 1 ? '' : 's'} sent, ${sellersSkipped} skipped`);

  if (!SEND) {
    console.log('(Preview only — pass --send to email and advance state)');
    return;
  }

  // Advance state only on successful send (even if 0 VQs)
  if (!TEST_MODE) {
    writeState({ lastDigestTs: new Date(untilMs).toISOString(), sellersSent, totalVqs });
    console.log(`State advanced to ${new Date(untilMs).toISOString()}`);
  } else {
    console.log('(Test mode — state NOT advanced)');
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
