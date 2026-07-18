#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createManualVQ } = require('./shared/vq-manual-writer');
const { psqlQuery } = require('./shared/db-helpers');

async function main() {
  // Find Master Electronics BP and location
  const masterResult = psqlQuery(`
    SELECT bp.c_bpartner_id, bl.c_bpartner_location_id, bp.name
    FROM adempiere.c_bpartner bp
    JOIN adempiere.c_bpartner_location bl ON bp.c_bpartner_id = bl.c_bpartner_id
    WHERE bp.name ILIKE '%Master Electronics%'
      AND bp.isvendor = 'Y'
      AND bp.isactive = 'Y'
      AND bl.isactive = 'Y'
    LIMIT 1;
  `);

  if (!masterResult || !masterResult.trim()) {
    console.log('ERROR: Master Electronics not found');
    return;
  }

  const [bpId, locId, vendorName] = masterResult.trim().split('|');
  console.log(`Vendor: ${vendorName} (BP ${bpId}, Loc ${locId})\n`);

  // VQ 1: 9290-05-00 (needs LAM approval)
  console.log('=== 9290-05-00 ===');
  const rfq1Result = psqlQuery(`
    SELECT rl.chuboe_rfq_line_id, rl.chuboe_cpc, rfq.value as rfq_value,
           rl.priceentered as base_price
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq rfq ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    WHERE rfq.c_bpartner_id = 1000730
      AND rlm.chuboe_mpn ILIKE '%9290-05-00%'
      AND rfq.isactive = 'Y'
    ORDER BY rfq.created DESC
    LIMIT 1;
  `);

  if (rfq1Result && rfq1Result.trim()) {
    const [rfqLineId, cpc, rfqValue, basePrice] = rfq1Result.trim().split('|');
    console.log(`CPC: ${cpc}, RFQ: ${rfqValue}, Base: $${basePrice}`);

    const vq1 = await createManualVQ({
      program: 'LAM_KITTING',
      rfqValue: rfqValue.trim(),
      rfqLineId: parseInt(rfqLineId.trim()),
      mpn: '9290-05-00',
      mfrText: 'Coto Technology, Inc.',
      vendorBpId: parseInt(bpId.trim()),
      vendorLocationId: parseInt(locId.trim()),
      qty: 100,
      cost: 7.62,
      dateCode: '24+',
      leadTime: 'STOCK',
      notes: 'Master Electronics - 1,228 in stock. Needs LAM approval before ordering.',
    });

    console.log(`✓ VQ created: ${vq1.id}`);
    console.log(`  9290-05-00: 100 pcs @ $7.62 = $762.00`);
    console.log(`  Base price: $${parseFloat(basePrice).toFixed(2)} → VQ price +${((7.62 / parseFloat(basePrice) - 1) * 100).toFixed(1)}%`);
  }

  // VQ 2: KLDR030.TXP (alternate for 670-037698-044, can buy)
  console.log('\n=== KLDR030.TXP (alt for 670-037698-044) ===');
  const rfq2Result = psqlQuery(`
    SELECT rl.chuboe_rfq_line_id, rl.chuboe_cpc, rfq.value as rfq_value,
           rl.priceentered as base_price
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq rfq ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    WHERE rfq.c_bpartner_id = 1000730
      AND rl.chuboe_cpc = '670-037698-044'
      AND rfq.isactive = 'Y'
    ORDER BY rfq.created DESC
    LIMIT 1;
  `);

  if (rfq2Result && rfq2Result.trim()) {
    const [rfqLineId, cpc, rfqValue, basePrice] = rfq2Result.trim().split('|');
    console.log(`CPC: ${cpc}, RFQ: ${rfqValue}, Base: $${basePrice}`);

    const vq2 = await createManualVQ({
      program: 'LAM_KITTING',
      rfqValue: rfqValue.trim(),
      rfqLineId: parseInt(rfqLineId.trim()),
      mpn: 'KLDR030.TXP',
      mfrText: 'Littelfuse',
      vendorBpId: parseInt(bpId.trim()),
      vendorLocationId: parseInt(locId.trim()),
      qty: 30,  // LAM MOQ from roster
      cost: 22.72,
      dateCode: '24+',
      leadTime: 'STOCK',
      notes: 'Master Electronics - 87 in stock. Alternate MPN for FNQ-R-30.',
    });

    console.log(`✓ VQ created: ${vq2.id}`);
    console.log(`  KLDR030.TXP: 30 pcs @ $22.72 = $681.60`);
    console.log(`  Base price: $${parseFloat(basePrice).toFixed(2)} → VQ price ${((22.72 / parseFloat(basePrice) - 1) * 100).toFixed(1)}%`);
  }
}

main().catch(console.error);
