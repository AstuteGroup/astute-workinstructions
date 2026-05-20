#!/usr/bin/env node
//
// Recover the VQs that the vq-loading-agent's UID 8519 reprocess (Betty Song's
// "upload VQ May 13th" red-row reprocess at 2026-05-20 10:20 CT) reported as
// "written" but didn't actually persist in OT, plus the 1 quote blocked by an
// MPN trailing-space mismatch on 1134281.
//
// Inputs:
//   - sessions/2026-05-20-uid8519-betty-red-only.json — the 42 quotes the agent
//     extracted with §3.7.0 HTML red-row detection (validated by the operator)
//
// Pre-check: query OT for existing active VQs across the 9 candidate RFQs on
// the (MPN, cost) signature. Quotes already present are SKIPPED. Only the
// truly-missing set is sent to loadBulkSummary.
//
// MPN trim fix already applied to vq-writer.js (line 253 + line 281). The
// Samwooele/GRM31CR60J476ME19L on 1134281 will now match.

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
const SNAPSHOT = path.join(process.env.HOME, 'workspace', 'recover-uid8519-snapshot.json');

// RFQs in Betty's email — only ones with red rows matter for re-attempt:
// 1134264 primary, 1134964/1134279/1134281 secondaries.
// 1134254 has only a no-price Sehot row (correctly skipped).
// 1134258/1134259/1134282 had 0 red rows.
// 1141962 is a typo — BZT52H quotes correctly landed on 1134264 via MPN match.
const RFQ_TARGETS = ['1134264', '1134964', '1134279', '1134281'];
const ALL_RFQS = [...RFQ_TARGETS, '1134254', '1134258', '1134259', '1134282']; // for existence pre-check
const BUYER_ID = 1011159; // Betty Song

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function pullExistingVQSignatures() {
  const sql =
    `SELECT TRIM(UPPER(v.chuboe_mpn)), v.cost, v.qty, COALESCE(LOWER(bp.name),'') ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id ` +
    `WHERE r.value IN (${ALL_RFQS.map(r => `'${r}'`).join(',')}) AND v.isactive='Y'`;
  const out = psqlPipe(sql);
  const set = new Set();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [mpn, cost, qty, vendor] = line.split('|');
    // Key on (MPN, cost, qty) — strong enough to prevent dupes without depending on vendor-name precision
    const key = mpn + '|' + parseFloat(cost).toFixed(6) + '|' + parseInt(qty, 10);
    set.add(key);
  }
  return set;
}

function quoteKey(q) {
  const mpn = (q.mpn || '').trim().toUpperCase();
  return mpn + '|' + parseFloat(q.cost).toFixed(6) + '|' + parseInt(q.qty, 10);
}

(async () => {
  const quotes = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
  console.log(`Loaded ${quotes.length} quotes from agent payload\n`);

  console.log('=== Pre-check: existing active VQs across the 9 RFQs ===');
  const existing = pullExistingVQSignatures();
  console.log(`Found ${existing.size} existing (MPN, cost, qty) signatures\n`);

  const toAttempt = [];
  const alreadyThere = [];
  for (const q of quotes) {
    if (existing.has(quoteKey(q))) alreadyThere.push(q);
    else toAttempt.push(q);
  }

  console.log(`Already in OT: ${alreadyThere.length}`);
  console.log(`To attempt:    ${toAttempt.length}\n`);

  if (toAttempt.length === 0) {
    console.log('Nothing to recover. Exiting.');
    return;
  }

  console.log('--- To-attempt list ---');
  for (const q of toAttempt) {
    console.log(`  ${q.vendorName || '?'} / ${q.mpn} @ $${q.cost} qty=${q.qty}` +
      (q.leadTime ? ` lt=${q.leadTime}` : '') + (q.currency ? ` ccy=${q.currency}` : ''));
  }
  console.log();

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
      if (result.failed.length > 0) {
        for (const f of result.failed) {
          console.log(`    FAIL: ${f.vendorName || '?'} / ${f.mpn} — ${f.reason}: ${(f.detail || f.error || '').slice(0, 200)}`);
        }
      }
      allResults.push({ rfq, written: result.written, skipped: result.skipped, failed: result.failed });
    } catch (err) {
      console.error(`  ERROR for RFQ ${rfq}: ${err.message}`);
      allResults.push({ rfq, error: err.message });
    }
    console.log();
  }

  // Summary
  let totalWritten = 0, totalFailed = 0;
  for (const r of allResults) {
    totalWritten += (r.written || []).length;
    totalFailed += (r.failed || []).length;
  }
  console.log('=== Summary ===');
  console.log(`Total new writes: ${totalWritten}`);
  console.log(`Total failed:     ${totalFailed}`);
  console.log(`Snapshot:         ${SNAPSHOT}`);

  fs.writeFileSync(SNAPSHOT, JSON.stringify({
    ts: new Date().toISOString(),
    payloadFile: PAYLOAD,
    rfqTargets: RFQ_TARGETS,
    quotesLoaded: quotes.length,
    alreadyThere: alreadyThere.length,
    toAttempt: toAttempt.length,
    totalWritten,
    totalFailed,
    results: allResults,
  }, null, 2));
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
