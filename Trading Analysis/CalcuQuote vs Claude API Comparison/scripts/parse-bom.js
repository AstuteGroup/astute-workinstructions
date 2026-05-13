#!/usr/bin/env node
// Parse a CalcuQuote Costed BOM xlsx into the quotes.json format the
// comparison script expects.
//
// Usage:
//   node parse-bom.js <path/to/CostedBOM.xlsx> <scratch_dir>
//
// Auto-detects header row, reads only rows where Selected MPN + Supplier are
// populated (real quotes — not unpriced AVL alternates).

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const SRC = process.argv[2];
const OUT_DIR = process.argv[3];
if (!SRC || !OUT_DIR) {
  console.error('Usage: node parse-bom.js <path/to/CostedBOM.xlsx> <scratch_dir>');
  process.exit(1);
}
const OUT = path.join(OUT_DIR, 'quotes.json');

const wb = xlsx.readFile(SRC, { cellDates: true });
const sh = wb.Sheets['CostedBom'] || wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(sh, { header: 1, defval: null });

const headerIdx = rows.findIndex(r => r && r[0] === 'Description');
if (headerIdx === -1) { console.error('Could not find header row in BOM'); process.exit(1); }
const hdr = rows[headerIdx].map(h => h == null ? '' : String(h).trim());
const col = name => hdr.findIndex(h => h === name);
const cols = {
  desc: col('Description'), allMpn: col('ALL MPN'),
  mfgr: col('Mfgr'), mpn: col('MPN'),
  selMfgr: col('Selected Mfgr'), selMpn: col('Selected MPN'),
  supplier: col('Supplier'), supplierSku: col('Supplier SKU'),
  totalQty: col('Total Qty'), totalDemand: col('Total Demand'),
  rfqTarget: col('RFQ Target Price'),
  quotedCcy: col('Quoted Currency'), quotedUnit: col('Quoted Unit'),
  rfqCcy: hdr.findIndex(h => h === 'RFQ Currency'),
  rfqUnit: hdr.findIndex(h => h === 'RFQ Unit'),
  mfgLeadTime: col('Mfg Lead Time'),
  leadTimeNotes: col('Lead Time Notes')
};

const quotes = [];
for (let r = headerIdx + 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.every(c => c == null || c === '')) continue;
  if (!row[cols.selMpn] || !row[cols.supplier]) continue;
  quotes.push({
    description: row[cols.desc] || '',
    allMpn: row[cols.allMpn] || '',
    rfqMpn: row[cols.mpn] || '',
    rfqMfgr: row[cols.mfgr] || '',
    selectedMpn: String(row[cols.selMpn]).trim(),
    selectedMfgr: row[cols.selMfgr] || '',
    supplier: String(row[cols.supplier]).trim(),
    supplierSku: row[cols.supplierSku] || '',
    totalQty: row[cols.totalQty],
    totalDemand: row[cols.totalDemand],
    rfqTargetPrice: row[cols.rfqTarget],
    quotedCurrency: row[cols.quotedCcy] || '',
    quotedUnit: row[cols.quotedUnit],
    rfqCurrency: row[cols.rfqCcy] || '',
    rfqUnit: row[cols.rfqUnit],
    mfgLeadTime: row[cols.mfgLeadTime],
    leadTimeNotes: row[cols.leadTimeNotes] || ''
  });
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(quotes, null, 2));
console.log(`Parsed ${quotes.length} quote rows from ${path.basename(SRC)} → ${OUT}`);

// Quick summary
const supSet = new Set(quotes.map(q => q.supplier));
const mpnSet = new Set(quotes.map(q => q.selectedMpn));
console.log(`  Unique suppliers : ${supSet.size}`);
console.log(`  Unique MPNs      : ${mpnSet.size}`);
