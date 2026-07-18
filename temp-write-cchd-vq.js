#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createManualVQ } = require('./shared/vq-manual-writer');
const { psqlQuery } = require('./shared/db-helpers');

async function main() {
  // Find the RFQ line for this MPN
  const rfqResult = psqlQuery(`
    SELECT rl.chuboe_rfq_line_id, rl.chuboe_cpc, rfq.value as rfq_value,
           rlm.chuboe_mpn, m.name as mfr_name
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq rfq ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    LEFT JOIN adempiere.chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
    WHERE rfq.c_bpartner_id = 1000730  -- Lam Research
      AND rfq.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND rlm.chuboe_mpn ILIKE '%CCHD-957X-25-49.152%'
    ORDER BY rfq.created DESC
    LIMIT 1;
  `);

  console.log('RFQ Line lookup:');
  console.log(rfqResult);

  if (!rfqResult || !rfqResult.trim()) {
    console.log('ERROR: RFQ line not found');
    return;
  }

  const [rfqLineId, cpc, rfqValue, mpn, mfrName] = rfqResult.trim().split('|');
  console.log(`\nFound: RFQ ${rfqValue}, Line ${rfqLineId}, CPC ${cpc}, MPN ${mpn}`);

  // Find Digi-Key BP and location
  const digiResult = psqlQuery(`
    SELECT bp.c_bpartner_id, bl.c_bpartner_location_id, bp.name
    FROM adempiere.c_bpartner bp
    JOIN adempiere.c_bpartner_location bl ON bp.c_bpartner_id = bl.c_bpartner_id
    WHERE bp.name ILIKE '%digi%key%'
      AND bp.isvendor = 'Y'
      AND bp.isactive = 'Y'
      AND bl.isactive = 'Y'
    LIMIT 1;
  `);

  if (!digiResult || !digiResult.trim()) {
    console.log('ERROR: Digi-Key not found');
    return;
  }

  const [bpId, locId, vendorName] = digiResult.trim().split('|');
  console.log(`Vendor: ${vendorName} (BP ${bpId}, Loc ${locId})`);

  // Create the VQ
  const vq = await createManualVQ({
    program: 'LAM_KITTING',
    rfqValue: rfqValue.trim(),
    rfqLineId: parseInt(rfqLineId.trim()),
    mpn: 'CCHD-957X-25-49.152',
    mfrText: 'Crystek Corporation',
    vendorBpId: parseInt(bpId.trim()),
    vendorLocationId: parseInt(locId.trim()),
    qty: 50,
    cost: 37.56,
    dateCode: '26+',
    leadTime: '09/15/26',
    notes: 'Digi-Key quote. Needs LAM approval before ordering.',
  });

  console.log(`\n✓ VQ created: ${vq.value || vq.id}`);
  console.log(`  MPN: CCHD-957X-25-49.152`);
  console.log(`  Qty: 50 @ $37.56`);
  console.log(`  Delivery: 09/15/26`);
}

main().catch(console.error);
