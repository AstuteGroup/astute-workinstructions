#!/usr/bin/env node
/**
 * Rerun VQ Writing and Auto-Purchase for existing RFQ
 *
 * Usage: node rerun-vq-autopurchase.js
 */

const fs = require('fs');
const path = require('path');
const { readCSVFile } = require('../../shared/csv-utils');
const { writeVQBatch } = require('../../shared/vq-writer');
const { tickVQForPurchase } = require('../../shared/vq-patcher');
const { postApproveOrder } = require('../../shared/r-request-writer');
const { buildCopyTextVQOnly } = require('../../shared/copy-text-builder');

const RFQ_SEARCH_KEY = '1140636';
const RFQ_ID = 1150051;
const AUTO_PURCHASE_MARGIN_PCT = 18;

const OUTPUT_DIR = path.join(__dirname, 'output');
const SOURCED_CSV = path.join(OUTPUT_DIR, 'LAM_Reorder_Alerts_2026-07-29_sourced.csv');
const FRANCHISE_JSON = path.join(OUTPUT_DIR, 'LAM_Reorder_Alerts_2026-07-29_sourced_franchise_data.json');
const MAPPING_JSON = path.join(OUTPUT_DIR, 'LAM_Reorder_Alerts_2026-07-29_rfq_mapping.json');

