#!/usr/bin/env node
/**
 * Create requests to add tariff lines to OT POs
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPost } = require('./shared/api-client');

// Tariff data by POV/PO
const tariffsByPO = {
  'PO809626': {
    pov: 'POV0075563',
    tariffs: [
      { invoice: '89821186', shipDate: '2026-04-14', amount: 55.30, items: '172043-0302, DLS4XS4AA35X, DLS3XS4AA35X' },
      { invoice: '90172966', shipDate: '2026-05-05', amount: 12.32, items: 'DLS4XS4AA35X' },
      { invoice: '90302299', shipDate: '2026-05-13', amount: 18.45, items: 'DLS3XS4AA35X' },
      { invoice: '90893594', shipDate: '2026-06-16', amount: 27.92, items: 'DLS4XS4AA35X, DLS3XS4AA35X' },
      { invoice: '90945447', shipDate: '2026-06-18', amount: 49.20, items: 'DLS3XS4AA35X' },
    ],
  },
  'PO810910': {
    pov: 'POV0076829',
    tariffs: [
      { invoice: '91087894', shipDate: '2026-06-25', amount: 14.38, items: '0216010.HXP, RC0805JR-07100RL, RC0805JR-0791KL' },
    ],
  },
};

const REQUEST_TYPE_ID = 1000006;  // Change Request
const SALES_REP_ID = 1000004;     // Jake Harris

async function main() {
  console.log('Creating tariff addition requests from OT POs...\n');

  for (const [poNumber, data] of Object.entries(tariffsByPO)) {
    console.log(`=== ${poNumber} (${data.pov}) ===`);

    // Look up the C_Order_ID
    const orderResult = psqlQuery(`
      SELECT c_order_id, documentno, grandtotal
      FROM adempiere.c_order
      WHERE documentno = '${poNumber}'
        AND issotrx = 'N'
        AND isactive = 'Y'
      LIMIT 1;
    `);

    if (!orderResult || !orderResult.includes('|')) {
      console.log(`  ✗ Could not find OT PO ${poNumber}`);
      continue;
    }

    const [orderId, docNo, grandTotal] = orderResult.split('|');
    console.log(`  Found: C_Order_ID ${orderId}, Total: $${grandTotal}`);

    const totalTariff = data.tariffs.reduce((sum, t) => sum + t.amount, 0);

    // Build request text
    const tariffLines = data.tariffs.map(t =>
      `  Invoice ${t.invoice} (${t.shipDate}): $${t.amount.toFixed(2)}\n    Items: ${t.items}`
    ).join('\n\n');

    const requestText = `REQUEST: Add Tariff Lines to ${poNumber}

Infor POV: ${data.pov}
OT PO: ${poNumber}

Tariff charges from Mouser invoices need to be added to this PO:

${tariffLines}

TOTAL TARIFF: $${totalTariff.toFixed(2)}

Please add ${data.tariffs.length} tariff line(s) to match the invoice charges.

Reference: Mouser Invoice Reconciliation 2026-07-14`;

    // Create the R_Request using the approved context
    try {
      const request = await apiPost('r_request', {
        R_RequestType_ID: REQUEST_TYPE_ID,
        Summary: `Add tariff lines to ${poNumber} - ${data.pov} - $${totalTariff.toFixed(2)} (${data.tariffs.length} invoices)`,
        Result: requestText,
        C_Order_ID: parseInt(orderId),
        SalesRep_ID: SALES_REP_ID,
        AD_User_ID: SALES_REP_ID,
        Priority: '5',
      }, { context: 'r-request-writer' });
      console.log(`  ✓ Request created: ${request.DocumentNo || request.id}`);
      console.log(`    Tariff total: $${totalTariff.toFixed(2)}`);
      console.log(`    Invoices: ${data.tariffs.map(t => t.invoice).join(', ')}`);
    } catch (err) {
      console.log(`  ✗ Request failed: ${err.message}`);
    }
    console.log('');
  }
}

main().catch(console.error);
