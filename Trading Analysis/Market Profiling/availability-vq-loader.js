#!/usr/bin/env node
/**
 * Availability VQ Loader
 *
 * Converts NetComponents scrape results (from --check-only mode) into
 * $0 availability VQs for market intelligence purposes.
 *
 * Key differences from standard VQ loading:
 * - Cost = 0 (no pricing available from scrape)
 * - Qty = supplier's available quantity
 * - Notes indicate this is a market profile (scrape-only, no pricing)
 * - Unknown vendors use a placeholder BP with vendor name in notes
 *
 * Usage:
 *   node availability-vq-loader.js <scrape_results.xlsx> --rfq <rfq_number> [--dry-run]
 *   node availability-vq-loader.js <scrape_results.xlsx> --rfq 1234567 --dry-run
 *   node availability-vq-loader.js <scrape_results.xlsx> --rfq 1234567 --commit
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { execFileSync } = require('child_process');

// Shared utilities - reuse existing VQ loader infrastructure
const sharedPath = path.join(__dirname, '../../shared');
const { apiPost, resolveBP } = require(path.join(sharedPath, 'api-client'));
const { resolveMfrForRow } = require(path.join(sharedPath, 'mfr-resolver'));
const { resolveBPHistorical } = require(path.join(sharedPath, 'partner-lookup'));
const logger = require(path.join(sharedPath, 'logger')).createLogger('AvailabilityVQ');

// ─── Configuration ─────────────────────────────────────────────────────────

// Placeholder BP ID for unknown vendors - same as VQ loader uses
const UNKNOWN_VENDOR_PLACEHOLDER_BP_ID = 1000003;

// How long to consider existing VQs when checking for duplicates
const DUPLICATE_CHECK_DAYS = 14;

// ─── Vendor BP Resolution ──────────────────────────────────────────────────

/**
 * Resolve NC supplier name to OT business partner ID.
 *
 * Uses the SAME resolution logic as VQ loader (shared/api-client.js resolveBP):
 * 1. Curated vendor aliases (shared/data/vendor-aliases.json)
 * 2. Exact match by searchKey
 * 3. Fuzzy name matching
 * 4. Historical VQ fallback (resolveBPHistorical) - same as broker VQ loading
 * 5. Placeholder BP if unknown (with vendor name in notes)
 */
async function resolveVendorBP(supplierName) {
  if (!supplierName) return null;

  try {
    // Use the same resolveBP as VQ loader - handles aliases, fuzzy matching, caching
    const bp = await resolveBP(null, supplierName);
    if (bp) {
      return { id: bp.id, name: bp.name, source: 'resolved' };
    }
  } catch (e) {
    logger.debug(`BP resolution failed for '${supplierName}': ${e.message}`);
  }

  // Historical fallback: check recent VQ history for this vendor label
  // Same pattern as load-bulk-summary.js - matches short broker names like
  // "Yuexunfa" → "YUE XUN FA INTERNATIONAL LIMITED" by finding BPs that have
  // received VQs with similar names in the last 90 days.
  try {
    const hist = resolveBPHistorical(supplierName);
    if (hist) {
      logger.info(`Historical BP fallback: '${supplierName}' → ${hist.id} (${hist.name})`);
      return { id: hist.id, name: hist.name, source: 'historical' };
    }
  } catch (e) {
    logger.debug(`Historical BP fallback failed for '${supplierName}': ${e.message}`);
  }

  // Unknown vendor - use placeholder (same pattern as VQ loader)
  return {
    id: UNKNOWN_VENDOR_PLACEHOLDER_BP_ID,
    source: 'placeholder',
    vendorName: supplierName
  };
}

// ─── RFQ Resolution ────────────────────────────────────────────────────────

/**
 * Get RFQ details by search key (document number)
 */
