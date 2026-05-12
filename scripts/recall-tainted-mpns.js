#!/usr/bin/env node
/**
 * Re-pull cached pricing envelopes for a list of MPNs.
 *
 * Designed as a follow-up to sweep-failed-cache.js — when that tool deletes
 * tainted envelopes, this one optionally pre-warms the cache by force-pulling
 * a fresh envelope for each MPN that was on the recall list.
 *
 * Input: JSON file from `sweep-failed-cache.js --recall-list <path>` —
 *        an array of `{ mpn, qty }` tuples.
 *
 * Behavior: for each tuple, calls searchAllDistributors() with cacheTTL=null
 * (forces a live pull) and writePricingResult() (writes the resulting envelope
 * to disk + DB). Per-distributor throttling kicks in automatically via the
 * franchise-api per-disty token bucket. DigiKey quota: this script does NOT
 * check remaining quota — caller should verify quota budget before running.
 *
 * Usage:
 *   node recall-tainted-mpns.js <list.json>             # process all entries
 *   node recall-tainted-mpns.js <list.json> --limit 100 # cap at first 100
 *   node recall-tainted-mpns.js <list.json> --dry-run   # show what would run
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const listPath = args[0];
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

if (!listPath || !fs.existsSync(listPath)) {
  console.error('Usage: recall-tainted-mpns.js <list.json> [--limit N] [--dry-run]');
  process.exit(1);
}

try { require('dotenv').config({ path: path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.env') }); } catch {}

const fapi = require(path.resolve(__dirname, '../shared/franchise-api'));
const { writePricingResult } = require(path.resolve(__dirname, '../shared/api-result-writer'));

const tuples = JSON.parse(fs.readFileSync(listPath, 'utf8')).slice(0, LIMIT);
console.log(`Recalling ${tuples.length} MPN(s) from ${listPath}${LIMIT < Infinity ? ` (capped)` : ''}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('');

if (DRY_RUN) {
  for (const t of tuples.slice(0, 10)) console.log(`  ${t.mpn} (qty=${t.qty})`);
  if (tuples.length > 10) console.log(`  ... ${tuples.length - 10} more`);
  process.exit(0);
}

const stats = {
  total: tuples.length,
  ok: 0,
  partial: 0,
  failed: 0,
  byDisty: {},  // disty → failures
  startMs: Date.now(),
};

function progressLine(i) {
  const elapsed = ((Date.now() - stats.startMs) / 1000).toFixed(0);
  const rate = i > 0 ? (i / parseFloat(elapsed || 1)).toFixed(2) : '0';
  console.log(`[${i}/${stats.total}] ok=${stats.ok} partial=${stats.partial} failed=${stats.failed} elapsed=${elapsed}s rate=${rate}/s`);
}

(async () => {
  for (let i = 0; i < tuples.length; i++) {
    const { mpn, qty } = tuples[i];
    try {
      const fresh = await fapi.searchAllDistributors(mpn, qty || 1, { cacheTTL: null });
      await writePricingResult({
        searchResult: fresh,
        mpn,
        qty: qty || 1,
        source: 'recall-tainted-mpns',
      });
      const failedNow = (fresh?.distributors || []).filter(d => d?.error).map(d => d.name || d.distributor);
      if (failedNow.length === 0) stats.ok++;
      else {
        stats.partial++;
        for (const d of failedNow) stats.byDisty[d] = (stats.byDisty[d] || 0) + 1;
      }
    } catch (e) {
      stats.failed++;
      console.error(`[${mpn}] threw: ${e.message}`);
    }
    if ((i + 1) % 50 === 0) progressLine(i + 1);
  }
  progressLine(tuples.length);
  console.log('');
  console.log('=== Final ===');
  console.log(`ok (all distys clean):  ${stats.ok}`);
  console.log(`partial (≥1 failed):    ${stats.partial}`);
  console.log(`failed (threw):         ${stats.failed}`);
  if (Object.keys(stats.byDisty).length > 0) {
    console.log('Still-failing distributors:');
    for (const [d, n] of Object.entries(stats.byDisty).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${d.padEnd(20)} ${n}`);
    }
  }
})();
