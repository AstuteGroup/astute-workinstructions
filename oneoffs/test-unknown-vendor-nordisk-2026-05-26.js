/**
 * Test: Load Nordisk quotes using unknown vendor exception
 *
 * Context (2026-05-26):
 * - Nordisk vendor doesn't exist as a BP in OT
 * - 2 quotes for LTM4630AEV#PBF stuck in sidecar
 * - Operator requested: "note vendor in VQ notes" instead of creating BP
 *
 * This test demonstrates the new unknownVendorPlaceholderBpId feature that
 * allows loading VQs when the vendor BP doesn't exist by storing the vendor
 * name in the VQ notes field.
 *
 * PREREQUISITES:
 * 1. Create placeholder BP in OT (see instructions in vq-loading.js)
 * 2. Update UNKNOWN_VENDOR_PLACEHOLDER_BP_ID constant with the actual BP ID
 * 3. Verify the placeholder BP exists and is active
 *
 * USAGE:
 *   node oneoffs/test-unknown-vendor-nordisk-2026-05-26.js [--dry-run] [--placeholder-bp-id=XXXXX]
 */

'use strict';

const { loadBulkSummary } = require('../shared/load-bulk-summary');

// Nordisk quotes from sidecar
const NORDISK_QUOTES = [
  {
    vendorName: 'Nordisk',
    mpn: 'LTM4630AEV#PBF',
    mfr: 'Analog Devices',
    qty: 890,
    cost: 35.9,
    dateCode: '20+',
    leadTime: 'stock',
  },
  {
    vendorName: 'Nordisk',
    mpn: 'LTM4630AEV#PBF',
    mfr: 'Analog Devices',
    qty: 1000,
    cost: 40.6,
    dateCode: '21+',
    leadTime: '1 week',
    vendorNotes: 'stock need share',
  },
];

const RFQ_SEARCH_KEY = '1135455';
const BUYER_ID = 1011012;  // Serena Lam (from sidecar)

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const placeholderBpArg = args.find(a => a.startsWith('--placeholder-bp-id='));
  const placeholderBpId = placeholderBpArg
    ? Number(placeholderBpArg.split('=')[1])
    : null;

  if (!placeholderBpId && !dryRun) {
    console.error('ERROR: --placeholder-bp-id=XXXXX required (unless --dry-run)');
    console.error('');
    console.error('Steps to create the placeholder BP:');
    console.error('1. Create a new BP in OT with:');
    console.error('   - Name: "Unknown Vendor - Note in VQ"');
    console.error('   - Search Key: "UNKNOWN-VENDOR-VQ-NOTE"');
    console.error('   - IsVendor: Y, IsCustomer: N');
    console.error('   - Vendor Type: 1000010 (Non-Traceable without Franchised lines)');
    console.error('   - IsActive: Y');
    console.error('2. Note the c_bpartner_id from the created record');
    console.error('3. Run this script with --placeholder-bp-id=<that ID>');
    console.error('');
    console.error('Or run with --dry-run to test without writing:');
    console.error('  node oneoffs/test-unknown-vendor-nordisk-2026-05-26.js --dry-run');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('Loading Nordisk quotes with unknown vendor exception');
  console.log('='.repeat(70));
  console.log('');
  console.log(`RFQ:          ${RFQ_SEARCH_KEY}`);
  console.log(`Buyer:        ${BUYER_ID}`);
  console.log(`Quotes:       ${NORDISK_QUOTES.length}`);
  console.log(`Placeholder:  ${placeholderBpId || '(dry run - not used)'}`);
  console.log(`Dry run:      ${dryRun}`);
  console.log('');

  try {
    const result = await loadBulkSummary({
      rfqSearchKey: RFQ_SEARCH_KEY,
      buyerId: BUYER_ID,
      quotes: NORDISK_QUOTES,
      unknownVendorPlaceholderBpId: placeholderBpId,
      dryRun,
    });

    console.log('RESULT:');
    console.log('-------');
    console.log(`Written:  ${result.written.length} VQs`);
    console.log(`Skipped:  ${result.skipped.length}`);
    console.log(`Failed:   ${result.failed.length}`);
    console.log(`Gaps:     ${result.gaps.length} lines with no VQs`);
    console.log('');

    if (result.written.length > 0) {
      console.log('Written VQs:');
      for (const w of result.written) {
        console.log(`  - VQ ${w.vqLineId}: ${w.mpn} @ $${w.cost} x ${w.qty} (${w.vendor})`);
      }
      console.log('');
      console.log('NOTE: Vendor name "Nordisk" was stored in Chuboe_Note_User');
      console.log('      Check the VQ records in OT to verify.');
    }

    if (result.failed.length > 0) {
      console.log('FAILED:');
      for (const f of result.failed) {
        console.log(`  - ${f.mpn}: ${f.reason} - ${f.detail || f.error}`);
      }
    }

    if (dryRun) {
      console.log('');
      console.log('DRY RUN complete - no data written');
      console.log('Remove --dry-run flag to actually load the VQs');
    } else {
      console.log('');
      console.log('SUCCESS - VQs loaded to OT');
      console.log('');
      console.log('NEXT STEPS:');
      console.log('1. Verify VQs in OT (check notes contain "Vendor: Nordisk")');
      console.log('2. Delete/clear the sidecar files if load was successful:');
      console.log('   - ~/workspace/.vq-loading-pending/DB9PR02MB7020202B1DEBBFC97C34EBB0950B2@DB9PR02MB7020.eurprd02.prod.outlook.com.json');
      console.log('   - ~/workspace/.vq-loading-pending/DB9PR02MB702075859975ED7A644CA39E950B2@DB9PR02MB7020.eurprd02.prod.outlook.com.json');
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error('');
    console.error('Stack trace:');
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
