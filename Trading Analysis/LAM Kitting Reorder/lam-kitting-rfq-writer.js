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
const { tickVQForPurchase } = require('../../shared/vq-patcher');
const { postApproveOrder } = require('../../shared/r-request-writer');

// ─── Constants ──────────────────────────────────────────────────────────────

const LAM_BPARTNER_ID = 1000730;       // Lam Research
const LAM_CONTACT_ID = 1033762;        // Rob Johnson
const SALESREP_ID = 1007049;           // Josh Syre (internal employee record)
const RFQ_TYPE = '3PL/VMI';

// Auto-purchase threshold — ticks IsPurchased='Y' + posts approve-order R_Request
// when the best in-stock franchise margin is at-or-above this percentage AND the
// vendor's available stock covers the LAM MOQ. 18% = the green band on the report.
const AUTO_PURCHASE_MARGIN_PCT = 18.0;

// Add N US business days to a date (skips Sat/Sun). Used for promise date default
// when a franchise vendor says "STOCK" / "In Stock" — convention per data-model.md.
function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

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

  let vqResult = null;
  if (vqItems.length > 0) {
    vqResult = await writeVQBatch(rfqResult.searchKey, vqItems, {
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

  // ── Step 3: Auto-purchase — tick best-in-stock VQ + post approve-order R_Request
  // for lines where the franchise margin comfortably clears the 18% green-band
  // threshold AND the vendor has enough stock to fill LAM MOQ in a single shot.
  // Everything else stays on the manual-review path.
  const autoRequests = {};   // mpn → R_Request documentNo

  if (vqResult && (vqResult.written || vqResult.allWritten)) {
    console.log('\nStep 3: Auto-purchase pass (margin ≥ 18%, stock ≥ LAM MOQ)...');
    const writtenVQs = vqResult.allWritten || vqResult.written || [];
    const stockSupplierIdx = headers.indexOf('In Stock Supplier');
    const stockPriceIdx    = headers.indexOf('In Stock Price');
    const stockQtyIdx      = headers.indexOf('In Stock Qty');
    const stockMarginIdx   = headers.indexOf('In Stock Margin %');
    const moqIdx           = headers.indexOf('LAM MOQ');
    const mfrIdxAuto       = headers.indexOf('Manufacturer');

    const promiseDate = addBusinessDays(new Date(), 5).toISOString().split('T')[0];

    for (const row of csv.rows) {
      const mpn = (row[mpnIdx] || '').trim();
      if (!mpn) continue;

      const marginRaw = String(row[stockMarginIdx] || '').replace('%', '').trim();
      const margin = parseFloat(marginRaw);
      const stockQty = parseInt(row[stockQtyIdx], 10) || 0;
      const lamMoq = parseInt(row[moqIdx], 10) || 0;
      const stockSupplier = (row[stockSupplierIdx] || '').trim();
      const stockPrice = parseFloat(row[stockPriceIdx]) || 0;

      if (!isFinite(margin) || margin < AUTO_PURCHASE_MARGIN_PCT) continue;
      if (stockQty < lamMoq || lamMoq <= 0) continue;
      if (!stockSupplier || !stockPrice) continue;

      // Find the matching VQ row (mpn + vendor substring + price). Vendor names
      // in the franchise CSV and the VQ writer's output occasionally differ in
      // punctuation (e.g., "Sager" vs "Sager - v3004"), so match on the first
      // word of the supplier and an exact-ish price.
      const vendorKey = stockSupplier.split(/[\s\-]/)[0].toLowerCase();
      const matchVQ = writtenVQs.find(w =>
        w.mpn === mpn
        && (w.vendor || '').toLowerCase().includes(vendorKey)
        && Math.abs(Number(w.price) - stockPrice) < 0.01);
      if (!matchVQ) {
        console.log(`  [skip] ${mpn} — no VQ match for "${stockSupplier}" @ $${stockPrice}`);
        continue;
      }

      const rfqLineNo = lineMappingForAuto(rfqCandidates, mpn);
      const approvalText =
        `Line ${rfqLineNo}  ${mpn}  ${lamMoq}pcs @ $${stockPrice}  DC 24+  ${row[mfrIdxAuto] || ''}\n` +
        `Vendor: ${stockSupplier}\n` +
        `Auto-approved — in-stock margin ${margin.toFixed(1)}% ≥ ${AUTO_PURCHASE_MARGIN_PCT}%, stock ${stockQty} ≥ LAM MOQ ${lamMoq}`;

      try {
        await tickVQForPurchase(matchVQ.vqLineId, {
          program: 'LAM_KITTING',
          extra: {
            Chuboe_Lead_Time:          'STOCK',
            DatePromised:              promiseDate,
            Chuboe_Warehouse_ID:       1000015,   // W111 LAM KITTING
            Chuboe_Warehouse_Group_ID: 1000008,   // BROWNSVILLE
            M_Shipper_ID:              1000003,   // FedEx Ground
            Chuboe_Inco_Term_ID:       1000000,   // EXW
          },
        });
        const r = await postApproveOrder({
          vqId:         matchVQ.vqLineId,
          program:      'LAM_KITTING',
          rfqId:        rfqResult.rfqId,
          summary:      `approve order — ${stockSupplier} ${mpn} (LAM Kitting)`,
          approvalText,
        });
        autoRequests[mpn] = r.documentNo;
        console.log(`  ✓ ${mpn} — VQ ${matchVQ.vqLineId} ticked; R_Request ${r.documentNo} (margin ${margin.toFixed(1)}%)`);
      } catch (err) {
        console.log(`  ✗ ${mpn} — auto-purchase failed: ${err.message}`);
        if (err.violations) err.violations.forEach(v => console.log(`      - ${v}`));
      }
    }

    const count = Object.keys(autoRequests).length;
    console.log(`Step 3 complete — ${count} auto-approved`);
  }

  // ── Step 4: Write mapping file for email step ──
  const lineMapping = {};
  rfqCandidates.forEach((c, i) => {
    lineMapping[c.mpn] = (i + 1) * 10; // Line 10, 20, 30...
  });

  const mappingFile = sourcedCsvPath.replace('_sourced.csv', '_rfq_mapping.json');
  const mapping = {
    rfqSearchKey:  rfqResult.searchKey,
    rfqId:         rfqResult.rfqId,
    linesWritten:  rfqResult.linesWritten,
    vqItems:       vqItems.length,
    lines:         lineMapping,
    autoRequests,                    // mpn → R_Request documentNo for auto-approved lines
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
  console.log(`  Auto-approved: ${Object.keys(autoRequests).length}`);
}

// Small helper so the main loop stays readable — maps an MPN to its RFQ line
// number using the same incremental-by-10 scheme as the Step 4 mapping write.
function lineMappingForAuto(rfqCandidates, mpn) {
  const idx = rfqCandidates.findIndex(c => c.mpn === mpn);
  return idx >= 0 ? (idx + 1) * 10 : '?';
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
