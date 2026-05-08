require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });
const { patchRecord } = require('../../../shared/record-updater');

(async () => {
  // datenextaction = "Dock Date" in OT terminology. Matches customer PO due date
  // (when goods must reach their receiving dock). For stock/UPS Ground sales
  // to Masline, dock date = ship-promise date = 2026-06-05 per PO 304068.
  await patchRecord('chuboe_cq_line', 1264300, {
    DateNextAction: '2026-06-05',
  });
  console.log('CQ 1264300 dock date set.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
