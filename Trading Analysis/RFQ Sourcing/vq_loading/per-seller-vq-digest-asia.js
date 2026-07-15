#!/usr/bin/env node
//
// Per-Seller VQ Digest — ASIA SELLERS (Twice Daily)
//
// Sends Asia-based sellers their VQ digest twice daily at:
//   - 11 AM Shenzhen (03:00 UTC)
//   - 5 PM Shenzhen (09:00 UTC)
//
// Rolling window: each digest covers "since last digest" for that seller.
//
// SCOPE: Only VQs where chuboe_buyer_id is an APAC buyer (8 buyers).
// SELLERS: Only the 17 Asia-based sellers listed in ASIA_SELLER_IDS.
//
// TO:  Seller's email
// CC:  Buyers who sourced for that seller + Ivy Song
//
// Usage:
//   node per-seller-vq-digest-asia.js              # preview, no email
//   node per-seller-vq-digest-asia.js --send       # email + advance state
//   node per-seller-vq-digest-asia.js --send --test # send all to jake@ for review
//   node per-seller-vq-digest-asia.js --since 12   # override window (no state advance)
//   node per-seller-vq-digest-asia.js --reset-state # clear state file

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
const { createNotifier } = require('../../../shared/notifier');

const STATE_FILE = path.join(process.env.HOME, 'workspace', '.asia-seller-vq-digest-state.json');

// Always CC Ivy on Asia seller digests
const ALWAYS_CC = ['ivy.song@astutegroup.com'];

// Asia sellers — twice daily digest (11 AM + 5 PM Shenzhen)
// Added 2026-07-09
const ASIA_SELLER_IDS = [
  1021224,  // Spring Tu
  1011159,  // Betty Song
  1023803,  // Renald Ng (ray.ng@)
  1009528,  // Wing Zhang
  1016958,  // Laurel Kee
  1009478,  // Winnie Lee
  1009866,  // Rotsarin Phromsatcha
  1009210,  // Silvia Munoz
  1017134,  // Ivy Chew
  1013784,  // Ivy Song
  1041139,  // Jasper Kee
  1018538,  // Serena Zhang
  1005190,  // Feong Chang
  1006326,  // Elaine Liang
  1019425,  // May Wu
  1009477,  // Tracy Xie
  1034720,  // Grace Zheng
];

// System-placeholder vendors (not real quotes)
const SYSTEM_VENDOR_IDS = [1009435, 1008101];

// APAC buyer IDs — only VQs from these buyers appear
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

const MAX_WINDOW_HOURS = 7 * 24; // 7 days max if state is stale

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const TEST_MODE = args.includes('--test');
const RESET_STATE = args.includes('--reset-state');
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
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// Determine window for a specific seller (rolling per-seller state)
function determineWindowForSeller(sellerId, state) {
  const now = Date.now();
  if (SINCE_OVERRIDE_HOURS != null) {
    return { sinceMs: now - SINCE_OVERRIDE_HOURS * 3600 * 1000, untilMs: now, source: `--since ${SINCE_OVERRIDE_HOURS}h` };
  }
  const sellerState = state[sellerId];
  if (!sellerState || !sellerState.lastDigestTs) {
    // First run for this seller — default to 12 hours (half-day)
    return { sinceMs: now - 12 * 3600 * 1000, untilMs: now, source: 'first run (default 12h)' };
  }
  const last = Date.parse(sellerState.lastDigestTs);
  const oldest = now - MAX_WINDOW_HOURS * 3600 * 1000;
  const sinceMs = Math.max(last, oldest);
  return { sinceMs, untilMs: now, source: sinceMs === oldest ? `state stale — capped at ${MAX_WINDOW_HOURS}h` : 'since last digest' };
}

function isInternalEmail(email) {
  if (!email) return false;
  const domain = email.toLowerCase().split('@')[1];
  return domain === 'astutegroup.com' || domain === 'orangetsunami.com';
}

function sanitizeSheetName(name) {
  if (!name) return 'Sheet';
  let clean = String(name).replace(/[/\\?*[\]:]/g, '_');
  if (clean.length > 31) clean = clean.slice(0, 31);
  return clean || 'Sheet';
}

