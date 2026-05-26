/**
 * oneoffs/backfill-nobids-uid8655-2026-05-26.js
 *
 * Backfill the 14 no-bid VQs that UID 8655 (Ivy, "ADI Shortage Quotation",
 * 5/25) dropped as WRITE_FAILED. The email's ADUM4402CRWZ block was 7 vendors
 * all replying "NO STK". Those are genuine no-bids (qty 0 / cost 0) that should
 * be captured as the "we asked, no" signal. ADUM4402CRWZ is a line on BOTH RFQ
 * 1135455 (Plexus) and 1133119, so 7 vendors x 2 RFQs = 14 no-bid VQs.
 *
 * Doubles as the validation test for the load-bulk-summary.js no-bid fix.
 *
 * Usage:
 *   node oneoffs/backfill-nobids-uid8655-2026-05-26.js            # DRY RUN
 *   node oneoffs/backfill-nobids-uid8655-2026-05-26.js --commit   # live write
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { loadBulkSummary } = require('../shared/load-bulk-summary');

const COMMIT = process.argv.includes('--commit');
const BUYER_ID = 1011012;
const RFQS = ['1135455', '1133119'];

// 7 vendors that replied "NO STK" on ADUM4402CRWZ (search keys from the
// original UID 8655 writer-attribution rows).
const VENDORS = [
  { vendorName: 'HAOXIN',   vendorSearchKey: '1006032' },
  { vendorName: 'KEMING',   vendorSearchKey: '1002317' },
  { vendorName: 'ACTION',   vendorSearchKey: '1003464' },
  { vendorName: 'GUIYU',    vendorSearchKey: '1003866' },
  { vendorName: 'FIXCHIPS', vendorSearchKey: '1002391' },
  { vendorName: 'FIRSTTOP', vendorSearchKey: '1005255' },
  { vendorName: 'Smartel',  vendorSearchKey: '1006857' },
];

function quotesFor() {
  return VENDORS.map(v => ({
    mpn: 'ADUM4402CRWZ',
    mfr: 'Analog Devices',
    qty: 0,
    cost: 0,
    leadTime: '',
    vendorNotes: 'NO STK',
    vendorName: v.vendorName,
    vendorSearchKey: v.vendorSearchKey,
  }));
}

(async () => {
  console.log(`\n=== No-bid backfill for UID 8655 ${COMMIT ? '(LIVE COMMIT)' : '(DRY RUN)'} ===\n`);
  for (const rfq of RFQS) {
    const res = await loadBulkSummary({
      rfqSearchKey: rfq,
      buyerId: BUYER_ID,
      quotes: quotesFor(),
      dryRun: !COMMIT,
    });
    const nb = res.written.filter(w => w.noBid).length;
    console.log(`RFQ ${rfq}: written=${res.written.length} (no-bid=${nb}) skipped=${res.skipped.length} failed=${res.failed.length}`);
    if (res.failed.length) console.log('  FAILED:', JSON.stringify(res.failed, null, 2));
    if (res.skipped.length) console.log('  SKIPPED:', res.skipped.map(s => `${s.vendorName}:${s.reason}`).join(', '));
    for (const w of res.written) {
      console.log(`  written line ${w.line} ${w.mpn} ${w.vendor} cost=${w.cost} qty=${w.qty} noBid=${!!w.noBid} vqLineId=${w.vqLineId || '(dry)'}`);
    }
  }
  console.log('\n=== done ===');
})().catch(e => { console.error('ERR', e); process.exit(1); });
