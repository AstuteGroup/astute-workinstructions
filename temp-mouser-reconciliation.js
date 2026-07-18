#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

// Get POV0075257 details and all related VQs
console.log('=== MOUSER POV0075257 RECONCILIATION ===\n');

// Find the OT PO for POV0075257
const poResult = psqlQuery(`
  SELECT o.c_order_id, o.documentno, o.grandtotal, o.docstatus,
         o.poreference
  FROM adempiere.c_order o
  WHERE o.issotrx = 'N'
    AND o.isactive = 'Y'
    AND (o.poreference ILIKE '%POV0075257%' OR o.description ILIKE '%POV0075257%')
  LIMIT 1;
`);

console.log('OT PO for POV0075257:');
console.log(poResult || '(not found)');

// Get all order lines for this PO
const linesResult = psqlQuery(`
  SELECT ol.line, ol.chuboe_mpn, ol.qtyordered, ol.qtydelivered, ol.qtyinvoiced,
         ol.priceactual, ol.linenetamt, ol.chuboe_po_string
  FROM adempiere.c_orderline ol
  JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
  WHERE o.issotrx = 'N'
    AND o.isactive = 'Y'
    AND (o.poreference ILIKE '%POV0075257%' OR o.description ILIKE '%POV0075257%')
    AND ol.isactive = 'Y'
  ORDER BY ol.line;
`);

console.log('\nPO Lines:');
console.log('Line | MPN | Qty Ordered | Qty Delivered | Qty Invoiced | Price | Line Total | POV Stamp');
console.log('-'.repeat(120));
console.log(linesResult || '(none)');

// Get VQs created today for Mouser on LAM RFQs
console.log('\n\n=== VQs Created Today for Mouser (LAM) ===\n');
const vqResult = psqlQuery(`
  SELECT vl.chuboe_vq_line_id, vl.chuboe_mpn, vl.qty, vl.cost,
         vl.qty * vl.cost as line_total,
         rfq.value as rfq_value
  FROM adempiere.chuboe_vq_line vl
  JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
  JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
  WHERE rfq.c_bpartner_id = 1000730
    AND bp.name ILIKE '%Mouser%'
    AND vl.created::date = CURRENT_DATE
    AND vl.isactive = 'Y'
  ORDER BY vl.chuboe_vq_line_id;
`);

console.log('VQ ID | MPN | Qty | Cost | Line Total | RFQ');
console.log('-'.repeat(100));

let totalVQs = 0;
let totalVQAmount = 0;
for (const line of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
  const parts = line.split('|').map(s => s.trim());
  console.log(line);
  totalVQs++;
  totalVQAmount += parseFloat(parts[4]) || 0;
}

console.log('-'.repeat(100));
console.log(`Total VQs: ${totalVQs}`);
console.log(`Total VQ Amount: $${totalVQAmount.toFixed(2)}`);

// Check for tariff VQs
console.log('\n\n=== Tariff Lines Created Today ===\n');
const tariffResult = psqlQuery(`
  SELECT vl.chuboe_vq_line_id, vl.chuboe_mpn, vl.cost, vl.description
  FROM adempiere.chuboe_vq_line vl
  JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
  WHERE rfq.c_bpartner_id = 1000730
    AND vl.chuboe_mpn LIKE 'TARIFF%'
    AND vl.created::date = CURRENT_DATE
    AND vl.isactive = 'Y'
  ORDER BY vl.chuboe_vq_line_id;
`);

console.log(tariffResult || '(none)');
