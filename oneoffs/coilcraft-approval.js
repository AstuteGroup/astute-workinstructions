#!/usr/bin/env node
/**
 * One-off: Post Coilcraft approval for 4 VQs
 * VQs already ticked: 2249560, 2249561, 2249562, 2249563
 */

const { psqlQuery } = require('../shared/db-helpers');
const { buildCopyTextBatchVQOnly } = require('../shared/copy-text-builder');
const { postApproveOrder } = require('../shared/r-request-writer');

async function main() {
  const vqIds = [2249560, 2249561, 2249562, 2249563];

  // Query full VQ data for copy text
  const sql = `
    SELECT
      vq.chuboe_vq_line_id,
      rl.line AS rfq_line_no,
      vq.chuboe_mpn AS mpn,
      COALESCE(mfr.name, vq.chuboe_mfr_text) AS mfr,
      vq.qty,
      vq.cost,
      vq.chuboe_date_code AS date_code,
      COALESCE(coo.name, 'PENDING') AS coo,
      vq.chuboe_lead_time AS lead_time,
      bp.name AS vendor,
      vt.name AS vendor_type,
      tr.name AS traceability
    FROM chuboe_vq_line vq
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
    LEFT JOIN chuboe_mfr mfr ON mfr.chuboe_mfr_id = vq.chuboe_mfr_id
    LEFT JOIN c_country coo ON coo.c_country_id = vq.c_country_id
    LEFT JOIN c_bpartner bp ON bp.c_bpartner_id = vq.c_bpartner_id
    LEFT JOIN chuboe_vendortype vt ON vt.chuboe_vendortype_id = bp.chuboe_vendortype_id
    LEFT JOIN chuboe_traceability tr ON tr.chuboe_traceability_id = vq.chuboe_traceability_id
    WHERE vq.chuboe_vq_line_id IN (${vqIds.join(',')})
    ORDER BY rl.line
  `;

  const rows = psqlQuery(sql).split('\n').filter(r => r.trim());

  let totalCost = 0;
  const lines = rows.map(row => {
    const [vqId, rfqLineNo, mpn, mfr, qty, cost, dateCode, coo, leadTime, vendor, vendorType, traceability] = row.split('|');
    totalCost += parseFloat(qty) * parseFloat(cost);
    return {
      rfqLineNo,
      purchaseQty: parseInt(qty),
      mpn,
      mfr,
      vendor,
      vendorType: vendorType || 'Manufacturer Direct',
      traceability: traceability || 'Authorized Distribution Certs',
      qty: parseInt(qty),
      cost: parseFloat(cost),
      dateCode,
      coo,
      leadTime,
    };
  });

  const copyText = buildCopyTextBatchVQOnly(
    { customer: 'Lam Research', totalCost },
    lines
  );

  console.log('=== COPY TEXT ===');
  console.log(copyText);
  console.log('=================\n');

  const result = await postApproveOrder({
    vqIds: vqIds,
    program: 'LAM_KITTING',
    rfqId: 1150091,
    summary: 'approve order — Coilcraft direct (4 parts) for RFQ 1140676',
    approvalText: copyText,
    message: 'LAM Kitting rebuy - Coilcraft direct order',
  });

  console.log('R_Request:', result.documentNo);
  console.log('ID:', result.id);
}

main().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
