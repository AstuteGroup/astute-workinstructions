#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPut } = require('./shared/api-client');
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');

// Tenant-level MFR IDs (client 1000000, NOT system IDs)
const MFR = {
  COTO_TEC: 1019369,        // "COTO_TEC" for Coto Technology
  LITTELFUSE: 1020272,      // "Littelfuse, Inc."
};

async function patchVQ(vqId, data) {
  return await apiPut('chuboe_vq_line', vqId, data);
}

async function main() {
  console.log('=== Completing LAM Kitting Purchase Requests ===\n');

  // Step 1: Patch MFR IDs on Master VQs (using tenant-level MFRs)
  console.log('Step 1: Patching MFR IDs on Master VQs...');
  const mfrPatches = [
    { vqId: 2228136, mfrId: MFR.COTO_TEC, name: '9290-05-00 (Coto Technology)' },
    { vqId: 2228137, mfrId: MFR.LITTELFUSE, name: 'KLDR030.TXP (Littelfuse)' },
  ];
  for (const p of mfrPatches) {
    try {
      await patchVQ(p.vqId, { Chuboe_MFR_ID: p.mfrId });
      console.log(`  ✓ ${p.name}: MFR ID set to ${p.mfrId}`);
    } catch (err) {
      console.log(`  ✗ ${p.name}: ${err.message}`);
    }
  }

  // Step 2: Tick Master VQs with allowCompetingTicked (VQ 1376226 is processed/complete)
  console.log('\nStep 2: Ticking Master VQs for purchase...');
  const masterVqs = [
    { vqId: 2228136, mpn: '9290-05-00', needsApproval: true, leadTime: 'STOCK' },
    { vqId: 2228137, mpn: 'KLDR030.TXP', needsApproval: false, leadTime: 'STOCK' },
  ];

  for (const vq of masterVqs) {
    const promiseDate = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
    console.log(`  ${vq.mpn} (VQ ${vq.vqId})...`);
    try {
      const result = await tickVQForPurchase(vq.vqId, {
        program: 'LAM_KITTING',
        allowCompetingTicked: true,  // VQ 1376226 is already processed
        extra: {
          DatePromised: promiseDate,
          DueDate: promiseDate,
          Chuboe_Lead_Time: vq.leadTime,
          Chuboe_Packaging_ID: 1000001,
        }
      });
      console.log(`    ✓ Ticked`);
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
    }
  }

  // Step 3: Create R_Request for Master (2 items)
  console.log('\nStep 3: Creating R_Request for Master...');

  const masterItems = [
    { vqId: 2228136, mpn: '9290-05-00', qty: 100, cost: 7.62, cpc: '632-B14832-001', needsApproval: true, approvalReason: '14% below current base price' },
    { vqId: 2228137, mpn: 'KLDR030.TXP', qty: 30, cost: 22.72, cpc: '670-037698-044', needsApproval: false, approvalReason: 'Alternate for FNQ-R-30' },
  ];

  const totalValue = masterItems.reduce((sum, v) => sum + (v.qty * v.cost), 0);
  const mpnList = masterItems.map(v => v.mpn).join(', ');
  const needsApproval = masterItems.some(v => v.needsApproval);

  console.log(`  Master: ${masterItems.length} item(s), $${totalValue.toFixed(2)}`);

  let approvalText = `LAM Kitting Purchase Request\nVendor: Master Electronics\n\n`;
  for (const item of masterItems) {
    approvalText += `CPC: ${item.cpc}\n`;
    approvalText += `MPN: ${item.mpn}\n`;
    approvalText += `Qty: ${item.qty.toLocaleString()}\n`;
    approvalText += `Cost: $${item.cost.toFixed(4)}\n`;
    approvalText += `Total: $${(item.qty * item.cost).toFixed(2)}\n`;
    if (item.approvalReason) {
      approvalText += `Note: ${item.approvalReason}\n`;
    }
    approvalText += '\n';
  }
  approvalText += `---\nTotal Value: $${totalValue.toFixed(2)}`;
  if (needsApproval) {
    approvalText += '\n\n** REQUIRES LAM APPROVAL **';
  }

  const summary = needsApproval
    ? `approve order — Master ${mpnList} (LAM Kitting) - NEEDS LAM APPROVAL`
    : `approve order — Master ${mpnList} (LAM Kitting)`;

  try {
    const { id, documentNo } = await postApproveOrder({
      vqId: masterItems[0].vqId,
      vqIds: masterItems.map(v => v.vqId),
      program: 'LAM_KITTING',
      rfqId: 1067492,  // From the VQ
      summary: summary.substring(0, 200),
      approvalText: approvalText,
      message: needsApproval ? 'Requires LAM approval' : 'Ready for PO',
      allowCompetingTicked: true,
    });
    console.log(`    ✓ R_Request ${documentNo} (ID: ${id})`);
  } catch (err) {
    console.log(`    ✗ ${err.message}`);
  }

  console.log('\n=== Summary ===');
  console.log('✓ Sager R_Request: 1167901 (created in previous run)');
  console.log('✓ Master R_Request: (just created above)');
  console.log('\n⚠ Digi-Key (CCHD-957X-25-49.152) needs manual handling:');
  console.log('  - VQ 2228128 needs Crystek MFR ID');
  console.log('  - No tenant-level Crystek MFR exists (only system ID 1001625)');
  console.log('  - Create tenant MFR for Crystek, then patch VQ and create R_Request');
}

main().catch(console.error);