// Pull VQs for a specific seller in a given window
function pullVQsForSeller(sellerId, sinceTs, untilTs) {
  const scrub = (col) => `REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), E'[\\\\r\\\\n]+', ' ', 'g'), '\\\\|', '/', 'g')`;

  const sql =
    `SELECT v.chuboe_vq_line_id, r.value AS rfq,
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
       AND r.salesrep_id = ${sellerId}
     ORDER BY r.value, rl.chuboe_cpc;`;

  const out = psqlPipe(sql);
  const rows = out.trim().split('\n').filter(Boolean);

  const vqs = [];
  const buyerEmails = new Set();
  let sellerName = '';
  let sellerEmail = '';

  for (const line of rows) {
    const parts = line.split('|');
    const [vqId, rfq, rfqType, customer, cpc, vendor, mpn, cost, currency, qty,
           dateCode, leadTime, noteP, noteX, noteU, buyer, buyerId, buyerEmail,
           seller, sellerEmailVal, created, createdby, loader] = parts;

    if (!sellerName) sellerName = seller || '';
    if (!sellerEmail) sellerEmail = sellerEmailVal || '';

    const notes = [noteP, noteX, noteU].filter(Boolean).join(' | ').replace(/\r?\n/g, ' ').trim();

    vqs.push({
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
      created,
      loader: loader || '',
    });

    if (buyerEmail && isInternalEmail(buyerEmail)) {
      buyerEmails.add(buyerEmail.toLowerCase());
    }
  }

  return { vqs, buyerEmails, sellerName, sellerEmail };
}

// Look up seller info by ID
function getSellerInfo(sellerId) {
  const sql = `SELECT name, email FROM adempiere.ad_user WHERE ad_user_id = ${sellerId}`;
  const out = psqlPipe(sql).trim();
  if (!out) return { name: `ID ${sellerId}`, email: null };
  const [name, email] = out.split('|');
  return { name: name || `ID ${sellerId}`, email: email || null };
}