async function main() {
  console.log('=== Rerun VQ Writing and Auto-Purchase ===');
  console.log(`RFQ: ${RFQ_SEARCH_KEY} (ID: ${RFQ_ID})`);
  console.log('');

  // Load data
  const csv = readCSVFile(SOURCED_CSV);
  const franchiseData = JSON.parse(fs.readFileSync(FRANCHISE_JSON, 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(MAPPING_JSON, 'utf8'));

  const headers = csv.headers;
  const mpnIdx = headers.indexOf('MPN');
  const cpcIdx = headers.indexOf('CPC');
  const mfrIdx = headers.indexOf('Manufacturer');
  const lamMoqIdx = headers.indexOf('LAM MOQ');
  const lamResaleIdx = headers.indexOf('LAM Resale');
  const inStockSupplierIdx = headers.indexOf('In-Stock Supplier');
  const inStockPriceIdx = headers.indexOf('In-Stock Price');
  const inStockQtyIdx = headers.indexOf('In-Stock Qty');

  // Step 1: Build VQ items with MFR from CSV
  console.log('Step 1: Building VQ items from franchise data...');
  const vqItems = [];

  for (const row of csv.rows) {
    const mpn = row[mpnIdx];
    if (!mpn) continue;

    const franchiseResults = franchiseData[mpn]?.[mpn];
    if (!franchiseResults?.distributors) continue;

    vqItems.push({
      mpn,
      cpc: row[cpcIdx] || '',
      mfrText: row[mfrIdx] || '',  // MFR from roster/CSV as fallback
      franchiseResults,
    });
  }

  console.log(`  ${vqItems.length} items with franchise data`);

  // Step 2: Write VQs
  console.log('');
  console.log('Step 2: Writing VQ lines...');

  const vqResult = await writeVQBatch(RFQ_SEARCH_KEY, vqItems, {
    delayMs: 100,
    applyRestrictedMfrGate: true,
  });

  const writtenVQs = vqResult.written || vqResult.allWritten || [];
  const flaggedVQs = vqResult.flagged || vqResult.allFlagged || [];
  const failedVQs = vqResult.failed || vqResult.allFailed || [];

  console.log(`  Written: ${writtenVQs.length}`);
  console.log(`  Flagged: ${flaggedVQs.length}`);
  console.log(`  Failed: ${failedVQs.length}`);

  if (flaggedVQs.length > 0) {
    console.log('  Flagged items:');
    for (const f of flaggedVQs.slice(0, 10)) {
      console.log(`    ${f.mpn}: ${f.reason} — ${f.detail || ''}`);
    }
    if (flaggedVQs.length > 10) console.log(`    ... and ${flaggedVQs.length - 10} more`);
  }

  // Step 3: Auto-purchase pass
  console.log('');
  console.log('Step 3: Auto-purchase pass...');

  const autoRequests = {};
  const today = new Date();
  const promiseDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const row of csv.rows) {
    const mpn = row[mpnIdx];
    const stockSupplier = row[inStockSupplierIdx];
    const stockPrice = parseFloat(row[inStockPriceIdx]) || 0;
    const stockQty = parseInt(row[inStockQtyIdx]) || 0;
    const lamMoq = parseInt(row[lamMoqIdx]) || 0;
    const lamResale = parseFloat(row[lamResaleIdx]) || 0;

    if (!mpn || !stockSupplier || stockPrice <= 0 || stockQty <= 0) continue;
    if (lamMoq <= 0 || lamResale <= 0) continue;

    const margin = ((lamResale - stockPrice) / lamResale) * 100;
    if (margin < AUTO_PURCHASE_MARGIN_PCT) continue;
    if (stockQty < lamMoq) continue;

    // Find matching VQ
    const vendorKey = stockSupplier.split(/[\s\-]/)[0].toLowerCase();
    const matchVQ = writtenVQs.find(w =>
      w.mpn === mpn &&
      (w.vendor || '').toLowerCase().includes(vendorKey) &&
      Math.abs(Number(w.price) - stockPrice) < 0.01
    );

    if (!matchVQ) {
      console.log(`  [skip] ${mpn} — no VQ match for "${stockSupplier}" @ $${stockPrice}`);
      continue;
    }

    const rfqLineNo = mapping.lines[mpn] || 0;
    const mfrText = row[mfrIdx] || matchVQ.mfr || '';
    const lineCost = stockPrice * lamMoq;

    // Build proper Copy Text
    const approvalText = buildCopyTextVQOnly({
      customer: 'Lam Research',
      totalCost: lineCost,
      rfqLineNo,
      purchaseQty: lamMoq,
      soldQty: 0,
      mpn,
      mfr: mfrText,
      salesRep: 'Jake Harris',
      vendor: stockSupplier,
      vendorType: 'Franchise',
      traceability: 'Authorized Distribution Certs',
      qty: lamMoq,
      cost: stockPrice,
      dateCode: '24+',
      coo: 'PENDING',
      leadTime: 'STOCK',
    });

    const autoApprovalMessage =
      `Auto-approved via rerun — in-stock margin ${margin.toFixed(1)}% >= ${AUTO_PURCHASE_MARGIN_PCT}%, ` +
      `vendor stock ${stockQty} >= LAM MOQ ${lamMoq}.`;

    let tickSucceeded = false;
    try {
      await tickVQForPurchase(matchVQ.vqLineId, {
        program: 'LAM_KITTING',
        extra: {
          Qty: lamMoq,
          Chuboe_Note_User: `Auto-purchase — ${stockSupplier} stock at tick: ${stockQty} pcs (buying LAM MOQ ${lamMoq})`,
          IsChuboeDomesticShipping: 'Y',
          Chuboe_Lead_Time: 'STOCK',
          DatePromised: promiseDate,
          DueDate: promiseDate,
          Chuboe_Warehouse_ID: 1000015,
          Chuboe_Warehouse_Group_ID: 1000008,
          M_Shipper_ID: 1000003,
          Chuboe_Inco_Term_ID: 1000000,
        },
      });
      tickSucceeded = true;

      const r = await postApproveOrder({
        vqId: matchVQ.vqLineId,
        program: 'LAM_KITTING',
        rfqId: RFQ_ID,
        summary: `approve order — ${stockSupplier} ${mpn} (LAM Kitting)`,
        approvalText,
        message: autoApprovalMessage,
      });
      autoRequests[mpn] = r.documentNo;
      console.log(`  ✓ ${mpn} — VQ ${matchVQ.vqLineId} ticked; R_Request ${r.documentNo} (margin ${margin.toFixed(1)}%)`);
    } catch (err) {
      console.log(`  ✗ ${mpn} — auto-purchase failed: ${err.message}`);
      if (err.violations) err.violations.forEach(v => console.log(`      - ${v}`));

      if (tickSucceeded) {
        try {
          const { patchRecord } = require('../../shared/record-updater');
          await patchRecord('chuboe_vq_line', matchVQ.vqLineId, { IsPurchased: 'N' });
          console.log(`      [rollback] VQ ${matchVQ.vqLineId} unticked`);
        } catch (rollbackErr) {
          console.log(`      [rollback FAILED] VQ ${matchVQ.vqLineId} may be orphaned`);
        }
      }
    }
  }

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`VQs written: ${writtenVQs.length}`);
  console.log(`VQs flagged: ${flaggedVQs.length}`);
  console.log(`Auto-approved: ${Object.keys(autoRequests).length}`);

  if (Object.keys(autoRequests).length > 0) {
    console.log('');
    console.log('Auto-approval requests:');
    for (const [mpn, docNo] of Object.entries(autoRequests)) {
      console.log(`  ${mpn}: R_Request ${docNo}`);
    }
  }

  // Update mapping file
  mapping.autoRequests = autoRequests;
  mapping.rerunAt = new Date().toISOString();
  fs.writeFileSync(MAPPING_JSON, JSON.stringify(mapping, null, 2));
  console.log('');
  console.log('Mapping file updated.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
