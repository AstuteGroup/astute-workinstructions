#!/usr/bin/env node
/**
 * Build LAM Master Roster
 *
 * Consolidates all three LAM award files into a single master roster
 * with contract data only (static, manually maintained).
 *
 * Dynamic data (stock, on-order, supplier, delivery dates) is NOT included —
 * that comes from Infor files at query time.
 *
 * Sources:
 * 1. Lam_Kitting_DB (has thresholds)
 * 2. Lam_EPG_SIPOC (no thresholds)
 * 3. Phase 2 Adds (no thresholds)
 *
 * Output: LAM_Master_Roster.xlsx
 *
 * Email for all LAM workflows: lamkitting@orangetsunami.com
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const BASE_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(BASE_DIR, 'Trading Analysis/LAM 3PL');

const FILES = {
  kittingDB: path.join(OUTPUT_DIR, 'Lam_Kitting_DB_05082026.xlsx'),
  epgSipoc: path.join(BASE_DIR, 'Trading Analysis/LAM EPG Award/Lam_EPG_SIPOC.xlsx'),
  phase2Adds: path.join(OUTPUT_DIR, 'Astute_New Part ADDS_ Working Copy - 04222026.xlsx')
};

console.log('Building LAM Master Roster (Contract Data Only)...\n');

// Load Kitting DB
console.log('Loading Kitting DB...');
const kittingWb = XLSX.readFile(FILES.kittingDB, { raw: true });
const kittingData = XLSX.utils.sheet_to_json(kittingWb.Sheets['INVENTORY'], { raw: true });
const kittingMPNs = new Map();
for (const row of kittingData) {
  const mpn = (row['MPN'] || '').toString().trim();
  if (!mpn) continue;
  kittingMPNs.set(mpn.toUpperCase(), {
    mpn,
    cpc: row['Lam P/N'] || '',
    mfr: row['Manufacturer'] || '',
    description: row['Item Description'] || '',
    leadTime: row['Lead Time'] || '',
    basePrice: row['Base Unit Price'],
    resalePrice: row['Resale Price'],
    threshold: row['MIN QTY'],
    moq: row['MOQ'],
    buyer: row['Buyer'] || '',
    source: 'Kitting DB'
  });
}
console.log(`  ${kittingMPNs.size} MPNs from Kitting DB`);

// Load EPG SIPOC
console.log('Loading EPG SIPOC...');
const epgWb = XLSX.readFile(FILES.epgSipoc, { raw: true });
const epgData = XLSX.utils.sheet_to_json(epgWb.Sheets['Sheet1'], { range: 1, raw: true });
const epgMPNs = new Map();
for (const row of epgData) {
  const mpn = (row['MPN'] || '').toString().trim();
  if (!mpn) continue;
  epgMPNs.set(mpn.toUpperCase(), {
    mpn,
    cpc: row['CPC'] || '',
    mfr: row['MFR'] || '',
    description: row['Description '] || row['Description'] || '',
    leadTime: row['Lead time'] || '',
    basePrice: row['Base Unit Price'],
    resalePrice: row['Resale Price'],
    spqMoq: row['SPQ/MOQ'],
    source: 'EPG SIPOC'
  });
}
console.log(`  ${epgMPNs.size} MPNs from EPG SIPOC`);

// Load Phase 2 Adds
console.log('Loading Phase 2 Adds...');
const p2Wb = XLSX.readFile(FILES.phase2Adds, { raw: true });
const p2Data = XLSX.utils.sheet_to_json(p2Wb.Sheets['Astute action list 4.14.26'], { range: 1, raw: true });
const p2MPNs = new Map();
for (const row of p2Data) {
  const mpn = (row['MPN'] || '').toString().trim();
  if (!mpn) continue;
  p2MPNs.set(mpn.toUpperCase(), {
    mpn,
    cpc: row['Part Number '] || row['Part Number'] || '',
    mfr: row['MFR'] || '',
    description: row['Description '] || row['Description'] || '',
    leadTime: row['Lead Time\n(wks)'] || row['Lead Time (wks)'] || '',
    basePrice: row['Base Unit Price'],
    spqMoq: row['SPQ/MOQ'],
    source: 'Phase 2 Adds'
  });
}
console.log(`  ${p2MPNs.size} MPNs from Phase 2 Adds`);

// Consolidate
console.log('\nConsolidating...');
const allMPNs = new Set([...kittingMPNs.keys(), ...epgMPNs.keys(), ...p2MPNs.keys()]);
console.log(`Total unique MPNs: ${allMPNs.size}`);

const consolidated = [];
let withThreshold = 0;
let missingThreshold = 0;

for (const mpnKey of allMPNs) {
  const k = kittingMPNs.get(mpnKey);
  const e = epgMPNs.get(mpnKey);
  const p = p2MPNs.get(mpnKey);

  // Prefer Kitting DB data, then EPG, then Phase 2
  const primary = k || e || p;

  const hasThreshold = k && k.threshold !== undefined && k.threshold !== '';
  if (hasThreshold) {
    withThreshold++;
  } else {
    missingThreshold++;
  }

  // Determine award source(s)
  const awards = [];
  if (k) awards.push('Kitting');
  if (e) awards.push('EPG');
  if (p) awards.push('Phase 2');

  const row = {
    'CPC': k?.cpc || e?.cpc || p?.cpc || '',
    'MPN': primary.mpn,
    'Manufacturer': k?.mfr || e?.mfr || p?.mfr || '',
    'Description': k?.description || e?.description || p?.description || '',
    'Award': awards.join(', '),  // Which program(s) the part is on
    'Base Unit Price': k?.basePrice ?? e?.basePrice ?? p?.basePrice ?? '',
    'Resale Price': k?.resalePrice ?? e?.resalePrice ?? '',
    'Pending': '',  // "Price Approval" / "Removal" / blank
    'Proposed Resale': '',  // New price if pending approval
    'Last Approved': '',  // Date resale was last approved
    'Reorder Threshold': k?.threshold ?? '',
    'MOQ': k?.moq ?? e?.spqMoq ?? p?.spqMoq ?? '',
    'Contractual Lead Time': k?.leadTime || e?.leadTime || p?.leadTime || '',
    'Buyer': k?.buyer || '',
  };

  consolidated.push(row);
}

// Sort by MPN
consolidated.sort((a, b) => a['MPN'].localeCompare(b['MPN']));

console.log(`\nThreshold status:`);
console.log(`  With threshold: ${withThreshold}`);
console.log(`  MISSING threshold: ${missingThreshold}`);

// Build workbook
const wb = XLSX.utils.book_new();

// Main roster sheet
const wsMain = XLSX.utils.json_to_sheet(consolidated);

// Set column widths
wsMain['!cols'] = [
  { wch: 18 },  // CPC
  { wch: 25 },  // MPN
  { wch: 30 },  // Manufacturer
  { wch: 40 },  // Description
  { wch: 18 },  // Award
  { wch: 14 },  // Base Unit Price
  { wch: 12 },  // Resale Price
  { wch: 14 },  // Pending
  { wch: 14 },  // Proposed Resale
  { wch: 12 },  // Last Approved
  { wch: 16 },  // Reorder Threshold
  { wch: 8 },   // MOQ
  { wch: 12 },  // Lead Time
  { wch: 15 },  // Buyer
];

XLSX.utils.book_append_sheet(wb, wsMain, 'Master Roster');

// Missing thresholds sheet
const missing = consolidated.filter(r => r['Reorder Threshold'] === '');
const wsMissing = XLSX.utils.json_to_sheet(missing);
XLSX.utils.book_append_sheet(wb, wsMissing, 'Missing Thresholds');

// Summary sheet
const summary = [
  { Metric: 'Total unique MPNs', Value: allMPNs.size },
  { Metric: 'With Reorder Threshold', Value: withThreshold },
  { Metric: 'Missing threshold', Value: missingThreshold },
  { Metric: '', Value: '' },
  { Metric: 'Source: Kitting DB', Value: kittingMPNs.size },
  { Metric: 'Source: EPG SIPOC', Value: epgMPNs.size },
  { Metric: 'Source: Phase 2 Adds', Value: p2MPNs.size },
  { Metric: '', Value: '' },
  { Metric: 'Email', Value: 'lamkitting@orangetsunami.com' },
  { Metric: 'Generated', Value: new Date().toISOString() },
];
const wsSummary = XLSX.utils.json_to_sheet(summary);
XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

// Write output
const outputPath = path.join(OUTPUT_DIR, 'LAM_Master_Roster.xlsx');
XLSX.writeFile(wb, outputPath);

console.log(`\nOutput: ${outputPath}`);
console.log(`\nSheets:`);
console.log(`  - Master Roster: ${consolidated.length} rows`);
console.log(`  - Missing Thresholds: ${missing.length} rows (need Reorder Threshold added)`);
console.log(`  - Summary`);
console.log(`\nColumns:`);
console.log(`  CPC, MPN, Manufacturer, Description, Award`);
console.log(`  Base Unit Price, Resale Price`);
console.log(`  Pending, Proposed Resale, Last Approved`);
console.log(`  Reorder Threshold, MOQ, Contractual Lead Time, Buyer`);
