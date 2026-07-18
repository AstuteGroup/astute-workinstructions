#!/usr/bin/env node
/**
 * Add VQs to RFQ 1139512 for POV0075257 mismatched items
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createManualVQ } = require('./shared/vq-manual-writer');
const { psqlQuery } = require('./shared/db-helpers');

const invoiceItems = [
  { mpn: '42819-5223', mfr: 'Molex', qty: 25, cost: 11.94, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'SSW-104-06-G-S', mfr: 'Samtec', qty: 75, cost: 1.21, tracking: '520858061244', invoice: '89765460', shipDate: '2026-04-13' },
  { mpn: 'SL-120-G-10', mfr: 'Samtec', qty: 35, cost: 8.75, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'SCT3022ALGC11', mfr: 'ROHM', qty: 50, cost: 40.29, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'RA73F1J200RBTDF', mfr: 'TE Connectivity', qty: 165, cost: 1.46, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'IP5-04-05.0-L-S-1-L-TR', mfr: 'Samtec', qty: 50, cost: 9.86, tracking: '518989245440', invoice: '89497435', shipDate: '2026-03-26' },
  { mpn: 'RG2012P-2742-B-T5', mfr: 'Susumu', qty: 561, cost: 0.073, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: '0505012.MXP', mfr: 'Littelfuse', qty: 160, cost: 3.08, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'IXFY26N30X3', mfr: 'IXYS', qty: 70, cost: 2.49, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'SRU2013-2R2Y', mfr: 'Bourns', qty: 350, cost: 0.518, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'TNPW120690K9BEEA', mfr: 'Vishay', qty: 650, cost: 0.272, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'C0805C102JBRACTU', mfr: 'KEMET', qty: 1000, cost: 0.137, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'RG2012P-1071-B-T5', mfr: 'Susumu', qty: 3000, cost: 0.069, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'RG2012P-2101-B-T5', mfr: 'Susumu', qty: 3000, cost: 0.069, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'C1812C224J1RACTU', mfr: 'KEMET', qty: 300, cost: 0.649, tracking: '518989428660', invoice: '89519101', shipDate: '2026-03-27' },
  { mpn: 'RG2012P-1961-B-T5', mfr: 'Susumu', qty: 516, cost: 0.098, tracking: '518989428660, 525458371932', invoice: '89519101, 90441161', shipDate: '2026-03-27' },
  { mpn: 'SHV24-1A85-78D3K', mfr: 'MEDER', qty: 431, cost: 9.54, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'SMCJ1.5KE30A-TP', mfr: 'MCC', qty: 630, cost: 0.293, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: '10139781-122402LF', mfr: 'Amphenol', qty: 105, cost: 5.29, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'ECS-TXO-3225MV-160-TR', mfr: 'ECS', qty: 150, cost: 1.59, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'TNPW08051K91BEEN', mfr: 'Vishay', qty: 625, cost: 0.388, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'TNPW0402249RBYEP', mfr: 'Vishay', qty: 650, cost: 0.333, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: 'H11N1SR2M', mfr: 'onsemi', qty: 200, cost: 1.08, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
  { mpn: '0216.200MXP', mfr: 'Littelfuse', qty: 140, cost: 1.19, tracking: '519883511560', invoice: '89568193', shipDate: '2026-03-30' },
];

const RFQ_VALUE = '1139512';
const RFQ_ID = 1148927;
const MOUSER_BP_ID = 1000334;
const MOUSER_LOCATION_ID = 1000683;

async function main() {
  console.log('Adding VQs to RFQ 1139512...\n');

  // Get RFQ line IDs
  const rfqLines = psqlQuery(`
    SELECT rl.chuboe_rfq_line_id, UPPER(TRIM(rlm.chuboe_mpn)) as mpn
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND rl.isactive = 'Y' AND rlm.isactive = 'Y'
    ORDER BY rl.line
  `);

  const lineMap = {};
  for (const row of (rfqLines || '').split('\n').filter(r => r.includes('|'))) {
    const [lineId, mpn] = row.split('|');
    lineMap[mpn.trim()] = parseInt(lineId);
  }
  console.log(`Found ${Object.keys(lineMap).length} RFQ lines\n`);

  let vqCount = 0;
  for (const item of invoiceItems) {
    const rfqLineId = lineMap[item.mpn.toUpperCase()];
    if (!rfqLineId) {
      console.log(`SKIP: No RFQ line for ${item.mpn}`);
      continue;
    }

    try {
      const vq = await createManualVQ({
        program: 'LAM_KITTING',
        rfqValue: RFQ_VALUE,
        rfqLineId: rfqLineId,
        mpn: item.mpn,
        mfrText: item.mfr,
        vendorBpId: MOUSER_BP_ID,
        vendorLocationId: MOUSER_LOCATION_ID,
        qty: item.qty,
        cost: item.cost,
        dateCode: '24+',
        leadTime: 'STOCK',
        notes: `POV0075257 | Invoice ${item.invoice} | Ship ${item.shipDate} | Tracking: ${item.tracking}`,
      });
      console.log(`✓ ${item.mpn}: VQ ${vq.id}`);
      vqCount++;
    } catch (err) {
      console.log(`✗ ${item.mpn}: ${err.message}`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`VQs Created: ${vqCount} / ${invoiceItems.length}`);
  console.log(`RFQ: 1139512 (internal ID: 1148927)`);
}

main().catch(console.error);
