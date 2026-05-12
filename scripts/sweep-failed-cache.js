#!/usr/bin/env node
/**
 * Scan the local pricing-envelope cache for envelopes containing any
 * PricingResponseStatus='Failed' entries. Report counts by distributor +
 * total. With --delete, removes those files from disk.
 *
 * The read-side gate in api-result-writer.getFreshness() already refuses to
 * serve Failed-tainted envelopes to RFQ enrichment. This sweep is for:
 *   - Audit: how much of the cache is tainted, by which distributor
 *   - Disk cleanup
 *   - Preventing OTHER consumers (Vortex Matches reads files directly via
 *     fetchCachedEnvelopes) from serving partial-failure data
 *
 * Usage:
 *   node sweep-failed-cache.js                       # audit only
 *   node sweep-failed-cache.js --delete              # delete all tainted files
 *   node sweep-failed-cache.js --max-age 30          # only files newer than 30 days
 *   node sweep-failed-cache.js --min-age 30          # only files older than 30 days
 *   node sweep-failed-cache.js --max-age 30 --delete # delete tainted within last 30d
 *   node sweep-failed-cache.js --recall-list out.json --recall-age 14
 *       # write list of tainted MPNs ≤14d old to out.json (for proactive recall)
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.resolve(__dirname, '../shared/data/api-pricing-cache');
const args = process.argv.slice(2);
const DELETE = args.includes('--delete');

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const MIN_AGE_DAYS = parseInt(flagValue('--min-age'), 10) || 0;
const MAX_AGE_DAYS = parseInt(flagValue('--max-age'), 10) || 0;
const RECALL_LIST_PATH = flagValue('--recall-list');
const RECALL_AGE_DAYS = parseInt(flagValue('--recall-age'), 10) || 14;

if (!fs.existsSync(CACHE_DIR)) {
  console.error(`Cache dir not found: ${CACHE_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
console.log(`Scanning ${files.length} cache files in ${CACHE_DIR}`);
console.log(`Mode: ${DELETE ? 'DELETE' : 'AUDIT'}${MIN_AGE_DAYS ? `, min-age=${MIN_AGE_DAYS}d` : ''}${MAX_AGE_DAYS ? `, max-age=${MAX_AGE_DAYS}d` : ''}${RECALL_LIST_PATH ? `, recall-list=${RECALL_LIST_PATH} (≤${RECALL_AGE_DAYS}d)` : ''}`);
console.log('');

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const minAgeCutoff = MIN_AGE_DAYS ? dateNDaysAgo(MIN_AGE_DAYS) : null;  // skip files newer than this
const maxAgeCutoff = MAX_AGE_DAYS ? dateNDaysAgo(MAX_AGE_DAYS) : null;  // skip files older than this
const recallCutoff = dateNDaysAgo(RECALL_AGE_DAYS);

const distyTaint = {};     // disty → count of envelopes where it failed
const failedByCategory = { ALL_FAILED: 0, PARTIAL_FAILED: 0 };
const taintedFiles = [];
const recallMpns = new Set();  // MPNs of tainted files ≤RECALL_AGE_DAYS old
let scanned = 0;
let parseErrors = 0;
let healthy = 0;

for (const f of files) {
  // file: MPN_YYYY-MM-DD.json — note MPN may contain underscores
  const m = f.match(/^(.+)_(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  const fileDate = m[2];
  const mpnKey = m[1];
  if (minAgeCutoff && fileDate > minAgeCutoff) continue;
  if (maxAgeCutoff && fileDate < maxAgeCutoff) continue;

  scanned++;
  let env;
  try {
    env = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
  } catch (e) {
    parseErrors++;
    continue;
  }

  const status = env?.data?.Status || [];
  const failed = status.filter(s => s.PricingResponseStatus === 'Failed');
  if (failed.length === 0) {
    healthy++;
    continue;
  }

  for (const s of failed) {
    distyTaint[s.APIName] = (distyTaint[s.APIName] || 0) + 1;
  }
  if (failed.length === status.length && status.length > 0) failedByCategory.ALL_FAILED++;
  else failedByCategory.PARTIAL_FAILED++;
  taintedFiles.push({ file: f, date: fileDate, failed: failed.map(s => s.APIName) });

  // Collect recall-list MPNs (use envelope's searchedMPN — restores punctuation
  // that's stripped by the cacheKey filename normalization)
  if (RECALL_LIST_PATH && fileDate >= recallCutoff) {
    const realMpn = env?.data?._meta?.searchedMPN || mpnKey;
    const realQty = env?.data?._meta?.searchedQty || 1;
    recallMpns.add(JSON.stringify({ mpn: realMpn, qty: realQty }));
  }
}

console.log('=== Audit results ===');
console.log(`Files scanned:       ${scanned}`);
console.log(`Parse errors:        ${parseErrors}`);
console.log(`Healthy envelopes:   ${healthy}`);
console.log(`Tainted envelopes:   ${taintedFiles.length}`);
console.log(`  all-failed:        ${failedByCategory.ALL_FAILED}`);
console.log(`  partial-failed:    ${failedByCategory.PARTIAL_FAILED}`);
console.log('');

console.log('Tainted-envelope count by failing distributor:');
const sorted = Object.entries(distyTaint).sort((a, b) => b[1] - a[1]);
for (const [d, n] of sorted) {
  console.log(`  ${d.padEnd(20)} ${n}`);
}

if (taintedFiles.length === 0) {
  console.log('\nNo tainted envelopes found. Nothing to do.');
  process.exit(0);
}

// Distribution by age
const ageBuckets = { '0-1d': 0, '1-3d': 0, '3-7d': 0, '7-14d': 0, '14-30d': 0, '>30d': 0 };
const now = new Date();
for (const t of taintedFiles) {
  const ageD = Math.floor((now - new Date(t.date)) / 86400000);
  if (ageD <= 1) ageBuckets['0-1d']++;
  else if (ageD <= 3) ageBuckets['1-3d']++;
  else if (ageD <= 7) ageBuckets['3-7d']++;
  else if (ageD <= 14) ageBuckets['7-14d']++;
  else if (ageD <= 30) ageBuckets['14-30d']++;
  else ageBuckets['>30d']++;
}
console.log('\nTainted-envelope age distribution:');
for (const [b, n] of Object.entries(ageBuckets)) {
  if (n > 0) console.log(`  ${b.padEnd(8)} ${n}`);
}

// Write recall list if requested (even on audit-only runs)
if (RECALL_LIST_PATH) {
  const list = [...recallMpns].map(s => JSON.parse(s));
  fs.writeFileSync(RECALL_LIST_PATH, JSON.stringify(list, null, 2));
  console.log(`\nWrote ${list.length} unique (mpn, qty) tuples to ${RECALL_LIST_PATH}`);
}

if (!DELETE) {
  console.log('\nDry-run only. Re-run with --delete to remove tainted files.');
  process.exit(0);
}

console.log('\nDeleting tainted files...');
let deleted = 0;
let delErrors = 0;
for (const t of taintedFiles) {
  try {
    fs.unlinkSync(path.join(CACHE_DIR, t.file));
    deleted++;
  } catch (e) {
    delErrors++;
  }
}
console.log(`Deleted ${deleted} file(s)${delErrors ? `, ${delErrors} error(s)` : ''}.`);
