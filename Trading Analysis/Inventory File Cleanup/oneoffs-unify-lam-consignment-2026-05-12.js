/**
 * One-off: Unify LAM Consignment into a single offer under BP 1011267.
 *
 * Today (mid-week, 2026-05-12):
 *   - offer 1026247 (BP 1000730 Lam Research) = 103-line 5/8 misload via excess agent
 *   - offer 1026218 (BP 1011267 LAM Consignment) = 30-line carryover (post auto-retire 5/6)
 *   - no active "Weekly inventory ... LAM_Consignment" — next inventory cron is 5/18
 *
 * This script:
 *   1. Deactivates 1026218 (current 30-line carryover under LAM Consignment BP)
 *   2. Deactivates 1026247 (misload under wrong BP)
 *   3. Writes a new unified offer under BP 1011267 / Type 1000014 with all 103
 *      POV0071878 static-seed lines preserved from 1026247
 *
 * Stands until the 5/18 cron, which (after the unification code change) will
 * refresh this offer with merged static + live W118 contents.
 */

const fs = require('fs');
const { deactivatePriorOffers, writeOffer } = require('./astute-workinstructions/shared/offer-writeback');

const LAM_CONSIGNMENT_BP = 1011267;
const STOCK_PHILIPPINES_TYPE = 1000014;
const MISLOAD_BP = 1000730;
const MISLOAD_DESC_SUFFIX = 'uid 1209)';
const DESCRIPTION = '[Unified LAM Consignment] Static seed POV0071878 — refreshed 2026-05-12 (mid-week rebuild from misload offer 1026140)';

function parseTSV(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n').filter(l => l.length > 0);
  const cols = ['chuboe_offer_line_id', 'line', 'mpn', 'mfr', 'qty', 'price', 'dateCode', 'leadTime', 'packageDesc', 'description', 'cpc', 'moq', 'spq'];
  // Skip header row, parse data rows
  return lines.slice(1).map(row => {
    const parts = row.split('\t');
    const obj = {};
    cols.forEach((c, i) => { obj[c] = parts[i] || ''; });
    return obj;
  });
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');

  // 1. Load lines snapshot
  const snapshot = parseTSV('/home/analytics_user/workspace/offer-1026247-lines.tsv');
  console.log(`Loaded ${snapshot.length} lines from offer-1026247-lines.tsv`);

  // Map to writeOffer line shape
  const lines = snapshot.map(row => ({
    mpn: row.mpn,
    mfrText: row.mfr || null,
    qty: row.qty ? parseFloat(row.qty) : null,
    price: row.price && parseFloat(row.price) > 0 ? parseFloat(row.price) : null, // guard will blank anyway for consignment BP
    dateCode: row.dateCode || null,
    leadTime: row.leadTime || null,
    packageDesc: row.packageDesc || null,
    description: row.description || null,
    cpc: row.cpc || null,
    moq: row.moq || null,
    spq: row.spq || null,
  }));

  console.log(`Sample first 3 lines:`);
  console.log(JSON.stringify(lines.slice(0, 3), null, 2));

  if (dryRun) {
    console.log('\n--dry-run — skipping writes');
    console.log(`Would deactivate prior offers for (BP=${LAM_CONSIGNMENT_BP}, Type=${STOCK_PHILIPPINES_TYPE}) — current carryover 1026218`);
    console.log(`Would deactivate prior offers for (BP=${MISLOAD_BP}, Type=${STOCK_PHILIPPINES_TYPE}, descriptionEndsWith='${MISLOAD_DESC_SUFFIX}') — misload 1026247`);
    console.log(`Would write new offer: BP=${LAM_CONSIGNMENT_BP}, Type=${STOCK_PHILIPPINES_TYPE}, ${lines.length} lines, description="${DESCRIPTION}"`);
    return;
  }

  // 2. Deactivate carryover 1026218 (under LAM Consignment BP)
  console.log(`\n[1/3] Deactivating prior offers under BP ${LAM_CONSIGNMENT_BP} / Type ${STOCK_PHILIPPINES_TYPE}...`);
  const d1 = await deactivatePriorOffers(LAM_CONSIGNMENT_BP, STOCK_PHILIPPINES_TYPE);
  console.log(`  → ${d1.offersDeactivated} offers, ${d1.linesDeactivated} lines deactivated`);
  d1.deactivatedOffers.forEach(o => console.log(`    - offer ${o.id} (value ${o.value}): "${o.description}"`));

  // 3. Deactivate misload 1026247 (under wrong BP, scoped by description)
  console.log(`\n[2/3] Deactivating misload offer under BP ${MISLOAD_BP} / Type ${STOCK_PHILIPPINES_TYPE} (descriptionEndsWith='${MISLOAD_DESC_SUFFIX}')...`);
  const d2 = await deactivatePriorOffers(MISLOAD_BP, STOCK_PHILIPPINES_TYPE, { descriptionEndsWith: MISLOAD_DESC_SUFFIX });
  console.log(`  → ${d2.offersDeactivated} offers, ${d2.linesDeactivated} lines deactivated`);
  d2.deactivatedOffers.forEach(o => console.log(`    - offer ${o.id} (value ${o.value}): "${o.description}"`));

  // 4. Write new unified offer
  console.log(`\n[3/3] Writing new unified offer (BP=${LAM_CONSIGNMENT_BP}, Type=${STOCK_PHILIPPINES_TYPE}, ${lines.length} lines)...`);
  const result = await writeOffer({
    bpartnerId: LAM_CONSIGNMENT_BP,
    offerTypeId: STOCK_PHILIPPINES_TYPE,
    description: DESCRIPTION,
    lines,
  });

  console.log(`\nResult:`);
  console.log(`  offerId:       ${result.offerId}`);
  console.log(`  searchKey:     ${result.searchKey}`);
  console.log(`  linesWritten:  ${result.linesWritten}`);
  console.log(`  mpnsWritten:   ${result.mpnsWritten}`);
  console.log(`  errors:        ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.log('\n  Error detail:');
    result.errors.forEach(e => console.log(`    - ${e}`));
  }
})();
