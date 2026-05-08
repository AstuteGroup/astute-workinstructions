// One-off LAM Kitting-style report for RFQ 1133067 broker sourcing.
// Mirrors the lam-kitting-runner.js xlsx format but swaps the franchise
// columns for broker columns (In Stock Supplier → Best Broker Supplier, etc.).
// Emails to Jake Harris + Josh Syre.
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { createNotifier } = require('../../../../shared/notifier');
const { readCSVFile } = require('../../../../shared/csv-utils');

const RFQ_SEARCH_KEY = '1133067';
const PRIOR_LAM_SOURCED = path.join(__dirname, '../../../LAM Kitting Reorder/output/LAM_Reorder_Alerts_2026-04-27_sourced.csv');
const LAM_DB = path.join(__dirname, '../../../LAM Kitting Reorder/Lam_Kitting_DB_03132026.xlsx');
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

const CURRENCY_COLS = ['Base Unit Price', 'Resale Price', 'Historical Purchase Price', 'Best Broker Cost', 'Cost'];
const INT_COLS = ['Reorder Threshold', 'LAM MOQ', 'QTY ON HAND', 'Shortfall', 'On Order Qty', '# Broker Quotes', 'Qty', 'RFQ Line #'];
const PCT_COLS = ['Best Broker Margin %', 'Margin %'];

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
      const obj = {};
      csv.headers.forEach((h, i) => { obj[h] = row[i]; });
      map[mpn] = obj;
    }
  }
  return map;
}

function loadVqIds() {
  // Match (rfq_line, vendor_search_key, cost) → vq_id from trackers
  const map = new Map();   // key: `${mpn}|${vendorName}|${cost}` → vqId
  // CLI tracker
  if (fs.existsSync(TRACKER_CLI)) {
    const cli = JSON.parse(fs.readFileSync(TRACKER_CLI, 'utf8'));
    for (const w of (cli.written || [])) {
      const k = `${w.mpn}|${w.vendor}|${w.cost}`;
      map.set(k, w.vqLineId);
    }
  }
  // Direct write tracker
  if (fs.existsSync(TRACKER_DIRECT)) {
    const d = JSON.parse(fs.readFileSync(TRACKER_DIRECT, 'utf8'));
    for (const w of (d.written || [])) {
      const k = `${w.mpn}|${w.vendor}|${w.cost}`;
      map.set(k, w.vqId);
    }
  }
  return map;
}

function buildEnrichedQuotes(quotes, priorRows) {
  // Compute margin per quote against the LAM resale.
  const enriched = quotes.map(q => {
    const prior = priorRows[q.mpn] || {};
    const resale = parseFloat(prior['Resale Price']) || 0;
    const margin = resale > 0 ? (resale - q.cost) / resale : null;
    const isSuspended = !!SUSPENDED_BP[q.vendorSearchKey];
    return {
      ...q,
      line: LINE_OF[q.mpn],
      resale,
      margin,
      isSuspended,
    };
  });
  return enriched;
}

function summarizePerMpn(enriched) {
  // Best non-Dragon, non-RED per MPN.
  const summary = {};
  for (const mpn of TARGET_MPNS) {
    const lineQuotes = enriched.filter(r => r.mpn === mpn);
    const usable = lineQuotes.filter(r => !r.isSuspended);
    const viable = usable.filter(r => r.margin !== null && r.margin > 0).sort((a, b) => b.margin - a.margin);
    summary[mpn] = {
      totalQuotes: lineQuotes.length,
      suspendedQuotes: lineQuotes.filter(r => r.isSuspended).length,
      best: viable[0] || null,
      allRed: usable.length > 0 && viable.length === 0,
    };
  }
  return summary;
}

function applyMarginShading(cell, marginPct) {
  if (typeof marginPct !== 'number' || isNaN(marginPct)) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: getMarginColor(marginPct * 100) } };
}

function formatMargin(m) {
  if (m === null || m === undefined || isNaN(m)) return '';
  return m;   // store as decimal; Excel cell format applies %
}

