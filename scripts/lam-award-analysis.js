#!/usr/bin/env node
/**
 * LAM Award Consolidation Analysis
 *
 * Analyzes all three LAM award files to identify:
 * - Overlap between files
 * - Items missing from Kitting DB (no threshold data)
 * - Items with missing threshold values
 */

const XLSX = require('xlsx');
const path = require('path');

const FILES = {
  kittingDB: path.join(__dirname, '../Trading Analysis/LAM 3PL/Lam_Kitting_DB_05082026.xlsx'),
  epgSipoc: path.join(__dirname, '../Trading Analysis/LAM EPG Award/Lam_EPG_SIPOC.xlsx'),
  phase2Adds: path.join(__dirname, '../Trading Analysis/LAM 3PL/Astute_New Part ADDS_ Working Copy - 04222026.xlsx')
};

// Load Kitting DB
const kittingWb = XLSX.readFile(FILES.kittingDB, { raw: true });
const kittingData = XLSX.utils.sheet_to_json(kittingWb.Sheets['INVENTORY'], { raw: true });
const kittingMPNs = new Map();
for (const row of kittingData) {
  const mpn = (row['MPN'] || '').toString().trim();
  if (mpn) {
    kittingMPNs.set(mpn.toUpperCase(), {
      mpn,
      cpc: row['Lam P/N'],
      threshold: row['MIN QTY'],
      moq: row['MOQ'],
      basePrice: row['Base Unit Price'],
      resalePrice: row['Resale Price'],
      source: 'Kitting DB'
    });
  }
}

// Load EPG SIPOC (header is row 1)
const epgWb = XLSX.readFile(FILES.epgSipoc, { raw: true });
const epgData = XLSX.utils.sheet_to_json(epgWb.Sheets['Sheet1'], { range: 1, raw: true });
const epgMPNs = new Map();
for (const row of epgData) {
  const mpn = (row['MPN'] || '').toString().trim();
  if (mpn) {
    epgMPNs.set(mpn.toUpperCase(), {
      mpn,
      cpc: row['CPC'],
      spqMoq: row['SPQ/MOQ'],
      basePrice: row['Base Unit Price'],
      resalePrice: row['Resale Price'],
      leadTime: row['Lead time'],
      source: 'EPG SIPOC'
    });
  }
}

// Load Phase 2 Adds (header is row 1)
const p2Wb = XLSX.readFile(FILES.phase2Adds, { raw: true });
const p2Data = XLSX.utils.sheet_to_json(p2Wb.Sheets['Astute action list 4.14.26'], { range: 1, raw: true });
const p2MPNs = new Map();
for (const row of p2Data) {
  const mpn = (row['MPN'] || '').toString().trim();
  if (mpn) {
    p2MPNs.set(mpn.toUpperCase(), {
      mpn,
      cpc: row['Part Number '] || row['Part Number'],
      spqMoq: row['SPQ/MOQ'],
      basePrice: row['Base Unit Price'],
      leadTime: row['Lead Time\n(wks)'] || row['Lead Time (wks)'],
      source: 'Phase 2 Adds'
    });
  }
}

console.log('=== LAM AWARD CONSOLIDATION ANALYSIS ===\n');
console.log('File counts:');
console.log('  Kitting DB:', kittingMPNs.size, 'MPNs');
console.log('  EPG SIPOC:', epgMPNs.size, 'MPNs');
console.log('  Phase 2 Adds:', p2MPNs.size, 'MPNs');

// Find overlaps and gaps
const allMPNs = new Set([...kittingMPNs.keys(), ...epgMPNs.keys(), ...p2MPNs.keys()]);
console.log('\nTotal unique MPNs across all files:', allMPNs.size);

let inKittingOnly = 0;
let inEpgOnly = 0;
let inP2Only = 0;
let inKittingAndEpg = 0;
let inKittingAndP2 = 0;
let inEpgAndP2 = 0;
let inAll = 0;
const missingFromKitting = [];

for (const mpn of allMPNs) {
  const inK = kittingMPNs.has(mpn);
  const inE = epgMPNs.has(mpn);
  const inP = p2MPNs.has(mpn);

  if (inK && inE && inP) inAll++;
  else if (inK && inE) inKittingAndEpg++;
  else if (inK && inP) inKittingAndP2++;
  else if (inE && inP) inEpgAndP2++;
  else if (inK) inKittingOnly++;
  else if (inE) inEpgOnly++;
  else if (inP) inP2Only++;

  // Track items NOT in Kitting DB (missing thresholds)
  if (!inK && (inE || inP)) {
    const data = epgMPNs.get(mpn) || p2MPNs.get(mpn);
    missingFromKitting.push({ mpn: data.mpn, source: data.source, cpc: data.cpc });
  }
}

console.log('\nOverlap analysis:');
console.log('  In Kitting DB only:', inKittingOnly);
console.log('  In EPG SIPOC only:', inEpgOnly);
console.log('  In Phase 2 only:', inP2Only);
console.log('  In Kitting + EPG:', inKittingAndEpg);
console.log('  In Kitting + Phase 2:', inKittingAndP2);
console.log('  In EPG + Phase 2 (no Kitting!):', inEpgAndP2);
console.log('  In all three:', inAll);

console.log('\n=== CRITICAL: ITEMS MISSING THRESHOLDS ===');
console.log('(In EPG or Phase 2, but NOT in Kitting DB - no MIN QTY threshold!)');
console.log('Count:', missingFromKitting.length);
if (missingFromKitting.length > 0) {
  console.log('\nFirst 30:');
  missingFromKitting.slice(0, 30).forEach(m => {
    console.log(' ', m.mpn, '|', m.cpc, '| from:', m.source);
  });
  if (missingFromKitting.length > 30) {
    console.log('  ... and', missingFromKitting.length - 30, 'more');
  }
}

// Check items in Kitting DB with no threshold value
const noThreshold = [];
for (const [mpn, data] of kittingMPNs) {
  const t = data.threshold;
  if (t === undefined || t === null || t === '' || isNaN(t)) {
    noThreshold.push(data);
  }
}
console.log('\n=== ITEMS IN KITTING DB WITH MISSING/INVALID THRESHOLD ===');
console.log('Count:', noThreshold.length);
if (noThreshold.length > 0) {
  noThreshold.slice(0, 20).forEach(d => {
    console.log(' ', d.mpn, '|', d.cpc, '| MIN QTY:', d.threshold);
  });
}

// Summary
console.log('\n=== SUMMARY ===');
console.log('Items with threshold data (in Kitting DB):', kittingMPNs.size - noThreshold.length);
console.log('Items MISSING threshold data:');
console.log('  - Not in Kitting DB at all:', missingFromKitting.length);
console.log('  - In Kitting DB but threshold blank:', noThreshold.length);
console.log('  TOTAL MISSING:', missingFromKitting.length + noThreshold.length);
