#!/usr/bin/env node
/**
 * LAM Kitting RFQ + VQ Writer
 *
 * Reads the sourced reorder alerts + franchise data JSON.
 * For items WITHOUT an on-order qty / recent POV, creates:
 *   1. One 3PL/VMI RFQ header (LAM Research, Rob Johnson contact, Josh Syre salesrep)
 *   2. One RFQ line per reorder item (qty = shortfall)
 *   3. VQ lines for ALL franchise API results (stock and lead time clearly separated)
 *
 * Outputs a JSON mapping of MPN → RFQ line number for the email step.
 *
 * Usage:
 *   node lam-kitting-rfq-writer.js <sourced-csv> <franchise-data-json> [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { readCSVFile } = require('../../shared/csv-utils');
const { writeRFQ } = require('../../shared/rfq-writer');
const { writeVQBatch } = require('../../shared/vq-writer');

// ─── Constants ──────────────────────────────────────────────────────────────

const LAM_BPARTNER_ID = 1000730;       // Lam Research
const LAM_CONTACT_ID = 1033762;        // Rob Johnson
const SALESREP_ID = 1007049;           // Josh Syre (internal employee record)
const RFQ_TYPE = '3PL/VMI';

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  if (positionalArgs.length < 2) {
    console.error('Usage: node lam-kitting-rfq-writer.js <sourced-csv> <franchise-data-json> [--dry-run]');
    process.exit(1);
  }

  const sourcedCsvPath = positionalArgs[0];
  const franchiseJsonPath = positionalArgs[1];
  const dateStr = new Date().toISOString().split('T')[0];

  console.log('LAM Kitting RFQ + VQ Writer');
  console.log('===========================');
  console.log(`Sourced CSV: ${sourcedCsvPath}`);
  console.log(`Franchise data: ${franchiseJsonPath}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // ── Load sourced alerts ──
  const csv = readCSVFile(sourcedCsvPath);
  const headers = csv.headers;
  const mpnIdx = headers.indexOf('MPN');
  const cpcIdx = headers.indexOf('Lam P/N');
  const shortfallIdx = headers.indexOf('Shortfall');
  const mfrIdx = headers.indexOf('Manufacturer');
  const descIdx = headers.indexOf('Item Description');
  const priorityIdx = headers.indexOf('Priority');
  const statusIdx = headers.indexOf('Sourcing Status');

  // ── Load franchise data ──
  const franchiseData = JSON.parse(fs.readFileSync(franchiseJsonPath, 'utf-8'));

  // ── Filter: items that need an RFQ ──
  // Skip PENDING RECEIPT — stock is likely inbound (recent PO within 90 days);
  // the emailed report is sufficient visibility for those and a second RFQ
  // would just clutter OT.
  //
  // Include CRITICAL/HIGH/MEDIUM/LOW — even if they show a stale 2024/2025
  // POV in the Recent POV cell. Stale POs don't qualify as "recent activity"
  // under the 90-day rule, so those items genuinely need a fresh RFQ.
  //
  // Skip SKIPPED - TIMEOUT/ERROR — no VQ data to write.
  const rfqCandidates = [];
  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const priority = (row[priorityIdx] || '').toString().trim();
    const status = (row[statusIdx] || '').toString().trim();

    if (priority === 'PENDING RECEIPT') {
      console.log(`  SKIP ${row[mpnIdx]} — PENDING RECEIPT (recent PO in flight)`);
      continue;
    }

    if (status === 'SKIPPED - TIMEOUT/ERROR') {
      console.log(`  SKIP ${row[mpnIdx]} — sourcing incomplete`);
      continue;
    }

    rfqCandidates.push({
      mpn: row[mpnIdx],
      cpc: row[cpcIdx] || '',
      shortfall: parseInt(row[shortfallIdx]) || 0,
      mfrText: row[mfrIdx] || '',
      description: row[descIdx] || '',
      franchiseResults: franchiseData[row[mpnIdx]] || null,
    });
  }

  console.log(`\n${rfqCandidates.length} items need RFQ (CRITICAL/HIGH/MEDIUM/LOW with no recent PO activity)`);
  console.log(`${csv.rows.length - rfqCandidates.length} items skipped (PENDING RECEIPT or sourcing incomplete)\n`);

  if (rfqCandidates.length === 0) {
    console.log('Nothing to write — all items have orders in flight.');
    // Write empty mapping so downstream doesn't error
    const mappingFile = sourcedCsvPath.replace('_sourced.csv', '_rfq_mapping.json');
    fs.writeFileSync(mappingFile, JSON.stringify({ rfqSearchKey: null, lines: {} }));
    return;
  }

  // ── Step 1: Create RFQ ──
  console.log('Step 1: Creating RFQ...');

  const rfqLines = rfqCandidates.map(c => ({
    mpn: c.mpn,
    mfrText: c.mfrText,
    qty: c.shortfall,
    targetPrice: 0,
    cpc: c.cpc,
    description: c.description,
  }));

  if (dryRun) {
    console.log(`  [DRY RUN] Would create 3PL/VMI RFQ for LAM Research with ${rfqLines.length} lines:`);
    rfqLines.forEach((l, i) => console.log(`    Line ${(i+1)*10}: ${l.mpn} (CPC: ${l.cpc}, qty: ${l.qty})`));
    const mappingFile = sourcedCsvPath.replace('_sourced.csv', '_rfq_mapping.json');
    const dryMapping = { rfqSearchKey: 'DRY-RUN', lines: {} };
    rfqLines.forEach((l, i) => { dryMapping.lines[l.mpn] = (i+1)*10; });
    fs.writeFileSync(mappingFile, JSON.stringify(dryMapping, null, 2));
    console.log(`  Mapping written to: ${mappingFile}`);
    return;
  }

  const rfqResult = await writeRFQ({
    bpartnerId: LAM_BPARTNER_ID,
    type: RFQ_TYPE,
    description: `LAM Kitting Reorder ${dateStr} — auto-generated`,
    salesrepId: SALESREP_ID,
    userId: LAM_CONTACT_ID,
    lines: rfqLines,
  });

  if (!rfqResult.rfqId) {
    console.error('  ERROR: RFQ creation failed:', rfqResult.errors);
    process.exit(1);
  }

  console.log(`  RFQ created: ${rfqResult.searchKey} (ID: ${rfqResult.rfqId})`);
  console.log(`  Lines written: ${rfqResult.linesWritten}, MPNs: ${rfqResult.mpnsWritten}`);
  if (rfqResult.errors.length > 0) {
    console.log(`  Errors: ${rfqResult.errors.join('; ')}`);
  }

  // ── Step 2: Write VQ lines for all franchise results ──
  console.log('\nStep 2: Writing VQ lines from franchise API data...');

  // Build items array for writeVQBatch — only items with franchise data
  const vqItems = rfqCandidates
    .filter(c => c.franchiseResults && c.franchiseResults.distributors)
    .map(c => ({
      mpn: c.mpn,
      cpc: c.cpc,
      franchiseResults: c.franchiseResults,
    }));

  const vqItemsWithoutData = rfqCandidates.filter(c => !c.franchiseResults || !c.franchiseResults.distributors);
  if (vqItemsWithoutData.length > 0) {
    console.log(`  ${vqItemsWithoutData.length} items have no franchise data — no VQs to write:`);
    vqItemsWithoutData.forEach(c => console.log(`    ${c.mpn}`));
  }

  if (vqItems.length > 0) {
    const vqResult = await writeVQBatch(rfqResult.searchKey, vqItems, {
      delayMs: 100,
    });

    const vqWritten = vqResult.written?.length || vqResult.allWritten?.length || 0;
    const vqFlagged = vqResult.flagged?.length || vqResult.allFlagged?.length || 0;
    const vqFailed = vqResult.failed?.length || vqResult.allFailed?.length || 0;
    console.log(`  VQ lines written: ${vqWritten}`);
    console.log(`  VQ lines flagged: ${vqFlagged}`);
    console.log(`  VQ lines failed: ${vqFailed}`);

    const flaggedItems = vqResult.flagged || vqResult.allFlagged || [];
    if (flaggedItems.length > 0) {
      console.log('  Flagged items:');
      for (const f of flaggedItems) {
        console.log(`    ${f.mpn || f.cpc}: ${f.reason} — ${f.detail || ''}`);
      }
    }
  } else {
    console.log('  No franchise data available — skipping VQ write.');
  }

  // ── Step 3: Write mapping file for email step ──
  const lineMapping = {};
  rfqCandidates.forEach((c, i) => {
    lineMapping[c.mpn] = (i + 1) * 10; // Line 10, 20, 30...
  });

  const mappingFile = sourcedCsvPath.replace('_sourced.csv', '_rfq_mapping.json');
  const mapping = {
    rfqSearchKey: rfqResult.searchKey,
    rfqId: rfqResult.rfqId,
    linesWritten: rfqResult.linesWritten,
    vqItems: vqItems.length,
    lines: lineMapping,
  };
  fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
  console.log(`\nMapping written to: ${mappingFile}`);

  // ── Summary ──
  console.log('\n=== RFQ Summary ===');
  console.log(`  RFQ: ${rfqResult.searchKey} (3PL/VMI)`);
  console.log(`  Customer: Lam Research`);
  console.log(`  Contact: Rob Johnson`);
  console.log(`  Salesrep: Josh Syre`);
  console.log(`  Lines: ${rfqResult.linesWritten}`);
  console.log(`  VQ items sourced: ${vqItems.length}`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
