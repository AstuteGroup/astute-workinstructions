/**
 * Tick + post approve-order R_Requests for the 3 DC-24+ winners on RFQ 1133067.
 *
 *   Line  60  LTM8074EY#PBF   DQ      $5.88   80pcs   DC 24+
 *   Line  70  MAX16029TG+     Smartel $6.40   75pcs   DC 24+ (alt: MAX16029TG+T = T&R variant of canonical)
 *   Line 130  AD9467BCPZ-250  XJH     $113.95 100pcs  DC 25+
 *
 * Line 120 LMZ14202TZ-ADJ/NOPB dropped — only DC 24+ option is the LMZ14202TZX
 * alt (different module variant, AVL needed). Canonical TZ has no 24+ in batch.
 *
 * Each VQ gets:
 *   - PATCH ship-to defaults (W111 / Brownsville / FedEx Ground / EXW)
 *   - PATCH lead time + promise (STOCK / +10 days, or "STOCK - 1 WEEK" for DQ)
 *   - PATCH packaging per historical LAM ticks (F-REEL or OTHER)
 *   - PATCH Qty=LAM MOQ, IsChuboeDomesticShipping='N' (HK suppliers → Brownsville)
 *   - tickVQForPurchase → validator runs, auto-unticks competitors, sets IsPurchased=Y
 *   - postApproveOrder → submits R_Request to Jake (1000004), Submitted status
 *
 * Approval text uses the short-line shorthand fallback (per shared/r-requests.md
 * § "Short single-line shorthand"), same pattern as lam-kitting-rfq-writer.js
 * auto-purchase flow. Buyer didn't paste OT Copy Text — this is a broker-batch
 * tick analogous to the franchise auto-purchase path.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { tickVQForPurchase } = require('../../../../shared/vq-patcher');
const { postApproveOrder } = require('../../../../shared/r-request-writer');

const RFQ_ID = 1142482;        // chuboe_rfq_id (search_key 1133067)
const RFQ_SEARCH_KEY = '1133067';

// 10 days out per modal LAM Kitting STOCK pattern (39 ticks @ 10-day promise).
const PROMISE_DATE = '2026-05-09';

const WINNERS = [
  {
    vqId: 2140913, line: 60, mpn: 'LTM8074EY#PBF', mfr: 'Analog Devices',
    vendor: 'Hong Kong Duan Que Electronics Co., Limited', vendorShort: 'DQ',
    cost: 5.88, qty: 80, dc: '24+', leadTime: 'STOCK - 1 WEEK',  // 3-5 days quoted
    packagingId: 1000001, packagingName: 'F-REEL',
    lamResale: 9.71975487804878, lamMoq: 80,
    margin: 0.395,
  },
  {
    vqId: 2140922, line: 70, mpn: 'MAX16029TG+', mfr: 'Maxim Integrated',
    vendor: 'SMARTEL ELECTRONICS (ASIA) CO LTD', vendorShort: 'Smartel',
    cost: 6.40, qty: 75, dc: '24+', leadTime: 'STOCK',
    packagingId: 1000001, packagingName: 'F-REEL',
    lamResale: 8.925226829268293, lamMoq: 75,
    margin: 0.283,
    altMpn: 'MAX16029TG+T',  // T&R variant of canonical
  },
  {
    vqId: 2140932, line: 130, mpn: 'AD9467BCPZ-250', mfr: 'Analog Devices',
    vendor: 'Xin Jun Hong (HK) Industry Co., Ltd', vendorShort: 'XJH',
    cost: 113.95, qty: 100, dc: '25+', leadTime: 'STOCK',
    packagingId: 1000010, packagingName: 'OTHER',  // historical LAM tick used OTHER
    lamResale: 263.99063414634145, lamMoq: 100,
    margin: 0.568,
    coo: 'Philippines',
  },
];

(async () => {
  const results = [];
  for (const w of WINNERS) {
    console.log(`\n── Line ${w.line} | VQ ${w.vqId} | ${w.mpn} → ${w.vendor} @ $${w.cost} ──`);

    // PATCH gaps + tick. Validator runs after extras applied.
    const tickExtras = {
      Qty:                       w.lamMoq,
      Chuboe_Lead_Time:          w.leadTime,
      DatePromised:              PROMISE_DATE,
      Chuboe_Packaging_ID:       w.packagingId,
      Chuboe_Warehouse_ID:       1000015,   // W111 LAM KITTING
      Chuboe_Warehouse_Group_ID: 1000008,   // BROWNSVILLE
      M_Shipper_ID:              1000003,   // FedEx Ground
      Chuboe_Inco_Term_ID:       1000000,   // EXW
      IsChuboeDomesticShipping:  'N',       // HK supplier → US ship-to = international
    };

    let tickResult;
    try {
      tickResult = await tickVQForPurchase(w.vqId, {
        program: 'LAM_KITTING',
        extra: tickExtras,
      });
      console.log(`  ✓ ticked. Unticked competitors: ${tickResult.untickedCompeting.join(', ') || '(none)'}`);
    } catch (err) {
      console.error(`  ✗ tick failed: ${err.message}`);
      if (err.violations) err.violations.forEach(v => console.error(`      - ${v}`));
      results.push({ ...w, error: err.message });
      continue;
    }

    // Build approval text (short-line shorthand fallback per r-requests.md).
    const altTag = w.altMpn ? ` (alt MPN: ${w.altMpn})` : '';
    const approvalText =
      `Line ${w.line}  ${w.mpn}${altTag}  ${w.lamMoq}pcs @ $${w.cost.toFixed(4)}  DC ${w.dc}  ${w.mfr}\n` +
      `Vendor: ${w.vendor}\n` +
      `Ship-To: BROWNSVILLE (W111 LAM Kitting) · Shipper: FedEx Ground · Inco Term: EXW · Packaging: ${w.packagingName} · Lead Time: ${w.leadTime} · Promise: ${PROMISE_DATE}`;

    const message =
      `APAC broker batch — RFQ ${RFQ_SEARCH_KEY} (Tracy Xie summary 2026-04-29). ` +
      `Best DC-24+ quote on this line. Margin ${(w.margin * 100).toFixed(1)}% over LAM resale $${w.lamResale.toFixed(4)} at LAM MOQ ${w.lamMoq}.` +
      (w.altMpn ? ` Note: vendor quoted ${w.altMpn} which is the T&R packaging variant of canonical ${w.mpn} — same product, reel.` : '');

    try {
      const r = await postApproveOrder({
        vqId:          w.vqId,
        program:       'LAM_KITTING',
        rfqId:         RFQ_ID,
        summary:       `approve order — ${w.vendorShort} ${w.mpn} (LAM Kitting)`,
        approvalText,
        message,
        priority:      '5',
      });
      console.log(`  ✓ R_Request ${r.documentNo} (id ${r.id})`);
      results.push({ ...w, vqTicked: true, rRequestId: r.id, rRequestDocNo: r.documentNo, untickedCompeting: tickResult.untickedCompeting });
    } catch (err) {
      console.error(`  ✗ R_Request POST failed: ${err.message}`);
      results.push({ ...w, vqTicked: true, rRequestError: err.message });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    if (r.error) {
      console.log(`  Line ${r.line} ${r.mpn}: TICK FAILED — ${r.error}`);
    } else if (r.rRequestError) {
      console.log(`  Line ${r.line} ${r.mpn}: VQ ticked but R_Request FAILED — ${r.rRequestError}`);
    } else {
      console.log(`  Line ${r.line} ${r.mpn}: VQ ${r.vqId} ticked ✓ | R_Request ${r.rRequestDocNo} (id ${r.rRequestId}) ✓`);
    }
  }

  // Persist for the email step.
  const fs = require('fs');
  const trackerPath = path.join(__dirname, '2026-04-29-tick-approve-1133067.json');
  fs.writeFileSync(trackerPath, JSON.stringify({ rfqSearchKey: RFQ_SEARCH_KEY, runAt: new Date().toISOString(), promiseDate: PROMISE_DATE, results }, null, 2));
  console.log(`\nWrote ${trackerPath}`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
