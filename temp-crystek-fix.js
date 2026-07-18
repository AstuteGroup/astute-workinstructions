#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPut } = require('./shared/api-client');
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');

async function main() {
  console.log('=== Fixing Crystek VQ using MFR text ===\n');

  // VQ 2228128 already has Chuboe_MFR_Text = "Crystek Corporation"
  // Just need to tick it and create R_Request
  // The validator may require MFR ID - let's check

  console.log('Step 1: Ticking VQ 2228128...');
  try {
    await tickVQForPurchase(2228128, {
      program: 'LAM_KITTING',
      skipMfrIdValidation: true,  // Use MFR text instead
      extra: {
        DatePromised: '2026-09-15',
        DueDate: '2026-09-15',
        Chuboe_Lead_Time: '09/15/26',
        Chuboe_Packaging_ID: 1000001,
      }
    });
    console.log('  ✓ Ticked');
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    return;
  }

  console.log('\nStep 2: Creating R_Request for Digi-Key...');
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
      skipMfrIdValidation: true,
    });
    console.log(`  ✓ R_Request ${documentNo} (ID: ${id})`);
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }
}

main().catch(console.error);
