#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');
const { psqlQuery } = require('./shared/db-helpers');

// VQs to process grouped by supplier
const vqs = [
  // Digi-Key
  {
    vqId: 2228128,
    mpn: 'CCHD-957X-25-49.152',
    vendor: 'Digi-Key',
    qty: 50,
    cost: 37.56,
    rfqId: 1148651,
    rfqValue: '1139236',
    cpc: '635-225114-001',
    needsApproval: true,
    approvalReason: 'Lead time item - ETA 09/15/26'
  },
  // Master - 2 items
  {
    vqId: 2228136,
    mpn: '9290-05-00',
    vendor: 'Master',
    qty: 100,
    cost: 7.62,
    rfqId: 1067492,
    rfqValue: '1062721',
    cpc: '632-B14832-001',
    needsApproval: true,
    approvalReason: '14% below current base price'
  },
  {
    vqId: 2228137,
    mpn: 'KLDR030.TXP',
    vendor: 'Master',
    qty: 30,
    cost: 22.72,
    rfqId: 1148651,
    rfqValue: '1139236',
    cpc: '670-037698-044',
    needsApproval: false,
    approvalReason: 'Alternate for FNQ-R-30'
  },
  // Sager
  {
    vqId: 2133933,
    mpn: '5-104363-2',
    vendor: 'Sager',
    qty: 11929,
    cost: 0.5238,
    rfqId: 1142189,
    rfqValue: '1132774',
    cpc: '668-098496-003',
    needsApproval: false,
    approvalReason: ''
  },
];

async function main() {
  console.log('=== LAM Kitting Purchase Requests ===\n');

  // First, tick all VQs
  console.log('Step 1: Ticking VQs for purchase...\n');

  for (const vq of vqs) {
    console.log(`  ${vq.mpn} (VQ ${vq.vqId}) - ${vq.vendor}...`);
    try {
      const result = await tickVQForPurchase(vq.vqId, {
        program: 'LAM_KITTING',
        extra: {
          // Ensure promise date is set for stock items
          DatePromised: vq.mpn === 'CCHD-957X-25-49.152' ? '2026-09-15' : new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0],
          DueDate: vq.mpn === 'CCHD-957X-25-49.152' ? '2026-09-15' : new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0],
          Chuboe_Lead_Time: vq.mpn === 'CCHD-957X-25-49.152' ? '09/15/26' : 'STOCK',
          Chuboe_Packaging_ID: 1000001, // REEL
        }
      });
      console.log(`    ✓ Ticked${result.buyerCorrected ? ' (buyer corrected to Jake)' : ''}`);
      if (result.untickedCompeting?.length > 0) {
        console.log(`    ✓ Unticked competing: ${result.untickedCompeting.join(', ')}`);
      }
    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
    }
  }

  // Group by vendor for R_Requests
  console.log('\nStep 2: Creating R_Requests (1 per supplier)...\n');

  const byVendor = {};
  for (const vq of vqs) {
    if (!byVendor[vq.vendor]) byVendor[vq.vendor] = [];
    byVendor[vq.vendor].push(vq);
  }

  for (const [vendor, items] of Object.entries(byVendor)) {
    const totalValue = items.reduce((sum, v) => sum + (v.qty * v.cost), 0);
    const mpnList = items.map(v => v.mpn).join(', ');
    const needsApproval = items.some(v => v.needsApproval);

    console.log(`  ${vendor}: ${items.length} item(s), $${totalValue.toFixed(2)}`);

    // Build approval text for all items in this request
    let approvalText = '';
    for (const item of items) {
      approvalText += `RFQ Line\n`;
      approvalText += `  CPC: ${item.cpc}\n`;
      approvalText += `  MPN: ${item.mpn}\n`;
      approvalText += `  Quantity: ${item.qty}\n`;
      approvalText += `  Cost: $${item.cost.toFixed(4)} USD\n`;
      approvalText += `  Total: $${(item.qty * item.cost).toFixed(2)} USD\n`;
      if (item.approvalReason) {
        approvalText += `  Note: ${item.approvalReason}\n`;
      }
      approvalText += '\n';
    }

    const summary = needsApproval
      ? `approve order — ${vendor} ${mpnList} (LAM Kitting) - NEEDS LAM APPROVAL`
      : `approve order — ${vendor} ${mpnList} (LAM Kitting)`;

    try {
      // Use the first item's rfqId for the request linkage
      const { id, documentNo } = await postApproveOrder({
        vqId: items[0].vqId,
        vqIds: items.map(v => v.vqId),
        program: 'LAM_KITTING',
        rfqId: items[0].rfqId,
        summary: summary,
        approvalText: approvalText,
        message: needsApproval ? 'Requires LAM approval before PO creation' : 'Auto-approved for purchase',
      });
      console.log(`    ✓ R_Request ${documentNo} created (ID: ${id})`);
    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log('Items needing LAM approval (add to escalations):');
  for (const vq of vqs.filter(v => v.needsApproval)) {
    console.log(`  - ${vq.mpn}: ${vq.approvalReason}`);
  }
}

main().catch(console.error);
