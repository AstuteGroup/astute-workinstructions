#!/usr/bin/env node
//
// v2 recovery for Betty Song's "upload VQ May 13th" reprocess (UID 8519).
// v1 (recover-uid8519-missing-vqs.js) showed that the 8 truly-missing quotes
// all fail at BP resolution — resolveBP's name fuzzy-match picks wrong/
// no-VendorType BPs, leading to "Chuboe_VendorType null" 500 errors.
//
// v2 manually overrides vendorSearchKey for each quote based on operator-
// verified vendor → BP mappings (typos like "HK Dethchy" → "HK Detechy",
// "Samwooele" → "SAMWOO ELECO", "Louise yen" → "Louis Yen Singapore", etc.).
// "roson" has no BP match in OT — flagged for operator and skipped.
//
// MPN trim fix already in vq-writer.js. Idempotent natural-key dedup
// prevents double-writes against any already-present VQs.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const { loadBulkSummary } = require('../shared/load-bulk-summary');

const PAYLOAD = path.join(
  __dirname, '..',
  'Trading Analysis/RFQ Sourcing/vq_loading/sessions/2026-05-20-uid8519-betty-red-only.json',
);
const SNAPSHOT = path.join(process.env.HOME, 'workspace', 'recover-uid8519-v2-snapshot.json');

// Operator-verified vendor → BP search-key mapping (2026-05-20)
// Key = LOWER(quote.vendorName); Value = c_bpartner.value (search key)
const VENDOR_OVERRIDE = {
  'echo':         { searchKey: '1011728', canonicalName: 'ECHO COMPONENTS CO.,LTD' },
  'hm':           { searchKey: '1008556', canonicalName: 'HM Tech Electronic Limited' },
  'haoxin':       { searchKey: '1006032', canonicalName: 'Haoxin Hk Electronic Technology Co., Limited' },
  'hk dethchy':   { searchKey: '1008171', canonicalName: 'HK Detechy CO., LIMITED' }, // typo for "HK Detechy"
  'samwooele':    { searchKey: '1009392', canonicalName: 'SAMWOO ELECO CO..LTD' },     // typo for Samwoo Eleco
  'louise yen':   { searchKey: '1002685', canonicalName: 'Louis Yen Singapore Pte., Ltd' }, // typo for Louis Yen
  // 'roson' has no BP match — handled below as skip + operator flag
};

const RFQ_TARGETS = ['1134264', '1134964', '1134279', '1134281'];
const ALL_RFQS = [...RFQ_TARGETS, '1134254', '1134258', '1134259', '1134282'];
const BUYER_ID = 1011159; // Betty Song

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function pullExistingVQSignatures() {
  const sql =
    `SELECT TRIM(UPPER(v.chuboe_mpn)), v.cost, v.qty ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `WHERE r.value IN (${ALL_RFQS.map(r => `'${r}'`).join(',')}) AND v.isactive='Y'`;
  const out = psqlPipe(sql);
  const set = new Set();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [mpn, cost, qty] = line.split('|');
    set.add(mpn + '|' + parseFloat(cost).toFixed(6) + '|' + parseInt(qty, 10));
  }
  return set;
}

function quoteKey(q) {
  const mpn = (q.mpn || '').trim().toUpperCase();
  return mpn + '|' + parseFloat(q.cost).toFixed(6) + '|' + parseInt(q.qty, 10);
}

(async () => {
  const quotes = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
  const existing = pullExistingVQSignatures();
  console.log(`Loaded ${quotes.length} quotes; ${existing.size} existing OT signatures\n`);

  const skippedAsRoson = [];
  const toAttempt = [];
  for (const q of quotes) {
    if (existing.has(quoteKey(q))) continue; // already there
    const vname = (q.vendorName || '').trim().toLowerCase();
    const ov = VENDOR_OVERRIDE[vname];
    if (ov) {
      toAttempt.push({ ...q, vendorSearchKey: ov.searchKey, vendorName: ov.canonicalName });
    } else {
      // Unmapped — operator needs to disambiguate (e.g., "roson")
      skippedAsRoson.push({ ...q, reason: 'NO_VENDOR_BP_MAPPING' });
    }
  }
  console.log(`To attempt with overrides: ${toAttempt.length}`);
  console.log(`Skipped (no BP mapping):   ${skippedAsRoson.length}`);
  if (skippedAsRoson.length > 0) {
    for (const s of skippedAsRoson) {
      console.log(`  SKIP: ${s.vendorName} / ${s.mpn} @ $${s.cost} qty=${s.qty} — needs operator follow-up`);
    }
  }
  console.log();

  if (toAttempt.length === 0) {
    console.log('Nothing to recover.');
    return;
  }

  const allResults = [];
  for (const rfq of RFQ_TARGETS) {
    console.log(`=== loadBulkSummary against RFQ ${rfq} ===`);
    try {
      const result = await loadBulkSummary({
        rfqSearchKey: rfq,
        buyerId: BUYER_ID,
        quotes: toAttempt,
        dryRun: false,
      });
      console.log(`  written=${result.written.length} skipped=${result.skipped.length} failed=${result.failed.length}`);
      for (const w of result.written) {
        console.log(`    WROTE: vqId=${w.vqLineId} line=${w.line} ${w.vendor} / ${w.mpn} @ $${w.cost}`);
      }
      for (const f of result.failed) {
        console.log(`    FAIL: ${f.vendorName || '?'} / ${f.mpn} — ${f.reason}: ${(f.detail || f.error || '').slice(0, 200)}`);
      }
      allResults.push({ rfq, written: result.written, skipped: result.skipped, failed: result.failed });
    } catch (err) {
      console.error(`  ERROR for RFQ ${rfq}: ${err.message}`);
      allResults.push({ rfq, error: err.message });
    }
    console.log();
  }

  let totalWritten = 0, totalFailed = 0;
  for (const r of allResults) {
    totalWritten += (r.written || []).length;
    totalFailed += (r.failed || []).length;
  }
  console.log('=== Summary ===');
  console.log(`Total new writes: ${totalWritten}`);
  console.log(`Total failed:     ${totalFailed}`);
  console.log(`Operator follow-up: ${skippedAsRoson.length} (no BP mapping)`);
  console.log(`Snapshot: ${SNAPSHOT}`);

  fs.writeFileSync(SNAPSHOT, JSON.stringify({
    ts: new Date().toISOString(),
    payloadFile: PAYLOAD,
    vendorOverrides: VENDOR_OVERRIDE,
    rfqTargets: RFQ_TARGETS,
    quotesLoaded: quotes.length,
    toAttempt: toAttempt.length,
    skippedNoBp: skippedAsRoson,
    totalWritten,
    totalFailed,
    results: allResults,
  }, null, 2));
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
