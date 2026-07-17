#!/usr/bin/env node
/**
 * Audit Phase 2 entries in Master Roster against actual "Place PO" tab
 * Find any parts marked as Phase 2 that weren't actually on the Place PO tab
 */

const XLSX = require('xlsx');
const fs = require('fs');

const ROSTER_PATH = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx';
const PHASE2_FILE = '/home/analytics_user/workspace/file-drop/Astute New Part ADDs_ Working Copy.xlsx';

// Load roster
const roster = XLSX.readFile(ROSTER_PATH);
const rosterData = XLSX.utils.sheet_to_json(roster.Sheets[roster.SheetNames[0]]);

// Find all parts with "Phase 2" in Award column (but not Phase 3)
const phase2Parts = rosterData.filter(r => {
  const award = String(r['Award'] || '').toLowerCase();
  return award.includes('phase 2') && !award.includes('phase 3');
});

console.log(`Master Roster parts with "Phase 2" in Award: ${phase2Parts.length}`);
console.log('');

// Load Phase 2 file
const p2wb = XLSX.readFile(PHASE2_FILE);

// Get Place PO tab data (as array of arrays to handle weird headers)
const placePOSheet = p2wb.Sheets['Place PO'];
const placePORaw = XLSX.utils.sheet_to_json(placePOSheet, { header: 1 });

// Find all CPCs in Place PO tab (scan all cells for CPC pattern)
const placePOCPCs = new Set();
const cpcPattern = /\d{3}-[A-Z0-9]+-\d{3}/g;

for (const row of placePORaw) {
  for (const cell of (row || [])) {
    const cellStr = String(cell || '');
    const matches = cellStr.match(cpcPattern);
    if (matches) {
      matches.forEach(m => placePOCPCs.add(m));
    }
  }
}

console.log(`CPCs found on "Place PO" tab: ${placePOCPCs.size}`);
console.log('');

// Get Items with Issues CPCs for reference
const issuesSheet = p2wb.Sheets['Items with Issues'];
const issuesRaw = XLSX.utils.sheet_to_json(issuesSheet, { header: 1 });
const issuesCPCs = new Set();

for (const row of issuesRaw) {
  for (const cell of (row || [])) {
    const cellStr = String(cell || '');
    const matches = cellStr.match(cpcPattern);
    if (matches) {
      matches.forEach(m => issuesCPCs.add(m));
    }
  }
}

console.log(`CPCs found on "Items with Issues" tab: ${issuesCPCs.size}`);
console.log('');

// Audit: which Phase 2 roster parts are NOT on Place PO?
const notOnPlacePO = [];
const onPlacePO = [];
const onIssuesOnly = [];

for (const part of phase2Parts) {
  const cpc = part['CPC'];
  if (placePOCPCs.has(cpc)) {
    onPlacePO.push(part);
  } else {
    notOnPlacePO.push(part);
    if (issuesCPCs.has(cpc)) {
      onIssuesOnly.push(part);
    }
  }
}

console.log('=== AUDIT RESULTS ===');
console.log('');
console.log(`Phase 2 parts correctly on "Place PO" tab: ${onPlacePO.length}`);
console.log(`Phase 2 parts NOT on "Place PO" tab: ${notOnPlacePO.length}`);
console.log(`  - Of which on "Items with Issues" only: ${onIssuesOnly.length}`);
console.log('');

if (notOnPlacePO.length > 0) {
  console.log('=== PARTS MARKED PHASE 2 BUT NOT ON PLACE PO ===');
  console.log('');
  notOnPlacePO.forEach(p => {
    const onIssues = issuesCPCs.has(p['CPC']) ? ' [ON ISSUES TAB]' : '';
    console.log(`${p['CPC']} | ${p['MPN']} | Award: ${p['Award']}${onIssues}`);
  });
}

// Output summary to file
const audit = {
  generated: new Date().toISOString(),
  totalPhase2InRoster: phase2Parts.length,
  onPlacePO: onPlacePO.length,
  notOnPlacePO: notOnPlacePO.length,
  onIssuesOnly: onIssuesOnly.length,
  partsNotOnPlacePO: notOnPlacePO.map(p => ({
    cpc: p['CPC'],
    mpn: p['MPN'],
    award: p['Award'],
    onIssuesTab: issuesCPCs.has(p['CPC']),
  })),
};

const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/phase2_audit.json';
fs.writeFileSync(outputPath, JSON.stringify(audit, null, 2));
console.log(`\nAudit saved to: ${outputPath}`);
