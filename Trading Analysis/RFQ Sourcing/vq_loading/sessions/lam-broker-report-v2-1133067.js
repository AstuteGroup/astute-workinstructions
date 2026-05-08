// v2: Full LAM-format report for RFQ 1133067 with DC-newer alternatives column + DC upgrade tab.
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { createNotifier } = require('../../../../shared/notifier');
const { readCSVFile } = require('../../../../shared/csv-utils');

const RFQ_SEARCH_KEY = '1133067';
const PRIOR_LAM_SOURCED = path.join(__dirname, '../../../LAM Kitting Reorder/output/LAM_Reorder_Alerts_2026-04-27_sourced.csv');
const QUOTES_JSON = path.join(__dirname, '2026-04-29-LAM-reorders-1133067.json');
const TRACKER_CLI = path.join(__dirname, '2026-04-29T16-18-25-bulk-load-1133067.json');
const TRACKER_DIRECT = path.join(__dirname, '2026-04-29-missed-write-1133067.json');

const TARGET_MPNS = ['LTM8074EY#PBF','MAX16029TG+','LTM4632EV#PBF','AD9467BCPZ-250',
                     'LT1491ACS#PBF','SN74LVC125ARGYR','ADS8688IDBTR','LMZ14202TZ-ADJ/NOPB'];
const TARGET_MPN_SET = new Set(TARGET_MPNS);
const LINE_OF = {
  'SN74LVC125ARGYR': 10, 'LTM8074EY#PBF': 60, 'MAX16029TG+': 70, 'LTM4632EV#PBF': 80,
  'ADS8688IDBTR': 110, 'LMZ14202TZ-ADJ/NOPB': 120, 'AD9467BCPZ-250': 130, 'LT1491ACS#PBF': 150,
};
const SUSPENDED_BP = { '1006247': 'Dragon Core Electronics (HK) Co., Limited' };
const DC_THRESHOLD = 23;

const CURRENCY_COLS = ['Base Unit Price', 'Resale Price', 'Historical Purchase Price', 'Best Broker Cost', 'Cost', 'Newer-DC Cost'];
const INT_COLS = ['Reorder Threshold', 'LAM MOQ', 'QTY ON HAND', 'Shortfall', '# Broker Quotes', 'Qty', 'RFQ Line #'];
const PCT_COLS = ['Best Broker Margin %', 'Margin %', 'Newer-DC Margin %', 'Margin Δ %'];

function getMarginColor(margin) {
  if (margin > 18) return 'FF90EE90';
  if (margin >= 0) return 'FFFFFF99';
  return 'FFFF9999';
}

function loadPriorLamRows() {
  const csv = readCSVFile(PRIOR_LAM_SOURCED);
  const mpnIdx = csv.headers.indexOf('MPN');
  const map = {};
  for (const row of csv.rows) {
    const mpn = (row[mpnIdx] || '').trim();
    if (TARGET_MPN_SET.has(mpn)) {
      const obj = {}; csv.headers.forEach((h, i) => { obj[h] = row[i]; });
      map[mpn] = obj;
    }
  }
  return map;
}

function loadVqIds() {
  const map = new Map();
  if (fs.existsSync(TRACKER_CLI)) {
    const cli = JSON.parse(fs.readFileSync(TRACKER_CLI, 'utf8'));
    for (const w of (cli.written || [])) map.set(`${w.mpn}|${w.vendor}|${w.cost}`, w.vqLineId);
  }
  if (fs.existsSync(TRACKER_DIRECT)) {
    const d = JSON.parse(fs.readFileSync(TRACKER_DIRECT, 'utf8'));
    for (const w of (d.written || [])) map.set(`${w.mpn}|${w.vendor}|${w.cost}`, w.vqId);
  }
  return map;
}

function parseDcYear(dc) {
  if (!dc) return null;
  const m = String(dc).match(/^(\d{2})\+/);
  return m ? parseInt(m[1], 10) : null;
}

function buildEnriched(quotes, priorRows) {
  return quotes.map(q => {
    const prior = priorRows[q.mpn] || {};
    const resale = parseFloat(prior['Resale Price']) || 0;
    const margin = resale > 0 ? (resale - q.cost) / resale : null;
    const isSuspended = !!SUSPENDED_BP[q.vendorSearchKey];
    const dcYear = parseDcYear(q.dateCode);
    return { ...q, line: LINE_OF[q.mpn], resale, margin, isSuspended, dcYear };
  });
}

