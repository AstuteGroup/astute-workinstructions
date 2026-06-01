#!/usr/bin/env node
/**
 * LAM Kitting Customer-Facing Inventory Offer
 *
 * Refreshes the LAM customer-facing market offer (chuboe_offer_type_id=1000025
 * "LAM Kitting Inventory") that backs the LAM customer BI dashboard. The
 * dashboard queries by offer type + isactive='Y', so we follow the same
 * deactivate-prior + write-new pattern that inventory_cleanup.js uses for the
 * Astute inventory offers — server assigns a fresh offer ID each Monday, the
 * prior one is deactivated.
 *
 * Master roster = Lam_Kitting_DB.xlsx INVENTORY sheet (every program part).
 * Per part: qty = sum(W111+W115 lots) or 0 if not in this week's inventory.
 * That gives the customer full visibility on every program part with current
 * stock — including zero-stock parts (which the prior manual flow omitted).
 *
 * Lead-time policy:
 *   • Manual override codes (anything not matching /\d+\s*-?\s*\d*\s*weeks?/i) →
 *     preserved as-is from the Kitting DB. Examples: LTB, Obsolete, EOL, NRND, LTC.
 *   • Weeks-form values (or blank) → refreshed when this run's sourced.csv has a
 *     fresh "Lead Time (Weeks)" for the MPN; otherwise kept as-is. Sourcing only
 *     hits parts on the reorder list, so above-threshold parts keep their
 *     prior lead-time value (Phase 2: roster-wide lead-time refresher).
 *
 * CPC duplicate handling: roster has ~6 CPCs with multiple MPNs (LAM AVL alts).
 * The chuboe_offer_line CPC bean-callout collapses these on POST — first MPN
 * per CPC carries Chuboe_CPC, subsequent MPN rows for same CPC have Chuboe_CPC
 * blank. See CLAUDE.md / project_chuboe_offer_line_cpc_collapse.md.
 *
 * Usage:
 *   node lam-kitting-customer-offer.js [inventory-folder] [excel-file] [options]
 *
 * Options:
 *   --dry-run           Skip API; print plan + first 10 lines.
 *   --sourced-csv PATH  Override auto-detected this-week sourced CSV (for
 *                       fresh lead-time refresh on reorder-list parts).
 *   --no-fresh-lt       Skip lead-time refresh from sourced CSV (use Kitting
 *                       DB lead time as-is for every row).
 *
 * Outputs:
 *   • New chuboe_offer (type 1000025, BP 1000730) with all roster lines.
 *   • Console summary: offer search key, line counts, zero-stock count,
 *     refreshed-lead-time count.
 *   • Sidecar JSON at output/LAM_Customer_Offer_<date>.json with run metadata.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { writeOffer, deactivatePriorOffers } = require('../../shared/offer-writeback');
const { readCSVFile } = require('../../shared/csv-utils');
const { normalizeMPN } = require('../../shared/mpn-normalization');

const SCRIPT_DIR = __dirname;
const INVENTORY_CLEANUP_DIR = path.join(SCRIPT_DIR, '../Inventory File Cleanup');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

const LAM_BPARTNER_ID = 1000730;                // Lam Research
const OFFER_TYPE_LAM_KITTING_INVENTORY = 1000025;
const COUNTRY_US = 100;
const CURRENCY_USD = 100;                        // c_currency_id for USD

const KDB_PATTERN = /^Lam_Kitting_DB.*\.xlsx$/;

// Note: Uses shared/mpn-normalization.js normalizeMPN() for cross-source
// matching. Strips leading zeros, hyphens, spaces, case differences so
// variants like "9552156612741" / "09552156612741" and "ECP-U1C104MA5" /
// "ECPU1C104MA5" normalize to the same key.

// Cast an xlsx cell value to a clean string, preserving full numeric
// precision. Excel stores 13+ digit MPNs as numbers and `cell.w` (display
// text) collapses them to scientific notation ("9.55167E+12"). We use
// `raw: true` everywhere on Excel reads so .v (the actual number) flows
// through, then String() preserves all digits.
function cellToString(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim();
}

// Round price to 4 decimals to match the manual-cycle convention on the
// customer offer (existing lines store 11.4330, 0.7927, 105.7073, etc.).
// The Kitting DB sources prices at full double precision (e.g.
// 11.43301829268293) which would otherwise leak that precision into the
// offer. iDempiere's chuboe_offer_line.priceentered is numeric without a
// scale constraint, so 4-decimal rounding is a workflow convention, not a
// DB constraint.
function roundPrice(p) {
  if (p == null || isNaN(p)) return null;
  return Math.round(Number(p) * 10000) / 10000;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getDateStamp() {
  return new Date().toISOString().split('T')[0];
}

function getDescriptionDate() {
  // Match the manual-cycle convention: "Lam Kitting Inventory - 2026.04.08"
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const out = { positional: [], dryRun: false, sourcedCsv: null, noFreshLt: false, offerTypeId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-fresh-lt') out.noFreshLt = true;
    else if (a === '--sourced-csv') out.sourcedCsv = argv[++i];
    else if (a === '--offer-type-id') out.offerTypeId = parseInt(argv[++i], 10);
    else out.positional.push(a);
  }
  return out;
}

function findInventoryFolder() {
  const dateStr = getDateStamp();
  const candidate = path.join('/tmp', `Inventory ${dateStr}`);
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: most-recent Inventory * folder under /tmp
  const dirs = fs.readdirSync('/tmp')
    .filter(d => /^Inventory \d{4}-\d{2}-\d{2}$/.test(d))
    .map(d => path.join('/tmp', d))
    .sort()
    .reverse();
  return dirs[0] || null;
}

function findKittingDB() {
  const files = fs.readdirSync(SCRIPT_DIR).filter(f => KDB_PATTERN.test(f)).sort().reverse();
  return files.length > 0 ? path.join(SCRIPT_DIR, files[0]) : null;
}

function findSourcedCsv() {
  const dateStr = getDateStamp();
  const candidate = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStr}_sourced.csv`);
  if (fs.existsSync(candidate)) return candidate;
  // Most-recent matching file
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => /^LAM_Reorder_Alerts_\d{4}-\d{2}-\d{2}_sourced\.csv$/.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(OUTPUT_DIR, files[0]) : null;
}

// ─── ROSTER (Kitting DB INVENTORY sheet) ──────────────────────────────────────

function loadRoster(kdbPath) {
  const wb = XLSX.readFile(kdbPath);
  const sheet = wb.Sheets['INVENTORY'];
  if (!sheet) throw new Error(`Sheet "INVENTORY" not found in ${kdbPath}`);
  // raw: true preserves numeric MPN cells at full precision (cell.v) instead
  // of returning the scientific-notation display string (cell.w). 21 of 945
  // MPNs in the Kitting DB are stored as numbers (e.g. 9551666816741) and
  // would otherwise come through as "9.55167E+12".
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  if (rows.length < 2) throw new Error(`No data rows in INVENTORY sheet`);

  const header = rows[0];
  const idx = name => header.findIndex(h => cellToString(h).toLowerCase() === name.toLowerCase());
  const cols = {
    cpc:  idx('Lam P/N'),
    mpn:  idx('MPN'),
    mfr:  idx('Manufacturer'),
    desc: idx('Item Description'),
    lt:   idx('Lead Time'),
    base: idx('Base Unit Price'),
    rsl:  idx('Resale Price'),
    moq:  idx('MOQ'),
  };
  for (const [k, v] of Object.entries(cols)) {
    if (v < 0) throw new Error(`Missing required column in INVENTORY: ${k}`);
  }

  const roster = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const mpn = cellToString(r[cols.mpn]);
    if (!mpn) continue;
    roster.push({
      cpc:  cellToString(r[cols.cpc]),
      mpn,
      mfr:  cellToString(r[cols.mfr]),
      desc: cellToString(r[cols.desc]),
      lt:   cellToString(r[cols.lt]),
      base: typeof r[cols.base] === 'number' ? r[cols.base] : (parseFloat(r[cols.base]) || null),
      rsl:  typeof r[cols.rsl]  === 'number' ? r[cols.rsl]  : (parseFloat(r[cols.rsl])  || null),
      moq:  typeof r[cols.moq]  === 'number' ? r[cols.moq]  : (parseFloat(r[cols.moq])  || null),
    });
  }

  // Dedup on (CPC + MPN). The Kitting DB occasionally accumulates exact
  // duplicate rows (same CPC, same MPN, identical other fields) — operator
  // copy-paste artifacts. Drop them silently here, keep first occurrence,
  // and log the count so the operator can clean the source file at leisure.
  const seen = new Set();
  const deduped = [];
  const dupes = [];
  for (const r of roster) {
    const key = `${r.cpc} ${normalizeMPN(r.mpn)}`;
    if (seen.has(key)) {
      dupes.push(`${r.cpc} | ${r.mpn}`);
      continue;
    }
    seen.add(key);
    deduped.push(r);
  }
  if (dupes.length > 0) {
    log(`  Dropped ${dupes.length} duplicate roster row(s) (same CPC+MPN — clean these in the Kitting DB Excel):`);
    for (const d of dupes) log(`    • ${d}`);
  }
  return deduped;
}

// ─── INVENTORY (W111 + W115 cleaned CSVs) ─────────────────────────────────────

// Returns a map keyed by normalizeMPN(MPN) → summed qty. Inventory CSVs
// sometimes carry leading-zero variants (e.g. "09552156612741") while the
// Kitting DB has the un-padded form (e.g. "9552156612741"); canonicalizing
// both sides ensures these match. Mirrors lam-kitting-reorder.js.
function loadInventoryQty(inventoryFolder) {
  const qtyByCanonical = {};
  const w111 = path.join(inventoryFolder, 'W111_LAM_3PL.csv');
  const w115 = path.join(inventoryFolder, 'W115_LAM_Dead_Inventory.csv');

  for (const file of [w111, w115]) {
    if (!fs.existsSync(file)) {
      log(`  WARNING: inventory file missing: ${path.basename(file)}`);
      continue;
    }
    const csv = readCSVFile(file);
    const mpnIdx = csv.headers.indexOf('Chuboe_MPN');
    const qtyIdx = csv.headers.indexOf('Qty');
    if (mpnIdx < 0 || qtyIdx < 0) {
      log(`  WARNING: ${path.basename(file)} missing Chuboe_MPN/Qty columns — skipping`);
      continue;
    }
    let lots = 0;
    for (const row of csv.rows) {
      const mpnRaw = (row[mpnIdx] || '').trim();
      if (!mpnRaw) continue;
      const key = normalizeMPN(mpnRaw);
      const qty = parseFloat(row[qtyIdx]) || 0;
      qtyByCanonical[key] = (qtyByCanonical[key] || 0) + qty;
      lots++;
    }
    log(`  ${path.basename(file)}: ${lots} lot rows`);
  }
  return qtyByCanonical;
}

// ─── SOURCED CSV (fresh API-derived lead times for reorder-list parts) ───────

function loadFreshLeadTimes(sourcedCsvPath) {
  if (!sourcedCsvPath || !fs.existsSync(sourcedCsvPath)) return {};
  const csv = readCSVFile(sourcedCsvPath);
  const mpnIdx = csv.headers.indexOf('MPN');
  const ltWeeksIdx = csv.headers.indexOf('Lead Time (Weeks)');
  const inStockQtyIdx = csv.headers.indexOf('In Stock Qty');
  if (mpnIdx < 0 || ltWeeksIdx < 0) return {};

  const out = {};
  for (const row of csv.rows) {
    const mpnRaw = (row[mpnIdx] || '').trim();
    if (!mpnRaw) continue;
    const key = normalizeMPN(mpnRaw);
    const ltWeeks = parseFloat(row[ltWeeksIdx]);
    const inStock = inStockQtyIdx >= 0 ? parseFloat(row[inStockQtyIdx]) || 0 : 0;
    if (ltWeeks && ltWeeks > 0) {
      out[key] = `${ltWeeks} Weeks`;
    } else if (inStock > 0) {
      out[key] = 'In Stock';
    }
  }
  return out;
}

// ─── LEAD-TIME CHOOSER ──────────────────────────────────────────────────────

// Manual override = any non-empty value that is NOT a "weeks" pattern.
// Weeks pattern matches: "11 Weeks", "3-5 weeks", "12 wk", "8w" etc.
const WEEKS_RE = /\d+\s*-?\s*\d*\s*(weeks?|wks?|w)\b/i;

function chooseLeadTime(kdbLeadTime, freshValue) {
  const kdb = (kdbLeadTime || '').trim();
  const isWeeksPattern = WEEKS_RE.test(kdb);

  if (!kdb || isWeeksPattern) {
    // Eligible to refresh
    if (freshValue) return freshValue;
    return kdb; // fall back to KDB even if it's a weeks pattern but we have nothing fresher
  }
  // Manual override (LTB, Obsolete, EOL, etc.) — preserve
  return kdb;
}

// ─── BUILD LINES ────────────────────────────────────────────────────────────

function buildLines(roster, qtyByMpn, freshLts, opts = {}) {
  // Sort by CPC then MPN so duplicate-CPC alternates land adjacent — first
  // MPN in each CPC group carries Chuboe_CPC, subsequent rows for the same
  // CPC have CPC blank (per-CPC anchor pattern to avoid the chuboe_offer_line
  // server-side dedup callout).
  const sorted = [...roster].sort((a, b) => {
    const c = (a.cpc || '').localeCompare(b.cpc || '');
    if (c !== 0) return c;
    return a.mpn.localeCompare(b.mpn);
  });

  const seenCpc = new Set();
  const lines = [];
  let zeroStock = 0;
  let refreshed = 0;
  let preservedManual = 0;
  let cpcAnchorSkips = 0;

  for (const r of sorted) {
    const qty = qtyByMpn[normalizeMPN(r.mpn)] || 0;
    if (qty === 0) zeroStock++;

    const fresh = opts.freshLts ? freshLts[normalizeMPN(r.mpn)] : null;
    const finalLt = chooseLeadTime(r.lt, fresh);
    if (fresh && finalLt === fresh && finalLt !== r.lt) refreshed++;
    if (r.lt && finalLt === r.lt && !WEEKS_RE.test(r.lt)) preservedManual++;

    let cpcForLine = r.cpc;
    if (cpcForLine && seenCpc.has(cpcForLine)) {
      cpcForLine = ''; // anchor: only first row per CPC carries the CPC field
      cpcAnchorSkips++;
    } else if (cpcForLine) {
      seenCpc.add(cpcForLine);
    }

    lines.push({
      mpn: r.mpn,
      mfrText: r.mfr || null,
      qty,
      price: roundPrice(r.rsl), // Resale Price → priceentered (4 decimals — matches manual-cycle convention)
      leadTime: finalLt || null,
      // chuboe_moq is a varchar(60) — the manual workflow has been writing
      // literal "YES" since ~Nov 2025 (837/939 lines on the current live
      // offer). Operator confirmed this is intentional pending seller follow-
      // up, so we mirror the convention rather than substituting the actual
      // numeric MOQ from the Kitting DB. If the convention changes, switch
      // back to `r.moq != null ? r.moq : null`.
      moq: 'YES',
      cpc: cpcForLine || null,
      countryId: COUNTRY_US,
      currencyId: CURRENCY_USD,
      description: r.desc || null,
    });
  }

  return { lines, stats: { zeroStock, refreshed, preservedManual, cpcAnchorSkips } };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const inventoryFolder = args.positional[0] || findInventoryFolder();
  const kdbPath = args.positional[1] || findKittingDB();
  const sourcedCsv = args.sourcedCsv || (args.noFreshLt ? null : findSourcedCsv());
  const offerTypeId = args.offerTypeId || OFFER_TYPE_LAM_KITTING_INVENTORY;
  const isStaging = offerTypeId !== OFFER_TYPE_LAM_KITTING_INVENTORY;

  log('============================================================');
  log('LAM KITTING CUSTOMER OFFER REFRESH');
  log('============================================================');
  log(`Inventory folder: ${inventoryFolder || 'NOT FOUND'}`);
  log(`Kitting DB:       ${kdbPath ? path.basename(kdbPath) : 'NOT FOUND'}`);
  log(`Sourced CSV:      ${sourcedCsv ? path.basename(sourcedCsv) : '(none — lead times kept as-is)'}`);
  log(`Offer type:       ${offerTypeId}${isStaging ? '  [STAGING — invisible to customer dashboard]' : '  [LAM Kitting Inventory — LIVE for customer dashboard]'}`);
  log(`Mode:             ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (!inventoryFolder || !fs.existsSync(inventoryFolder)) {
    throw new Error(`Inventory folder not found. Run inventory_cleanup.js first.`);
  }
  if (!kdbPath || !fs.existsSync(kdbPath)) {
    throw new Error(`Lam_Kitting_DB.xlsx not found in ${SCRIPT_DIR}`);
  }

  log('');
  log('Step 1: Loading roster from Kitting DB INVENTORY sheet...');
  const roster = loadRoster(kdbPath);
  log(`  Roster: ${roster.length} parts`);

  log('Step 2: Summing inventory qty per MPN from W111 + W115...');
  const qtyByMpn = loadInventoryQty(inventoryFolder);
  log(`  Distinct MPNs with stock: ${Object.keys(qtyByMpn).length}`);

  log('Step 3: Loading fresh lead times from sourced CSV...');
  const freshLts = sourcedCsv ? loadFreshLeadTimes(sourcedCsv) : {};
  log(`  MPNs with fresh lead-time data: ${Object.keys(freshLts).length}`);

  log('Step 4: Building offer lines...');
  const { lines, stats } = buildLines(roster, qtyByMpn, freshLts, { freshLts: !!sourcedCsv });
  log(`  Lines built: ${lines.length}`);
  log(`    Zero-stock: ${stats.zeroStock}`);
  log(`    Refreshed lead time from sourcing: ${stats.refreshed}`);
  log(`    Preserved manual lead-time codes: ${stats.preservedManual}`);
  log(`    CPC-anchor blanked (alt-MPN rows): ${stats.cpcAnchorSkips}`);

  const description = isStaging
    ? `Lam Kitting Inventory - ${getDescriptionDate()} [STAGING]`
    : `Lam Kitting Inventory - ${getDescriptionDate()}`;
  log(`  Description: "${description}"`);

  if (args.dryRun) {
    log('');
    log('DRY RUN — sample of first 10 lines:');
    for (const l of lines.slice(0, 10)) {
      log(`  ${l.mpn} | ${l.mfrText} | qty=${l.qty} | $${l.price} | LT=${l.leadTime || ''} | CPC=${l.cpc || '(blank)'}`);
    }
    log('');
    log('DRY RUN — would call deactivatePriorOffers + writeOffer (skipped).');
    return { dryRun: true, lineCount: lines.length, ...stats };
  }

  log('');
  // Staging runs scope the deactivate to descriptions ending in [STAGING]
  // so they don't touch any unrelated active offer that happens to share
  // (BP, offer_type) — e.g. a real Manufacturer Cross Reference offer.
  log(`Step 5: Deactivating prior offer(s) on (BP=${LAM_BPARTNER_ID}, type=${offerTypeId})${isStaging ? ' filtered to [STAGING]' : ''}...`);
  const deact = await deactivatePriorOffers(
    LAM_BPARTNER_ID,
    offerTypeId,
    isStaging ? { descriptionEndsWith: '[STAGING]' } : {}
  );
  log(`  Deactivated ${deact.offersDeactivated} prior offer(s), ${deact.linesDeactivated} lines`);

  log('Step 6: Writing new offer + lines...');
  const result = await writeOffer({
    bpartnerId: LAM_BPARTNER_ID,
    offerTypeId,
    description,
    lines,
  });
  log(`  Offer created: search key ${result.searchKey} (chuboe_offer_id ${result.offerId})`);
  log(`  Lines written: ${result.linesWritten}/${lines.length}${result.errors.length ? ` — ${result.errors.length} errors` : ''}`);
  if (result.errors.length > 0) {
    log('  Errors (first 5):');
    for (const e of result.errors.slice(0, 5)) log(`    ${e}`);
  }

  // Sidecar JSON for the runner / audit trail
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const sidecarPath = path.join(OUTPUT_DIR, `LAM_Customer_Offer_${getDateStamp()}.json`);
  fs.writeFileSync(sidecarPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    description,
    offerTypeId,
    isStaging,
    offerId: result.offerId,
    searchKey: result.searchKey,
    lineCount: lines.length,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
    deactivatedPriorOffers: deact.offersDeactivated,
    deactivatedOfferKeys: (deact.deactivatedOffers || []).map(o => o.value || o.id),
    stats,
    sourcedCsv: sourcedCsv ? path.basename(sourcedCsv) : null,
    kdb: path.basename(kdbPath),
    inventoryFolder: path.basename(inventoryFolder),
  }, null, 2) + '\n');
  log(`  Sidecar: ${path.basename(sidecarPath)}`);

  log('============================================================');
  log('DONE');
  log('============================================================');

  return {
    offerId: result.offerId,
    searchKey: result.searchKey,
    lineCount: lines.length,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
    ...stats,
  };
}

if (require.main === module) {
  main()
    .then(r => {
      // Exit non-zero if any line errors so the runner can flag the email
      process.exit(r.errorCount && r.errorCount > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error(`FATAL: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { main, loadRoster, loadInventoryQty, loadFreshLeadTimes, buildLines, chooseLeadTime };
