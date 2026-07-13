#!/usr/bin/env node
/**
 * Build Complete AVL for LAM Program
 *
 * Sources:
 * 1. Astute New Part ADDs_ Working Copy.xlsx [MPNs] - 2,566 rows (Kitting AVL)
 * 2. Copy of Lam-Astute_NewParts - 02122026.xlsx [AVL] - 3,267 rows (NewParts AVL)
 * 3. EPG_AVL_Alternates_Analysis_20260409.xlsx - 68 rows (EPG alternates)
 * 4. Master Roster - to identify gaps
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const BASE_DIR = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis';
const FILE_DROP = '/home/analytics_user/workspace/file-drop';

/**
 * Load Kitting AVL from MPNs sheet
 * Format: Multiple MFRs and MPNs per row, newline-separated
 * (P) = Primary, (A) = Alternate
 */
function loadKittingAVL() {
  const filePath = path.join(FILE_DROP, 'Astute New Part ADDs_ Working Copy.xlsx');
  if (!fs.existsSync(filePath)) {
    console.log('  WARNING: Kitting AVL file not found:', filePath);
    return {};
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['MPNs'];
  if (!ws) {
    console.log('  WARNING: MPNs sheet not found');
    return {};
  }

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Find header row
  let headerIdx = -1;
  for (let i = 0; i < 10; i++) {
    if (data[i] && data[i].includes('Number')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.log('  WARNING: Could not find header row in MPNs sheet');
    return {};
  }

  const headers = data[headerIdx];
  const numIdx = headers.indexOf('Number');
  const mfrIdx = headers.indexOf('Mfg Name');
  const mpnIdx = headers.indexOf('Mfg Part Number');

  const avl = {};
  let totalEntries = 0;

  for (let i = headerIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[numIdx]) continue;

    const cpc = String(row[numIdx]).trim();
    const mfrCell = row[mfrIdx] ? String(row[mfrIdx]) : '';
    const mpnCell = row[mpnIdx] ? String(row[mpnIdx]) : '';

    // Split by newlines
    const mfrs = mfrCell.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const mpns = mpnCell.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    if (!avl[cpc]) avl[cpc] = [];

    // Pair up MFRs and MPNs
    const maxLen = Math.max(mfrs.length, mpns.length);
    for (let j = 0; j < maxLen; j++) {
      const mfr = mfrs[j] || mfrs[0] || '';
      const mpn = mpns[j] || mpns[0] || '';

      // Check if (P) primary or (A) alternate
      const isPrimary = mfr.includes('(P)');
      const cleanMfr = mfr.replace(/\s*\([PA]\)\s*/g, '').trim();

      avl[cpc].push({
        mpn: mpn,
        mfr: cleanMfr,
        preferred: isPrimary,
        source: 'Kitting-AVL'
      });
      totalEntries++;
    }
  }

  console.log(`  Kitting AVL: ${Object.keys(avl).length} CPCs, ${totalEntries} MPN entries`);
  return avl;
}

/**
 * Load NewParts AVL
 */
function loadNewPartsAVL() {
  const filePath = path.join(BASE_DIR, 'LAM New Parts Pricing/Copy of Lam-Astute_NewParts - 02122026.xlsx');
  if (!fs.existsSync(filePath)) {
    console.log('  WARNING: NewParts AVL file not found');
    return {};
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['AVL'];
  if (!ws) {
    console.log('  WARNING: AVL sheet not found in NewParts file');
    return {};
  }

  const data = XLSX.utils.sheet_to_json(ws);

  const avl = {};
  for (const row of data) {
    const cpc = row.Material;
    if (!cpc) continue;

    if (!avl[cpc]) avl[cpc] = [];
    avl[cpc].push({
      mpn: row['Manufacturer Part ID.'],
      mfr: row['Name of manufacturer'],
      preferred: row["Prefered Manufacturer's Part Number"] === 'X',
      source: 'NewParts-AVL'
    });
  }

  console.log(`  NewParts AVL: ${Object.keys(avl).length} CPCs, ${Object.values(avl).flat().length} MPN entries`);
  return avl;
}

/**
 * Load EPG Alternates
 */
function loadEPGAlternates() {
  const filePath = path.join(BASE_DIR, 'LAM EPG Award/EPG_AVL_Alternates_Analysis_20260409.xlsx');
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Alternates Analysis'];
  if (!ws) return {};

  const data = XLSX.utils.sheet_to_json(ws);

  const avl = {};
  for (const row of data) {
    const cpc = row.CPC;
    if (!cpc) continue;

    if (!avl[cpc]) avl[cpc] = [];
    avl[cpc].push({
      mpn: row['AVL MPN'],
      mfr: row.MFR,
      preferred: row['Preferred?'] === 'YES',
      winner: row['WINNER?'] ? true : false,
      source: 'EPG-Alternates'
    });
  }

  console.log(`  EPG Alternates: ${Object.keys(avl).length} CPCs, ${Object.values(avl).flat().length} MPN entries`);
  return avl;
}

/**
 * Load Master Roster CPCs
 */
function loadMasterRosterCPCs() {
  const filePath = path.join(BASE_DIR, 'LAM 3PL/LAM_Master_Roster.xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Master Roster'];
  const data = XLSX.utils.sheet_to_json(ws);

  const roster = {};
  for (const row of data) {
    const cpc = row.CPC;
    if (!cpc) continue;
    roster[cpc] = {
      mpn: row.MPN,
      mfr: row.Manufacturer,
      award: row.Award
    };
  }
  return roster;
}

// Main
console.log('=== Building Complete LAM AVL ===\n');

// Load all sources
console.log('Loading sources...');
const kittingAVL = loadKittingAVL();
const newPartsAVL = loadNewPartsAVL();
const epgAlternates = loadEPGAlternates();
const masterRoster = loadMasterRosterCPCs();
console.log(`  Master Roster: ${Object.keys(masterRoster).length} CPCs`);

// Merge AVLs (priority: Kitting > NewParts > EPG for same CPC)
console.log('\nMerging AVL sources...');
const completeAVL = {};

// Start with Kitting (original program)
for (const [cpc, entries] of Object.entries(kittingAVL)) {
  completeAVL[cpc] = [...entries];
}

// Add NewParts (only if CPC not already present, or add new MPNs)
for (const [cpc, entries] of Object.entries(newPartsAVL)) {
  if (!completeAVL[cpc]) {
    completeAVL[cpc] = entries;
  } else {
    // Add any MPNs not already present
    for (const entry of entries) {
      const exists = completeAVL[cpc].some(e => e.mpn === entry.mpn);
      if (!exists) {
        completeAVL[cpc].push(entry);
      }
    }
  }
}

// Add EPG alternates
for (const [cpc, entries] of Object.entries(epgAlternates)) {
  if (!completeAVL[cpc]) {
    completeAVL[cpc] = entries;
  } else {
    for (const entry of entries) {
      const exists = completeAVL[cpc].some(e => e.mpn === entry.mpn);
      if (!exists) {
        completeAVL[cpc].push(entry);
      }
    }
  }
}

console.log(`  Complete AVL: ${Object.keys(completeAVL).length} CPCs, ${Object.values(completeAVL).flat().length} MPN entries`);

// Analyze coverage
console.log('\n=== Coverage Analysis ===\n');

const rosterCPCs = new Set(Object.keys(masterRoster));
const avlCPCs = new Set(Object.keys(completeAVL));

const inBoth = [...rosterCPCs].filter(c => avlCPCs.has(c));
const rosterOnly = [...rosterCPCs].filter(c => !avlCPCs.has(c));
const avlOnly = [...avlCPCs].filter(c => !rosterCPCs.has(c));

console.log(`CPCs on Master Roster: ${rosterCPCs.size}`);
console.log(`CPCs in Complete AVL: ${avlCPCs.size}`);
console.log('');
console.log(`✓ In Both (covered): ${inBoth.length}`);
console.log(`✗ Roster only (MISSING AVL): ${rosterOnly.length}`);
console.log(`  AVL only (not in program): ${avlOnly.length}`);

// AVL count distribution
console.log('\n=== AVL Count Distribution (Roster CPCs only) ===\n');
const avlCountDist = {};
for (const cpc of inBoth) {
  const count = completeAVL[cpc].length;
  avlCountDist[count] = (avlCountDist[count] || 0) + 1;
}

for (const [count, num] of Object.entries(avlCountDist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${count} approved MPN(s): ${num} CPCs`);
}

// List missing CPCs by Award
if (rosterOnly.length > 0) {
  console.log('\n=== Missing AVL by Award ===\n');
  const missingByAward = {};
  for (const cpc of rosterOnly) {
    const award = masterRoster[cpc].award || 'Unknown';
    missingByAward[award] = (missingByAward[award] || 0) + 1;
  }
  for (const [award, count] of Object.entries(missingByAward).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${award}: ${count} CPCs`);
  }
}

// Write output files
console.log('\n=== Writing Output Files ===\n');

// 1. Complete AVL (flat format)
const avlRows = [];
for (const cpc of [...rosterCPCs].sort()) {
  const rosterInfo = masterRoster[cpc];
  const avlEntries = completeAVL[cpc] || [];

  if (avlEntries.length === 0) {
    // No AVL data - use roster MPN as sole entry
    avlRows.push({
      CPC: cpc,
      MPN: rosterInfo.mpn,
      Manufacturer: rosterInfo.mfr,
      Preferred: 'Y',
      Source: 'Roster-Only',
      'AVL Count': 1,
      Award: rosterInfo.award
    });
  } else {
    for (const entry of avlEntries) {
      avlRows.push({
        CPC: cpc,
        MPN: entry.mpn,
        Manufacturer: entry.mfr,
        Preferred: entry.preferred ? 'Y' : '',
        Source: entry.source,
        'AVL Count': avlEntries.length,
        Award: rosterInfo.award
      });
    }
  }
}

const outWb = XLSX.utils.book_new();
const avlWs = XLSX.utils.json_to_sheet(avlRows);
XLSX.utils.book_append_sheet(outWb, avlWs, 'Complete AVL');

// 2. Missing AVL summary
const missingRows = rosterOnly.map(cpc => {
  const r = masterRoster[cpc];
  return {
    CPC: cpc,
    'Roster MPN': r.mpn,
    'Roster MFR': r.mfr,
    Award: r.award,
    'Action': 'Need AVL from LAM'
  };
});
const missingWs = XLSX.utils.json_to_sheet(missingRows);
XLSX.utils.book_append_sheet(outWb, missingWs, 'Missing AVL');

// 3. Summary stats
const summaryRows = [
  { Metric: 'Master Roster CPCs', Value: rosterCPCs.size },
  { Metric: 'AVL Source CPCs', Value: avlCPCs.size },
  { Metric: 'Covered (in both)', Value: inBoth.length },
  { Metric: 'Missing AVL Data', Value: rosterOnly.length },
  { Metric: 'Total AVL Entries', Value: avlRows.length },
  { Metric: '', Value: '' },
  { Metric: 'Sole Sourced (1 MPN)', Value: avlCountDist[1] || 0 },
  { Metric: '2 Approved MPNs', Value: avlCountDist[2] || 0 },
  { Metric: '3 Approved MPNs', Value: avlCountDist[3] || 0 },
  { Metric: '4+ Approved MPNs', Value: Object.entries(avlCountDist).filter(([k]) => Number(k) >= 4).reduce((sum, [, v]) => sum + v, 0) }
];
const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
XLSX.utils.book_append_sheet(outWb, summaryWs, 'Summary');

const outPath = path.join(BASE_DIR, 'LAM 3PL/LAM_Complete_AVL.xlsx');
XLSX.writeFile(outWb, outPath);
console.log(`Wrote: ${outPath}`);
console.log(`  - Complete AVL: ${avlRows.length} rows`);
console.log(`  - Missing AVL: ${missingRows.length} CPCs`);
