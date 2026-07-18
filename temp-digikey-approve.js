#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPut, apiPost } = require('./shared/api-client');

async function main() {
  console.log('=== Digi-Key Approval (CCHD-957X-25-49.152) ===\n');

  // Step 1: Tick VQ directly (MFR text already set to "Crystek Corporation")
  console.log('Step 1: Ticking VQ 2228128...');
  try {
    await apiPut('chuboe_vq_line', 2228128, {
      IsPurchased: true,
      DatePromised: '2026-09-15',
      DueDate: '2026-09-15',
      Chuboe_Lead_Time: '09/15/26',
      Chuboe_Packaging_ID: 1000001,
    });
    console.log('  ✓ Ticked');
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    return;
  }

  // Step 2: Create R_Request (using canonical payload from r-request-writer)
  console.log('\nStep 2: Creating R_Request...');
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
    const result = await apiPost('r_request', {
      AD_Table_ID: 1000002,       // chuboe_rfq
      Record_ID: 1148651,         // RFQ ID
      R_RequestType_ID: 1000000,  // approve order
      R_Status_ID: 1000000,       // submitted
      AD_User_ID: 1000004,        // Jake Harris
      SalesRep_ID: 1000004,       // Jake Harris
      Priority: '5',
      Summary: 'approve order — Digi-Key CCHD-957X-25-49.152 (LAM Kitting) - NEEDS LAM APPROVAL',
      Chuboe_Approval_Text: approvalText,
      Result: 'Requires LAM approval - lead time item ETA 09/15/26',
    }, { context: 'r-request-writer' });
    console.log(`  ✓ R_Request ${result.DocumentNo} (ID: ${result.id})`);
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }
}

main().catch(console.error);
