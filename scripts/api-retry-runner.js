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
 *   - Calls shared/franchise-api.searchPart(distributor, mpn, qty).
 *   - Exit 0 on success (result has no .error).
 *   - Exit 1 on .error so the queue worker increments attempts and reschedules.
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

(async () => {
  try {
    const r = await fapi.searchPart(distributor, mpn, qty || 1);
    if (r && r.error) {
      console.error(`retry-failed [${distributor}] ${mpn}: ${r.error}`);
      process.exit(1);
    }
    console.log(`retry-ok [${distributor}] ${mpn} found=${r?.found || false}`);
    process.exit(0);
  } catch (e) {
    console.error(`retry-threw [${distributor}] ${mpn}: ${e.message}`);
    process.exit(1);
  }
})();
