#!/usr/bin/env node
/**
 * Create VQ for 550-2205F from Future Electronics
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const { createManualVQ } = require('../shared/vq-manual-writer');

async function main() {
  console.log('Creating VQ for 550-2205F from Future Electronics...\n');

  const vq = await createManualVQ({
    program: 'LAM_KITTING',
    rfqValue: '1140676',
    rfqLineId: 3157141,          // 550-2205F line on RFQ 1140676
    mpn: '550-2205F',
    mfrText: 'Dialight',
    vendorBpId: 1000328,         // Future Electronics Corporation
    vendorLocationId: 1000241,   // V001038 - Future Electronics (US) LLC
    qty: 100,
    cost: 0.395,
    dateCode: '24+',
    leadTime: 'STOCK',
    notes: 'LAM kitting purchase',
  });

  console.log('\n=== VQ Created ===');
  console.log('VQ ID:', vq.id);
  console.log('MPN:', vq.mpn);
  console.log('MFR:', vq.mfrText);
  console.log('Qty:', vq.qty);
  console.log('Cost: $' + vq.cost);
  console.log('Date Code:', vq.dateCode);
  console.log('Lead Time:', vq.leadTime);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
