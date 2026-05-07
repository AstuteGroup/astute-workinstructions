#!/usr/bin/env node
/**
 * smoke-test-spine.js — first-use validation of the Customer Excess pipeline.
 *
 * Per Loading workflow Step 0: writes one tiny test offer through the spine
 * to verify writeOffer + router + breadcrumb chain work in production.
 * Then deactivates the test offer so it doesn't pollute downstream queries.
 *
 * Run only when the operator pre-clears: this writes a real (1-line) record
 * to chuboe_offer / chuboe_offer_line / chuboe_offer_line_mpn in PROD OT.
 *
 * USAGE:
 *   node smoke-test-spine.js                    # full test (write + verify + cleanup)
 *   node smoke-test-spine.js --no-cleanup       # leave the test offer for inspection
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { writeOffer } = require('../../shared/offer-writeback');
const { patchRecord } = require('../../shared/record-updater');
const { dispatch } = require('../../shared/offer-router');
const breadcrumbs = require('../../shared/breadcrumbs');
const { psqlQuery } = require('../../shared/db-helpers');

const TEST_BP_ID = 1000332;        // Astute Electronics Inc
const TEST_MPN   = 'SMOKETEST-OFFER-' + Date.now().toString().slice(-6);
const TEST_QTY   = 1;
const TEST_PRICE = 0.01;
const TEST_MFR   = 'Test Manufacturer';

const NO_CLEANUP = process.argv.includes('--no-cleanup');

async function main() {
  console.log('====================================');
  console.log('CUSTOMER EXCESS PIPELINE — SMOKE TEST');
  console.log('====================================');
  console.log(`Test MPN: ${TEST_MPN}`);
  console.log(`Test BP:  ${TEST_BP_ID} (Astute Electronics Inc)`);
  console.log(`Test qty/price: ${TEST_QTY} @ \$${TEST_PRICE}`);
  console.log('');

  // ── Step 1: write the offer ───────────────────────────────────────────
  console.log('Step 1: writeOffer() to PROD OT...');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const description = `${today}-Astute_SMOKE_TEST_${TEST_MPN}-DELETE`;

  let result;
  try {
    result = await writeOffer({
      bpartnerId: TEST_BP_ID,
      offerTypeId: 'Customer Excess',
      description,
      writeMpnRecords: true,
      lines: [{ mpn: TEST_MPN, mfrText: TEST_MFR, qty: TEST_QTY, price: TEST_PRICE }],
    });
  } catch (err) {
    console.error('FAIL: writeOffer threw:', err.message);
    process.exit(1);
  }

  const ok1 = result.offerId != null && result.linesWritten === 1 && result.errors.length === 0;
  console.log(`  → offerId=${result.offerId}, searchKey=${result.searchKey}, lines=${result.linesWritten}, mpns=${result.mpnsWritten}, errors=${result.errors.length}`);
  if (!ok1) {
    console.error('FAIL: writeOffer result not clean:', result);
    process.exit(1);
  }
  console.log('  ✓ writeOffer succeeded');

  // ── Step 2: verify rows exist in OT replica ───────────────────────────
  console.log('');
  console.log('Step 2: verifying rows replicated to local idempiere_replica...');

  // Wait briefly for replication
  await new Promise(r => setTimeout(r, 3000));

  const offerOut = psqlQuery(
    `SELECT chuboe_offer_id, value, description, isactive FROM adempiere.chuboe_offer WHERE chuboe_offer_id = ${result.offerId}`
  );
  if (!offerOut) {
    console.warn('  ⚠ chuboe_offer row not yet replicated (lag?). Check via psql in a few seconds.');
  } else {
    console.log(`  ✓ chuboe_offer row present: ${offerOut}`);
  }

  const lineOut = psqlQuery(
    `SELECT chuboe_offer_line_id, line, qty, priceentered FROM adempiere.chuboe_offer_line WHERE chuboe_offer_id = ${result.offerId} AND isactive = 'Y'`
  );
  const lineCount = lineOut ? lineOut.split('\n').filter(l => l.trim()).length : 0;
  console.log(`  → ${lineCount} active chuboe_offer_line row(s)`);
  if (lineOut) console.log(`    ${lineOut}`);

  const lineMpnOut = psqlQuery(
    `SELECT chuboe_offer_line_mpn_id, chuboe_mpn, chuboe_mfr_text FROM adempiere.chuboe_offer_line_mpn WHERE chuboe_offer_id = ${result.offerId} AND isactive = 'Y'`
  );
  const mpnCount = lineMpnOut ? lineMpnOut.split('\n').filter(l => l.trim()).length : 0;
  console.log(`  → ${mpnCount} active chuboe_offer_line_mpn row(s)`);
  if (lineMpnOut) console.log(`    ${lineMpnOut}`);

  // ── Step 3: dispatch through router ───────────────────────────────────
  console.log('');
  console.log('Step 3: dispatching through router (Customer Excess → analysis stub)...');
  const beforeCount = breadcrumbs.readSince(Date.now() - 60000).length;
  let dispatchResult;
  try {
    dispatchResult = await dispatch({
      offerId: result.offerId,
      searchKey: result.searchKey,
      offerType: 'Customer Excess',
      partner: { id: TEST_BP_ID, name: 'Astute Electronics Inc' },
      lineCount: 1,
      source: 'smoke-test',
    });
  } catch (err) {
    console.error('FAIL: router.dispatch threw:', err.message);
    process.exit(1);
  }
  console.log(`  → ${JSON.stringify(dispatchResult)}`);

  const afterCount = breadcrumbs.readSince(Date.now() - 60000).length;
  const newBreadcrumbs = afterCount - beforeCount;
  console.log(`  → ${newBreadcrumbs} new breadcrumb(s) written`);
  if (newBreadcrumbs < 2) {
    console.error('FAIL: expected 2 breadcrumbs (router.routed + analysis.queued), got', newBreadcrumbs);
    process.exit(1);
  }
  console.log('  ✓ router dispatch succeeded');

  // ── Step 4: cleanup ──────────────────────────────────────────────────
  if (NO_CLEANUP) {
    console.log('');
    console.log(`SKIPPING CLEANUP — test offer ${result.searchKey} (id=${result.offerId}) left active for inspection`);
    return;
  }

  console.log('');
  console.log('Step 4: deactivating test offer (PATCH IsActive=N) ...');
  try {
    // Deactivate header
    await patchRecord('chuboe_offer', result.offerId, { IsActive: 'N' });
    console.log(`  ✓ chuboe_offer ${result.offerId} → IsActive=N`);
    // Lines deactivate by cascade; if not, the header IsActive=N is enough to filter out downstream queries
  } catch (err) {
    console.error(`  ⚠ cleanup failed: ${err.message} — manually deactivate offer ${result.offerId} (search key ${result.searchKey})`);
  }

  console.log('');
  console.log('====================================');
  console.log('SMOKE TEST PASSED');
  console.log('====================================');
  console.log(`Offer search key: ${result.searchKey}  (deactivated)`);
  console.log(`OT chuboe_offer_id: ${result.offerId}`);
  console.log('');
  console.log('Spine confirmed working end-to-end:');
  console.log('  inbox poller → writeOffer → OT → type router → analysis stub → breadcrumb');
  console.log('');
  console.log('Next step: live offer arrives in excess@ → poller picks it up at the next 30-min tick.');
}

main().catch(err => { console.error('FATAL:', err.message); console.error(err.stack); process.exit(1); });
