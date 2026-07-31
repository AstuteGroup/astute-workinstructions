#!/usr/bin/env node
/**
 * Submit Master Electronics approval request for RFQ 1139771
 * 4 parts + 2 tariffs
 */

const { tickVQForPurchase } = require('../shared/vq-patcher');
const { postApproveOrder } = require('../shared/r-request-writer');
const { psqlQuery } = require('../shared/db-helpers');

const VQ_IDS = [2230204, 2230206, 2229860, 2234619, 2234617, 2234618];
const RFQ_ID = 1149186;  // internal ID for RFQ 1139771
const RFQ_VALUE = '1139771';

async function buildCopyText() {
  // Get RFQ header info
  const rfqSql = `
    SELECT
      bp.name AS customer
    FROM chuboe_rfq r
    JOIN c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    WHERE r.chuboe_rfq_id = ${RFQ_ID}
  `;
  const rfqRow = psqlQuery(rfqSql);
  const customer = rfqRow.split('|')[0];

  // Get VQ details
  const vqSql = `
    SELECT
      vq.chuboe_vq_line_id,
      rl.line,
      vq.chuboe_mpn,
      mfr.name AS mfr_name,
      vq.qty,
      vq.cost,
      vq.chuboe_date_code,
      vq.chuboe_lead_time,
      coo.name AS coo_name,
      vendor.name AS vendor_name,
      vt.name AS vendor_type,
      tr.name AS traceability
    FROM chuboe_vq_line vq
    JOIN chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN chuboe_mfr mfr ON vq.chuboe_mfr_id = mfr.chuboe_mfr_id
    LEFT JOIN c_country coo ON vq.c_country_id = coo.c_country_id
    JOIN c_bpartner vendor ON vq.c_bpartner_id = vendor.c_bpartner_id
    LEFT JOIN chuboe_vendortype vt ON vq.chuboe_vendortype_id = vt.chuboe_vendortype_id
    LEFT JOIN chuboe_traceability tr ON vq.chuboe_traceability_id = tr.chuboe_traceability_id
    WHERE vq.chuboe_vq_line_id IN (${VQ_IDS.join(',')})
    ORDER BY rl.line
  `;

  const vqRows = psqlQuery(vqSql).split('\n');

  let totalCost = 0;
  let copyText = '';

  // RFQ Header
  copyText += 'RFQ\n';
  copyText += `  Customer: ${customer}\n`;
  copyText += `  RFQ #: ${RFQ_VALUE}\n\n`;

  // Each VQ line
  for (const row of vqRows) {
    const [vqId, line, mpn, mfrName, qty, cost, dc, leadTime, cooName, vendorName, vendorType, traceability] = row.split('|');
    const qtyNum = parseInt(qty);
    const costNum = parseFloat(cost);
    const ext = qtyNum * costNum;
    totalCost += ext;

    copyText += 'RFQ Line\n';
    copyText += `  RFQ Line #: ${line}\n`;
    copyText += `  MPN: ${mpn}\n`;
    copyText += `  MFR: ${mfrName || 'N/A'}\n`;
    copyText += `  Purchase Qty: ${qtyNum}\n\n`;

    copyText += 'Vendor Quote\n';
    copyText += `  Vendor: ${vendorName}\n`;
    copyText += `  Vendor Type: ${vendorType || 'Catalog'}\n`;
    copyText += `  Traceability: ${traceability || 'Authorized Distribution Certs'}\n`;
    copyText += `  MPN: ${mpn}\n`;
    copyText += `  MFR: ${mfrName || 'N/A'}\n`;
    copyText += `  Quantity: ${qtyNum}\n`;
    copyText += `  Cost: ${costNum.toFixed(2)} USD\n`;
    copyText += `  Date Code: ${dc || 'N/A'}\n`;
    copyText += `  COO: ${cooName || 'PENDING'}\n`;
    copyText += `  Lead Time: ${leadTime || 'STOCK'}\n\n`;
  }

  copyText += `Total Cost: $${totalCost.toFixed(2)}\n`;

  return { copyText, totalCost };
}

async function main() {
  console.log('='.repeat(60));
  console.log('Master Electronics Approval - RFQ ' + RFQ_VALUE);
  console.log('='.repeat(60));

  // Step 1: Ensure all VQs are ticked with validation
  console.log('\nStep 1: Validating and ticking VQs...');
  for (const vqId of VQ_IDS) {
    try {
      const result = await tickVQForPurchase(vqId, {
        program: 'LAM_KITTING',
        allowCompetingTicked: true  // We're buying all these
      });
      console.log(`  VQ ${vqId}: ${result.ticked ? 'OK' : 'already ticked'}`);
    } catch (e) {
      if (e.message.includes('already ticked') || e.message.includes('IsPurchased')) {
        console.log(`  VQ ${vqId}: already ticked`);
      } else {
        console.log(`  VQ ${vqId}: ERROR - ${e.message}`);
        if (e.violations) {
          e.violations.forEach(v => console.log(`    - ${v}`));
        }
        process.exit(1);
      }
    }
  }

  // Step 2: Build copy text
  console.log('\nStep 2: Building approval text...');
  const { copyText, totalCost } = await buildCopyText();

  // Step 3: Submit the approval request
  console.log('\nStep 3: Submitting approval request...');
  const result = await postApproveOrder({
    vqIds: VQ_IDS,
    program: 'LAM_KITTING',
    rfqId: RFQ_ID,
    summary: `approve order — Master Electronics RFQ ${RFQ_VALUE} - 4 parts + 2 tariffs - $${totalCost.toFixed(2)}`,
    approvalText: copyText,
    message: 'GRF1-J-P-08-E-RA-TH1-E needs resale approval (buying $36.27 vs base $34.58). See lam-escalations.json.',
    allowCompetingTicked: true,  // Tariffs are on same line as parts
  });

  console.log('\n' + '='.repeat(60));
  console.log('SUBMITTED');
  console.log('  Request #: ' + result.documentNo);
  console.log('  Internal ID: ' + result.id);
  console.log('  VQs validated: ' + result.vqsValidated);
  console.log('  Total: $' + totalCost.toFixed(2));
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('\nFATAL ERROR:', e.message);
  if (e.violations) {
    console.error('Violations:');
    e.violations.forEach(v => console.error('  - ' + v));
  }
  process.exit(1);
});
