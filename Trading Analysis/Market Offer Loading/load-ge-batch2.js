/**
 * GE Aerospace Rev-Share Batch 2 — One-off Loader
 *
 * Purpose: Load Astute Rev Share Part 2.xlsx (BOM sheet) into a single
 * chuboe_offer record (Customer Excess type) for GE Aerospace. Second
 * full-batch use of writeOffer() in production — first one to exercise
 * MFR resolution + price + CPC fields all together.
 *
 * Source: excess inbox email 431 — "FW: Items for rev share"
 * Sender: Patrick.Bade@geaerospace.com
 *
 * File shape:
 *   Sheet "BOM" — 1028 data rows
 *   Header row at index 1: ["Assembly","Component","MPN","MFG'er","Component Description",
 *                            "Qty Per","On Hand ","On Order ","E&O ","Unit Price","Total","Where used "]
 *   Cols of interest:
 *     Component (1) → CPC (GE's internal item code)
 *     MPN (2) → MPN
 *     MFG'er (3) → MFR text (often a distributor — needs filtering)
 *     Component Description (4) → description
 *     E&O (8) → offered qty
 *     Unit Price (9) → price
 *
 * Pre-load cleanup:
 *   - Skip rows with null/empty MPN (~675 sub-component rows in BOMs)
 *   - Dedupe by MPN — same component appears in multiple assemblies
 *   - Sum E&O on the 3 MPNs with mismatched qty across rows (per-assembly
 *     allocations that should be aggregated for the broker view)
 *   - Filter known distributor names from the MFR field (GE put distributors
 *     like ARROW, AVNET, TTI, FUTURE in the MFG'er column for many lines —
 *     these should be empty, not corrupting OT with distributor-as-mfr)
 *   - Skip rows with E&O qty = 0 (nothing to offer)
 *
 * Net expected: ~256 unique MPNs, $714k book value, all with full field data.
 *
 * Usage:
 *   node load-ge-batch2.js                  # full run
 *   node load-ge-batch2.js --dry-run        # extract only, do not write
 *   node load-ge-batch2.js --limit 1        # smoke test (first line only)
 */

const XLSX = require('xlsx');
const path = require('path');
const { writeOffer } = require('/home/analytics_user/workspace/astute-workinstructions/shared/offer-writeback');

const SOURCE_FILE = '/home/analytics_user/workspace/excess-downloads/Astute Rev Share Part 2.xlsx';
const SHEET_NAME = 'BOM';
const PARTNER_BPID = 1000062;          // GE Aerospace c_bpartner_id (same as Batch 1)
const OFFER_TYPE = 'Customer Excess';
const DESCRIPTION = '04.08.2026-GE_Aerospace_RevShare_B2';

// Distributor names that GE put in the MFR column. These should be filtered
// out at extraction time — distributors are not manufacturers, and writing
// them as mfrText corrupts downstream MFR resolution.
const KNOWN_DISTRIBUTORS = new Set([
  'ARROW ELECTRONICS', 'ARROW',
  'AVNET',
  'TTI', 'TTI INC', 'TTI INC.',
  'FUTURE ELECTRONICS', 'FUTURE',
  'BISCO INDUSTRIES', 'BISCO',
  'POWELL ELECTRONICS', 'POWELL',
  'CALUMET', 'CALUMET ELECTRONICS',
  'BANNER METALCRAFT', 'BANNER',
  'HARDWARE SPECIALTY', 'HARDWARE SPECIALTY CO',
  'SERVTRONICS', 'SERVTRONICS, AN ENDRIES', 'SERVTRONICS AN ENDRIES',
  'MC DAVIS COMPANY', 'MCDAVIS COMPANY',
  'EMPIRE PLASTICS',
  'EPEC',
  'FTG CIRCUITS', 'FTG CHATSWORTH', 'FTG',
  'UNICORP',
]);

function isDistributor(mfr) {
  if (!mfr) return false;
  return KNOWN_DISTRIBUTORS.has(String(mfr).trim().toUpperCase());
}

