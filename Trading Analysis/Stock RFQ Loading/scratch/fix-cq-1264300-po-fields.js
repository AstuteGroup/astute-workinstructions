/**
 * Backfill PO-derived customer-side fields on CQ 1264300 that were missed
 * at write time. Values sourced from Masline PO 304068.
 */
require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });
const { patchRecord } = require('../../../shared/record-updater');

(async () => {
  await patchRecord('chuboe_cq_line', 1264300, {
    C_BPartner_Location_ID:  1002806,     // Masline Rochester NY 14620
    M_Shipper_ID:            1000026,     // UPS Ground
    Chuboe_ShippingAcct:     '124-121',   // PO: "UPS Ground #124-121"
    Chuboe_Inco_Term_ID:     1000000,     // EXW
    Chuboe_Product_Code_ID:  1000001,     // PA - Passives
    Chuboe_LeadTime_ID:      1000005,     // STOCK
    DatePromised:            '2026-06-05',// PO due date (customer-side commitment)
    C_UOM_ID:                100,         // Each
  });
  console.log('CQ 1264300 PO-field backfill done.');
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
