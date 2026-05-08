/**
 * One-off loader: Masline PO 304068 → RFQ + VQ (Taxan consignment) + CQ
 *
 * Precedent: RFQ 1131454 / VQ 1994832 / CQ 1262849 / SO506499 (March 2026)
 * Taxan consignment = 55% Taxan / 45% Astute. Resale $9.00 → cost $4.95.
 */

require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });

const { writeRFQ } = require('../../../shared/rfq-writer');
const { writeCQ } = require('../../../shared/cq-writer');
const { apiPost } = require('../../../shared/api-client');

const MPN = 'B20NJ50RE-B';
const MFR_TEXT = 'Ohmite';
const QTY = 100;
const RESALE = 9.00;
const COST = 4.95; // 55% of resale (Taxan consignment split)
const DATE_CODE = '2013';

(async () => {
  // ─── 1. RFQ ────────────────────────────────────────────────────────────────
  console.log('\n=== Step 1: Writing RFQ ===');
  const rfqResult = await writeRFQ({
    bpartnerId: 1002213,           // Masline Electronics Inc
    type: 'Stock',
    salesrepId: 1000004,           // Jake Harris
    userId: 1006322,               // John Rodriguez (matching March precedent)
    description: 'Masline PO 304068 — per Jake 4/22 email',
    lines: [{
      mpn: MPN,
      mfrText: MFR_TEXT,
      qty: QTY,
      targetPrice: RESALE,
      cpc: MPN,
      description: 'Vitreous Enamel Power Resistor 20W 50 ohm 5% Axial',
      dateCode: DATE_CODE,
    }],
  });

  console.log(JSON.stringify(rfqResult, null, 2));
  if (!rfqResult.rfqId || rfqResult.errors?.length) {
    console.error('RFQ write failed — aborting');
    process.exit(1);
  }

  const rfqId = rfqResult.rfqId;
  const rfqSearchKey = rfqResult.searchKey;

  // Fetch the line ID we just created (needed for VQ link)
  const { psqlQuery } = require('../../../shared/db-helpers');
  const lineIdRaw = psqlQuery(
    `SELECT chuboe_rfq_line_id FROM adempiere.chuboe_rfq_line WHERE chuboe_rfq_id = ${rfqId} AND isactive='Y' ORDER BY line ASC LIMIT 1`
  );
  const rfqLineId = parseInt(lineIdRaw);
  if (!rfqLineId) {
    console.error('Could not resolve chuboe_rfq_line_id — aborting');
    process.exit(1);
  }
  console.log(`RFQ search key ${rfqSearchKey} (id ${rfqId}), line id ${rfqLineId}`);

  // ─── 2. VQ (Taxan consignment buy-back) ───────────────────────────────────
  console.log('\n=== Step 2: Writing VQ to Taxan Excess ===');
  const vqPayload = {
    Chuboe_RFQ_ID: rfqId,
    Chuboe_RFQ_Line_ID: rfqLineId,
    Chuboe_MPN: MPN,
    Chuboe_MFR_Text: MFR_TEXT,            // skip MFR_ID — Ohmite is system-level (ad_client_id=0)
    C_BPartner_ID: 1003621,               // Astute Electronics - Taxan Excess
    Qty: QTY,
    Cost: COST,
    Chuboe_Date_Code: DATE_CODE,
    C_UOM_ID: 100,                        // Each
    C_Country_ID: 1000001,                // PENDING
    C_Currency_ID: 100,                   // USD
    Chuboe_RoHS: 'Y',
    Chuboe_Traceability_ID: 1000003,      // Non-Traceable
    Chuboe_Lead_Time: 'STOCK',
    Chuboe_Packaging_ID: 1000008,
    Chuboe_Warehouse_ID: 1000004,
    Chuboe_Inco_Term_ID: 1000000,
    M_Shipper_ID: 1000043,
    Chuboe_VendorType_ID: 1000013,
    Chuboe_Warehouse_Group_ID: 1000000,
    Description: `Taxan consignment buy-back (55/45 split) for Masline PO 304068. Cost = 55% × $${RESALE.toFixed(2)} resale = $${COST.toFixed(2)}.`,
  };
  const vq = await apiPost('chuboe_vq_line', vqPayload);
  console.log(`VQ created: chuboe_vq_line_id=${vq.id}`);

  // ─── 3. CQ (Customer quote to Masline) ────────────────────────────────────
  console.log('\n=== Step 3: Writing CQ to Masline ===');
  const cqResult = await writeCQ(rfqSearchKey, {
    mpn: MPN,
    cpc: MPN,
    mfrText: MFR_TEXT,
    qty: QTY,
    resale: RESALE,
    dateCode: DATE_CODE,
    leadTime: 'STOCK',
    rohs: 'Y',
  });
  console.log(JSON.stringify(cqResult, null, 2));

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log(`RFQ: ${rfqSearchKey} (id ${rfqId}) — 100 pcs ${MPN} @ $${RESALE} target`);
  console.log(`VQ:  ${vq.id} — Taxan Excess, $${COST} cost (55%)`);
  console.log(`CQ:  ${cqResult.written?.[0]?.cqLineId || '?'} — Masline, $${RESALE} resale`);
  console.log(`Margin: ${((RESALE - COST) / RESALE * 100).toFixed(1)}% | GP: $${((RESALE - COST) * QTY).toFixed(2)}`);
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
