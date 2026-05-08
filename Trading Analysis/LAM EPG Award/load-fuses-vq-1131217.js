/**
 * Load Fuses Unlimited VQ for BK/1A1119-10-R against RFQ 1131217 (previous LAM RFQ).
 * Data capture only — Jake will source from Master next on 1132040.
 *
 * Quote: Fuses Unlimited #1633615 dated 2026-03-27 (same quote as the 4 VQs loaded
 * to 1132040 — vq_line_ids 2004665, 2004668, 2004670, 2004674).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { writeVQFromAPI } = require('../../shared/vq-writer');

const RFQ = '1131217';
const BUYER_ID = 1000004; // Jake Harris
const FUSES_BP_SEARCH_KEY = '1003109';

const LINE = {
  cpc:        '670-A39955-001',
  rfqMpn:     '1A1119-10-R',          // matches chuboe_rfq_line_mpn #5178885 on 1131217
  catalogMpn: 'BK/1A1119-10-R',
  mfr:        'Eaton',
  qty:        850,
  cost:       0.3274,
};

async function main() {
  const note = `${LINE.catalogMpn} part number accepted`;

  const franchiseResults = {
    distributors: [{
      found: true,
      name: 'Fuses Unlimited',
      bpValue: FUSES_BP_SEARCH_KEY,
      vqMpn: LINE.rfqMpn,
      vqManufacturer: LINE.mfr,
      franchiseRfqPrice: LINE.cost,
      vqPrice: LINE.cost,
      franchiseQty: LINE.qty,
      vqLeadTime: 'stock',
      vqVendorNotes: note,
    }],
  };

  console.log(`[fuses-1131217] ${LINE.cpc} ${LINE.rfqMpn}  qty=${LINE.qty}  cost=$${LINE.cost}  note="${note}"`);

  const r = await writeVQFromAPI(RFQ, LINE.cpc, franchiseResults, {
    searchedMpn: LINE.rfqMpn,
    buyerId: BUYER_ID,
  });

  for (const w of r.written) console.log(`  ✓ vq_line_id=${w.vqLineId}  mfr_id=${w.mfrId || '(text-only)'}`);
  for (const f of r.flagged) console.log(`  ⚠ FLAGGED: ${f.reason} — ${f.detail}`);
  for (const f of r.failed)  console.log(`  ✗ FAILED: ${f.reason} — ${f.detail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
