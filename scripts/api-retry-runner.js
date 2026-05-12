#!/usr/bin/env node
/**
 * Universal Bucket A retry entrypoint for franchise-api calls.
 *
 * Replaces the per-cog `node -e "..."` strings the queue used to store. The
 * wrapper in shared/franchise-api.js enqueues a command of the shape:
 *
 *   API_RETRY_IN_FLIGHT=1 API_RETRY_ARGS_B64=<base64-json> \
 *     node scripts/api-retry-runner.js
 *
 * Args are passed via base64-encoded JSON in API_RETRY_ARGS_B64 to avoid
 * any shell-escaping concerns with MPNs containing quotes or backslashes.
 *
 * Args shape:
 *   { distributor: "mouser", mpn: "CRCW12061K91FKEA", qty: 1 }
 *
 * Behavior:
 *   - Sets API_RETRY_IN_FLIGHT=1 so the wrapper's catch block does NOT
 *     re-enqueue (preventing infinite retry-loop and queue duplication).
 *   - First confirms the single-distributor retry succeeds via searchPart().
 *   - On success, triggers a full envelope re-pull
 *     (searchAllDistributors + writePricingResult) so the cached envelope
 *     gets the recovered data. Without this heal, the cached envelope keeps
 *     the stale Failed entry for the full TTL window — the read-side gate in
 *     getFreshness() handles this defensively, but the heal closes the loop.
 *   - Exit 0 on retry success (single-distributor probe ok), regardless of
 *     whether the full re-pull also succeeded (the heal is best-effort).
 *   - Exit 1 on retry failure so the queue worker increments attempts and
 *     reschedules.
 */

const path = require('path');

// Load .env so franchise-api cogs can read API keys
try { require('dotenv').config({ path: path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.env') }); } catch {}

const RAW = process.env.API_RETRY_ARGS_B64;
if (!RAW) {
  console.error('api-retry-runner: API_RETRY_ARGS_B64 env var missing');
  process.exit(1);
}

let args;
try {
  args = JSON.parse(Buffer.from(RAW, 'base64').toString('utf-8'));
} catch (e) {
  console.error('api-retry-runner: failed to decode args:', e.message);
  process.exit(1);
}

const { distributor, mpn, qty } = args || {};
if (!distributor || !mpn) {
  console.error('api-retry-runner: missing distributor or mpn in args');
  process.exit(1);
}

const fapi = require(path.resolve(__dirname, '../shared/franchise-api'));
const { writePricingResult } = require(path.resolve(__dirname, '../shared/api-result-writer'));

(async () => {
  // Step 1: probe the failing distributor specifically. If it still fails,
  // the queue worker reschedules; no point doing a full re-pull yet.
  let probe;
  try {
    probe = await fapi.searchPart(distributor, mpn, qty || 1);
  } catch (e) {
    console.error(`retry-threw [${distributor}] ${mpn}: ${e.message}`);
    process.exit(1);
  }
  if (probe && probe.error) {
    console.error(`retry-failed [${distributor}] ${mpn}: ${probe.error}`);
    process.exit(1);
  }
  console.log(`retry-ok [${distributor}] ${mpn} found=${probe?.found || false}`);

  // Step 2: heal the cache. Force a full envelope re-pull so the cached
  // envelope reflects the recovered state. Best-effort — if this fails the
  // single-disty retry still counts as success (exit 0). The read-side
  // Failed-entry gate in getFreshness() backstops any heal that fails.
  try {
    const fresh = await fapi.searchAllDistributors(mpn, qty || 1, { cacheTTL: null });
    await writePricingResult({
      searchResult: fresh,
      mpn,
      qty: qty || 1,
      source: 'api-retry-runner',
    });
    const stillFailed = (fresh?.distributors || [])
      .filter(d => d?.error)
      .map(d => d.name || d.distributor);
    if (stillFailed.length > 0) {
      console.log(`heal-partial [${mpn}] still-failed=${stillFailed.join(',')}`);
    } else {
      console.log(`heal-ok [${mpn}] envelope refreshed`);
    }
  } catch (e) {
    console.error(`heal-threw [${mpn}]: ${e.message}`);
    // Don't fail the retry on heal-failure — single-disty probe already passed
  }

  process.exit(0);
})();
