#!/usr/bin/env node
/**
 * Add tariff lines to RFQ 1139512 for POV0075257
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPost } = require('./shared/api-client');
const { createManualVQ } = require('./shared/vq-manual-writer');

const RFQ_ID = 1148927;
const RFQ_VALUE = '1139512';
const MOUSER_BP_ID = 1000334;
const MOUSER_LOCATION_ID = 1000683;

// Tariff lines exactly as on invoices
const tariffs = [
  { invoice: '89497435', shipDate: '2026-03-26', amount: 99.65, items: '42819-5223, SL-120-G-10' },
  { invoice: '89519101', shipDate: '2026-03-27', amount: 94.41, items: '0505012.MXP, SRU2013-2R2Y, RG2012P-2101-B-T5, RG2012P-1961-B-T5' },
  { invoice: '89568193', shipDate: '2026-03-30', amount: 778.90, items: 'SHV24-1A85-78D3K, SMCJ1.5KE30A-TP, 10139781-122402LF, 0216.200MXP' },
  { invoice: '89765460', shipDate: '2026-04-13', amount: 7.28, items: 'SSW-104-06-G-S' },
  { invoice: '90441161', shipDate: '2026-05-20', amount: 0.31, items: 'RG2012P-1961-B-T5' },
];

// LAM_KITTING program defaults
const WAREHOUSE_ID = 1000015;        // W111: LAM KITTING
const WAREHOUSE_GROUP_ID = 1000008;  // BROWNSVILLE
const SHIPPER_ID = 1000003;          // FedEx Ground
const INCOTERM_ID = 1000000;         // EXW
const PACKAGING_ID = 1000005;        // BULK (for tariffs)
const TRACEABILITY_ID = 1000000;     // Authorized Distribution Certs
const PENDING_COO_ID = 1000001;      // PENDING

async function main() {
  console.log('Adding tariff lines to RFQ 1139512...\n');

  // Get next line number
  const lineResult = psqlQuery(`
    SELECT COALESCE(MAX(line), 0) as max_line
    FROM adempiere.chuboe_rfq_line
    WHERE chuboe_rfq_id = ${RFQ_ID} AND isactive = 'Y';
  `);
  let nextLine = 10;
  for (const row of (lineResult || '').split('\n').filter(r => r.trim())) {
    const val = parseInt(row.trim());
    if (!isNaN(val)) nextLine = val + 10;
  }
  console.log(`Starting at line ${nextLine}\n`);

  const createdVQs = [];

  for (const tariff of tariffs) {
    console.log(`Processing Invoice ${tariff.invoice}: $${tariff.amount.toFixed(2)}`);

    // Create RFQ Line for this tariff
    const rfqLine = await apiPost('chuboe_rfq_line', {
      Chuboe_RFQ_ID: RFQ_ID,
      Line: nextLine,
      Qty: 1,
      PriceEntered: 0,
    });
    console.log(`  ✓ Created RFQ Line ${rfqLine.id} (line ${nextLine})`);

    // Create RFQ Line MPN for this tariff
    const rfqLineMpn = await apiPost('chuboe_rfq_line_mpn', {
      Chuboe_RFQ_Line_ID: rfqLine.id,
      Chuboe_MPN: `TARIFF-INV${tariff.invoice}`,
    });
    console.log(`  ✓ Created RFQ Line MPN: TARIFF-INV${tariff.invoice}`);

    // Create VQ for this tariff using the enforced wrapper
    const vq = await createManualVQ({
      program: 'LAM_KITTING',
      rfqValue: RFQ_VALUE,
      rfqLineId: rfqLine.id,
      mpn: `TARIFF-INV${tariff.invoice}`,
      mfrText: 'N/A',
      vendorBpId: MOUSER_BP_ID,
      vendorLocationId: MOUSER_LOCATION_ID,
      qty: 1,
      cost: tariff.amount,
      dateCode: 'N/A',
      leadTime: 'STOCK',
      notes: `Tariff for Invoice ${tariff.invoice} (${tariff.shipDate}). Items: ${tariff.items}`,
    });
    console.log(`  ✓ Created VQ ${vq.id}: $${tariff.amount.toFixed(2)}`);

    createdVQs.push({
      vqId: vq.id,
      invoice: tariff.invoice,
      amount: tariff.amount,
    });

    nextLine += 10;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Tariff lines added: ${createdVQs.length}`);
  console.log(`Total tariff: $${tariffs.reduce((sum, t) => sum + t.amount, 0).toFixed(2)}`);
  console.log('\nVQ IDs:');
  for (const vq of createdVQs) {
    console.log(`  ${vq.vqId}: Invoice ${vq.invoice} - $${vq.amount.toFixed(2)}`);
  }
}

main().catch(console.error);
