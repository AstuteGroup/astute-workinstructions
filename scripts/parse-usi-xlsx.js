#!/usr/bin/env node
'use strict';

const XLSX = require('xlsx');

const file = '/tmp/USI MX List of Sale - WK22.xlsx';

console.log(`=== ${file} ===`);
try {
  const wb = XLSX.readFile(file);
  console.log('Sheet names:', wb.SheetNames);

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Show first 10 rows to understand structure
  console.log('First 10 rows:');
  for (let i = 0; i < Math.min(10, data.length); i++) {
    console.log(`  ${i}: ${JSON.stringify(data[i])}`);
  }

  // Count rows
  const nonEmptyRows = data.filter(r => r.some(c => c != null && c !== '')).length;
  console.log(`Total non-empty rows: ${nonEmptyRows}`);
} catch (err) {
  console.error(`Error reading ${file}: ${err.message}`);
}
