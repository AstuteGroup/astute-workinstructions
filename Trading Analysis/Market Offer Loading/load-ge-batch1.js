/**
 * GE Aerospace Rev-Share Batch 1 — One-off Loader
 *
 * Purpose: Load Astute rev share parts.xlsx into a single chuboe_offer
 * record (Customer Excess type) for GE Aerospace. This is the first
 * full-batch use of writeOffer() in production.
 *
 * Source: excess inbox email 430 — "FW: Items for rev share"
 * Sender: Patrick.Bade@geaerospace.com
 *
 * File shape:
 *   Sheet "Legacy Obsolete " (note trailing space)
 *   Header row at index 1: ["AML", "Description", "No Demand Obsolete"]
 *   Data rows from index 2 onward
 *   Cols: AML = MPN, Description = part description, No Demand Obsolete = qty
 *
 * Notes:
 *   - No MFR column → mfrText left null on every line
 *   - No price column → price left null
 *   - No date code → dateCode left null
 *   - GE-internal MPNs are messy (REV markers, parens, comma-separated
 *     cross-refs). For Batch 1 we accept them as-is — cleanup happens
 *     downstream in Analysis enrichment, not in Loading.
 *
 * One-off because Batch 2's BOM sheet has a totally different shape.
 * Generalize to shared/offer-extractor.js after Batch 2 informs the
 * design.
 */

const XLSX = require('xlsx');
const path = require('path');
const { writeOffer } = require('/home/analytics_user/workspace/astute-workinstructions/shared/offer-writeback');

const SOURCE_FILE = '/home/analytics_user/workspace/excess-downloads/Astute rev share parts.xlsx';
const SHEET_NAME = 'Legacy Obsolete '; // trailing space is intentional
const PARTNER_BPID = 1000062;          // GE Aerospace c_bpartner_id
const OFFER_TYPE = 'Customer Excess';
const DESCRIPTION = '04.08.2026-GE_Aerospace_RevShare_B1';

function extractLines() {
  const wb = XLSX.readFile(SOURCE_FILE);
  if (!wb.Sheets[SHEET_NAME]) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
  }
  const sheet = wb.Sheets[SHEET_NAME];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Header row at index 1, data starts at index 2
  const HEADER_ROW = 1;
  const headers = (rows[HEADER_ROW] || []).map(h => (h == null ? '' : String(h).trim()));

  // Verify expected headers
  const EXPECTED = ['AML', 'Description', 'No Demand Obsolete'];
  for (let i = 0; i < EXPECTED.length; i++) {
    if (headers[i] !== EXPECTED[i]) {
      throw new Error(`Header mismatch at col ${i}: expected "${EXPECTED[i]}", got "${headers[i]}"`);
    }
  }

  const lines = [];
  let skipped = 0;
  for (let i = HEADER_ROW + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const mpn = row[0] != null ? String(row[0]).trim() : '';
    const desc = row[1] != null ? String(row[1]).trim() : '';
    const qty = row[2];

    if (!mpn) {
      skipped++;
      continue;
    }

    const line = { mpn };
    if (desc) line.description = desc;
    if (qty != null && qty !== '') {
      const n = Number(qty);
      if (!isNaN(n) && n > 0) line.qty = n;
    }
    lines.push(line);
  }

  return { lines, skipped, total: rows.length - HEADER_ROW - 1 };
}

async function main() {
  console.log('=== GE Aerospace Rev-Share Batch 1 Loader ===');
  console.log(`Source: ${SOURCE_FILE}`);
  console.log(`Sheet:  "${SHEET_NAME}"`);
  console.log(`Partner: GE Aerospace (BP=${PARTNER_BPID})`);
  console.log(`Offer type: ${OFFER_TYPE}`);
  console.log(`Description: ${DESCRIPTION}`);
  console.log('');

  // Extract
  const { lines, skipped, total } = extractLines();
  console.log(`Extracted ${lines.length} lines from ${total} data rows (${skipped} skipped — no MPN)`);

  // Sample for sanity
  console.log('First 3 lines:');
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    console.log(`  [${i}]`, JSON.stringify(lines[i]));
  }
  console.log(`Last line:`);
  console.log(`  [${lines.length - 1}]`, JSON.stringify(lines[lines.length - 1]));
  console.log('');

  // Coverage stats
  const withQty = lines.filter(l => l.qty != null).length;
  const withDesc = lines.filter(l => l.description).length;
  console.log(`Coverage: ${withQty}/${lines.length} have qty, ${withDesc}/${lines.length} have description`);
  console.log(`(0/${lines.length} have MFR — file has no MFR column)`);
  console.log(`(0/${lines.length} have price — file has no price column)`);
  console.log('');

  // Write
  console.log(`Writing ${lines.length} lines to OT (this will take ~1-2 minutes)...`);
  const startMs = Date.now();
  let result;
  try {
    result = await writeOffer({
      bpartnerId: PARTNER_BPID,
      offerTypeId: OFFER_TYPE,
      description: DESCRIPTION,
      writeMpnRecords: true,
      lines,
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
  console.log(`Lines written:     ${result.linesWritten} / ${lines.length}`);
  console.log(`MPN records:       ${result.mpnsWritten} / ${lines.length}`);
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
    console.log('');
  }

  const allClean =
    result.offerId != null &&
    result.linesWritten === lines.length &&
    result.mpnsWritten === lines.length &&
    result.errors.length === 0;

  if (allClean) {
    console.log('✓ BATCH 1 WRITE CLEAN');
    console.log(`  All ${lines.length} lines + ${lines.length} MPN records written.`);
    console.log(`  OT search key: ${result.searchKey}`);
  } else {
    console.log('⚠ BATCH 1 PARTIAL — review errors above before proceeding to Step 6 (move email).');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('UNHANDLED:', err);
  process.exit(2);
});
