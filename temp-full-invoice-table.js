#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { createNotifier } = require('./shared/notifier');

async function main() {
  // Get the OT PO for Mouser/LAM with POV0075257
  const poResult = psqlQuery(`
    SELECT o.documentno as ot_po, o.poreference as pov, o.grandtotal, o.docstatus,
           o.c_order_id
    FROM adempiere.c_order o
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    WHERE o.issotrx = 'N'
      AND o.isactive = 'Y'
      AND bp.name ILIKE '%Mouser%'
      AND o.poreference ILIKE '%POV0075257%'
    LIMIT 1;
  `);

  let otPo = '', pov = '', orderId = '';
  if (poResult && poResult.trim()) {
    [otPo, pov, , , orderId] = poResult.trim().split('|');
  }

  // Get order lines
  const linesResult = psqlQuery(`
    SELECT ol.line, ol.chuboe_mpn, ol.qtyordered, ol.qtydelivered, ol.qtyinvoiced,
           ol.priceactual, ol.linenetamt
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    WHERE o.issotrx = 'N'
      AND o.isactive = 'Y'
      AND bp.name ILIKE '%Mouser%'
      AND o.poreference ILIKE '%POV0075257%'
      AND ol.isactive = 'Y'
    ORDER BY ol.line;
  `);

  // Get all Mouser VQs from RFQ 1139512 created today
  const vqResult = psqlQuery(`
    SELECT vl.chuboe_vq_line_id, vl.chuboe_mpn, vl.qty, vl.cost,
           vl.qty * vl.cost as line_total
    FROM adempiere.chuboe_vq_line vl
    JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
    WHERE rfq.value = '1139512'
      AND bp.name ILIKE '%Mouser%'
      AND vl.created::date = CURRENT_DATE
      AND vl.isactive = 'Y'
    ORDER BY vl.chuboe_mpn;
  `);

  // Build the email
  let body = `MOUSER POV0075257 RECONCILIATION
================================

OT PO: ${otPo || '(not found)'}
Infor POV: POV0075257
RFQ: 1139512
Vendor: Mouser Electronics

12 Invoices: 89497435, 89519101, 89568193, 89765460, 89821186, 90172966, 90302299, 90441161, 90893594, 90945447, 90969889, 91087894

================================================================================
PART LINES (VQs Created Today)
================================================================================
VQ ID    | MPN                          |   Qty | Unit Cost |  Line Total
---------|------------------------------|-------|-----------|-------------
`;

  let partsTotal = 0;
  const partLines = [];
  const tariffLines = [];

  for (const line of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [id, mpn, qty, cost, total] = line.split('|').map(s => s.trim());
    if (mpn.startsWith('TARIFF')) {
      tariffLines.push({ id, mpn, qty, cost: parseFloat(cost), total: parseFloat(total) });
    } else {
      partLines.push({ id, mpn, qty: parseInt(qty), cost: parseFloat(cost), total: parseFloat(total) });
      partsTotal += parseFloat(total);
    }
  }

  for (const p of partLines) {
    body += `${p.id.padEnd(8)} | ${p.mpn.padEnd(28)} | ${String(p.qty).padStart(5)} | $${p.cost.toFixed(3).padStart(8)} | $${p.total.toFixed(2).padStart(10)}\n`;
  }

  body += `---------|------------------------------|-------|-----------|-------------
                                     PARTS SUBTOTAL: $${partsTotal.toFixed(2).padStart(10)}

================================================================================
TARIFF LINES (VQs Created Today)
================================================================================
VQ ID    | Invoice      |     Amount
---------|--------------|------------
`;

  let tariffTotal = 0;
  for (const t of tariffLines) {
    const invNum = t.mpn.replace('TARIFF-INV', '');
    body += `${t.id.padEnd(8)} | ${invNum.padEnd(12)} | $${t.cost.toFixed(2).padStart(9)}\n`;
    tariffTotal += t.cost;
  }

  body += `---------|--------------|------------
              TARIFF SUBTOTAL: $${tariffTotal.toFixed(2).padStart(9)}

================================================================================
INVOICE STATUS
================================================================================
`;

  const invoicesWithTariff = new Set(tariffLines.map(t => t.mpn.replace('TARIFF-INV', '')));
  const allInvoices = ['89497435', '89519101', '89568193', '89765460', '89821186', '90172966', '90302299', '90441161', '90893594', '90945447', '90969889', '91087894'];

  for (const inv of allInvoices) {
    const tariff = tariffLines.find(t => t.mpn.includes(inv));
    if (tariff) {
      body += `✓ ${inv}  Tariff: $${tariff.cost.toFixed(2)}\n`;
    } else {
      body += `? ${inv}  No tariff line - verify if $0 or missing\n`;
    }
  }

  body += `
================================================================================
SUMMARY
================================================================================
Parts (24 lines):    $${partsTotal.toFixed(2).padStart(10)}
Tariffs (5 lines):   $${tariffTotal.toFixed(2).padStart(10)}
                     ---------------
GRAND TOTAL:         $${(partsTotal + tariffTotal).toFixed(2).padStart(10)}

Total VQs: ${partLines.length + tariffLines.length} (${partLines.length} parts + ${tariffLines.length} tariffs)

================================================================================
ACTION ITEMS
================================================================================
1. Verify the 7 invoices marked with "?" - do they have $0 tariff or missing?
2. Tick VQs for purchase and create approval request when ready
`;

  const notifier = createNotifier({
    fromEmail: 'lamkitting@orangetsunami.com',
    fromName: 'LAM Reconciliation'
  });

  await notifier.sendEmail(
    'jake.harris@astutegroup.com',
    'Mouser POV0075257 Reconciliation - Full Table',
    body
  );

  console.log('Full reconciliation table sent!');
  console.log(body);
}

main().catch(console.error);
