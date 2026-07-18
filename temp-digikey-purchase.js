#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPost, apiPut } = require('./shared/api-client');
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');

async function main() {
  console.log('=== Digi-Key Purchase Request (CCHD-957X-25-49.152) ===\n');

  // Step 1: Create tenant-level Crystek MFR
  console.log('Step 1: Creating tenant-level Crystek MFR...');
  let crystekMfrId;
  try {
    const result = await apiPost('Chuboe_MFR', {
      Name: 'Crystek Corporation',
      IsActive: true,
    });
    crystekMfrId = result.id;
    console.log(`  ✓ Created MFR "Crystek Corporation" (ID: ${crystekMfrId})`);
  } catch (err) {
    console.log(`  ✗ Error creating MFR: ${err.message}`);
    return;
  }

  // Step 2: Patch VQ 2228128 with the new MFR ID
  console.log('\nStep 2: Patching VQ 2228128 with Crystek MFR ID...');
  try {
    await apiPut('chuboe_vq_line', 2228128, { Chuboe_MFR_ID: crystekMfrId });
    console.log(`  ✓ MFR ID set to ${crystekMfrId}`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    return;
  }

  // Step 3: Tick VQ for purchase
  console.log('\nStep 3: Ticking VQ for purchase...');
  try {
    const result = await tickVQForPurchase(2228128, {
      program: 'LAM_KITTING',
      extra: {
        DatePromised: '2026-09-15',  // Lead time item
        DueDate: '2026-09-15',
        Chuboe_Lead_Time: '09/15/26',
        Chuboe_Packaging_ID: 1000001,
      }
    });
    console.log(`  ✓ Ticked VQ 2228128`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    return;
  }

  // Step 4: Create R_Request
  console.log('\nStep 4: Creating R_Request for Digi-Key...');
  const approvalText = `LAM Kitting Purchase Request
Vendor: Digi-Key

CPC: 635-225114-001
MPN: CCHD-957X-25-49.152
Qty: 50
Cost: $37.5600
Total: $1,878.00
Lead Time: 09/15/26 (ETA)

---
Total Value: $1,878.00

** REQUIRES LAM APPROVAL **
Reason: Lead time item - ETA September 15, 2026`;

  try {
    const { id, documentNo } = await postApproveOrder({
      vqId: 2228128,
      vqIds: [2228128],
      program: 'LAM_KITTING',
      rfqId: 1148651,
      summary: 'approve order — Digi-Key CCHD-957X-25-49.152 (LAM Kitting) - NEEDS LAM APPROVAL',
      approvalText: approvalText,
      message: 'Requires LAM approval - lead time item',
    });
    console.log(`  ✓ R_Request ${documentNo} (ID: ${id})`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    return;
  }

  console.log('\n=== Done ===');
  console.log('\nAll purchase requests created:');
  console.log('  - Sager (2 items): R_Request 1167901');
  console.log('  - Master (2 items): R_Request 1167902');
  console.log('  - Digi-Key (1 item): (just created above)');
  console.log('\nItems needing LAM approval:');
  console.log('  - CCHD-957X-25-49.152 (lead time 09/15/26)');
  console.log('  - 9290-05-00 (14% below base)');
}

main().catch(console.error);