function getRFQBySearchKey(searchKey) {
  const sql = `
    SELECT chuboe_rfq_id, value, c_bpartner_id, description
    FROM adempiere.chuboe_rfq
    WHERE value = '${searchKey.replace(/'/g, "''")}'
      AND isactive = 'Y'
    LIMIT 1
  `;
  try {
    const out = execFileSync('psql', ['-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
    const line = out.trim().split('\n')[0];
    if (!line) return null;
    const [id, value, bpartnerId, description] = line.split('|');
    return { id: parseInt(id, 10), value, bpartnerId: parseInt(bpartnerId, 10), description };
  } catch (e) {
    return null;
  }
}

/**
 * Get RFQ line by MPN
 */
function getRFQLineByMPN(rfqId, mpn) {
  const cleanMpn = (mpn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sql = `
    SELECT rl.chuboe_rfq_line_id
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = ${rfqId}
      AND rl.isactive = 'Y'
      AND rlm.isactive = 'Y'
      AND rlm.chuboe_mpn_clean = '${cleanMpn}'
    LIMIT 1
  `;
  try {
    const out = execFileSync('psql', ['-At', '-c', sql], { encoding: 'utf8' });
    const id = parseInt(out.trim(), 10);
    return isNaN(id) ? null : id;
  } catch (e) {
    return null;
  }
}

// ─── Duplicate Check ───────────────────────────────────────────────────────

/**
 * Check if an availability VQ already exists for this MPN + vendor
 */
function existingAvailabilityVQ(rfqLineId, mpn, bpId) {
  const cleanMpn = (mpn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sql = `
    SELECT chuboe_vq_line_id
    FROM adempiere.chuboe_vq_line
    WHERE chuboe_rfq_line_id = ${rfqLineId}
      AND chuboe_mpn_clean = '${cleanMpn}'
      AND c_bpartner_id = ${bpId}
      AND cost = 0
      AND created > NOW() - INTERVAL '${DUPLICATE_CHECK_DAYS} days'
      AND isactive = 'Y'
    LIMIT 1
  `;
  try {
    const out = execFileSync('psql', ['-At', '-c', sql], { encoding: 'utf8' });
    const id = parseInt(out.trim(), 10);
    return isNaN(id) ? null : id;
  } catch (e) {
    return null;
  }
}

// ─── Main Processing ───────────────────────────────────────────────────────

/**
 * Parse scrape results Excel file
 */
function parseScrapeResults(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  // Filter to SCRAPED status only
  return rows.filter(r => r['Status'] === 'SCRAPED' || r.status === 'SCRAPED');
}

/**
 * Build availability note for VQ
 */
function buildAvailabilityNote(row, vendorName) {
  const date = new Date().toISOString().slice(0, 10);
  const qty = row['Supplier Qty'] || row.supplier_qty || 0;
  const dc = row['Date Code'] || row.date_code || row['DC'] || '';
  const region = row['Region'] || row.region || '';

  let note = `Market profile ${date}: ${vendorName} has ${qty.toLocaleString()} pcs`;
  if (dc) note += `, DC ${dc}`;
  if (region) note += ` (${region})`;
  note += '. Scrape only, no pricing.';

  return note;
}

/**
 * Write a single availability VQ
 */
async function writeAvailabilityVQ(rfq, row, dryRun = false) {
  const mpn = row['Part Number'] || row.part_number || '';
  const supplierName = row['Supplier'] || row.supplier || '';
  const supplierQty = parseInt(row['Supplier Qty'] || row.supplier_qty || 0, 10);
  const dateCode = row['Date Code'] || row.date_code || row['DC'] || '';
  const offeredMpn = row['Offered MPN'] || row.offered_mpn || mpn;

  // Skip if no MPN or qty
  if (!mpn || !supplierQty) {
    return { status: 'skipped', reason: 'no_mpn_or_qty', mpn, supplier: supplierName };
  }

  // Resolve RFQ line
  const rfqLineId = getRFQLineByMPN(rfq.id, mpn);
  if (!rfqLineId) {
    return { status: 'failed', reason: 'no_rfq_line', mpn, supplier: supplierName };
  }

  // Resolve vendor BP
  const bpResult = await resolveVendorBP(supplierName);
  if (!bpResult) {
    return { status: 'failed', reason: 'bp_resolution_failed', mpn, supplier: supplierName };
  }

  // Check for existing availability VQ
  const existingId = existingAvailabilityVQ(rfqLineId, mpn, bpResult.id);
  if (existingId) {
    return {
      status: 'skipped',
      reason: 'duplicate',
      mpn,
      supplier: supplierName,
      existingVqId: existingId
    };
  }

  // Resolve MFR (try to infer from MPN if no data)
  const mfrResult = resolveMfrForRow({ mfrText: '', mpn: offeredMpn || mpn });
  const mfrText = mfrResult.canonical || '';
  const mfrId = (mfrResult.id && !mfrResult.isSystem) ? mfrResult.id : null;

  // Build notes
  const vendorDisplay = bpResult.source === 'placeholder' ? bpResult.vendorName : supplierName;
  const availabilityNote = buildAvailabilityNote(row, vendorDisplay);

  // Prepend vendor name to notes if using placeholder BP
  let finalNote = availabilityNote;
  if (bpResult.source === 'placeholder') {
    finalNote = `Vendor: ${supplierName} | ${availabilityNote}`;
  }

  // Build payload
  const payload = {
    Chuboe_RFQ_ID: rfq.id,
    Chuboe_RFQ_Line_ID: rfqLineId,
    C_BPartner_ID: bpResult.id,
    Chuboe_MPN: offeredMpn || mpn,
    Chuboe_MFR_Text: mfrText,
    ...(mfrId ? { Chuboe_MFR_ID: mfrId } : {}),
    Cost: 0,  // KEY DIFFERENCE: no pricing from scrape
    Qty: supplierQty,
    C_Currency_ID: 100, // USD
    Chuboe_Date_Code: dateCode || null,
    Chuboe_Note_User: finalNote,
    C_UOM_ID: 100, // Each
  };

  if (dryRun) {
    return {
      status: 'would_write',
      mpn,
      supplier: supplierName,
      qty: supplierQty,
      bpId: bpResult.id,
      bpSource: bpResult.source,
      payload
    };
  }

  // Write VQ
  try {
    const result = await apiPost('Chuboe_VQ_Line', payload);
    return {
      status: 'written',
      vqLineId: result.id,
      mpn,
      supplier: supplierName,
      qty: supplierQty,
      bpId: bpResult.id,
      bpSource: bpResult.source
    };
  } catch (e) {
    return {
      status: 'failed',
      reason: 'api_error',
      mpn,
      supplier: supplierName,
      error: e.message.substring(0, 200)
    };
  }
}

/**
 * Process all scrape results
 */
async function processResults(filePath, rfqSearchKey, dryRun = false) {
  // Parse input file
  const rows = parseScrapeResults(filePath);
  logger.info(`Parsed ${rows.length} scraped rows from ${path.basename(filePath)}`);

  if (rows.length === 0) {
    logger.warn('No SCRAPED rows found in file');
    return { written: 0, skipped: 0, failed: 0, duplicates: 0, results: [] };
  }

  // Resolve RFQ
  const rfq = getRFQBySearchKey(rfqSearchKey);
  if (!rfq) {
    throw new Error(`RFQ '${rfqSearchKey}' not found`);
  }
  logger.info(`RFQ ${rfqSearchKey} resolved: ID ${rfq.id}`);

  // Process each row
  const results = [];
  const stats = { written: 0, skipped: 0, failed: 0, duplicates: 0 };

  for (const row of rows) {
    const result = await writeAvailabilityVQ(rfq, row, dryRun);
    results.push(result);

    if (result.status === 'written' || result.status === 'would_write') {
      stats.written++;
    } else if (result.status === 'skipped') {
      stats.skipped++;
      if (result.reason === 'duplicate') stats.duplicates++;
    } else {
      stats.failed++;
    }

    // Brief delay between writes
    if (!dryRun && result.status === 'written') {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  return { ...stats, results };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3 || !args.includes('--rfq')) {
    console.log('Usage: node availability-vq-loader.js <scrape_results.xlsx> --rfq <rfq_number> [--dry-run|--commit]');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run   Preview what would be written (default)');
    console.log('  --commit    Actually write VQs to OT');
    console.log('');
    console.log('Examples:');
    console.log('  node availability-vq-loader.js RFQ_123/Results_2026-06-03.xlsx --rfq 1234567 --dry-run');
    console.log('  node availability-vq-loader.js RFQ_123/Results_2026-06-03.xlsx --rfq 1234567 --commit');
    process.exit(1);
  }

  const filePath = args[0];
  const rfqIdx = args.indexOf('--rfq');
  const rfqSearchKey = args[rfqIdx + 1];
  const commit = args.includes('--commit');
  const dryRun = !commit;

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Availability VQ Loader');
  console.log('='.repeat(60));
  console.log(`Input file: ${filePath}`);
  console.log(`RFQ: ${rfqSearchKey}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (preview only)' : 'COMMIT (writing to OT)'}`);
  console.log('='.repeat(60));

  try {
    const result = await processResults(filePath, rfqSearchKey, dryRun);

    console.log('');
    console.log('='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`${dryRun ? 'Would write' : 'Written'}: ${result.written} VQs`);
    console.log(`Skipped: ${result.skipped} (${result.duplicates} duplicates)`);
    console.log(`Failed: ${result.failed}`);
    console.log('='.repeat(60));

    // Show sample results
    if (result.results.length > 0) {
      console.log('');
      console.log('Sample results:');
      const samples = result.results.slice(0, 5);
      for (const r of samples) {
        const statusIcon = r.status === 'written' || r.status === 'would_write' ? '+' :
                          r.status === 'skipped' ? '-' : 'x';
        console.log(`  [${statusIcon}] ${r.mpn} @ ${r.supplier}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
      }
      if (result.results.length > 5) {
        console.log(`  ... and ${result.results.length - 5} more`);
      }
    }

    // Show unknown vendors needing BP creation
    const unknownVendors = result.results
      .filter(r => r.bpSource === 'placeholder')
      .map(r => r.supplier)
      .filter((v, i, arr) => arr.indexOf(v) === i); // unique

    if (unknownVendors.length > 0) {
      console.log('');
      console.log('Unknown vendors (using placeholder BP):');
      for (const v of unknownVendors.slice(0, 10)) {
        console.log(`  - ${v}`);
      }
      if (unknownVendors.length > 10) {
        console.log(`  ... and ${unknownVendors.length - 10} more`);
      }
      console.log('');
      console.log('Add these to shared/data/vendor-aliases.json or create BPs in OT.');
    }

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  processResults,
  writeAvailabilityVQ,
  resolveVendorBP,
  parseScrapeResults
};
