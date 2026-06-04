#!/usr/bin/env node
/**
 * Regression test: load-bulk-summary must surface writer's skipped[] correctly.
 *
 * Background: pre-2026-05-22, load-bulk-summary checked only
 * `result.written.length > 0` from writeVQFromAPI and fell through to its own
 * failed[] bucket when written was empty — silently mis-classifying every
 * PRE_EXISTING_DUPLICATE the writer correctly detected. Surfaced when Ivy's
 * 5/21 resend of RFQ 1133479 showed failed:73 / skipped:5 in the breadcrumb,
 * when in reality ~60 of those "failures" were dups.
 *
 * Test strategy: monkey-patch shared/api-client.apiPost so no real writes
 * occur, pick any active VQ row in OT, synthesize a "quote" payload that
 * targets that row's natural key, and assert that loadBulkSummary buckets it
 * as skipped[PRE_EXISTING_DUPLICATE] — NOT as failed.
 *
 * Self-anchoring: the test picks its own anchor row at runtime so it survives
 * deletion of any specific historical VQ. Requires DB connectivity (psql).
 *
 * Exit codes:
 *   0 — pass
 *   1 — fail (regression detected or setup error)
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const SHARED = path.join(__dirname, '..', 'shared');

// ── Monkey-patch apiPost BEFORE loadBulkSummary requires it ─────────────────
const apiClient = require(path.join(SHARED, 'api-client'));
apiClient.apiPost = async function mockApiPost() {
  const err = new Error('TEST: apiPost mocked — no writes allowed');
  err.statusCode = 500;
  err.isNetworkError = false;
  throw err;
};

const { loadBulkSummary } = require(path.join(SHARED, 'load-bulk-summary'));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function pass(msg) {
  console.log(`PASS: ${msg}`);
}

function pickAnchorRow() {
  // Recent, active VQ row on an active RFQ. Constrained to a row whose MPN
  // matches the RFQ line's MPN directly (avoids fuzzy-resolution edge cases).
  const sql = `
    SELECT
      v.chuboe_vq_line_id,
      r.value          AS rfq_search_key,
      v.chuboe_mpn,
      bp.value         AS bp_search_key,
      bp.name          AS bp_name,
      v.cost,
      v.qty,
      COALESCE(v.chuboe_mfr_text, '') AS mfr_text
    FROM adempiere.chuboe_vq_line v
    JOIN adempiere.chuboe_rfq_line l ON l.chuboe_rfq_line_id = v.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq      r ON r.chuboe_rfq_id      = l.chuboe_rfq_id
    JOIN adempiere.c_bpartner      bp ON bp.c_bpartner_id    = v.c_bpartner_id
    JOIN adempiere.chuboe_rfq_line_mpn m
      ON m.chuboe_rfq_line_id = l.chuboe_rfq_line_id
     AND m.chuboe_mpn         = v.chuboe_mpn
    WHERE v.isactive   = 'Y'
      AND r.isactive   = 'Y'
      AND l.isactive   = 'Y'
      AND m.isactive   = 'Y'
      AND v.cost       > 0
      AND v.qty        > 0
      AND v.c_currency_id = 100
      AND (v.chuboe_date_code IS NULL OR v.chuboe_date_code = '')
      AND v.chuboe_mfr_text IS NOT NULL
      AND v.chuboe_mfr_text <> ''
      AND v.created >= NOW() - INTERVAL '14 days'
    ORDER BY v.created DESC
    LIMIT 1;
  `;
  const out = execFileSync('psql', ['-At', '-F|', '-c', sql], { encoding: 'utf8' });
  const line = out.trim().split('\n').filter(Boolean)[0];
  if (!line) return null;
  const [vqLineId, rfqSearchKey, mpn, bpSearchKey, bpName, cost, qty, mfrText] = line.split('|');
  return {
    vqLineId: Number(vqLineId),
    rfqSearchKey, mpn, bpSearchKey, bpName,
    cost: parseFloat(cost),
    qty: parseInt(qty, 10),
    mfrText,
  };
}

(async function main() {
  console.log('Regression test: load-bulk-summary skipped[] propagation\n');

  const anchor = pickAnchorRow();
  if (!anchor) fail('Could not find an anchor VQ row in OT (no eligible row in last 14 days).');
  console.log(`Anchor: vq ${anchor.vqLineId} | RFQ ${anchor.rfqSearchKey} | ${anchor.mpn} | ${anchor.bpName} | $${anchor.cost}`);

  const result = await loadBulkSummary({
    rfqSearchKey: anchor.rfqSearchKey,
    buyerId: 1000004,
    quotes: [{
      vendorSearchKey: anchor.bpSearchKey,
      vendorName: anchor.bpName,
      mpn: anchor.mpn,
      mfr: anchor.mfrText,
      qty: anchor.qty,
      cost: anchor.cost,
    }],
  });

  console.log(`\nResult: written=${result.written.length} skipped=${result.skipped.length} failed=${result.failed.length}`);

  // Assertions
  if (result.failed.length > 0) {
    const fmt = result.failed.map(f => `${f.reason}: ${f.detail || f.error}`).join('; ');
    fail(`Expected failed:0 (dup should land in skipped). Got failed:${result.failed.length} — ${fmt}`);
  }
  pass('failed[] is empty (dup did not leak into failed bucket)');

  const dupRow = result.skipped.find(s => s.reason === 'PRE_EXISTING_DUPLICATE');
  if (!dupRow) {
    const reasons = result.skipped.map(s => s.reason).join(', ');
    fail(`Expected at least one skipped[reason=PRE_EXISTING_DUPLICATE]. Got reasons: ${reasons || '(none)'}`);
  }
  pass('skipped[] contains PRE_EXISTING_DUPLICATE row');

  if (dupRow.vqLineId !== anchor.vqLineId) {
    fail(`PRE_EXISTING_DUPLICATE row references vqLineId ${dupRow.vqLineId}, expected ${anchor.vqLineId}`);
  }
  pass(`PRE_EXISTING_DUPLICATE row references the correct anchor vqLineId (${anchor.vqLineId})`);

  console.log('\nAll assertions passed.');
  process.exit(0);
})().catch(err => {
  fail(`Unhandled exception: ${err.stack || err.message}`);
});
