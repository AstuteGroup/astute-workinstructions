require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });
const { markCQSold } = require('../../../shared/cq-patcher');

(async () => {
  const result = await markCQSold(1264300, {
    poReference:        '304068',
    datePromised:       '2026-06-05',    // Masline PO due date
    bpartnerLocationId: 1002806,         // Masline Rochester
    shipperId:          1000026,         // UPS Ground
    incoTermId:         1000000,         // EXW
    productCodeId:      1000001,         // PA - Passives
    leadTimeId:         1000005,         // STOCK
    shippingAcct:       '124-121',
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(e => {
  console.error('FATAL:', e.message);
  if (e.violations) console.error('Violations:', e.violations);
  process.exit(1);
});
