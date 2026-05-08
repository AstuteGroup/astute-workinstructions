/**
 * One-off: mark CQ 1264300 sold to match precedent (CQ 1262849).
 *  - IsSold = Y
 *  - R_Status_ID = 1000026 (Closed)
 *  - POReference = '304068'
 *  - DatePromised = 2026-04-27 (matches VQ)
 *  - Chuboe_Lead_Time = 'STOCK'
 */
require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });

const { patchRecord } = require('../../../shared/record-updater');

(async () => {
  await patchRecord('chuboe_cq_line', 1264300, {
    IsSold: 'Y',
    R_Status_ID: 1000026,
    POReference: '304068',
    DatePromised: '2026-04-27',
    Chuboe_Lead_Time: 'STOCK',
  });
  console.log('CQ 1264300 patched.');
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
