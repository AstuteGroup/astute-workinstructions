/**
 * Update Lam_EPG_SIPOC.xlsx with the Fuses Unlimited PO that just landed.
 *
 *   OT PO:  PO809583
 *   Infor:  POV0075524
 *
 * Touches 4 rows (per Jake's "everything else relating to this order"):
 *   1. Row 12  LP-CC-30        — multi-source partial: Arrow (20) + Fuses (30) = 50 full
 *   2. Row 22  KLKR007.T       — multi-source partial: Sager (60) + Fuses (20) = 80 full
 *   3. Row 155 #ABC-12         — clean Fuses (105 full, was "pending")
 *   4. Row 203 S505H-500-R     — clean Fuses (200 full, was "pending")
 *
 * NOTE: Row 168 (BK/1A1119-10-R) is the held line — Jake said "we'll get that
 * from Master next" — NOT touched. The 1131217 data-capture VQ for it
 * (vq_line_id 2004760) does not affect 1132040 SIPOC.
 *
 * Backs up to Lam_EPG_SIPOC.backup-<date>.xlsx before saving.
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');

const SIPOC_FILE = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const BACKUP_FILE = path.join(__dirname, `Lam_EPG_SIPOC.backup-${new Date().toISOString().slice(0,10)}.xlsx`);

const FUSES_OT_PO = 'PO809583';
const FUSES_POV   = 'POV0075524';

// Backup
fs.copyFileSync(SIPOC_FILE, BACKUP_FILE);
console.log(`[backup] ${path.basename(BACKUP_FILE)}`);

const wb = XLSX.readFile(SIPOC_FILE);
const sheetName = wb.SheetNames[0];
const ws = wb.Sheets[sheetName];

// Helper to set cell value (preserves cell if exists, creates if missing)
function setCell(rowIdx, colIdx, value, format) {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  let cell = ws[addr];
  if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
  cell.v = value;
  if (typeof value === 'number') cell.t = 'n';
  else cell.t = 's';
  if (format) cell.z = format;
  delete cell.w; // clear cached display
}

// ── Row 12: LP-CC-30 (multi-source Arrow + Fuses) ──────────────────────────
{
  const r = 12;
  const arrowQty = 20, arrowPx = 49.66;
  const fusesQty = 30, fusesPx = 24.0308;
  const totalQty = arrowQty + fusesQty;
  const wAvg = (arrowQty * arrowPx + fusesQty * fusesPx) / totalQty;
  const basePx = 60.6146;
  const savings = basePx * totalQty - (arrowQty * arrowPx + fusesQty * fusesPx);

  setCell(r, 15, `Arrow (${arrowQty} @ $${arrowPx}) / Fuses Unlimited (${fusesQty} @ $${fusesPx})`);
  setCell(r, 16, Math.round(wAvg * 10000) / 10000, '$#,##0.0000');
  setCell(r, 17, totalQty, '#,##0');
  setCell(r, 18, 0, '#,##0');
  setCell(r, 19, 'stock');
  setCell(r, 20, 'Y');
  setCell(r, 22, Math.round(savings * 100) / 100, '$#,##0.00');
  setCell(r, 26, `POV0075254 / ${FUSES_POV}`);
  setCell(r, 33, `Fuses ${FUSES_OT_PO} (${fusesQty}ea @ $${fusesPx}); Arrow earlier`);
  console.log(`[row 12] LP-CC-30:        Arrow(20) + Fuses(30) = 50, w.avg $${wAvg.toFixed(4)}, savings $${savings.toFixed(2)}`);
}

// ── Row 22: KLKR007.T (multi-source Sager + Fuses) ─────────────────────────
{
  const r = 22;
  const sagerQty = 60, sagerPx = 21.25;
  const fusesQty = 20, fusesPx = 19.148;
  const totalQty = sagerQty + fusesQty;
  const wAvg = (sagerQty * sagerPx + fusesQty * fusesPx) / totalQty;
  const basePx = 25.715;
  const savings = basePx * totalQty - (sagerQty * sagerPx + fusesQty * fusesPx);

  setCell(r, 15, `Sager (${sagerQty} @ $${sagerPx}) / Fuses Unlimited (${fusesQty} @ $${fusesPx})`);
  setCell(r, 16, Math.round(wAvg * 10000) / 10000, '$#,##0.0000');
  setCell(r, 17, totalQty, '#,##0');
  setCell(r, 18, 0, '#,##0');
  setCell(r, 19, 'lead time / stock');
  setCell(r, 20, 'Y');
  setCell(r, 22, Math.round(savings * 100) / 100, '$#,##0.00');
  setCell(r, 26, `POV0075301 / ${FUSES_POV}`);
  setCell(r, 33, `Fuses ${FUSES_OT_PO} (${fusesQty}ea @ $${fusesPx}); Sager earlier`);
  console.log(`[row 22] KLKR007.T:       Sager(60) + Fuses(20) = 80, w.avg $${wAvg.toFixed(4)}, savings $${savings.toFixed(2)}`);
}

// ── Row 155: #ABC-12 (clean Fuses 105 full) ────────────────────────────────
{
  const r = 155;
  const qty = 105, px = 0.2707;
  const basePx = 2.49;
  const savings = basePx * qty - qty * px;

  setCell(r, 15, 'Fuses Unlimited');
  setCell(r, 16, px, '$#,##0.0000');
  setCell(r, 17, qty, '#,##0');
  setCell(r, 18, 0, '#,##0');
  setCell(r, 19, 'stock');
  setCell(r, 20, 'Y');
  setCell(r, 22, Math.round(savings * 100) / 100, '$#,##0.00');
  setCell(r, 26, FUSES_POV);
  setCell(r, 33, `Fuses ${FUSES_OT_PO}; BK/ABC-12-R part number accepted`);
  console.log(`[row 155] #ABC-12:        Fuses ${qty} @ $${px}, savings $${savings.toFixed(2)}`);
}

// ── Row 203: S505H-500-R (clean Fuses 200 full) ────────────────────────────
{
  const r = 203;
  const qty = 200, px = 1.1036;
  const basePx = 1.2523;
  const savings = basePx * qty - qty * px;

  setCell(r, 15, 'Fuses Unlimited');
  setCell(r, 16, px, '$#,##0.0000');
  setCell(r, 17, qty, '#,##0');
  setCell(r, 18, 0, '#,##0');
  setCell(r, 19, 'stock');
  setCell(r, 20, 'Y');
  setCell(r, 22, Math.round(savings * 100) / 100, '$#,##0.00');
  setCell(r, 26, FUSES_POV);
  setCell(r, 33, `Fuses ${FUSES_OT_PO}; BK1-S505H-500-R part number accepted`);
  console.log(`[row 203] S505H-500-R:    Fuses ${qty} @ $${px}, savings $${savings.toFixed(2)}`);
}

XLSX.writeFile(wb, SIPOC_FILE);
console.log(`\n[saved] ${path.basename(SIPOC_FILE)}`);