function pickBestNonSuspended(quotes) {
  const usable = quotes.filter(r => !r.isSuspended);
  const viable = usable.filter(r => r.margin !== null && r.margin > 0).sort((a, b) => b.margin - a.margin);
  return viable[0] || null;
}

function pickNewerDcAlt(lineQuotes, currentBest) {
  // From the same line, find the cheapest viable non-suspended quote whose
  // DC year is strictly newer than currentBest.dcYear. Return null if none.
  if (!currentBest || currentBest.dcYear === null) return null;
  const candidates = lineQuotes
    .filter(r => !r.isSuspended)
    .filter(r => r.margin !== null && r.margin > 0)
    .filter(r => r.dcYear !== null && r.dcYear > currentBest.dcYear)
    .sort((a, b) => b.margin - a.margin);
  return candidates[0] || null;
}

function summarizePerMpn(enriched) {
  const summary = {};
  for (const mpn of TARGET_MPNS) {
    const lineQuotes = enriched.filter(r => r.mpn === mpn);
    const usable = lineQuotes.filter(r => !r.isSuspended);
    const viable = usable.filter(r => r.margin !== null && r.margin > 0).sort((a, b) => b.margin - a.margin);
    const best = viable[0] || null;
    const newerDc = pickNewerDcAlt(lineQuotes, best);
    const allRed = usable.length > 0 && viable.length === 0;
    summary[mpn] = {
      totalQuotes: lineQuotes.length,
      suspendedQuotes: lineQuotes.filter(r => r.isSuspended).length,
      best, newerDc, allRed,
      lineQuotes,
    };
  }
  return summary;
}

function applyMarginShading(cell, marginPct) {
  if (typeof marginPct !== 'number' || isNaN(marginPct)) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: getMarginColor(marginPct * 100) } };
}

function colorPriority(cell) {
  if (cell.value === 'CRITICAL') {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
    cell.font = { bold: true };
  } else if (cell.value === 'HIGH') {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  }
}