async function main() {
  const priorRows = loadPriorLamRows();
  console.log(`Loaded ${Object.keys(priorRows).length}/${TARGET_MPNS.length} prior LAM rows`);

  const quotes = JSON.parse(fs.readFileSync(QUOTES_JSON, 'utf8'));
  const enriched = buildEnrichedQuotes(quotes, priorRows);
  const vqIds = loadVqIds();
  const summary = summarizePerMpn(enriched);

  // Build workbook
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LAM Kitting Reorder';
  wb.created = new Date();

  // ── Tab 1: Sourced Reorder Alerts (broker-flavored)
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
    '# Broker Quotes', 'Sourcing Status', 'RFQ Line #', 'RFQ Search Key',
  ];
  ws.addRow(headers);
  const hdr = ws.getRow(1);
  hdr.font = { bold: true };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  for (const mpn of TARGET_MPNS) {
    const prior = priorRows[mpn] || {};
    const s = summary[mpn];
    const best = s.best;
    const status = best
      ? (best.margin > 0.18 ? 'BROKER SOURCED — GREEN' : 'BROKER SOURCED — YELLOW')
      : (s.allRed ? 'BROKER SOURCED — ALL RED' : 'NO COVERAGE');
    const altMpnTag = best?.vendorQuotedMpn && best.vendorQuotedMpn !== best.mpn
      ? ` (alt: ${best.vendorQuotedMpn})` : '';

    const rowData = [
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
      best ? formatMargin(best.margin) : '',
      s.totalQuotes,
      status,
      LINE_OF[mpn],
      RFQ_SEARCH_KEY,
    ];
    const r = ws.addRow(rowData);

    // Color the margin cell
    const marginCol = headers.indexOf('Best Broker Margin %') + 1;
    if (best) applyMarginShading(r.getCell(marginCol), best.margin);

    // Color the priority cell
    const priorityCol = headers.indexOf('Priority') + 1;
    const priorityCell = r.getCell(priorityCol);
    if (priorityCell.value === 'CRITICAL') {
      priorityCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
      priorityCell.font = { bold: true };
    } else if (priorityCell.value === 'HIGH') {
      priorityCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    }

    // Color the status cell
    const statusCol = headers.indexOf('Sourcing Status') + 1;
    const statusCell = r.getCell(statusCol);
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
    else if (h === 'Best Broker Lead Time' || h === 'Lead Time') col.width = 14;
    else col.width = 16;
    if (CURRENCY_COLS.includes(h)) col.numFmt = '$#,##0.0000';
    else if (INT_COLS.includes(h)) col.numFmt = '#,##0';
    else if (PCT_COLS.includes(h)) col.numFmt = '0.0%';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Tab 2: All Broker Quotes (62 rows)
  const ws2 = wb.addWorksheet('All Broker Quotes');
  const h2 = [
    'RFQ Line #', 'MPN', 'Vendor', 'Vendor Quoted MPN',
    'Cost', 'Qty', 'Date Code', 'COO', 'Lead Time',
    'Margin %', 'Flag', 'Notes', 'VQ Line ID',
  ];
  ws2.addRow(h2);
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  enriched.sort((a, b) => a.line - b.line || a.cost - b.cost);
  for (const r of enriched) {
    const flag = r.isSuspended ? 'SUSPENDED'
      : r.margin === null ? '?'
      : r.margin < 0 ? 'RED'
      : r.margin < 0.18 ? 'YELLOW' : 'GREEN';
    const vqKey = `${r.mpn}|${r.vendorName}|${r.cost}`;
    const vqId = vqIds.get(vqKey) || '';
    const row = ws2.addRow([
      r.line, r.mpn, r.vendorName, r.vendorQuotedMpn || '',
      r.cost, r.qty, r.dateCode || '', r.coo || '', r.leadTime || '',
      formatMargin(r.margin), flag, r.vendorNotes || '', vqId,
    ]);
    // Color margin
    const marginCol = h2.indexOf('Margin %') + 1;
    if (typeof r.margin === 'number') applyMarginShading(row.getCell(marginCol), r.margin);
    // Color flag
    const flagCol = h2.indexOf('Flag') + 1;
    const fc = row.getCell(flagCol);
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

  // Save xlsx to /tmp (don't persist analysis output to git per github-vs-email)
  const xlsxPath = `/tmp/LAM_Reorder_Alerts_2026-04-29_RFQ${RFQ_SEARCH_KEY}_APAC_broker.xlsx`;
  await wb.xlsx.writeFile(xlsxPath);
  console.log(`Wrote ${xlsxPath}`);

  // Build email body
  const totalQuotes = enriched.length;
  const suspendedCount = enriched.filter(r => r.isSuspended).length;
  const greenCount = Object.values(summary).filter(s => s.best && s.best.margin > 0.18).length;
  const yellowCount = Object.values(summary).filter(s => s.best && s.best.margin <= 0.18 && s.best.margin > 0).length;
  const redCount = Object.values(summary).filter(s => s.allRed).length;

  // Total GP at LAM MOQ if best-per-line
  let totalGp = 0;
  for (const mpn of TARGET_MPNS) {
    const s = summary[mpn];
    const prior = priorRows[mpn] || {};
    const moq = parseFloat(prior['LAM MOQ']) || 0;
    if (s.best) totalGp += (s.best.resale - s.best.cost) * moq;
  }

  const body = `LAM Kitting Reorder — APAC Broker Sourcing for RFQ ${RFQ_SEARCH_KEY}

8 of the 15 lines on RFQ ${RFQ_SEARCH_KEY} were broker-sourced by Tracy Xie (vq@ email forwarded ${new Date().toISOString().split('T')[0]}).

${totalQuotes} broker quotes loaded as VQs against this RFQ:
- 🟢 GREEN best (margin >18%):  ${greenCount}/8 lines
- 🟡 YELLOW best (margin 0-18%): ${yellowCount}/8 lines
- 🔴 ALL RED (no viable quote):  ${redCount}/8 lines
- ⚠ Suspended-vendor quotes captured for record only: ${suspendedCount} (Dragon Core Electronics, BP type 1000004)

Estimated GP at LAM MOQ if best-per-line is taken: $${totalGp.toFixed(2)}

Watchouts:
- Line 120 (LMZ14202TZ-ADJ/NOPB): the GREEN quotes ($6.80–6.95) are for the **LMZ14202TZX-ADJ/NOPB** alt variant. Canonical-MPN quotes are 🟡 11–15% margin. AVL confirmation needed before picking the X variant.
- Line 150 (LT1491ACS#PBF): only quotes that beat resale are **LT1491ACS#TRPBF** (T&R packaging) variants. Canonical #PBF quotes are all 🔴 −13 to −20%.

Attached: LAM-format xlsx with two tabs:
  - "Sourced Reorder Alerts" — best broker pick per line (LAM Kitting Reorder column layout, w/ broker columns swapped in)
  - "All Broker Quotes" — all ${totalQuotes} quotes with per-quote margins, COO, DC, VQ line IDs

Note: this is an APAC broker sourcing supplement to the standard LAM Kitting Reorder cron (which is franchise-only). LAM Kitting policy is franchise-only by default; broker sourcing is for escalation paths. Purchasing/sales decides which (if any) of these to take.
`;

  // Send
  const recipients = 'jake.harris@astutegroup.com, josh.syre@astutegroup.com';
  const notifier = createNotifier({
    fromEmail: 'excess@orangetsunami.com',
    fromName: 'LAM Kitting Reorder',
  });
  const ok = await notifier.sendWithAttachment(
    recipients,
    `LAM Kitting Reorder — APAC Broker Sourcing for RFQ ${RFQ_SEARCH_KEY}`,
    body,
    [{ filename: path.basename(xlsxPath), path: xlsxPath }]
  );
  console.log(ok ? `Email sent to ${recipients}` : 'Email failed');
}

main().catch(err => { console.error(err); process.exit(1); });
