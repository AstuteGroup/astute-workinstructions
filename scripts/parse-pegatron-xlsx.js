#!/usr/bin/env node
'use strict';

const XLSX = require('xlsx');

const files = [
  '/tmp/excess 2026-0520-0001 .xlsx',
  '/tmp/excess 2026-0520-0002 .xlsx',
  '/tmp/excess 2026-0520-0003 .xlsx'
];

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  try {
    const wb = XLSX.readFile(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Show headers
    if (data.length > 0) {
      console.log('Headers:', data[0]);
    }

    // Show first 5 data rows
    console.log('First 5 rows:');
    for (let i = 1; i < Math.min(6, data.length); i++) {
      console.log(`  ${i}: ${JSON.stringify(data[i])}`);
    }

    console.log(`Total rows: ${data.length - 1} (excluding header)`);
  } catch (err) {
    console.error(`Error reading ${file}: ${err.message}`);
  }
}
