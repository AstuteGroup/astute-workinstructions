/**
 * Re-post approve-order R_Requests for the 3 DC-24+ winners on RFQ 1133067
 * after Jake closed the original 3 (1158559 / 1158560 / 1158561).
 *
 * Change vs original: ship-to flips from BROWNSVILLE → HONG KONG (W111
 * stays as the program warehouse — Jake's call). Parts will arrive at the
 * HK warehouse from the APAC brokers, then internal-transfer to BTX for
 * kitting consumption.
 *
 * Field deltas:
 *   Chuboe_Warehouse_ID         1000015 (W111 LAM KITTING)         — unchanged
 *   Chuboe_Warehouse_Group_ID   1000008 (BROWNSVILLE) → 1000001 (HONG KONG)
 *   M_Shipper_ID                1000003 (FedEx Ground) → 1000045 (Courier/Local Delivery)
 *   Chuboe_Inco_Term_ID         1000000 (EXW)                      — unchanged
 *   IsChuboeDomesticShipping    'N' → 'Y'  (HK supplier → HK warehouse, same country)
 *
 * Validator: program = null to bypass the LAM_KITTING program-default check
 * (which expects W111+BROWNSVILLE+FedEx Ground). All other gates still run:
 * DC, lead time, promise, packaging, traceability, public-note sanity,
 * competing-tick check. VQs are still ticked from the prior run.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { patchRecord } = require('../../../../shared/record-updater');
const { postApproveOrder } = require('../../../../shared/r-request-writer');

const RFQ_ID = 1142482;
const RFQ_SEARCH_KEY = '1133067';
const PROMISE_DATE = '2026-05-09';

const WINNERS = [
  {
    vqId: 2140913, line: 60, mpn: 'LTM8074EY#PBF', mfr: 'Analog Devices',
    vendor: 'Hong Kong Duan Que Electronics Co., Limited', vendorShort: 'DQ',
    cost: 5.88, qty: 80, dc: '24+', leadTime: 'STOCK - 1 WEEK',
    packagingName: 'F-REEL',
    lamResale: 9.71975487804878, lamMoq: 80, margin: 0.395,
  },
  {
    vqId: 2140922, line: 70, mpn: 'MAX16029TG+', mfr: 'Maxim Integrated',
    vendor: 'SMARTEL ELECTRONICS (ASIA) CO LTD', vendorShort: 'Smartel',
    cost: 6.40, qty: 75, dc: '24+', leadTime: 'STOCK',
    packagingName: 'F-REEL',
    lamResale: 8.925226829268293, lamMoq: 75, margin: 0.283,
    altMpn: 'MAX16029TG+T',
  },
  {
    vqId: 2140932, line: 130, mpn: 'AD9467BCPZ-250', mfr: 'Analog Devices',
    vendor: 'Xin Jun Hong (HK) Industry Co., Ltd', vendorShort: 'XJH',
    cost: 113.95, qty: 100, dc: '25+', leadTime: 'STOCK',
    packagingName: 'OTHER',
    lamResale: 263.99063414634145, lamMoq: 100, margin: 0.568,
  },
];

const HK_PATCH = {
  Chuboe_Warehouse_Group_ID: 1000001,   // HONG KONG (was 1000008 BROWNSVILLE)
  M_Shipper_ID:              1000045,   // Courier/Local Delivery (was 1000003 FedEx Ground)
  IsChuboeDomesticShipping:  'Y',       // HK → HK domestic
};

(async () => {
  const results = [];
  for (const w of WINNERS) {
    console.log(`\n── Line ${w.line} | VQ ${w.vqId} | ${w.mpn} → ${w.vendor} ──`);

    // PATCH the ship-to fields. VQ is already ticked, so this is a pure update.
    try {
      await patchRecord('chuboe_vq_line', w.vqId, HK_PATCH);
      console.log(`  ✓ ship-to PATCHed → HK / Courier / domestic=Y`);
    } catch (err) {
      console.error(`  ✗ PATCH failed: ${err.message}`);
      results.push({ ...w, error: `PATCH failed: ${err.message}` });
      continue;
    }

    // Build approval text with HK ship-to + BTX transfer note.
    const altTag = w.altMpn ? ` (alt MPN: ${w.altMpn})` : '';
    const approvalText =
      `Line ${w.line}  ${w.mpn}${altTag}  ${w.lamMoq}pcs @ $${w.cost.toFixed(4)}  DC ${w.dc}  ${w.mfr}\n` +
      `Vendor: ${w.vendor}\n` +
      `Ship-To: HONG KONG (W111 LAM Kitting) · Shipper: Courier/Local Delivery · Inco Term: EXW · Packaging: ${w.packagingName} · Lead Time: ${w.leadTime} · Promise: ${PROMISE_DATE}\n` +
      `APAC supplier ships to HK; internal transfer to BTX for kitting consumption.`;

    const message =
      `APAC broker batch — RFQ ${RFQ_SEARCH_KEY} (Tracy Xie summary 2026-04-29). ` +
      `Best DC-24+ quote on this line. Margin ${(w.margin * 100).toFixed(1)}% over LAM resale $${w.lamResale.toFixed(4)} at LAM MOQ ${w.lamMoq}. ` +
      `Ship-to is HK (W111 LAM Kitting); parts will be internally transferred to BTX after receipt.` +
      (w.altMpn ? ` Note: vendor quoted ${w.altMpn} which is the T&R packaging variant of canonical ${w.mpn} — same product, reel.` : '');

    try {
      // program = null → skips the LAM_KITTING program-default ship-to check
      // (warehouse_group=1000001 HK and shipper=1000045 Courier don't match
      // LAM_KITTING's expected 1000008 BROWNSVILLE / 1000003 FedEx Ground).
      // All other validator gates still run.
      const r = await postApproveOrder({
        vqId:          w.vqId,
        program:       null,
        rfqId:         RFQ_ID,
        summary:       `approve order — ${w.vendorShort} ${w.mpn} (LAM Kitting, ship to HK)`,
        approvalText,
        message,
        priority:      '5',
      });
      console.log(`  ✓ R_Request ${r.documentNo} (id ${r.id})`);
      results.push({ ...w, rRequestId: r.id, rRequestDocNo: r.documentNo });
    } catch (err) {
      console.error(`  ✗ R_Request POST failed: ${err.message}`);
      if (err.violations) err.violations.forEach(v => console.error(`      - ${v}`));
      results.push({ ...w, rRequestError: err.message });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    if (r.error || r.rRequestError) {
      console.log(`  Line ${r.line} ${r.mpn}: FAILED — ${r.error || r.rRequestError}`);
    } else {
      console.log(`  Line ${r.line} ${r.mpn}: VQ ${r.vqId} → R_Request ${r.rRequestDocNo} (id ${r.rRequestId})`);
    }
  }

  const fs = require('fs');
  const trackerPath = path.join(__dirname, '2026-04-29-tick-approve-1133067-HK.json');
  fs.writeFileSync(trackerPath, JSON.stringify({ rfqSearchKey: RFQ_SEARCH_KEY, runAt: new Date().toISOString(), supersedes: ['1158559','1158560','1158561'], shipTo: 'HONG KONG', promiseDate: PROMISE_DATE, results }, null, 2));
  console.log(`\nWrote ${trackerPath}`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
