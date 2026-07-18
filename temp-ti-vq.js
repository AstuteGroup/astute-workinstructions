#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createManualVQ } = require('./shared/vq-manual-writer');
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');

async function main() {
  console.log('=== Creating VQ for SN74LVC125ARGYR from ti.com ===\n');

  // Step 1: Create VQ
  console.log('Step 1: Creating manual VQ...');
  let vq;
  try {
    vq = await createManualVQ({
      program: 'LAM_KITTING',
      rfqValue: '1139236',
      rfqLineId: 3149767,
      mpn: 'SN74LVC125ARGYR',
      mfrText: 'Texas Instruments',
      vendorBpId: 1003257,        // Texas Instruments (franchise vendor)
      vendorLocationId: 1005677,
      qty: 200,
      cost: 0.339,
      dateCode: '26+',            // Current year for franchise stock
      leadTime: 'STOCK',
      notes: 'ti.com direct order',
    });
    console.log(`  ✓ Created VQ ${vq.id}`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    return;
  }

  // Step 2: Tick for purchase
  console.log('\nStep 2: Ticking VQ for purchase...');
  const promiseDate = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
  try {
    await tickVQForPurchase(vq.id, {
      program: 'LAM_KITTING',
      extra: {
        DatePromised: promiseDate,
        DueDate: promiseDate,
        Chuboe_Lead_Time: 'STOCK',
        Chuboe_Packaging_ID: 1000001,
      }
    });
    console.log(`  ✓ Ticked VQ ${vq.id}`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    return;
  }

  // Step 3: Create R_Request for approval with custom resale
  console.log('\nStep 3: Creating R_Request with custom resale $0.42...');
  const approvalText = `LAM Kitting Purchase Request
Vendor: Texas Instruments (ti.com)

CPC: (from RFQ 1139236)
MPN: SN74LVC125ARGYR
Qty: 200
Cost: $0.3390
Total: $67.80

---
CUSTOM RESALE REQUESTED: $0.42/ea
(Standard margin would be ~$0.XX - operator requested override)

Total Value: $67.80`;

  try {
    const { id, documentNo } = await postApproveOrder({
      vqId: vq.id,
      vqIds: [vq.id],
      program: 'LAM_KITTING',
      rfqId: 1148651,
      summary: 'approve order — ti.com SN74LVC125ARGYR 200pc (LAM Kitting) - CUSTOM RESALE $0.42',
      approvalText: approvalText,
      message: 'Custom resale requested: $0.42/ea',
    });
    console.log(`  ✓ R_Request ${documentNo} (ID: ${id})`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    return;
  }

  console.log('\n=== Done ===');
  console.log(`VQ ${vq.id} ready for approval`);
  console.log('Cost: $0.339, Custom Resale: $0.42');
}

main().catch(console.error);
