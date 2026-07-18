#!/usr/bin/env node
const { readCSVFile } = require('./shared/csv-utils');

const csv = readCSVFile('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/LAM_Reorder_Alerts_2026-07-14_sourced.csv');

// Get column indexes
const col = (name) => csv.headers.indexOf(name);

// Group by supplier
const bySupplier = {};
for (const row of csv.rows) {
  const status = row[col('Sourcing Status')] || '';
  if (status !== 'SOURCED') continue;

  const inStockSupplier = row[col('In Stock Supplier')] || '';
  const ltSupplier = row[col('Lead Time Supplier')] || '';
  const supplier = inStockSupplier || ltSupplier || 'Unknown';
  const inStock = inStockSupplier ? true : false;
  const price = parseFloat(row[col('In Stock Price')] || row[col('Lead Time Price')]) || 0;
  const margin = row[col('In Stock Margin %')] || row[col('Lead Time Margin %')] || '';
  const mpn = row[col('MPN')];
  const selectedMpn = row[col('Selected MPN')] || '';
  const cpc = row[col('Lam P/N')];
  const priority = row[col('Priority')];
  const shortfall = parseInt(row[col('Shortfall')] || 0);
  const extCost = price * shortfall;

  if (!bySupplier[supplier]) bySupplier[supplier] = { lines: [], totalExt: 0 };
  bySupplier[supplier].lines.push({ cpc, mpn, selectedMpn, inStock, price, shortfall, margin, priority, extCost });
  bySupplier[supplier].totalExt += extCost;
}

// Sort by total ext cost descending
const sorted = Object.entries(bySupplier).sort((a, b) => b[1].totalExt - a[1].totalExt);

console.log('SUPPLIER CONSOLIDATION VIEW');
console.log('===========================\n');

let totalItems = 0;
let totalCost = 0;

for (const [supplier, data] of sorted) {
  const inStockCount = data.lines.filter(l => l.inStock).length;
  const leadTimeCount = data.lines.filter(l => !l.inStock).length;
  totalItems += data.lines.length;
  totalCost += data.totalExt;

  console.log(`${supplier} (${data.lines.length} items, ~$${data.totalExt.toFixed(2)} ext)`);
  for (const l of data.lines) {
    const tag = l.inStock ? 'STOCK' : 'LT';
    const altNote = l.selectedMpn && l.selectedMpn !== l.mpn ? ` [ALT: ${l.selectedMpn}]` : '';
    console.log(`  ${tag.padEnd(5)} | ${l.cpc} | ${l.mpn}${altNote} | $${l.price} x ${l.shortfall} | ${l.margin} | ${l.priority}`);
  }
  console.log('');
}

console.log('===========================');
console.log(`TOTAL: ${totalItems} items, ~$${totalCost.toFixed(2)} ext cost`);
