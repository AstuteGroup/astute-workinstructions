#!/usr/bin/env node
/**
 * Find all potential AVL data sources across the workspace
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const searchDirs = [
  '/home/analytics_user/workspace/file-drop',
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM New Parts Pricing',
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM Billings Review',
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM EPG Award'
];

console.log('=== Searching for AVL data sources ===\n');

for (const dir of searchDirs) {
  if (!fs.existsSync(dir)) continue;

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx'));
  } catch (e) {
    continue;
  }

  for (const file of files) {
    if (file.includes('backup')) continue;

    try {
      const wb = XLSX.readFile(path.join(dir, file));

      for (const name of wb.SheetNames) {
        const lower = name.toLowerCase();
        // Look for AVL-related sheets
        if (lower.includes('avl') || lower.includes('approved') || lower.includes('vendor') || lower.includes('alternate')) {
          const ws = wb.Sheets[name];
          const data = XLSX.utils.sheet_to_json(ws);
          console.log(`${file}`);
          console.log(`  [${name}]: ${data.length} rows`);
          if (data[0]) {
            console.log(`  Headers: ${Object.keys(data[0]).slice(0, 6).join(', ')}...`);
          }
          console.log('');
        }
      }
    } catch (e) {
      // Skip files that can't be read
    }
  }
}

// Also check for files that have multiple rows per CPC
console.log('\n=== Checking for multi-row-per-CPC files ===\n');

const multiRowFiles = [
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM EPG Award/EPG_AVL_Alternates_Analysis_20260409.xlsx',
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/Lam_Kitting_DB_05082026.xlsx'
];

for (const filePath of multiRowFiles) {
  if (!fs.existsSync(filePath)) continue;

  try {
    const wb = XLSX.readFile(filePath);
    console.log(`${path.basename(filePath)}:`);

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(ws);

      // Count CPCs
      const cpcCol = Object.keys(data[0] || {}).find(k =>
        k.toLowerCase().includes('cpc') ||
        k.toLowerCase().includes('lam p/n') ||
        k.toLowerCase().includes('part number')
      );

      if (cpcCol) {
        const cpcCounts = {};
        for (const row of data) {
          const cpc = row[cpcCol];
          if (cpc) {
            cpcCounts[cpc] = (cpcCounts[cpc] || 0) + 1;
          }
        }

        const uniqueCpcs = Object.keys(cpcCounts).length;
        const multiRowCpcs = Object.entries(cpcCounts).filter(([k, v]) => v > 1).length;

        console.log(`  [${sheetName}]: ${data.length} rows, ${uniqueCpcs} unique CPCs, ${multiRowCpcs} with multiple rows`);
      }
    }
    console.log('');
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
}
