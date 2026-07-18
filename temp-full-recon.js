#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const fs = require('fs');
const path = require('path');

// Invoice files we have
const invoiceDir = '/tmp/mouser_invoices';
const invoiceFiles = fs.readdirSync(invoiceDir).filter(f => f.endsWith('.pdf'));
const invoiceNumbers = invoiceFiles.map(f => f.replace('.pdf', ''));

console.log('=== MOUSER INVOICE RECONCILIATION ===\n');
console.log(`Found ${invoiceNumbers.length} invoice PDFs: ${invoiceNumbers.join(', ')}\n`);

// Get all Mouser VQs created today
const vqResult = psqlQuery(`
  SELECT vl.chuboe_vq_line_id, vl.chuboe_mpn, vl.qty, vl.cost,
         vl.qty * vl.cost as line_total,
         vl.description
  FROM adempiere.chuboe_vq_line vl
  JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
  JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
  WHERE rfq.c_bpartner_id = 1000730
    AND bp.name ILIKE '%Mouser%'
    AND vl.created::date = CURRENT_DATE
    AND vl.isactive = 'Y'
  ORDER BY vl.chuboe_vq_line_id;
`);

// Parse VQs
const vqs = [];
for (const line of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
  const [id, mpn, qty, cost, total, desc] = line.split('|').map(s => s.trim());
  vqs.push({ id, mpn, qty: parseInt(qty), cost: parseFloat(cost), total: parseFloat(total), desc });
}

// Separate parts vs tariffs
const partVQs = vqs.filter(v => !v.mpn.startsWith('TARIFF'));
const tariffVQs = vqs.filter(v => v.mpn.startsWith('TARIFF'));

console.log('PART VQs Created Today:');
console.log('-'.repeat(90));
console.log('VQ ID    | MPN                          | Qty    | Unit Cost | Line Total');
console.log('-'.repeat(90));

let partsTotal = 0;
for (const v of partVQs) {
  console.log(`${v.id.padEnd(8)} | ${v.mpn.padEnd(28)} | ${String(v.qty).padStart(6)} | $${v.cost.toFixed(3).padStart(8)} | $${v.total.toFixed(2).padStart(10)}`);
  partsTotal += v.total;
}
console.log('-'.repeat(90));
console.log(`Parts Subtotal: $${partsTotal.toFixed(2)}`);

console.log('\n\nTARIFF VQs Created Today:');
console.log('-'.repeat(60));
console.log('VQ ID    | Invoice      | Amount');
console.log('-'.repeat(60));

let tariffTotal = 0;
for (const v of tariffVQs) {
  const invNum = v.mpn.replace('TARIFF-INV', '');
  console.log(`${v.id.padEnd(8)} | ${invNum.padEnd(12)} | $${v.cost.toFixed(2)}`);
  tariffTotal += v.cost;
}
console.log('-'.repeat(60));
console.log(`Tariff Subtotal: $${tariffTotal.toFixed(2)}`);

// Check which invoices have tariffs
const invoicesWithTariffs = new Set(tariffVQs.map(v => v.mpn.replace('TARIFF-INV', '')));
const invoicesWithoutTariffs = invoiceNumbers.filter(inv => !invoicesWithTariffs.has(inv));

console.log('\n\n=== INVOICE STATUS ===\n');
console.log('Invoices WITH tariff lines:');
for (const inv of [...invoicesWithTariffs]) {
  const tariff = tariffVQs.find(v => v.mpn.includes(inv));
  console.log(`  ${inv}: $${tariff.cost.toFixed(2)}`);
}

console.log('\nInvoices WITHOUT tariff lines:');
for (const inv of invoicesWithoutTariffs) {
  console.log(`  ${inv}: (no tariff or $0)`);
}

console.log('\n\n=== GRAND TOTAL ===');
console.log(`Parts:   $${partsTotal.toFixed(2)}`);
console.log(`Tariffs: $${tariffTotal.toFixed(2)}`);
console.log(`TOTAL:   $${(partsTotal + tariffTotal).toFixed(2)}`);
console.log(`\nTotal VQs: ${vqs.length} (${partVQs.length} parts + ${tariffVQs.length} tariffs)`);
