/**
 * analyze-offer.js — Customer Excess Analysis entry point (V1 STUB).
 *
 * V1 SCOPE: writes a breadcrumb noting the offer was queued for analysis.
 * The real intent classifier (Step 2), scoring engine (Step 4), and intent-
 * shaped output renderers (Step 5) are documented in `market-offer-analysis.md`
 * and will replace this stub incrementally.
 *
 * The stub is the right boundary contract for the router: pass `{offerId,
 * searchKey, source}`, get back `{route, status}`. When real analysis ships,
 * it'll honor the same signature and write richer breadcrumbs.
 *
 * Manual replay path (per Loading workflow Step 7):
 *   node analyze-offer.js --offer-id 9000123
 *   node analyze-offer.js --offer-search-key 1024645
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const breadcrumbs = require('../../shared/breadcrumbs');

/**
 * Stub analysis handler — invoked by the offer-router.
 *
 * @param {object} opts
 *   opts.offerId   — chuboe_offer_id (required)
 *   opts.searchKey — chuboe_offer.value (optional but useful for breadcrumb)
 *   opts.source    — who triggered us ('router', 'manual', etc.)
 * @returns {Promise<{route, status, ...}>}
 */
async function analyzeOffer(opts = {}) {
  if (!opts.offerId) throw new Error('analyzeOffer: opts.offerId required');

  // V1: just record that the offer is queued. Future work fills in:
  //   - intent classification (Spec Buy / Proactive Customer / Reactive RFQ-match)
  //   - per-line scoring (supply scarcity / price advantage / demand signal)
  //   - render output appropriate to inferred intent
  //   - emit drill-down candidates for the digest
  breadcrumbs.write({
    cog: 'customer-excess-analysis',
    event: 'queued',
    offerId: opts.offerId,
    searchKey: opts.searchKey || null,
    source: opts.source || 'unknown',
    note: 'V1 stub — real intent classifier + scoring + renderers pending; offer is loaded in OT and queryable via search key',
  });

  return {
    route: 'customer-excess-analysis',
    status: 'queued',
    offerId: opts.offerId,
    searchKey: opts.searchKey,
    note: 'V1 stub — analysis pending build-out',
  };
}

// CLI invocation for manual replay
async function main() {
  const argv = process.argv.slice(2);
  let offerId = null, searchKey = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--offer-id') offerId = Number(argv[++i]);
    else if (argv[i] === '--offer-search-key') searchKey = argv[++i];
  }
  if (!offerId && !searchKey) {
    console.error('Usage: node analyze-offer.js --offer-id <id> | --offer-search-key <key>');
    process.exit(2);
  }

  // If only searchKey provided, look up the ID from OT
  if (!offerId && searchKey) {
    const { apiGet } = require('../../shared/api-client');
    const r = await apiGet('chuboe_offer', { filter: `value eq '${searchKey}'` });
    const records = r && r.records ? r.records : [];
    if (records.length === 0) {
      console.error(`No chuboe_offer found with value=${searchKey}`);
      process.exit(3);
    }
    offerId = records[0].id || records[0].chuboe_offer_id;
  }

  const result = await analyzeOffer({ offerId, searchKey, source: 'cli-manual' });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err.message); console.error(err.stack); process.exit(1); });
}

module.exports = { analyzeOffer };