function extractLines() {
  const wb = XLSX.readFile(SOURCE_FILE);
  if (!wb.Sheets[SHEET_NAME]) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
  }
  const sheet = wb.Sheets[SHEET_NAME];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Verify headers (header row at index 1, data starts at index 2)
  const HEADER_ROW = 1;
  const headers = (rows[HEADER_ROW] || []).map(h => (h == null ? '' : String(h).trim()));
  const EXPECTED = ['Assembly', 'Component', 'MPN', "MFG'er", 'Component Description',
                    'Qty Per', 'On Hand', 'On Order', 'E&O', 'Unit Price', 'Total', 'Where used'];
  for (let i = 0; i < EXPECTED.length; i++) {
    if (headers[i] !== EXPECTED[i]) {
      throw new Error(`Header mismatch at col ${i}: expected "${EXPECTED[i]}", got "${headers[i]}"`);
    }
  }

  const COMP = 1, MPN = 2, MFR = 3, DESC = 4, EO = 8, PRICE = 9;

  // Aggregate by MPN
  const byMpn = new Map();
  let nullMpn = 0;
  let distFiltered = 0;

  for (let i = HEADER_ROW + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const mpn = row[MPN] != null ? String(row[MPN]).trim() : '';
    if (!mpn) { nullMpn++; continue; }

    const cpcRaw = row[COMP] != null ? String(row[COMP]).trim() : '';
    const mfrRaw = row[MFR] != null ? String(row[MFR]).trim() : '';
    const desc   = row[DESC] != null ? String(row[DESC]).trim() : '';
    const eo     = row[EO];
    const price  = row[PRICE];

    // Filter distributors from MFR field
    let mfrText = '';
    if (mfrRaw && !isDistributor(mfrRaw)) {
      mfrText = mfrRaw;
    } else if (mfrRaw) {
      distFiltered++;
      // mfrText stays empty
    }

    if (!byMpn.has(mpn)) {
      byMpn.set(mpn, {
        mpn,
        cpc: cpcRaw,
        mfrText,
        description: desc,
        qty: Number(eo) || 0,
        price: Number(price) || null,
      });
    } else {
      const existing = byMpn.get(mpn);
      // Sum E&O on duplicate MPNs (per-assembly allocations)
      const existingEo = existing.qty;
      const newEo = Number(eo) || 0;
      if (existingEo !== newEo && newEo > 0) {
        existing.qty = existingEo + newEo;
      }
      // Prefer non-empty mfrText if existing is empty
      if (!existing.mfrText && mfrText) existing.mfrText = mfrText;
    }
  }

  // Drop zero-qty entries
  const lines = [];
  let zeroQty = 0;
  for (const v of byMpn.values()) {
    if (v.qty > 0) lines.push(v);
    else zeroQty++;
  }

  return {
    lines,
    stats: {
      totalDataRows: rows.length - HEADER_ROW - 1,
      nullMpn,
      uniqueMpns: byMpn.size,
      distFiltered,
      zeroQty,
      loaded: lines.length,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

  console.log('=== GE Aerospace Rev-Share Batch 2 Loader ===');
  console.log(`Source: ${SOURCE_FILE}`);
  console.log(`Sheet:  ${SHEET_NAME}`);
  console.log(`Partner: GE Aerospace (BP=${PARTNER_BPID})`);
  console.log(`Offer type: ${OFFER_TYPE}`);
  console.log(`Description: ${DESCRIPTION}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : limit ? `LIMIT ${limit}` : 'FULL'}`);
  console.log('');

  const { lines, stats } = extractLines();
  console.log('Extraction stats:');
  console.log(`  Total BOM data rows:        ${stats.totalDataRows}`);
  console.log(`  Rows with null MPN:         ${stats.nullMpn}`);
  console.log(`  Unique MPNs:                ${stats.uniqueMpns}`);
  console.log(`  Distributor MFRs filtered:  ${stats.distFiltered}`);
  console.log(`  Zero-qty MPNs dropped:      ${stats.zeroQty}`);
  console.log(`  → Loadable lines:           ${stats.loaded}`);
  console.log('');

  // Coverage report
  const withMfr = lines.filter(l => l.mfrText).length;
  const withPrice = lines.filter(l => l.price != null).length;
  const withCpc = lines.filter(l => l.cpc).length;
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const totalValue = lines.reduce((s, l) => s + (l.qty * (l.price || 0)), 0);
  console.log('Field coverage:');
  console.log(`  With MFR text: ${withMfr} / ${lines.length}  (${(withMfr/lines.length*100).toFixed(1)}%)`);
  console.log(`  With price:    ${withPrice} / ${lines.length}  (${(withPrice/lines.length*100).toFixed(1)}%)`);
  console.log(`  With CPC:      ${withCpc} / ${lines.length}  (${(withCpc/lines.length*100).toFixed(1)}%)`);
  console.log(`  Total qty:     ${totalQty.toLocaleString()}`);
  console.log(`  Total value:   $${totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
  console.log('');

  // First few + last samples
  console.log('First 3 extracted:');
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    console.log(`  [${i}]`, JSON.stringify(lines[i]));
  }
  console.log('');

  if (dryRun) {
    console.log('DRY RUN — exiting before write.');
    return;
  }

  const linesToWrite = limit ? lines.slice(0, limit) : lines;
  const desc = limit ? DESCRIPTION + '_SMOKETEST' : DESCRIPTION;

  console.log(`Writing ${linesToWrite.length} lines to OT (this will take ~${Math.ceil(linesToWrite.length * 0.2)}s)...`);
  const startMs = Date.now();
  let result;
  try {
    result = await writeOffer({
      bpartnerId: PARTNER_BPID,
      offerTypeId: OFFER_TYPE,
      description: desc,
      writeMpnRecords: true,
      lines: linesToWrite,
    });
  } catch (err) {
    console.error('FATAL: writeOffer threw');
    console.error(err.stack || err.message || err);
    process.exit(1);
  }
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log('');
  console.log('=== RESULT ===');
  console.log(`Offer search key:  ${result.searchKey}`);
  console.log(`chuboe_offer_id:   ${result.offerId}`);
  console.log(`Lines written:     ${result.linesWritten} / ${linesToWrite.length}`);
  console.log(`MPN records:       ${result.mpnsWritten} / ${linesToWrite.length}`);
  console.log(`Errors:            ${result.errors.length}`);
  console.log(`Elapsed:           ${elapsedSec}s`);
  console.log('');

  if (result.errors.length > 0) {
    console.log('=== ERRORS (first 20) ===');
    for (const e of result.errors.slice(0, 20)) {
      console.log(`  - ${e}`);
    }
    if (result.errors.length > 20) {
      console.log(`  ...and ${result.errors.length - 20} more`);
    }
  }

  const allClean =
    result.offerId != null &&
    result.linesWritten === linesToWrite.length &&
    result.mpnsWritten === linesToWrite.length &&
    result.errors.length === 0;

  if (allClean) {
    console.log(`✓ ${limit ? 'SMOKE TEST' : 'BATCH 2 WRITE'} CLEAN`);
    console.log(`  OT search key: ${result.searchKey}`);
  } else {
    console.log('⚠ PARTIAL — review errors above before proceeding.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('UNHANDLED:', err);
  process.exit(2);
});
