/**
 * Update SIPOC with all 21 lines loaded today (Tracy + Amatom + DigiKey + TTI).
 * Fuses 4 lines already updated this morning with POV0075524 / PO809583.
 *
 * POV / OT PO not yet assigned by support team — reference the R_Request
 * number in the Notes column with the word "Request" so it's clear what's
 * pending vs already cut.
 *
 * Backs up SIPOC before saving.
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');

const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const BACKUP = path.join(__dirname, `Lam_EPG_SIPOC.backup-2026-04-09-pm.xlsx`);

// Each entry: cpc, vendor name, unit cost, buy qty, lead time string, R_Request#, partial info
const UPDATES = [
  // ─── Tracy / HK brokers — R_Request 1157778 ──────────────────────────────
  { cpc: '631-123367-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 53.4463, qty: 10,  ltw: 'stock',          req: 1157778, note: 'STOCK; absorbs rebalance from EPM240+LTC4231 (real Smartel $41.00)' },
  { cpc: '630-047972-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 74.50,    qty: 10,  ltw: 'stock',          req: 1157778, note: 'Listed as INTEL manufacturer; STOCK' },
  { cpc: '630-052043-001', src: 'CHIP ENERGY INTERNATIONAL',  cost: 12.062,   qty: 50,  ltw: 'stock',          req: 1157778, note: 'COO Malaysia; STOCK' },
  { cpc: '630-048308-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 22.39,    qty: 20,  ltw: 'stock',          req: 1157778, note: 'Booked at LAM target (real Smartel $27.00, rebalanced)' },
  { cpc: '630-337161-001', src: 'Dragon Core Electronics HK', cost: 6.18,     qty: 10,  ltw: 'stock',          req: 1157778, note: 'STOCK; Dragon Core Suspended vendor type — purchasing manager review' },
  { cpc: '630-B70151-001', src: 'HK Firsttop Technology',     cost: 1.04,     qty: 120, ltw: 'stock',          req: 1157778, note: 'Quoted MPN: ADA4891-2ARZ-R7; COO Philippines' },
  { cpc: '630-311294-001', src: 'Dragon Core Electronics HK', cost: 4.63,     qty: 25,  ltw: 'stock',          req: 1157778, note: 'STOCK; Dragon Core Suspended vendor type — purchasing manager review' },
  { cpc: '630-198438-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 15.25,    qty: 15,  ltw: 'stock',          req: 1157778, note: 'Quoted MPN: AD5696RBRUZ-RL7; COO exclusion: not China' },
  { cpc: '630-017794-002', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 9.60,     qty: 20,  ltw: 'stock',          req: 1157778, note: 'STOCK' },
  { cpc: '630-900073-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 8.31,     qty: 25,  ltw: 'stock',          req: 1157778, note: 'Quoted MPN: AD586KRZ-REEL7; STOCK' },
  { cpc: '630-204173-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 2.45,     qty: 80,  ltw: 'stock',          req: 1157778, note: 'Quoted MPN: 524MILFT; STOCK' },
  { cpc: '630-099973-001', src: 'Dragon Core Electronics HK', cost: 6.18,     qty: 35,  ltw: 'stock',          req: 1157778, note: 'Quoted MPN: ADG431BRZ-REEL7; Dragon Core Suspended vendor type' },
  { cpc: '630-341691-001', src: 'SMARTEL ELECTRONICS (ASIA)', cost: 7.3282,   qty: 35,  ltw: 'stock',          req: 1157778, note: 'Booked at LAM target (real Smartel $8.25, rebalanced)' },
  { cpc: '630-343681-001', src: 'CHIP ENERGY INTERNATIONAL',  cost: 5.778,    qty: 40,  ltw: 'stock',          req: 1157778, note: 'Quoted MPN: AD5292BRUZ-20-RL7; COO Malaysia' },

  // ─── Amatom — R_Request 1157851 ───────────────────────────────────────────
  { cpc: '723-097621-068', src: 'Amatom',                     cost: 10.07,    qty: 105, ltw: 'stock',          req: 1157851, note: 'STOCK; 3800 on hand at Amatom' },
  { cpc: '723-097621-043', src: 'Amatom',                     cost: 12.19,    qty: 85,  ltw: '9-10 weeks',     req: 1157851, note: '9-10 week lead time; NCNR per quote' },

  // ─── DigiKey — R_Request 1157858 ──────────────────────────────────────────
  { cpc: '668-A01540-026', src: 'Digi-Key Electronics',       cost: 10.52,    qty: 25,  ltw: 'stock',          req: 1157858, note: 'STOCK; DigiKey PN 626-1892-ND' },
  { cpc: '630-114967-001', src: 'Digi-Key Electronics',       cost: 36.30,    qty: 30,  ltw: 'stock',          req: 1157858, note: 'PARTIAL: 30 of 40 — 10 ea pending; DigiKey PN 220-1183-ND', partialQty: 30, qtyRemaining: 10 },
  { cpc: '668-277308-002', src: 'Digi-Key Electronics',       cost: 7.026,    qty: 35,  ltw: 'stock',          req: 1157858, note: 'STOCK; DigiKey PN 626-1798-ND' },
  { cpc: '668-A51618-026', src: 'Digi-Key Electronics',       cost: 11.6936,  qty: 25,  ltw: 'stock',          req: 1157858, note: 'STOCK; DigiKey PN 626-1893-ND' },

  // ─── TTI — R_Request 1157863 ──────────────────────────────────────────────
  { cpc: '639-A21747-001', src: 'TTI Inc',                    cost: 13.09,    qty: 50,  ltw: 'stock',          req: 1157863, note: 'TTI MOQ 50 (LAM need 20; 30 ea excess); stock 2950; 99wk LT alt' },
];

// Backup
fs.copyFileSync(SIPOC, BACKUP);
console.log(`[backup] ${path.basename(BACKUP)}`);

const wb = XLSX.readFile(SIPOC);
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Build CPC → row index map
const cpcToRow = new Map();
for (let i = 2; i < aoa.length; i++) {
  const cpc = String(aoa[i][0] || '').trim();
  if (cpc) cpcToRow.set(cpc, i);
}

function setCell(rowIdx, colIdx, value, format) {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  let cell = ws[addr];
  if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
  cell.v = value;
  cell.t = (typeof value === 'number') ? 'n' : 's';
  if (format) cell.z = format;
  delete cell.w;
}

let updated = 0, missed = 0;
for (const u of UPDATES) {
  const rowIdx = cpcToRow.get(u.cpc);
  if (rowIdx == null) {
    console.log(`  ✗ CPC ${u.cpc} NOT FOUND in SIPOC`);
    missed++;
    continue;
  }
  const row = aoa[rowIdx];
  const basePrice = Number(row[6] || 0);
  const qtyForSavings = u.qty;
  const savings = (basePrice - u.cost) * qtyForSavings;

  setCell(rowIdx, 15, u.src);
  setCell(rowIdx, 16, Math.round(u.cost * 10000) / 10000, '$#,##0.0000');
  setCell(rowIdx, 17, u.qty, '#,##0');
  setCell(rowIdx, 18, u.qtyRemaining || 0, '#,##0');
  setCell(rowIdx, 19, u.ltw);
  setCell(rowIdx, 20, 'Y');
  setCell(rowIdx, 22, Math.round(savings * 100) / 100, '$#,##0.00');
  // POV col 26: leave blank, support team will fill when PO is cut
  setCell(rowIdx, 33, `Request ${u.req}; ${u.note}`);

  console.log(`  ✓ row ${rowIdx} CPC ${u.cpc}  ${u.src}  Request ${u.req}`);
  updated++;
}

XLSX.writeFile(wb, SIPOC);
console.log(`\n[saved] ${path.basename(SIPOC)}`);
console.log(`[updated] ${updated} rows  |  [missed] ${missed} rows`);
