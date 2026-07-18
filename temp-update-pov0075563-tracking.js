#!/usr/bin/env node
/**
 * Update tracking numbers for POV0075563 based on Mouser invoices
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPut } = require('./shared/api-client');

const updates = [
  { lineId: 1024350, mpn: 'DLS3XS4AA35X', qty: 150, tracking: '524979566100', note: 'Inv 90302299 May 13' },
  { lineId: 1024351, mpn: 'DLS3XS4AA35X', qty: 600, tracking: '528978984900, 528979396433', note: 'Inv 90893594 Jun 16, Inv 90945447 Jun 18' },
  { lineId: 1024352, mpn: 'DLS4XS4AA35X', qty: 256, tracking: '520858359297', note: 'Inv 89821186 Apr 14' },
  { lineId: 1024353, mpn: 'DLS4XS4AA35X', qty: 99, tracking: '523364610799, 528978984900', note: 'Inv 90172966 May 5, Inv 90893594 Jun 16' },
  { lineId: 1024354, mpn: '172043-0302', qty: 55, tracking: '520858359297', note: 'Inv 89821186 Apr 14' },
  { lineId: 1024356, mpn: 'CRCW201020K0FKTF', qty: 800, tracking: '520858359297', note: 'Inv 89821186 Apr 14' },
];

async function main() {
  console.log('Updating tracking for POV0075563...\n');

  for (const upd of updates) {
    console.log(`${upd.mpn} (${upd.qty} pcs) → ${upd.tracking}`);
    try {
      await apiPut('c_orderline', upd.lineId, {
        Chuboe_TrackingNumbers: upd.tracking
      });
      console.log('  ✓ Updated\n');
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}\n`);
    }
  }

  console.log('\n=== STILL PENDING (no tracking from Mouser) ===');
  console.log('K202XHT-E9S-N (85) - Line 1024357');
  console.log('TNPW1206198RBEEA (275) - Line 1024358');
  console.log('4922R-32L (60) - Line 1024359');
  console.log('\n=== NOT ON MOUSER INVOICES ===');
  console.log('XEL6060-821MEC (85) - Line 1024360 - different supplier?');
}

main().catch(console.error);
