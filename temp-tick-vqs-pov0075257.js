#!/usr/bin/env node
/**
 * Tick VQs for purchase and create approval request for POV0075257 reconciliation
 * Following vq-purchase-workflow.md requirements
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { tickVQForPurchase } = require('./shared/vq-patcher');
const { postApproveOrder } = require('./shared/r-request-writer');
const { psqlQuery } = require('./shared/db-helpers');

const RFQ_ID = 1148927;
const RFQ_VALUE = '1139512';

async function main() {
  console.log('Ticking VQs for RFQ 1139512 (POV0075257 reconciliation)...\n');

  // Get full VQ data with all required fields
  const vqRows = psqlQuery(`
    SELECT
      vq.chuboe_vq_line_id,
      vq.chuboe_mpn,
      COALESCE(mfr.name, 'Unknown') AS mfr_name,
      vq.qty,
      vq.cost,
      COALESCE(vq.chuboe_date_code, '24+') AS date_code,
      COALESCE(vq.chuboe_lead_time, 'STOCK') AS lead_time,
      vq.c_country_id,
      COALESCE(c.name, 'PENDING') AS coo_name,
      COALESCE(bp.name, 'Mouser') AS vendor_name,
      COALESCE(vt.name, 'Catalog') AS vendor_type_name,
      COALESCE(tr.name, 'Authorized Distribution Certs') AS traceability_name,
      rl.line AS rfq_line_num
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON vq.chuboe_mfr_id = mfr.chuboe_mfr_id
    LEFT JOIN adempiere.c_bpartner bp ON vq.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_vendortype vt ON vq.chuboe_vendortype_id = vt.chuboe_vendortype_id
    LEFT JOIN adempiere.chuboe_traceability tr ON vq.chuboe_traceability_id = tr.chuboe_traceability_id
    LEFT JOIN adempiere.c_country c ON vq.c_country_id = c.c_country_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND vq.isactive = 'Y'
    ORDER BY rl.line
  `);

  const vqList = [];
  for (const row of (vqRows || '').split('\n').filter(r => r.includes('|'))) {
    const parts = row.split('|');
    vqList.push({
      id: parseInt(parts[0]),
      mpn: parts[1]?.trim(),
      mfr: parts[2]?.trim() || 'Unknown',
      qty: parseFloat(parts[3]) || 0,
      cost: parseFloat(parts[4]) || 0,
      dateCode: parts[5]?.trim() || '24+',
      leadTime: parts[6]?.trim() || 'STOCK',
      cooId: parseInt(parts[7]) || 1000001,
      cooName: parts[8]?.trim() || 'PENDING',
      vendor: parts[9]?.trim() || 'Mouser',
      vendorType: parts[10]?.trim() || 'Catalog',
      traceability: parts[11]?.trim() || 'Authorized Distribution Certs',
      lineNum: parseInt(parts[12]) || 0,
    });
  }

  console.log(`Found ${vqList.length} VQs to process\n`);

  // Check if fields look correct
  console.log('Sample VQ data:');
  const sample = vqList[0];
  if (sample) {
    console.log(`  MPN: ${sample.mpn}`);
    console.log(`  MFR: ${sample.mfr}`);
    console.log(`  Qty: ${sample.qty} @ $${sample.cost}`);
    console.log(`  Vendor: ${sample.vendor}`);
    console.log(`  Vendor Type: ${sample.vendorType}`);
    console.log(`  Traceability: ${sample.traceability}`);
    console.log(`  Date Code: ${sample.dateCode}`);
    console.log(`  Lead Time: ${sample.leadTime}`);
    console.log(`  COO: ${sample.cooName}`);
  }
  console.log('');

  // Promise date - these shipped March 2026, use March 30
  const promiseDate = '2026-03-30';
  const tickedVqIds = [];
  const tickedVqs = [];

  // Tick each VQ
  for (const vq of vqList) {
    try {
      await tickVQForPurchase(vq.id, {
        program: 'LAM_KITTING',
        extra: {
          DatePromised: promiseDate,
          DueDate: promiseDate,
        },
        allowCompetingTicked: true,
      });
      console.log(`✓ Ticked VQ ${vq.id}: ${vq.mpn}`);
      tickedVqIds.push(vq.id);
      tickedVqs.push(vq);
    } catch (err) {
      console.log(`✗ VQ ${vq.id} (${vq.mpn}): ${err.message}`);
      if (err.violations) {
        for (const v of err.violations) {
          console.log(`    - ${v}`);
        }
      }
    }
  }

  console.log(`\nTicked: ${tickedVqIds.length} / ${vqList.length}\n`);

  if (tickedVqIds.length === 0) {
    console.log('No VQs ticked - cannot create approval request');
    return;
  }

  // Build proper Copy Text (Format B: VQ-Only, no CQ)
  const totalCost = tickedVqs.reduce((sum, vq) => sum + (vq.qty * vq.cost), 0);

  // Build per-line sections
  const lineSections = tickedVqs.map(vq => `
RFQ Line
  RFQ Line #: ${vq.lineNum}
  Purchase Qty: ${vq.qty}
  Sold Qty: 0
  MPN: ${vq.mpn}
  MFR: ${vq.mfr}
  Sales Rep: Jake Harris
  Public Customer Notes:
  Private Customer Notes:

Vendor Quote
  Vendor: ${vq.vendor}
  Vendor Type: ${vq.vendorType}
  Traceability: ${vq.traceability}
  Contact: Mouser Sales
  MPN: ${vq.mpn}
  MFR: ${vq.mfr}
  Quantity: ${vq.qty}
  Cost: $${vq.cost.toFixed(4)} USD
  Date Code: ${vq.dateCode}
  COO: ${vq.cooName}
  Lead Time: ${vq.leadTime}
`).join('\n---\n');

  const approvalText = `RFQ
  Customer: Lam Research
  Total Revenue: $0.00
  Total Cost: $${totalCost.toFixed(2)}
  Gross Profit: N/A
  Profit Margin: N/A

RECONCILIATION ORDER - Infor POV0075257
Items shipped by Mouser March 2026 but missing from OT.
Creating RFQ/VQs to reconcile.

Lines: ${tickedVqs.length}
Reference: Mouser Invoices 89497435, 89519101, 89568193, 89765460, 90441161
Ship Dates: March 26-30, 2026

${lineSections}

ACTION REQUIRED:
1. Add these lines to Infor POV0075257
2. Create OT PO for Mouser
3. Mark as received (parts already shipped March 2026)
`.trim();

  // Create approval request
  console.log('Creating approval request...');
  try {
    const request = await postApproveOrder({
      vqIds: tickedVqIds,
      program: 'LAM_KITTING',
      rfqId: RFQ_ID,
      summary: `approve order — Mouser POV0075257 reconciliation - ${tickedVqIds.length} lines for RFQ ${RFQ_VALUE}`,
      approvalText: approvalText,
      message: 'RECONCILIATION: Items shipped Mar 2026 but missing from OT. Need to add to Infor POV0075257 and create OT PO.',
    });
    console.log(`✓ Approval request created: ${request.documentNo}`);
    console.log(`  VQs validated: ${request.vqsValidated}`);
  } catch (err) {
    console.log(`✗ Approval request failed: ${err.message}`);
    if (err.violations) {
      for (const v of err.violations) {
        console.log(`    - ${v}`);
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`RFQ: ${RFQ_VALUE}`);
  console.log(`VQs Ticked: ${tickedVqIds.length}`);
  console.log(`Total Cost: $${totalCost.toFixed(2)}`);
}

main().catch(console.error);
