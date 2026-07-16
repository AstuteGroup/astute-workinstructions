#!/usr/bin/env node
const path = require('path');
const { readCSVFile } = require(path.resolve(__dirname, '../../shared/csv-utils'));

const invoicedPath = path.join(__dirname, 'Invoiced Sales - Account Review AI.csv');
const { headers, rows } = readCSVFile(invoicedPath);

const salespersonIdx = headers.indexOf('Internal Salesperson');
const dateIdx = headers.indexOf('Invoice Date');
const customerIdx = headers.indexOf('Customer Name');
const gpIdx = headers.indexOf('Invoice GP');

// Get all Aaron rows in 2026
const aaron2026 = rows.filter(row => {
  const salesperson = row[salespersonIdx];
  const dateStr = row[dateIdx];
  if (salesperson !== 'aaromend') return false;

  const date = new Date(dateStr.split(' ')[0]);
  return date.getFullYear() === 2026;
});

console.log(`Total Aaron 2026 rows: ${aaron2026.length}\n`);

// Group by month
const byMonth = {};
for (const row of aaron2026) {
  const dateStr = row[dateIdx];
  const date = new Date(dateStr.split(' ')[0]);
  const month = date.getMonth() + 1; // 1-12

  if (!byMonth[month]) {
    byMonth[month] = [];
  }
  byMonth[month].push(row);
}

console.log('Rows by month:');
for (let m = 1; m <= 12; m++) {
  const count = byMonth[m] ? byMonth[m].length : 0;
  const quarter = Math.ceil(m / 3);
  console.log(`  Month ${m} (Q${quarter}): ${count} rows`);
}

// Check Q2 specifically (Apr-Jun)
const q2Months = [4, 5, 6];
let q2Total = 0;
for (const m of q2Months) {
  q2Total += byMonth[m] ? byMonth[m].length : 0;
}

console.log(`\nQ2 2026 total: ${q2Total} rows`);

// Calculate GP for Q2
let totalGP = 0;
let missingGP = 0;

for (const m of q2Months) {
  if (!byMonth[m]) continue;

  for (const row of byMonth[m]) {
    const gpValue = row[gpIdx];
    if (gpValue === undefined || gpValue === null || gpValue === '') {
      missingGP++;
    } else {
      const gpStr = gpValue.replace(/[$,]/g, '');
      const gp = parseFloat(gpStr) || 0;
      totalGP += gp;
    }
  }
}

console.log(`Q2 2026 GP: $${totalGP.toFixed(2)}`);
console.log(`Rows with missing GP: ${missingGP}`);
console.log(`Expected: $52,411.00`);
console.log(`Difference: $${(totalGP - 52411).toFixed(2)}`);
