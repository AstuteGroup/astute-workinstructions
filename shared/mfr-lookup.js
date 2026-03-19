/**
 * Centralized Manufacturer Lookup & Normalization
 *
 * Resolves manufacturer names to canonical chuboe_mfr.name values.
 * Three-tier resolution: aliases file → DB lookup → pass-through.
 * Results are cached to avoid repeated DB queries.
 *
 * USAGE:
 *   const { normalizeMfr, lookupMfr } = require('../shared/mfr-lookup');
 *
 *   normalizeMfr('TI');           // → 'Texas Instruments Incorporated'
 *   normalizeMfr('MICRON');       // → 'Micron Technology, Inc.'
 *   normalizeMfr('SomeNewMfr');   // → DB lookup, then cache, or pass-through
 *
 * CONSUMERS:
 *   - VQ Loading: normalize vendor-quoted manufacturer names
 *   - Market Offer Uploading: normalize offer manufacturer names
 *   - Stock RFQ Loading: normalize RFQ manufacturer names
 *   - Suggested Resale: display canonical MFR in output
 *
 * ALIAS FILE: ../Trading Analysis/Market Offer Uploading/mfr-aliases.json
 *   - 165+ entries mapping common abbreviations to canonical DB names
 *   - Validated monthly via validate-mfr-aliases.js
 *   - Values MUST match exact chuboe_mfr.name in database
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Alias file (shared across all workflows) ---
const ALIAS_FILE = path.resolve(__dirname, '../Trading Analysis/Market Offer Uploading/mfr-aliases.json');

// --- Cache file (avoids repeated DB queries) ---
const CACHE_FILE = path.resolve(__dirname, 'data/mfr-cache.json');

let aliasMap = null;   // loaded lazily
let cache = null;      // loaded lazily

function loadAliases() {
  if (aliasMap) return aliasMap;
  try {
    const data = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf-8'));
    aliasMap = data.aliases || {};
  } catch (err) {
    console.error(`[mfr-lookup] Failed to load aliases from ${ALIAS_FILE}: ${err.message}`);
    aliasMap = {};
  }
  return aliasMap;
}

function loadCache() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } else {
      cache = {};
    }
  } catch (err) {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    // Non-fatal — cache miss just means another DB query next time
  }
}

/**
 * Query chuboe_mfr table for a manufacturer name
 * Uses strict matching to avoid false positives (e.g., "Target" → "Kopin Targeting Corp")
 */
function queryDB(mfrName) {
  try {
    const escaped = mfrName.replace(/'/g, "''");
    const sql = `SELECT name FROM adempiere.chuboe_mfr WHERE ad_client_id = 1000000 AND isactive='Y' AND (UPPER(name) = UPPER('${escaped}') OR name ILIKE '${escaped} %' OR name ILIKE '% ${escaped}' OR name ILIKE '${escaped},%') ORDER BY CASE WHEN UPPER(name) = UPPER('${escaped}') THEN 0 ELSE 1 END LIMIT 1`;

    const result = execSync(`psql -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    // Parse through rbash noise
    const lines = result.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') && !t.includes('/dev/null') && !t.includes('restricted:') && !t.includes('/tmp/claude');
    });
    if (lines.length > 0) return lines[0].trim();
  } catch (e) {
    // Also check stderr for rbash environments
    const combined = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    const lines = combined.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') && !t.includes('/dev/null') && !t.includes('restricted:') && !t.includes('/tmp/claude') && !t.includes('ERROR:');
    });
    if (lines.length > 0) return lines[0].trim();
  }
  return null;
}

/**
 * Normalize a manufacturer name to its canonical chuboe_mfr.name value.
 *
 * Resolution order:
 *   1. Alias file lookup (165+ entries, fast)
 *   2. Cache lookup (previous DB results)
 *   3. DB query (chuboe_mfr table, strict matching)
 *   4. Pass-through (return as-is, cache the miss)
 *
 * @param {string} mfrText - Raw manufacturer name from any source
 * @returns {string} Canonical manufacturer name, or original if not found
 */
function normalizeMfr(mfrText) {
  if (!mfrText) return '';

  const trimmed = mfrText.trim();
  if (!trimmed) return '';

  const upper = trimmed.toUpperCase();

  // 1. Check alias file
  const aliases = loadAliases();
  if (aliases[upper]) return aliases[upper];

  // 2. Check cache
  const c = loadCache();
  if (upper in c) return c[upper] || trimmed;

  // 3. DB lookup
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    c[upper] = dbResult;
    cache = c;
    saveCache();
    return dbResult;
  }

  // 4. Pass-through (cache the miss to avoid re-querying)
  c[upper] = trimmed;
  cache = c;
  saveCache();
  return trimmed;
}

/**
 * Full lookup returning match details (for workflows that need to know the source)
 *
 * @param {string} mfrText - Raw manufacturer name
 * @returns {{ canonical: string, source: string, matched: boolean }}
 */
function lookupMfr(mfrText) {
  if (!mfrText) return { canonical: '', source: 'empty', matched: false };

  const trimmed = mfrText.trim();
  const upper = trimmed.toUpperCase();

  // 1. Alias
  const aliases = loadAliases();
  if (aliases[upper]) {
    return { canonical: aliases[upper], source: 'alias', matched: true };
  }

  // 2. Cache (check if it was a DB hit or a miss)
  const c = loadCache();
  if (upper in c) {
    const val = c[upper];
    const wasDbHit = val !== trimmed && val !== upper;
    return { canonical: val || trimmed, source: wasDbHit ? 'cache(db)' : 'cache(passthrough)', matched: wasDbHit };
  }

  // 3. DB
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    c[upper] = dbResult;
    cache = c;
    saveCache();
    return { canonical: dbResult, source: 'db', matched: true };
  }

  // 4. Pass-through
  c[upper] = trimmed;
  cache = c;
  saveCache();
  return { canonical: trimmed, source: 'passthrough', matched: false };
}

/**
 * Clear the cache (useful after adding new aliases or MFR records)
 */
function clearCache() {
  cache = {};
  saveCache();
}

module.exports = {
  normalizeMfr,
  lookupMfr,
  clearCache,
};