async function main() {
  const priorRows = loadPriorLamRows();
  const quotes = JSON.parse(fs.readFileSync(QUOTES_JSON, 'utf8'));
  const enriched = buildEnriched(quotes, priorRows);
  const vqIds = loadVqIds();
  const summary = summarizePerMpn(enriched);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'LAM Kitting Reorder';
  wb.created = new Date();

  // ───── Tab 1: Sourced Reorder Alerts ────────────────────────────────────
  const ws = wb.addWorksheet('Sourced Reorder Alerts');
  const headers = [
    'Lam P/N', 'MPN', 'Manufacturer', 'Item Description',
    'QTY ON HAND', 'Reorder Threshold', 'Shortfall', 'Priority',
    'Recent POV', 'Last Promise Date', 'Last RFQ',
    'Base Unit Price', 'Resale Price', 'Historical Purchase Price',
    'OT Previous Supplier', 'OT Buyer', 'Historical Buyer',
    'Lead Time', 'LAM MOQ',
    'Best Broker Supplier', 'Best Broker Cost', 'Best Broker DC',
    'Best Broker COO', 'Best Broker Lead Time', 'Best Broker Margin %',
    'Newer-DC Alt Supplier', 'Newer-DC Cost', 'Newer-DC DC',
    'Newer-DC Margin %', 'Margin Δ %',
    '# Broker Quotes', 'Sourcing Status', 'RFQ Line #', 'RFQ Search Key',
  ];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  for (const mpn of TARGET_MPNS) {
    const prior = priorRows[mpn] || {};
    const s = summary[mpn];
    const best = s.best;
    const alt = s.newerDc;
    const status = best
      ? (best.margin > 0.18 ? 'BROKER SOURCED — GREEN' : 'BROKER SOURCED — YELLOW')
      : (s.allRed ? 'BROKER SOURCED — ALL RED' : 'NO COVERAGE');
    const altMpnTag = best?.vendorQuotedMpn && best.vendorQuotedMpn !== best.mpn
      ? ` (alt: ${best.vendorQuotedMpn})` : '';
    const altAltMpn = alt?.vendorQuotedMpn && alt.vendorQuotedMpn !== alt.mpn
      ? ` (alt: ${alt.vendorQuotedMpn})` : '';
    const marginDelta = (best && alt) ? alt.margin - best.margin : '';

    const r = ws.addRow([
      prior['Lam P/N'] || '',
      mpn,
      prior['Manufacturer'] || '',
      prior['Item Description'] || '',
      parseFloat(prior['QTY ON HAND']) || 0,
      parseFloat(prior['Reorder Threshold']) || 0,
      parseFloat(prior['Shortfall']) || 0,
      prior['Priority'] || '',
      prior['Recent POV'] || '',
      prior['Last Promise Date'] || '',
      `${RFQ_SEARCH_KEY} (Lam Research)`,
      parseFloat(prior['Base Unit Price']) || 0,
      parseFloat(prior['Resale Price']) || 0,
      parseFloat(prior['Historical Purchase Price']) || 0,
      prior['OT Previous Supplier'] || '',
      prior['OT Buyer'] || '',
      prior['Historical Buyer'] || '',
      prior['Lead Time'] || '',
      parseFloat(prior['LAM MOQ']) || 0,
      best ? best.vendorName + altMpnTag : '',
      best ? best.cost : '',
      best ? (best.dateCode || '') : '',
      best ? (best.coo || '') : '',
      best ? (best.leadTime || '') : '',
      best ? best.margin : '',
      alt ? alt.vendorName + altAltMpn : '',
      alt ? alt.cost : '',
      alt ? (alt.dateCode || '') : '',
      alt ? alt.margin : '',
      marginDelta,
      s.totalQuotes,
      status,
      LINE_OF[mpn],
      RFQ_SEARCH_KEY,
    ]);

    if (best) applyMarginShading(r.getCell(headers.indexOf('Best Broker Margin %') + 1), best.margin);
    if (alt) applyMarginShading(r.getCell(headers.indexOf('Newer-DC Margin %') + 1), alt.margin);
    colorPriority(r.getCell(headers.indexOf('Priority') + 1));

    const statusCell = r.getCell(headers.indexOf('Sourcing Status') + 1);
    if (status.includes('GREEN')) statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } };
    else if (status.includes('YELLOW')) statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF99' } };
    else if (status.includes('RED')) statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
    statusCell.font = { bold: true };
  }

  headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    if (h === 'Item Description') col.width = 45;
    else if (h === 'Recent POV') col.width = 55;
    else if (h.includes('Supplier') || h === 'OT Previous Supplier') col.width = 35;
    else if (h === 'MPN' || h === 'Lam P/N') col.width = 22;
    else if (h.includes('Margin') || h === 'Sourcing Status') col.width = 22;
    else if (h === 'Margin Δ %') col.width = 12;
    else if (h === 'Best Broker Lead Time' || h === 'Lead Time') col.width = 14;
    else col.width = 16;
    if (CURRENCY_COLS.includes(h)) col.numFmt = '$#,##0.0000';
    else if (INT_COLS.includes(h)) col.numFmt = '#,##0';
    else if (PCT_COLS.includes(h)) col.numFmt = '0.0%';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // ───── Tab 2: All Broker Quotes ────────────────────────────────────────
  const ws2 = wb.addWorksheet('All Broker Quotes');
  const h2 = ['RFQ Line #', 'MPN', 'Vendor', 'Vendor Quoted MPN',
              'Cost', 'Qty', 'Date Code', 'COO', 'Lead Time',
              'Margin %', 'Flag', 'Notes', 'VQ Line ID'];
  ws2.addRow(h2);
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  const sorted = [...enriched].sort((a, b) => a.line - b.line || a.cost - b.cost);
  for (const r of sorted) {
    const flag = r.isSuspended ? 'SUSPENDED'
      : r.margin === null ? '?'
      : r.margin < 0 ? 'RED'
      : r.margin < 0.18 ? 'YELLOW' : 'GREEN';
    const vqId = vqIds.get(`${r.mpn}|${r.vendorName}|${r.cost}`) || '';
    const row = ws2.addRow([
      r.line, r.mpn, r.vendorName, r.vendorQuotedMpn || '',
      r.cost, r.qty, r.dateCode || '', r.coo || '', r.leadTime || '',
      r.margin, flag, r.vendorNotes || '', vqId,
    ]);
    if (typeof r.margin === 'number') applyMarginShading(row.getCell(h2.indexOf('Margin %') + 1), r.margin);
    const fc = row.getCell(h2.indexOf('Flag') + 1);
    if (flag === 'GREEN') fc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } };
    else if (flag === 'YELLOW') fc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF99' } };
    else if (flag === 'RED') fc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
    else if (flag === 'SUSPENDED') {
      fc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      fc.font = { bold: true };
    }
  }
  h2.forEach((h, i) => {
    const col = ws2.getColumn(i + 1);
    if (h === 'Vendor') col.width = 40;
    else if (h === 'Notes') col.width = 50;
    else if (h === 'MPN' || h === 'Vendor Quoted MPN') col.width = 22;
    else col.width = 14;
    if (h === 'Cost') col.numFmt = '$#,##0.0000';
    else if (h === 'Margin %') col.numFmt = '0.0%';
    else if (h === 'Qty' || h === 'VQ Line ID' || h === 'RFQ Line #') col.numFmt = '#,##0';
  });
  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  // ───── Tab 3: DC Analysis & Upgrade Recommendations ──────────────────────
  const ws3 = wb.addWorksheet('DC Analysis');
  const h3 = ['RFQ Line #', 'MPN', 'Best Vendor', 'Best DC', 'Best Cost', 'Best Margin %',
              'Newest DC In Batch', 'Newer-DC Vendor', 'Newer-DC Cost', 'Newer-DC Margin %',
              'Margin Δ %', 'Cost Premium', 'Recommendation'];
  ws3.addRow(h3);
  ws3.getRow(1).font = { bold: true };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };

  for (const mpn of TARGET_MPNS) {
    const s = summary[mpn];
    if (!s.best) continue;
    const usable = s.lineQuotes.filter(r => !r.isSuspended && r.dcYear !== null);
    const newestDcYear = usable.length ? Math.max(...usable.map(r => r.dcYear)) : null;
    const newestStr = newestDcYear !== null ? `${newestDcYear}+` : '?';
    const alt = s.newerDc;
    const meetsThreshold = (s.best.dcYear || 0) >= DC_THRESHOLD;
    const costPremium = alt ? alt.cost - s.best.cost : '';
    const marginDelta = alt ? alt.margin - s.best.margin : '';

    let recommendation;
    if (meetsThreshold && !alt) {
      recommendation = `OK — best at ${s.best.dateCode} meets ≥${DC_THRESHOLD}+ threshold; no newer alt`;
    } else if (meetsThreshold && alt) {
      recommendation = `OK — best at ${s.best.dateCode}. Optional upgrade to ${alt.dateCode} via ${alt.vendorName} (+$${costPremium.toFixed(4)}/pc)`;
    } else if (!meetsThreshold && !alt) {
      recommendation = `⚠ Best at ${s.best.dateCode} (below ${DC_THRESHOLD}+) — no newer alt in batch; newest is ${newestStr}`;
    } else if (!meetsThreshold && alt) {
      const sameCost = costPremium === 0;
      recommendation = sameCost
        ? `✅ Pure upgrade — ${alt.vendorName} same cost, DC ${alt.dateCode}`
        : `⚠ Best at ${s.best.dateCode}. Upgrade to ${alt.dateCode} via ${alt.vendorName} (+$${costPremium.toFixed(4)}/pc, margin ${(alt.margin*100).toFixed(1)}%)`;
    }

    const row = ws3.addRow([
      LINE_OF[mpn], mpn, s.best.vendorName, s.best.dateCode, s.best.cost, s.best.margin,
      newestStr, alt ? alt.vendorName : '', alt ? alt.cost : '',
      alt ? alt.margin : '', marginDelta, costPremium, recommendation,
    ]);
    applyMarginShading(row.getCell(h3.indexOf('Best Margin %') + 1), s.best.margin);
    if (alt) applyMarginShading(row.getCell(h3.indexOf('Newer-DC Margin %') + 1), alt.margin);
    // Highlight rec cell
    const recCell = row.getCell(h3.indexOf('Recommendation') + 1);
    if (recommendation.startsWith('✅')) recCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } };
    else if (recommendation.startsWith('⚠')) recCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    recCell.font = { bold: true };
  }
  h3.forEach((h, i) => {
    const col = ws3.getColumn(i + 1);
    if (h === 'Recommendation') col.width = 80;
    else if (h === 'Best Vendor' || h === 'Newer-DC Vendor') col.width = 38;
    else if (h === 'MPN') col.width = 22;
    else col.width = 14;
    if (h === 'Best Cost' || h === 'Newer-DC Cost' || h === 'Cost Premium') col.numFmt = '$#,##0.0000';
    else if (h === 'Best Margin %' || h === 'Newer-DC Margin %' || h === 'Margin Δ %') col.numFmt = '0.0%';
  });
  ws3.views = [{ state: 'frozen', ySplit: 1 }];

  const xlsxPath = `/tmp/LAM_Reorder_Alerts_2026-04-29_RFQ${RFQ_SEARCH_KEY}_APAC_broker_v2.xlsx`;
  await wb.xlsx.writeFile(xlsxPath);
  console.log(`Wrote ${xlsxPath}`);

  // Email
  const totalQuotes = enriched.length;
  const suspendedCount = enriched.filter(r => r.isSuspended).length;
  const greenCount = Object.values(summary).filter(s => s.best && s.best.margin > 0.18).length;
  const yellowCount = Object.values(summary).filter(s => s.best && s.best.margin <= 0.18 && s.best.margin > 0).length;
  const altsAvailable = Object.values(summary).filter(s => s.newerDc).length;

  let totalGp = 0;
  for (const mpn of TARGET_MPNS) {
    const s = summary[mpn]; const prior = priorRows[mpn] || {};
    const moq = parseFloat(prior['LAM MOQ']) || 0;
    if (s.best) totalGp += (s.best.resale - s.best.cost) * moq;
  }

  const body = `Why this email — context

You received two earlier emails today on RFQ ${RFQ_SEARCH_KEY}:
  1. The full LAM-format xlsx with the best broker quote per line (${totalQuotes} VQs from Tracy Xie's APAC bulk summary, loaded against the RFQ).
  2. A short HTML follow-up flagging that two lines (10 and 80) had a best quote with date code older than 23+, with newer-DC alternatives.

This email **replaces both** with a single complete workbook. Same source data, same analysis — just consolidated so there's one file to refer to instead of three. The new "Newer-DC Alt" columns and the "DC Analysis" tab are the only net-new content; everything else is identical to what was already sent.

— Summary —

- 8 of 15 lines on RFQ ${RFQ_SEARCH_KEY} broker-sourced by Tracy Xie (vq@ forward 2026-04-29)
- ${totalQuotes} broker quotes captured as VQs against the RFQ
- 🟢 GREEN best (margin >18%): ${greenCount}/8 lines
- 🟡 YELLOW best (margin 0–18%): ${yellowCount}/8 lines
- ⚠ Suspended-vendor quotes captured for record only: ${suspendedCount} (Dragon Core Electronics)
- 🔄 Lines where a newer-DC alternative exists: ${altsAvailable}
- Estimated GP at LAM MOQ if best-per-line is taken: $${totalGp.toFixed(2)}

— Workbook contents (3 tabs) —

  1. "Sourced Reorder Alerts" — LAM Kitting column layout (Lam P/N, MPN, Priority, Recent POV, OT Previous Supplier, Lead Time, LAM MOQ, etc.) with broker sourcing columns. **NEW vs prior email:** "Newer-DC Alt Supplier / Cost / DC / Margin / Margin Δ" columns — populated only when a strictly newer DC is available at viable margin.
  2. "All Broker Quotes" — all ${totalQuotes} broker quotes with per-quote margin, COO, DC, VQ line IDs, GREEN/YELLOW/RED/SUSPENDED flags. Identical to prior email.
  3. "DC Analysis" — **NEW tab.** Per-line recommendation column flagging pure upgrades (same cost, newer DC), DC-premium tradeoffs, and lines with no newer DC available in this batch.

— Watchouts (unchanged from prior emails) —

- Line 120 (LMZ14202TZ-ADJ/NOPB): the GREEN best is the LMZ14202TZX-ADJ/NOPB alt variant. AVL confirmation required before substituting.
- Line 150 (LT1491ACS#PBF): only LT1491ACS#TRPBF (T&R) variants beat resale. Canonical #PBF quotes are all RED.

Note: APAC broker sourcing is a supplement to the standard franchise-only LAM Kitting Reorder cron — escalation path. Purchasing/sales decides what to act on.
`;

  const notifier = createNotifier({ fromEmail: 'excess@orangetsunami.com', fromName: 'LAM Kitting Reorder' });
  const ok = await notifier.sendWithAttachment(
    'jake.harris@astutegroup.com, josh.syre@astutegroup.com',
    `LAM Kitting Reorder — RFQ ${RFQ_SEARCH_KEY} — Updated Workbook (replaces 2 prior emails today)`,
    body,
    [{ filename: path.basename(xlsxPath), path: xlsxPath }]
  );
  console.log(ok ? 'Email sent' : 'Email failed');
}

main().catch(err => { console.error(err); process.exit(1); });
