/**
 * One-off: Bootstrap the "GM Stock" static carryover offer in OT.
 *
 * After running this:
 *   1. Note the resulting offerId (printed) — that's the bootstrapId.
 *   2. Add an entry to STATIC_CARRYOVER_OFFERS in inventory_cleanup.js:
 *        {
 *          label: 'GM Stock',
 *          bootstrapId: <offerId>,
 *          portalWarehouseName: 'Astute Electronics Inc. - GM Stock',
 *        }
 *   3. From next Monday's cron run, the offer auto-refreshes + lines flow into the
 *      weekly Netcomponents Upload CSV.
 *
 * Source: Josh's "GM Inventory" email 4/27, attachment "Ready To Ship - GM GP 11.14.25.xlsx",
 *   tab "1120 Price Update" (19 MPNs, 3,127,500 pcs).
 *
 * Usage:
 *   node bootstrap_gm_carryover.js --dry-run     # preview, no writes
 *   node bootstrap_gm_carryover.js --commit      # live write to OT
 */
const path = require('path');
require('dotenv').config({ path: path.join(process.env.HOME, 'workspace', '.env') });
const { writeOffer } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/offer-writeback'));

const DRY = process.argv.includes('--dry-run');
const COMMIT = process.argv.includes('--commit');
if (!DRY && !COMMIT) {
  console.error('Specify --dry-run or --commit');
  process.exit(1);
}

const lines = [
  { mpn: '74HCT4851PW/S400', mfrText: 'Nexperia', qty: 2500 },
  { mpn: 'BAS321-Q',         mfrText: 'Nexperia', qty: 27000 },
  { mpn: 'BAV70,215',        mfrText: 'Nexperia', qty: 450000 },
  { mpn: 'BC807-25-QR',      mfrText: 'Nexperia', qty: 441000 },
  { mpn: 'BC807-40,215',     mfrText: 'Nexperia', qty: 150000 },
  { mpn: 'BC817-40-Q',       mfrText: 'Nexperia', qty: 20000 },
  { mpn: 'BSS138p,215',      mfrText: 'Nexperia', qty: 9000 },
  { mpn: 'BUK9Y29-40E,115',  mfrText: 'Nexperia', qty: 28500 },
  { mpn: 'BZX384-C15-Q',     mfrText: 'Nexperia', qty: 120000 },
  { mpn: 'BZX585-C5V1',      mfrText: 'Nexperia', qty: 150000 },
  { mpn: 'BZX585-C5V1,115',  mfrText: 'Nexperia', qty: 33000 },
  { mpn: 'NLVVHC1G32DFT2G',  mfrText: 'Onsemi',   qty: 108000 },
  { mpn: 'PDZ9.1B,115',      mfrText: 'Nexperia', qty: 24000 },
  { mpn: 'PMEG4010ETR',      mfrText: 'Nexperia', qty: 63000 },
  { mpn: 'PMEG4010ETR-Q',    mfrText: 'Nexperia', qty: 240000 },
  { mpn: 'PTVS20VS1UR,115',  mfrText: 'Nexperia', qty: 51000 },
  { mpn: 'SBC846BLT1G',      mfrText: 'Onsemi',   qty: 516000 },
  { mpn: 'SBC846BLT3G',      mfrText: 'Onsemi',   qty: 60000 },
  { mpn: 'SZMMBZ18VALT1G',   mfrText: 'Onsemi',   qty: 135000 },
];

const today = new Date().toISOString().slice(0, 10);
const description = `[Carryover] GM Stock — GM stock for sale - see Jake (bootstrapped ${today})`;

const args = {
  bpartnerId: 1000332,        // Astute Electronics Inc
  offerTypeId: 1000008,       // Stock - Austin Warehouse
  description,
  lines,
};

(async () => {
  console.log('=== GM Stock Carryover Bootstrap ===');
  console.log('description:', description);
  console.log('bpartnerId:', args.bpartnerId, '(Astute Electronics Inc)');
  console.log('offerTypeId:', args.offerTypeId, '(Stock - Austin Warehouse)');
  console.log(`lines (${lines.length}):`);
  let totalQty = 0;
  for (const l of lines) {
    console.log(`  ${l.mpn.padEnd(20)} | ${l.mfrText.padEnd(10)} | ${l.qty.toLocaleString().padStart(9)}`);
    totalQty += l.qty;
  }
  console.log(`total qty: ${totalQty.toLocaleString()}`);

  if (DRY) {
    console.log('\n[DRY RUN] No writes performed.');
    return;
  }

  console.log('\n[COMMIT] Writing to OT...');
  const result = await writeOffer(args);
  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));
  if (result.errors && result.errors.length) {
    console.error('\n!! errors:', result.errors);
    process.exit(2);
  }
  if (result.linesWritten !== lines.length) {
    console.error(`\n!! linesWritten ${result.linesWritten} != lines.length ${lines.length}`);
    process.exit(3);
  }
  console.log('\n✓ Bootstrap complete.');
  console.log(`\nNext: register in STATIC_CARRYOVER_OFFERS with bootstrapId=${result.offerId}`);
})().catch(err => { console.error(err); process.exit(1); });
