/**
 * Regenerate the sourcing xlsx with "best vendor only" per tab.
 *
 * Reads EPG_Remaining_ByVendor_20260409.xlsx (which has every quote on every
 * vendor's tab — duplicative) and writes a new file where each line appears
 * on exactly ONE tab (its best franchise vendor's). No duplicates.
 *
 * Adds a "Next Best Alt" column on each tab so you can see the consolidation
 * trade-off when the runner-up is on a different vendor.
 *
 * Marks lines already loaded today so the buyer doesn't re-pick them.
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');

const SRC = path.join(__dirname, 'EPG_Remaining_ByVendor_20260409.xlsx');
const OUT = path.join(__dirname, `EPG_Remaining_BestOnly_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`);

// CPCs already loaded as IsPurchased=Y today (Fuses + Tracy + Amatom + DigiKey)
const ALREADY_LOADED = new Set([
  // Fuses
  '670-346211-025','670-332664-018','670-006780-038','670-338640-050',
  // Tracy/HK (incl Zynq held — count as touched)
  '630-337692-003','631-123367-001','630-047972-001','630-052043-001',
  '630-048308-001','630-337161-001','630-B70151-001','630-311294-001',
  '630-198438-001','630-017794-002','630-900073-001','630-099973-001',
  '630-341691-001','630-343681-001','630-204173-001',
  // Amatom
  '723-097621-068','723-097621-043',
  // DigiKey (just loaded)
  '630-114967-001','668-A01540-026','668-277308-002','668-A51618-026',
]);

const wb = XLSX.readFile(SRC);

// Build per-MPN quote map across all vendor tabs
const byMpn = new Map();
for (const sheetName of wb.SheetNames) {
  if (sheetName === 'Summary' || sheetName === 'No Source') continue;
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // headers: Line, CPC, MPN, MFR, Need Qty, Resale, Cost, Avail Qty, Full Qty?, Margin %, Line GP, API Hits, LT Alt Vendor, LT Alt Cost, LT Lead Time, LT Margin %
  for (const r of rows.slice(1)) {
    const mpn = String(r[2] || '').trim();
    if (!mpn) continue;
    const cpc = String(r[1] || '').trim();
    const cost = Number(r[6] || 0);
    if (!cost || cost <= 0) continue;
    const availQty = Number(r[7] || 0);
    const isStock = availQty > 0;
    if (!byMpn.has(mpn)) {
      byMpn.set(mpn, {
        line: r[0], cpc, mpn,
        mfr: r[3], need: Number(r[4]),
        resale: Number(r[5]),
        quotes: [],
      });
    }
    byMpn.get(mpn).quotes.push({
      vendor: sheetName,
      cost,
      availQty,
      isStock,
      fullQty: r[8],
      margin: Number(r[9] || 0),
      gp: Number(r[10] || 0),
      ltLeadTime: r[14],
      ltMargin: r[15],
    });
  }
}

// For each MPN, pick the best vendor (cheapest cost; prefer stock over LT when costs are tied)
const winnerByVendor = new Map(); // vendor -> [winning rows]
const noClearWinner = []; // for the "No Source" tab — should still match the original
for (const [mpn, d] of byMpn) {
  // Sort: stock first, then by cost ascending
  const sorted = [...d.quotes].sort((a, b) => {
    if (a.isStock !== b.isStock) return a.isStock ? -1 : 1;
    return a.cost - b.cost;
  });
  const best = sorted[0];
  const runnerUp = sorted[1] || null;
  const alreadyLoaded = ALREADY_LOADED.has(d.cpc);

  const winnerRow = {
    line: d.line, cpc: d.cpc, mpn, mfr: d.mfr, need: d.need, resale: d.resale,
    cost: best.cost, availQty: best.isStock ? best.availQty : 0,
    fullQty: best.fullQty, margin: best.margin, gp: best.gp,
    isStock: best.isStock,
    ltLeadTime: best.isStock ? '' : best.ltLeadTime,
    altVendor: runnerUp ? runnerUp.vendor : '',
    altCost: runnerUp ? runnerUp.cost : '',
    altDelta: runnerUp ? runnerUp.cost - best.cost : '',
    quoteCount: d.quotes.length,
    alreadyLoaded,
  };

  if (!winnerByVendor.has(best.vendor)) winnerByVendor.set(best.vendor, []);
  winnerByVendor.get(best.vendor).push(winnerRow);
}

// Build new workbook
const wbOut = XLSX.utils.book_new();

// Summary tab
const sortedVendors = [...winnerByVendor.entries()].sort((a, b) => b[1].length - a[1].length);
const summary = [
  [`LAM EPG RFQ 1132040 — Remaining-Lines Sourcing Report (BEST VENDOR ONLY)`],
  ['Generated', new Date().toISOString().slice(0,10)],
  ['Source', 'Filtered from EPG_Remaining_ByVendor_20260409.xlsx — each line appears on exactly ONE tab (its best franchise vendor)'],
  ['Lines marked "ALREADY LOADED"', 'CPCs that already have IsPurchased=Y from today\'s Fuses + Tracy + Amatom + DigiKey batches'],
  [''],
  ['Vendor', 'Lines (best)', 'Lines remaining (not loaded)', 'Total Cost', 'Total Resale', 'Gross Profit', 'Avg Margin %'],
];
let totLines = 0, totRem = 0, totCost = 0, totResale = 0, totGp = 0;
for (const [vendor, rows] of sortedVendors) {
  const remRows = rows.filter(r => !r.alreadyLoaded);
  const lns = rows.length;
  const rem = remRows.length;
  const cost = remRows.reduce((s, r) => s + r.cost * r.need, 0);
  const res = remRows.reduce((s, r) => s + r.resale * r.need, 0);
  const gp = res - cost;
  const m = res > 0 ? gp / res : 0;
  summary.push([vendor, lns, rem, cost, res, gp, m]);
  totLines += lns; totRem += rem; totCost += cost; totResale += res; totGp += gp;
}
summary.push([]);
summary.push(['TOTAL', totLines, totRem, totCost, totResale, totGp, totResale > 0 ? totGp / totResale : 0]);

const sumWs = XLSX.utils.aoa_to_sheet(summary);
sumWs['!cols'] = [{wch:18},{wch:13},{wch:24},{wch:14},{wch:14},{wch:14},{wch:13}];
for (let r = 6; r < 6 + sortedVendors.length; r++) {
  for (const c of [3,4,5]) { const cell = sumWs[XLSX.utils.encode_cell({r, c})]; if (cell) cell.z = '$#,##0.00'; }
  const mc = sumWs[XLSX.utils.encode_cell({r, c:6})]; if (mc) mc.z = '0.0%';
}
const totRow = 7 + sortedVendors.length;
for (const c of [3,4,5]) { const cell = sumWs[XLSX.utils.encode_cell({r:totRow, c})]; if (cell) cell.z = '$#,##0.00'; }
const totMc = sumWs[XLSX.utils.encode_cell({r:totRow, c:6})]; if (totMc) totMc.z = '0.0%';
XLSX.utils.book_append_sheet(wbOut, sumWs, 'Summary');

// Per-vendor tabs (BEST ONLY)
const headerCols = [
  'Line', 'CPC', 'MPN', 'MFR', 'Need Qty', 'Resale', 'Cost', 'Avail Qty', 'Full Qty?',
  'Margin %', 'Line GP', 'Stock?', 'Lead Time',
  'Next Best Alt Vendor', 'Next Best Alt Cost', 'Δ Cost (alt − best)',
  'Quote Count', 'Already Loaded?',
];
for (const [vendor, rows] of sortedVendors) {
  const data = [headerCols];
  // Sort: not-loaded first, then by GP descending
  const sorted = [...rows].sort((a, b) => {
    if (a.alreadyLoaded !== b.alreadyLoaded) return a.alreadyLoaded ? 1 : -1;
    return (b.gp || 0) - (a.gp || 0);
  });
  for (const r of sorted) {
    data.push([
      r.line, r.cpc, r.mpn, r.mfr, r.need, r.resale, r.cost, r.availQty, r.fullQty,
      r.margin, r.gp, r.isStock ? 'STOCK' : 'LT', r.ltLeadTime || '',
      r.altVendor, r.altCost, r.altDelta,
      r.quoteCount, r.alreadyLoaded ? 'YES (skip)' : '',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [
    {wch:6},{wch:18},{wch:24},{wch:22},{wch:9},{wch:11},{wch:11},{wch:10},{wch:10},
    {wch:9},{wch:11},{wch:8},{wch:13},{wch:18},{wch:13},{wch:14},{wch:11},{wch:14},
  ];
  for (let r = 1; r <= sorted.length; r++) {
    const fmt = (c, z) => { const cell = ws[XLSX.utils.encode_cell({r, c})]; if (cell) cell.z = z; };
    fmt(5, '$#,##0.0000');  // Resale
    fmt(6, '$#,##0.0000');  // Cost
    fmt(9, '0.0%');          // Margin
    fmt(10, '$#,##0.00');    // GP
    fmt(14, '$#,##0.0000');  // Alt Cost
    fmt(15, '$#,##0.0000');  // Δ
  }
  const safe = vendor.replace(/[\/\\\?\*\[\]:]/g, '').substring(0, 31);
  XLSX.utils.book_append_sheet(wbOut, ws, safe);
}

// Carry over the No Source tab unchanged
if (wb.Sheets['No Source']) {
  XLSX.utils.book_append_sheet(wbOut, wb.Sheets['No Source'], 'No Source');
}

XLSX.writeFile(wbOut, OUT);
console.log(`Wrote ${OUT}`);
console.log(`Vendors: ${winnerByVendor.size}`);
for (const [v, rs] of sortedVendors) {
  const rem = rs.filter(r => !r.alreadyLoaded).length;
  console.log(`  ${v.padEnd(16)} ${rs.length} best (${rem} remaining)`);
}
