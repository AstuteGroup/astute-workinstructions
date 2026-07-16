#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parse: parseCSVSync } = require('csv-parse/sync');

const bookedPath = path.join(__dirname, 'Booked Sales - Account Review AI.csv');

console.log('='.repeat(80));
console.log('BOOKED GP VERIFICATION - Aaron Mendoza Q2 2026');
console.log('='.repeat(80));

const content = fs.readFileSync(bookedPath, 'utf8');
const rows = parseCSVSync(content, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  trim: true
});

console.log(`\nTotal rows in Booked Sales CSV: ${rows.length}`);

// Filter for Aaron Q2 2026
const startDate = new Date('2026-04-01');
const endDate = new Date('2026-06-30');

const aaronBooked = rows.filter(row => {
  const salesperson = row['CO Internal Salesperson'];
  const dateStr = row['Date'];
  if (salesperson !== 'aaromend') return false;

  const date = new Date(dateStr.split(' ')[0]);
  return date >= startDate && date <= endDate;
});

console.log(`Aaron Q2 2026 booked lines: ${aaronBooked.length}\n`);

// Aggregate by customer
const byCustomer = {};
for (const row of aaronBooked) {
  const customer = row['Customer Name'];
  const gpStr = (row['Booked GP'] || '').replace(/[$,]/g, '');
  const gp = parseFloat(gpStr) || 0;

  if (!byCustomer[customer]) {
    byCustomer[customer] = { gp: 0, count: 0 };
  }
  byCustomer[customer].gp += gp;
  byCustomer[customer].count++;
}

// Sort by GP
const sorted = Object.entries(byCustomer).sort((a, b) => b[1].gp - a[1].gp);

console.log('Customer Breakdown (sorted by GP):');
console.log('-'.repeat(80));

let totalGP = 0;
for (const [customer, data] of sorted) {
  console.log(`${customer.padEnd(50)} $${data.gp.toFixed(2).padStart(10)} (${data.count} lines)`);
  totalGP += data.gp;
}

console.log('-'.repeat(80));
console.log(`${'TOTAL'.padEnd(50)} $${totalGP.toFixed(2).padStart(10)}`);
console.log('='.repeat(80));

console.log(`\n📌 Expected (from Infor): $45,492.00`);
console.log(`📌 Calculated: $${totalGP.toFixed(2)}`);
console.log(`📌 Difference: $${(totalGP - 45492).toFixed(2)}\n`);