async function buildSellerXlsx(vqs) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Asia Seller VQ Digest';
  wb.created = new Date();

  const rfqMap = new Map();
  for (const vq of vqs) {
    if (!rfqMap.has(vq.rfq)) rfqMap.set(vq.rfq, []);
    rfqMap.get(vq.rfq).push(vq);
  }

  const rfqList = [...rfqMap.keys()].slice(0, 250);

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

    const rfqVqs = rfqMap.get(rfq) || [];
    for (const v of rfqVqs) {
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

function buildSellerHtml(sellerName, vqs, windowStr) {
  const rfqMap = new Map();
  for (const vq of vqs) {
    if (!rfqMap.has(vq.rfq)) {
      rfqMap.set(vq.rfq, { customer: vq.customer, count: 0, buyers: new Set() });
    }
    const entry = rfqMap.get(vq.rfq);
    entry.count++;
    if (vq.buyer) entry.buyers.add(vq.buyer);
  }

  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">APAC Sourcing Update — ${esc(sellerName)}</h2>
<p style="margin-top:0;color:#666">${esc(windowStr)}</p>
<p style="margin:6px 0">
  <b>${vqs.length}</b> VQ${vqs.length === 1 ? '' : 's'} from APAC buyers across
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
Generated by per-seller-vq-digest-asia.js · Twice daily: 11 AM + 5 PM Shenzhen.<br/>
Scope: VQs loaded by APAC buying team.<br/>
Window labelled CT (chuboe_*.created storage convention).
</p></body></html>`;

  return html;
}

(async () => {
  const state = readState();
  const now = Date.now();

  console.log(`Asia Seller VQ Digest — ${new Date().toISOString()}`);
  console.log(`Sellers in roster: ${ASIA_SELLER_IDS.length}`);

  let totalVqs = 0;
  let sellersSent = 0;
  let sellersSkipped = 0;
  const newState = { ...state };

  for (const sellerId of ASIA_SELLER_IDS) {
    if (LIMIT_SELLERS && sellersSent >= LIMIT_SELLERS) {
      console.log(`  (stopping at --limit ${LIMIT_SELLERS})`);
      break;
    }

    const { sinceMs, untilMs, source } = determineWindowForSeller(sellerId, state);
    const sinceTs = utcToCTNaive(new Date(sinceMs));
    const untilTs = utcToCTNaive(new Date(untilMs));
    const windowStr = `${sinceTs} CT → ${untilTs} CT`;

    const { vqs, buyerEmails, sellerName, sellerEmail } = pullVQsForSeller(sellerId, sinceTs, untilTs);

    // If no email for seller, look it up
    let finalName = sellerName;
    let finalEmail = sellerEmail;
    if (!finalEmail) {
      const info = getSellerInfo(sellerId);
      finalName = info.name;
      finalEmail = info.email;
    }

    if (!finalEmail) {
      console.log(`  SKIP: ${finalName || sellerId} — no email`);
      sellersSkipped++;
      continue;
    }

    if (vqs.length === 0) {
      // No VQs — still advance state but don't send email
      if (SEND && !TEST_MODE && !SINCE_OVERRIDE_HOURS) {
        newState[sellerId] = { lastDigestTs: new Date(untilMs).toISOString(), lastVqCount: 0 };
      }
      console.log(`  ${finalName}: 0 VQs (${source}) — skipped, state advanced`);
      continue;
    }

    totalVqs += vqs.length;

    // Build CC list (remove seller if they're also a buyer)
    buyerEmails.delete(finalEmail.toLowerCase());
    const ccList = [...buyerEmails, ...ALWAYS_CC];

    console.log(`  ${finalName} <${finalEmail}>: ${vqs.length} VQ${vqs.length === 1 ? '' : 's'} (${source}), CC: ${ccList.length}`);

    const html = buildSellerHtml(finalName, vqs, windowStr);
    const xlsxBuf = await buildSellerXlsx(vqs);

    if (!SEND) {
      const previewPath = path.join(__dirname, 'output', `asia-seller-${finalName.replace(/\s+/g, '-')}-${Date.now()}.xlsx`);
      if (!fs.existsSync(path.dirname(previewPath))) fs.mkdirSync(path.dirname(previewPath), { recursive: true });
      fs.writeFileSync(previewPath, xlsxBuf);
      console.log(`    → Preview: ${previewPath}`);
      sellersSent++;
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);
    const timeLabel = new Date().toISOString().slice(11, 16).replace(':', '');
    const filename = `vq-digest-${finalName.replace(/\s+/g, '-')}-${today}-${timeLabel}.xlsx`;

    const notifier = createNotifier({
      fromEmail: 'vq@orangetsunami.com',
      fromName: 'APAC VQ Digest',
    });

    const toAddr = TEST_MODE ? 'jake.harris@astutegroup.com' : finalEmail;
    const subject = TEST_MODE
      ? `[TEST] APAC Update — ${finalName} — ${vqs.length} VQs (${today} ${timeLabel})`
      : `APAC Sourcing — ${vqs.length} VQ${vqs.length === 1 ? '' : 's'} (${today})`;

    const ok = await notifier.sendWithAttachment(
      toAddr,
      subject,
      html,
      [{ filename, content: xlsxBuf }],
      { html: true, cc: TEST_MODE ? [] : ccList },
    );

    if (!ok) {
      console.error(`    ✗ Email send failed for ${finalName}`);
    } else {
      console.log(`    ✓ Sent to ${toAddr}`);
      sellersSent++;
      if (!TEST_MODE && !SINCE_OVERRIDE_HOURS) {
        newState[sellerId] = { lastDigestTs: new Date(untilMs).toISOString(), lastVqCount: vqs.length };
      }
    }

    // Rate-limit: 2s delay between emails
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nTotal: ${totalVqs} VQs, ${sellersSent} seller${sellersSent === 1 ? '' : 's'} sent, ${sellersSkipped} skipped`);

  if (!SEND) {
    console.log('(Preview only — pass --send to email and advance state)');
    return;
  }

  if (!TEST_MODE && !SINCE_OVERRIDE_HOURS) {
    writeState(newState);
    console.log(`State updated for ${Object.keys(newState).length} sellers`);
  } else if (TEST_MODE) {
    console.log('(Test mode — state NOT updated)');
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
