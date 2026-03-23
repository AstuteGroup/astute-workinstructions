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
 * Returns { name, id } or null
 */
function queryDB(mfrName) {
  try {
    const escaped = mfrName.replace(/'/g, "''");
    const sql = `SELECT chuboe_mfr_id, name FROM adempiere.chuboe_mfr WHERE isactive='Y' AND (UPPER(name) = UPPER('${escaped}') OR name ILIKE '${escaped} %' OR name ILIKE '% ${escaped}' OR name ILIKE '${escaped},%' OR '${escaped}' ILIKE name || ' %') ORDER BY CASE WHEN UPPER(name) = UPPER('${escaped}') THEN 0 WHEN name ILIKE '${escaped}%' THEN 1 ELSE 2 END, LENGTH(name) ASC LIMIT 1`;

    const result = execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    // Parse through rbash noise
    const lines = result.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') && !t.includes('/dev/null') && !t.includes('restricted:') && !t.includes('/tmp/claude');
    });
    if (lines.length > 0) {
      const parts = lines[0].trim().split('|');
      if (parts.length >= 2) {
        return { id: parseInt(parts[0], 10), name: parts[1] };
      }
      // Fallback: single column (shouldn't happen but be safe)
      return { id: null, name: parts[0] };
    }
  } catch (e) {
    // Also check stderr for rbash environments
    const combined = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    const lines = combined.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') && !t.includes('/dev/null') && !t.includes('restricted:') && !t.includes('/tmp/claude') && !t.includes('ERROR:');
    });
    if (lines.length > 0) {
      const parts = lines[0].trim().split('|');
      if (parts.length >= 2) {
        return { id: parseInt(parts[0], 10), name: parts[1] };
      }
      return { id: null, name: parts[0] };
    }
  }
  return null;
}

/**
 * Read a cache entry. Handles both old format (string) and new format ({ name, id }).
 * Returns { name, id } or null.
 */
function cacheGet(c, upper) {
  if (!(upper in c)) return null;
  const val = c[upper];
  if (val && typeof val === 'object') return val;       // new format
  if (typeof val === 'string') return { name: val, id: null }; // old format (no ID)
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
  const cached = cacheGet(c, upper);
  if (cached) return cached.name || trimmed;

  // 3. DB lookup
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    c[upper] = { name: dbResult.name, id: dbResult.id };
    cache = c;
    saveCache();
    return dbResult.name;
  }

  // 4. Pass-through (cache the miss to avoid re-querying)
  c[upper] = { name: trimmed, id: null };
  cache = c;
  saveCache();
  return trimmed;
}

/**
 * Full lookup returning match details (for workflows that need to know the source).
 * Now includes chuboe_mfr_id for DB writeback.
 *
 * @param {string} mfrText - Raw manufacturer name
 * @returns {{ canonical: string, id: number|null, source: string, matched: boolean }}
 */
function lookupMfr(mfrText) {
  if (!mfrText) return { canonical: '', id: null, source: 'empty', matched: false };

  const trimmed = mfrText.trim();
  const upper = trimmed.toUpperCase();

  // 1. Alias — need to resolve the ID via DB/cache since alias file only has names
  const aliases = loadAliases();
  if (aliases[upper]) {
    const aliasName = aliases[upper];
    // Check cache for the alias name's ID
    const aliasUpper = aliasName.toUpperCase();
    const c = loadCache();
    const cached = cacheGet(c, aliasUpper);
    if (cached && cached.id) {
      return { canonical: aliasName, id: cached.id, source: 'alias', matched: true };
    }
    // Query DB for the alias name's ID
    const dbResult = queryDB(aliasName);
    if (dbResult) {
      c[aliasUpper] = { name: dbResult.name, id: dbResult.id };
      c[upper] = { name: dbResult.name, id: dbResult.id };
      cache = c;
      saveCache();
      return { canonical: dbResult.name, id: dbResult.id, source: 'alias', matched: true };
    }
    return { canonical: aliasName, id: null, source: 'alias', matched: true };
  }

  // 2. Cache (check if it was a DB hit or a miss)
  const c = loadCache();
  const cached = cacheGet(c, upper);
  if (cached) {
    const wasDbHit = cached.name !== trimmed && cached.name !== upper;
    return {
      canonical: cached.name || trimmed,
      id: cached.id || null,
      source: wasDbHit ? 'cache(db)' : 'cache(passthrough)',
      matched: wasDbHit,
    };
  }

  // 3. DB
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    c[upper] = { name: dbResult.name, id: dbResult.id };
    cache = c;
    saveCache();
    return { canonical: dbResult.name, id: dbResult.id, source: 'db', matched: true };
  }

  // 4. Pass-through
  c[upper] = { name: trimmed, id: null };
  cache = c;
  saveCache();
  return { canonical: trimmed, id: null, source: 'passthrough', matched: false };
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
