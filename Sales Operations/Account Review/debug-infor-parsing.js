#!/usr/bin/env node
/**
 * Debug script to check Infor CSV parsing for Aaron Q2 2026
 */

const fs = require('fs');
const path = require('path');
const { parse: parseCSVSync } = require('csv-parse/sync');

const projectDir = __dirname;
const invoicedPath = path.join(projectDir, 'Invoiced Sales - Account Review AI.csv');
const bookedPath = path.join(projectDir, 'Booked Sales - Account Review AI.csv');

console.log('='.repeat(80));
console.log('INFOR CSV PARSING DEBUG - Aaron Mendoza Q2 2026');
console.log('='.repeat(80));

// Parse Invoiced Sales
console.log('\n📊 Parsing Invoiced Sales CSV...\n');

const content = fs.readFileSync(invoicedPath, 'utf8');
const invoicedRows = parseCSVSync(content, {
  columns: true,  // First row is headers, return objects
  skip_empty_lines: true,
  relax_column_count: true,  // Allow rows with different column counts
  trim: true
});

console.log(`Total rows in file: ${invoicedRows.length}`);

if (invoicedRows.length > 0) {
  console.log(`\nHeaders: ${Object.keys(invoicedRows[0]).join(', ')}\n`);
}

// Filter for Aaron (aaromend) in Q2 2026
const startDate = new Date('2026-04-01');
const endDate = new Date('2026-06-30');

const aaronInvoiced = invoicedRows.filter(row => {
  const salesperson = row['Internal Salesperson'];
  const dateStr = row['Invoice Date'];

  if (salesperson !== 'aaromend') return false;

  const date = new Date(dateStr.split(' ')[0]);
  return date >= startDate && date <= endDate;
});

console.log(`Aaron's Q2 2026 invoiced lines: ${aaronInvoiced.length}\n`);

// Aggregate by customer
const byCustomer = {};
for (const row of aaronInvoiced) {
  const customer = row['Customer Name'];
  const gpValue = row['Invoice GP'];

  if (!gpValue || gpValue === '') {
    console.log(`WARNING: Row missing GP value`);
    console.log(`  Customer: ${customer}`);
    console.log(`  Invoice Date: ${row['Invoice Date']}`);
    console.log(`  CO Number: ${row['CO Number']}`);
    continue;
  }

  const gpStr = gpValue.replace(/[$,]/g, '');
  const gp = parseFloat(gpStr) || 0;

  if (!byCustomer[customer]) {
    byCustomer[customer] = { gp: 0, count: 0 };
  }
  byCustomer[customer].gp += gp;
  byCustomer[customer].count++;
}

// Sort by GP descending
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

console.log(`\n📌 Expected Total (from reference): $52,411.00`);
console.log(`📌 Calculated Total: $${totalGP.toFixed(2)}`);
console.log(`📌 Difference: $${(totalGP - 52411).toFixed(2)}\n`);

// Check for Alstom variations
console.log('\n🔍 Alstom Variations:');
console.log('-'.repeat(80));
for (const [customer, data] of sorted) {
  if (customer.toLowerCase().includes('alstom')) {
    console.log(`${customer.padEnd(50)} $${data.gp.toFixed(2).padStart(10)}`);
  }
}
console.log('='.repeat(80));
