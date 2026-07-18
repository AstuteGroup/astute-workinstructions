#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPut } = require('./shared/api-client');
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');

// MFR IDs from lookup
const MFR = {
  CRYSTEK: 1001625,
  COTO: 1001578,
  LITTELFUSE: 1000069,
  TE_CONN: 1000009,
};

// LAM Kitting defaults
const LAM_DEFAULTS = {
  Chuboe_Warehouse_ID: 1000015,
  Chuboe_Warehouse_Group_ID: 1000008,
  M_Shipper_ID: 1000003,
  Chuboe_Inco_Term_ID: 1000000,
};

// Sager location
const SAGER_LOCATION = 1006612;

async function patchVQ(vqId, data) {
  return await apiPut('chuboe_vq_line', vqId, data);
}

async function main() {
  console.log('=== LAM Kitting Purchase Requests ===\n');

  // Step 1: Untick the competing VQ for 9290-05-00
  console.log('Step 1: Unticking competing VQ 1376226...');
  try {
    await patchVQ(1376226, { IsPurchased: false });
    console.log('  ✓ Unticked VQ 1376226\n');
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}\n`);
  }

  // Step 2: Patch MFR IDs on VQs that need them
  console.log('Step 2: Patching MFR IDs...');
  const mfrPatches = [
    { vqId: 2228128, mfrId: MFR.CRYSTEK, name: 'CCHD-957X-25-49.152' },
    { vqId: 2228136, mfrId: MFR.COTO, name: '9290-05-00' },
    { vqId: 2228137, mfrId: MFR.LITTELFUSE, name: 'KLDR030.TXP' },
  ];
  for (const p of mfrPatches) {
    try {
      await patchVQ(p.vqId, { Chuboe_MFR_ID: p.mfrId });
      console.log(`  ✓ ${p.name}: MFR set`);
    } catch (err) {
      console.log(`  ✗ ${p.name}: ${err.message}`);
    }
  }

  // Step 3: Patch Sager VQs with warehouse/location/shipper
  console.log('\nStep 3: Patching Sager VQs with LAM defaults...');
  const sagerVqs = [2133933, 2134017];
  for (const vqId of sagerVqs) {
    try {
      await patchVQ(vqId, {
        ...LAM_DEFAULTS,
        C_BPartner_Location_ID: SAGER_LOCATION,
      });
      console.log(`  ✓ VQ ${vqId}: LAM defaults + location set`);
    } catch (err) {
      console.log(`  ✗ VQ ${vqId}: ${err.message}`);
    }
  }

  // Step 4: Tick all VQs
  console.log('\nStep 4: Ticking VQs for purchase...');
  const vqs = [
    { vqId: 2228128, mpn: 'CCHD-957X-25-49.152', vendor: 'Digi-Key', qty: 50, cost: 37.56, rfqId: 1148651, cpc: '635-225114-001', needsApproval: true, leadTime: '09/15/26', promiseDate: '2026-09-15' },
    { vqId: 2228136, mpn: '9290-05-00', vendor: 'Master', qty: 100, cost: 7.62, rfqId: 1067492, cpc: '632-B14832-001', needsApproval: true, leadTime: 'STOCK', promiseDate: new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0] },
    { vqId: 2228137, mpn: 'KLDR030.TXP', vendor: 'Master', qty: 30, cost: 22.72, rfqId: 1148651, cpc: '670-037698-044', needsApproval: false, leadTime: 'STOCK', promiseDate: new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0] },
    { vqId: 2133933, mpn: '5-104363-2', vendor: 'Sager', qty: 11929, cost: 0.5238, rfqId: 1142189, cpc: '668-098496-003', needsApproval: false, leadTime: 'STOCK', promiseDate: new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0] },
    { vqId: 2134017, mpn: '503398-1892', vendor: 'Sager', qty: 14400, cost: 1.35, rfqId: 1142189, cpc: '667-A00288-001', needsApproval: false, leadTime: 'STOCK', promiseDate: new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0] },
  ];

  for (const vq of vqs) {
    console.log(`  ${vq.mpn} (VQ ${vq.vqId})...`);
    try {
      const result = await tickVQForPurchase(vq.vqId, {
        program: 'LAM_KITTING',
        extra: {
          DatePromised: vq.promiseDate,
          DueDate: vq.promiseDate,
          Chuboe_Lead_Time: vq.leadTime,
          Chuboe_Packaging_ID: 1000001,
        }
      });
      console.log(`    ✓ Ticked`);
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
    }
  }

  // Step 5: Create R_Requests grouped by vendor
  console.log('\nStep 5: Creating R_Requests (1 per supplier)...');

  const byVendor = {};
  for (const vq of vqs) {
    if (!byVendor[vq.vendor]) byVendor[vq.vendor] = [];
    byVendor[vq.vendor].push(vq);
  }

  for (const [vendor, items] of Object.entries(byVendor)) {
    const totalValue = items.reduce((sum, v) => sum + (v.qty * v.cost), 0);
    const mpnList = items.map(v => v.mpn).join(', ');
    const needsApproval = items.some(v => v.needsApproval);

    console.log(`\n  ${vendor}: ${items.length} item(s), $${totalValue.toFixed(2)}`);

    let approvalText = `LAM Kitting Purchase Request\nVendor: ${vendor}\n\n`;
    for (const item of items) {
      approvalText += `CPC: ${item.cpc}\n`;
      approvalText += `MPN: ${item.mpn}\n`;
      approvalText += `Qty: ${item.qty.toLocaleString()}\n`;
      approvalText += `Cost: $${item.cost.toFixed(4)}\n`;
      approvalText += `Total: $${(item.qty * item.cost).toFixed(2)}\n`;
      approvalText += `Lead Time: ${item.leadTime}\n\n`;
    }
    approvalText += `---\nTotal Value: $${totalValue.toFixed(2)}`;
    if (needsApproval) {
      approvalText += '\n\n** REQUIRES LAM APPROVAL **';
    }

    const summary = needsApproval
      ? `approve order — ${vendor} ${mpnList} (LAM Kitting) - NEEDS LAM APPROVAL`
      : `approve order — ${vendor} ${mpnList} (LAM Kitting)`;

    try {
      const { id, documentNo } = await postApproveOrder({
        vqId: items[0].vqId,
        vqIds: items.map(v => v.vqId),
        program: 'LAM_KITTING',
        rfqId: items[0].rfqId,
        summary: summary.substring(0, 200),
        approvalText: approvalText,
        message: needsApproval ? 'Requires LAM approval' : 'Ready for PO',
      });
      console.log(`    ✓ R_Request ${documentNo} (ID: ${id})`);
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
    }
  }

  console.log('\n=== Done ===');
  console.log('\nItems needing LAM approval:');
  console.log('  - CCHD-957X-25-49.152 (lead time 09/15/26)');
  console.log('  - 9290-05-00 (14% below base)');
}

main().catch(console.error);
