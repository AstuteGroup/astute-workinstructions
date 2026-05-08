/**
 * Complete SIPOC field update for the 4 broker POs.
 * Fills: MPN to Purchase, Manufacturer, Qty Remaining, Total Cost,
 *        Margin, RFQ Number, Ship to, Processed in OT
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');

const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');

const COL = {
  CPC: 0, DESC: 1, MPN: 2, MFR: 3, LEAD_TIME: 4, SPQ_MOQ: 5,
  BASE_PRICE: 6, TOTAL_COST_BASE: 7, RESALE: 8,
  MPN_TO_PURCHASE: 13, MANUFACTURER: 14, SOURCE: 15,
  PURCHASE_PRICE: 16, QTY: 17, QTY_REMAINING: 18,
  LT_WKS: 19, VQ_IN_OT: 20,
  TOTAL_COST: 21, SAVINGS: 22, MARGIN: 23,
  CONTRACT_REVIEW: 24, RFQ_NUMBER: 25, POV: 26,
  PURCHASED_BY: 27, PO_SENT: 28, SHIP_TO: 29,
  PROCESSED_IN_OT: 30, OT_ORDER: 31,
  NOTES: 33,
};

// Vendor source name patterns for matching
const BROKER_VENDORS = ['SMARTEL', 'CHIP ENERGY', 'Dragon Core', 'Firsttop'];

function setSipocCell(ws, rowIdx, colIdx, value, format) {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  let cell = ws[addr];
  if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
  cell.v = value;
  cell.t = (typeof value === 'number') ? 'n' : 's';
  if (format) cell.z = format;
  delete cell.w;
}

function getCellVal(aoa, row, col) {
  return aoa[row] ? (aoa[row][col] || '') : '';
}

const wb = XLSX.readFile(SIPOC);
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

let updated = 0;

for (let i = 2; i < aoa.length; i++) {
  const r = aoa[i];
  const cpc = String(r[COL.CPC] || '').trim();
  if (!cpc) continue;

  const source = String(r[COL.SOURCE] || '').trim();
  const pov = String(r[COL.POV] || '').trim();

  // Only process rows with our broker POVs
  if (!pov || !pov.startsWith('POV00755')) continue;
  if (!BROKER_VENDORS.some(v => source.toUpperCase().includes(v.toUpperCase()))) continue;

  const mpn = String(r[COL.MPN] || '').trim();
  const mfr = String(r[COL.MFR] || '').trim();
  const purchasePrice = Number(r[COL.PURCHASE_PRICE] || 0);
  const qty = Number(r[COL.QTY] || 0);
  const resale = Number(r[COL.RESALE] || 0);
  const notes = String(r[COL.NOTES] || '').trim();

  // Extract quoted MPN from notes if present (e.g., "Quoted MPN: AD586KRZ-REEL7")
  const quotedMatch = notes.match(/Quoted MPN:\s*([^\s;]+)/i);
  const mpnToPurchase = quotedMatch ? quotedMatch[1] : mpn;

  // Col 13: MPN to Purchase
  if (!String(r[COL.MPN_TO_PURCHASE] || '').trim()) {
    setSipocCell(ws, i, COL.MPN_TO_PURCHASE, mpnToPurchase);
  }

  // Col 14: Manufacturer (purchasing)
  if (!String(r[COL.MANUFACTURER] || '').trim()) {
    setSipocCell(ws, i, COL.MANUFACTURER, mfr);
  }

  // Col 18: Qty Remaining to Source — 0 (fully sourced)
  if (!String(r[COL.QTY_REMAINING] || '').toString().trim() || r[COL.QTY_REMAINING] === '') {
    setSipocCell(ws, i, COL.QTY_REMAINING, 0, '#,##0');
  }

  // Col 21: Total Cost (purchase price × qty)
  if (!r[COL.TOTAL_COST] || r[COL.TOTAL_COST] === '') {
    const totalCost = purchasePrice * qty;
    setSipocCell(ws, i, COL.TOTAL_COST, totalCost, '$#,##0.00');
  }

  // Col 23: Margin ((resale - purchase) / resale)
  if (!r[COL.MARGIN] || r[COL.MARGIN] === '') {
    if (resale > 0) {
      const margin = (resale - purchasePrice) / resale;
      setSipocCell(ws, i, COL.MARGIN, margin, '0.0%');
    }
  }

  // Col 25: RFQ Number
  if (!String(r[COL.RFQ_NUMBER] || '').trim()) {
    setSipocCell(ws, i, COL.RFQ_NUMBER, '1132040');
  }

  // Col 29: Ship to — HK brokers ship to Hong Kong
  if (!String(r[COL.SHIP_TO] || '').trim()) {
    setSipocCell(ws, i, COL.SHIP_TO, 'Hong Kong');
  }

  // Col 30: Processed in OT — Y (VQs loaded, approval request made)
  if (!String(r[COL.PROCESSED_IN_OT] || '').trim()) {
    setSipocCell(ws, i, COL.PROCESSED_IN_OT, 'Y');
  }

  console.log(`  Row ${i}: CPC=${cpc} → MPN2Buy=${mpnToPurchase} MFR=${mfr} TotalCost=$${(purchasePrice*qty).toFixed(2)} Margin=${resale > 0 ? ((resale-purchasePrice)/resale*100).toFixed(1) : '?'}% Ship=HK`);
  updated++;
}

// Ensure range covers all columns
const range = XLSX.utils.decode_range(ws['!ref']);
if (range.e.c < 38) { range.e.c = 38; ws['!ref'] = XLSX.utils.encode_range(range); }

XLSX.writeFile(wb, SIPOC);
console.log(`\n✓ SIPOC complete update: ${updated} rows — MPN to Purchase, Manufacturer, Qty Remaining, Total Cost, Margin, RFQ Number, Ship to, Processed in OT`);
