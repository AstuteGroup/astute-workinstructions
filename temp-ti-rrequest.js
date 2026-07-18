#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { postApproveOrder } = require('./shared/r-request-writer');

async function main() {
  console.log('=== Creating R_Request for SN74LVC125ARGYR ===\n');

  const approvalText = `LAM Kitting Purchase Request
Vendor: Texas Instruments (ti.com)

MPN: SN74LVC125ARGYR
Qty: 200
Cost: $0.3390
Total: $67.80

---
CUSTOM RESALE REQUESTED: $0.42/ea

Total Value: $67.80`;

  try {
    const { id, documentNo } = await postApproveOrder({
      vqId: 2228209,
      vqIds: [2228209],
      program: 'LAM_KITTING',
      rfqId: 1148651,
      summary: 'approve order — ti.com SN74LVC125ARGYR 200pc (LAM Kitting) - CUSTOM RESALE $0.42',
      approvalText: approvalText,
      message: 'Custom resale requested: $0.42/ea',
    });
    console.log(`✓ R_Request ${documentNo} (ID: ${id})`);
  } catch (err) {
    console.log(`✗ Error: ${err.message}`);
  }
}

main().catch(console.error);
