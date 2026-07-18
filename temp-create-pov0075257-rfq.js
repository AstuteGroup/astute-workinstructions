#!/usr/bin/env node
/**
 * Create RFQ and VQs for POV0075257 mismatched items from Mouser invoices
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { writeRFQ } = require('./shared/rfq-writer');
const { createManualVQ } = require('./shared/vq-manual-writer');
const { psqlQuery } = require('./shared/db-helpers');

// Invoice data for POV0075257 (from Mouser invoices)
const invoiceItems = [
  // Invoice 89497435 (Mar 26) - Tracking: 518989245440
  { mpn: '42819-5223', mfr: 'Molex', qty: 25, cost: 11.94, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'SSW-104-06-G-S', mfr: 'Samtec', qty: 75, cost: 1.21, tracking: '520858061244', invoice: '89765460', shipDate: '2026-04-13' }, // shipped on later invoice
  { mpn: 'SL-120-G-10', mfr: 'Samtec', qty: 35, cost: 8.75, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'SCT3022ALGC11', mfr: 'ROHM', qty: 50, cost: 40.29, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'RA73F1J200RBTDF', mfr: 'TE Connectivity', qty: 165, cost: 1.46, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'IP5-04-05.0-L-S-1-L-TR', mfr: 'Samtec', qty: 50, cost: 9.86, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },

  // Invoice 89519101 (Mar 27) - Tracking: 518989428660
  { mpn: 'RG2012P-2742-B-T5', mfr: 'Susumu', qty: 561, cost: 0.073, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: '0505012.MXP', mfr: 'Littelfuse', qty: 160, cost: 3.08, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'IXFY26N30X3', mfr: 'IXYS', qty: 70, cost: 2.49, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'SRU2013-2R2Y', mfr: 'Bourns', qty: 350, cost: 0.518, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'TNPW120690K9BEEA', mfr: 'Vishay', qty: 650, cost: 0.272, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'C0805C102JBRACTU', mfr: 'KEMET', qty: 1000, cost: 0.137, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'RG2012P-1071-B-T5', mfr: 'Susumu', qty: 3000, cost: 0.069, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'RG2012P-2101-B-T5', mfr: 'Susumu', qty: 3000, cost: 0.069, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'C1812C224J1RACTU', mfr: 'KEMET', qty: 300, cost: 0.649, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'RG2012P-1961-B-T5', mfr: 'Susumu', qty: 516, cost: 0.098, tracking: '518989428660, 525458371932', invoice: '89519101, 90441161', shipDate: '2026-03-27' }, // 477+39 shipped

  // Invoice 89568193 (Mar 30) - Tracking: 519883511560
  { mpn: 'SHV24-1A85-78D3K', mfr: 'MEDER', qty: 431, cost: 9.54, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'SMCJ1.5KE30A-TP', mfr: 'MCC', qty: 630, cost: 0.293, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: '10139781-122402LF', mfr: 'Amphenol', qty: 105, cost: 5.29, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'ECS-TXO-3225MV-160-TR', mfr: 'ECS', qty: 150, cost: 1.59, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'TNPW08051K91BEEN', mfr: 'Vishay', qty: 625, cost: 0.388, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'TNPW0402249RBYEP', mfr: 'Vishay', qty: 650, cost: 0.333, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'H11N1SR2M', mfr: 'onsemi', qty: 200, cost: 1.08, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: '0216.200MXP', mfr: 'Littelfuse', qty: 140, cost: 1.19, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
];

const LAM_BP_ID = 1000730;
const LAM_CONTACT_ID = 1002375;
const MOUSER_BP_ID = 1000334;
const MOUSER_LOCATION_ID = 1000683;

async function main() {
  console.log('Creating RFQ for POV0075257 mismatched items...\n');
  console.log(`Items: ${invoiceItems.length}`);
  console.log(`Total ext: $${invoiceItems.reduce((sum, i) => sum + (i.qty * i.cost), 0).toFixed(2)}\n`);

  // Step 1: Create the RFQ
  console.log('Step 1: Creating RFQ...');
  const rfqResult = await writeRFQ({
    bpartnerId: LAM_BP_ID,
    type: '3PL/VMI',
    description: 'POV0075257 - Mouser invoices not in OT (reconciliation)',
    userId: LAM_CONTACT_ID,
    salesrepId: 1000004, // Jake
    lines: invoiceItems.map((item, idx) => ({
      mpn: item.mpn,
      mfrText: item.mfr,
      qty: item.qty,
      targetPrice: 0,
    }))
  });

  console.log(`  RFQ created: ${rfqResult.rfqId}`);
  console.log(`  Lines written: ${rfqResult.linesWritten}`);
  console.log(`  MPNs written: ${rfqResult.mpnsWritten}`);

  if (rfqResult.errors && rfqResult.errors.length > 0) {
    console.log('  Errors:', rfqResult.errors);
  }

  // Step 2: Get the RFQ line IDs
  console.log('\nStep 2: Getting RFQ line IDs...');
  const rfqLines = psqlQuery(`
    SELECT rl.chuboe_rfq_line_id, rlm.chuboe_mpn, rl.line
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = ${rfqResult.rfqId}
      AND rl.isactive = 'Y' AND rlm.isactive = 'Y'
    ORDER BY rl.line
  `);

  const lineMap = {};
  for (const row of (rfqLines || '').split('\n').filter(r => r.includes('|'))) {
    const [lineId, mpn] = row.split('|');
    lineMap[mpn.trim().toUpperCase()] = parseInt(lineId);
  }
  console.log(`  Found ${Object.keys(lineMap).length} line IDs`);

  // Step 3: Create VQs for each line
  console.log('\nStep 3: Creating VQs...');
  let vqCount = 0;

  for (const item of invoiceItems) {
    const rfqLineId = lineMap[item.mpn.toUpperCase()];
    if (!rfqLineId) {
      console.log(`  SKIP: No RFQ line found for ${item.mpn}`);
      continue;
    }

    try {
      const vq = await createManualVQ({
        program: 'LAM_KITTING',
        rfqValue: String(rfqResult.rfqId),
        rfqLineId: rfqLineId,
        mpn: item.mpn,
        mfrText: item.mfr,
        vendorBpId: MOUSER_BP_ID,
        vendorLocationId: MOUSER_LOCATION_ID,
        qty: item.qty,
        cost: item.cost,
        dateCode: '24+',
        leadTime: 'STOCK',
        notes: `Invoice ${item.invoice}, Ship ${item.shipDate}, Tracking: ${item.tracking}`,
      });
      console.log(`  ✓ VQ created for ${item.mpn}: ${vq.id}`);
      vqCount++;
    } catch (err) {
      console.log(`  ✗ VQ failed for ${item.mpn}: ${err.message}`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`RFQ ID: ${rfqResult.rfqId}`);
  console.log(`RFQ Lines: ${rfqResult.linesWritten}`);
  console.log(`VQs Created: ${vqCount}`);
  console.log(`\nNote: These VQs are from March 2026 invoices. They should already be shipped/received.`);
  console.log(`Reference: POV0075257 (Infor), Mouser invoices 89497435, 89519101, 89568193, 89765460, 90441161`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
