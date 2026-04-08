/**
 * Sanmina Q2FY26 E&O — One-off Loader
 *
 * Last one-off market offer loader before Phase 3 (AI-driven extraction).
 *
 * Source: excess inbox emails 428 + 429 — "FW: Q2FY26 SANMINA E&O Parts"
 * Sender: Ilce Tejeda / John Gorham @ sanmina.com
 *
 * File shape:
 *   File: Candidates top 02-17-2026 excess plant approved v2.1.xlsx
 *   3 sheets: Sheet1 (summary, skipped), v_excessdashboard_* (main data),
 *             Sell rejected (skipped — customer pulled back)
 *
 * Main sheet columns (header at index 1, data from index 2):
 *   A=Component (Sanmina internal code → CPC)
 *   B=Org Code (Sanmina plant code, e.g., E38, K10 → noted in description)
 *   C=Description (part type, e.g., "FPGA,XC7VX415T-..." → line description)
 *   D=OnHand Quantity (rolled up — informational only, not loaded)
 *   E=Excess (rolled up — informational only)
 *   F=Std Material Cost(USD) (formatted "$ 294.1" → parsed to PriceEntered)
 *   G=Extended value at STD Cost USD (informational)
 *   H=Demand (informational)
 *   I=MPN
 *   J=Clean Manufacturer Name → Chuboe_MFR_Text
 *   K=MPN On Hand (per-row qty → Qty)
 *   L=Date Code (YYWW format → Chuboe_Date_Code)
 *   M=Lot Number → noted in description alongside Org Code
 *
 * Strategy: load every row as a distinct (Date Code, Lot) inventory position.
 * 1991 lines → ~1991 chuboe_offer_lines. Sanmina's data quality is unclear
 * (Σ K doesn't reconcile with D or E for most MPNs) but per the user's
 * directive "needle in a haystack — capture faithfully and analyze, ask for
 * clarification only when we find a real opportunity."
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const XLSX = require('xlsx');
const path = require('path');
const { writeOffer } = require('/home/analytics_user/workspace/astute-workinstructions/shared/offer-writeback');

const SOURCE_FILE = '/home/analytics_user/workspace/excess-downloads/Candidates top 02-17-2026 excess plant approved v2.1.xlsx';
const SHEET_NAME = 'v_excessdashboard_2026012312092';
const PARTNER_BPID = 1000068;          // Sanmina Corporation c_bpartner_id
const OFFER_TYPE = 'Customer Excess';
const DESCRIPTION = '04.08.2026-Sanmina_Q2FY26_E&O';

// Column indices (matched to header row 1)
const COMP=0, ORG=1, DESC=2, ONHAND=3, EXCESS=4, COST=5,
      MPN=8, MFR=9, MPN_OH=10, DATECODE=11, LOT=12;

function parsePrice(s) {
  // Sanmina formats prices as "$ 294.1" with leading dollar sign and possibly spaces
  if (s == null) return null;
  if (typeof s === 'number') return s > 0 ? s : null;
  const cleaned = String(s).replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return (!isNaN(n) && n > 0) ? n : null;
}

function parseQty(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s > 0 ? s : null;
  const cleaned = String(s).replace(/[,\s]/g, '');
  const n = Number(cleaned);
  return (!isNaN(n) && n > 0) ? n : null;
}

function buildLineDescription(row) {
  // Sanmina-specific: include Org code and Lot in the line description so
  // those signals survive into OT. Format: "Org=K10 | Lot=TMP225YP294BT"
  const parts = [];
  if (row[ORG]) parts.push(`Org=${String(row[ORG]).trim()}`);
  if (row[LOT]) parts.push(`Lot=${String(row[LOT]).trim()}`);
  if (row[DESC]) parts.push(String(row[DESC]).trim());
  return parts.join(' | ');
}

function extractLines() {
  const wb = XLSX.readFile(SOURCE_FILE);
  if (!wb.Sheets[SHEET_NAME]) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
  }
  const sheet = wb.Sheets[SHEET_NAME];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Verify headers (row 1 = header, data starts at row 2)
  const HEADER_ROW = 1;
  const headers = (rows[HEADER_ROW] || []).map(h => (h == null ? '' : String(h).trim()));
  const EXPECTED = ['Component', 'Org Code', 'Description', 'OnHand Quantity', 'Excess',
                    'Std Material Cost(USD)', 'Extended value at STD Cost USD', 'Demand',
                    'MPN', 'Clean Manufacturer Name', 'MPN On Hand', 'Date Code', 'Lot Number'];
  for (let i = 0; i < EXPECTED.length; i++) {
    if (headers[i] !== EXPECTED[i]) {
      throw new Error(`Header mismatch at col ${i}: expected "${EXPECTED[i]}", got "${headers[i]}"`);
    }
  }

  // Per-CPC anchor strategy: iDempiere has a server-side bean callout that
  // collapses chuboe_offer_line records sharing the same (offer_id, CPC).
  // To preserve all per-(date code, lot) detail while still capturing the
  // Sanmina Component code mapping, we populate the CPC field on the FIRST
  // row encountered for each unique CPC and leave it empty on all subsequent
  // rows. The "anchor" row is otherwise identical to a regular detail row —
  // same MPN, qty, date code, lot, etc. The 1985-or-so detail rows then
  // sail through the bean callout untouched (no CPC = no dedup key).
  //
  // Trade-off: for CPCs that have multiple distinct MPNs in Sanmina's data
  // (e.g., LFKB32-0434-01 → both XC7VX415T-L2FFG1158E and XC7VX415T-L2FFG1158E4589),
  // only the MPN of whichever row happens to be first gets the explicit CPC
  // link in OT. The other MPN's tie to that CPC is recoverable from the
  // source xlsx but not from OT alone. Acceptable cost — see chat history
  // 2026-04-08 + the bean callout finding memory.

  const seenCpcs = new Set();
  const lines = [];
  let blankMpn = 0, zeroQty = 0, anchorsAssigned = 0;

  for (let i = HEADER_ROW + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const mpnRaw = row[MPN];
    if (!mpnRaw) { blankMpn++; continue; }
    const mpn = String(mpnRaw).trim();
    if (!mpn || mpn === '(blank)') { blankMpn++; continue; }

    const qty = parseQty(row[MPN_OH]);
    if (qty == null) { zeroQty++; continue; }

    const cpcRaw = row[COMP] != null ? String(row[COMP]).trim() : '';
    // Anchor logic: first row for each CPC carries the CPC value;
    // subsequent rows for the same CPC have CPC field left empty so the
    // bean callout doesn't collapse them.
    let cpcForLine = '';
    if (cpcRaw && !seenCpcs.has(cpcRaw)) {
      cpcForLine = cpcRaw;
      seenCpcs.add(cpcRaw);
      anchorsAssigned++;
    }

    const line = {
      mpn,
      qty,
      cpc: cpcForLine,
      mfrText: row[MFR] != null ? String(row[MFR]).trim() : '',
      price: parsePrice(row[COST]),
      dateCode: row[DATECODE] != null ? String(row[DATECODE]).trim() : '',
      // Always include the underlying CPC in the description so it's
      // recoverable per-row even when the CPC field is empty. Format is
      // backward-compatible with the v1 description.
      description: cpcRaw
        ? `CPC=${cpcRaw} | ${buildLineDescription(row)}`
        : buildLineDescription(row),
    };
    lines.push(line);
  }

  return { lines, blankMpn, zeroQty, anchorsAssigned };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

  console.log('=== Sanmina Q2FY26 E&O Loader ===');
  console.log(`Source: ${SOURCE_FILE}`);
  console.log(`Sheet:  ${SHEET_NAME}`);
  console.log(`Partner: Sanmina Corporation (BP=${PARTNER_BPID})`);
  console.log(`Offer type: ${OFFER_TYPE}`);
  console.log(`Description: ${DESCRIPTION}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : limit ? `LIMIT ${limit}` : 'FULL'}`);
  console.log('');

  const { lines, blankMpn, zeroQty, anchorsAssigned } = extractLines();
  console.log('Extraction stats:');
  console.log(`  Blank MPN rows skipped:  ${blankMpn}`);
  console.log(`  Zero/null qty skipped:   ${zeroQty}`);
  console.log(`  Loadable lines:          ${lines.length}`);
  console.log(`  CPC anchor lines:        ${anchorsAssigned}  (rows that carry the CPC field; rest have CPC=empty to avoid bean callout collapse)`);
  console.log(`  Detail-only lines:       ${lines.length - anchorsAssigned}`);
  console.log('');

  // Coverage
  const withMfr = lines.filter(l => l.mfrText).length;
  const withPrice = lines.filter(l => l.price != null).length;
  const withCpc = lines.filter(l => l.cpc).length;
  const withDc = lines.filter(l => l.dateCode).length;
  const uniqueMpns = new Set(lines.map(l => l.mpn));
  console.log('Field coverage:');
  console.log(`  Unique MPNs:    ${uniqueMpns.size}`);
  console.log(`  With MFR text:  ${withMfr} / ${lines.length}  (${(withMfr/lines.length*100).toFixed(1)}%)`);
  console.log(`  With price:     ${withPrice} / ${lines.length}  (${(withPrice/lines.length*100).toFixed(1)}%)`);
  console.log(`  With CPC:       ${withCpc} / ${lines.length}  (${(withCpc/lines.length*100).toFixed(1)}%)`);
  console.log(`  With Date Code: ${withDc} / ${lines.length}  (${(withDc/lines.length*100).toFixed(1)}%)`);
  console.log('');

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

  console.log(`Writing ${linesToWrite.length} lines to OT (this will take ~${Math.ceil(linesToWrite.length * 0.16)}s)...`);
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
    console.log(`✓ ${limit ? 'SMOKE TEST' : 'SANMINA WRITE'} CLEAN`);
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
