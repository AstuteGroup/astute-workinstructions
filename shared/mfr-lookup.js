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
 *   - Market Offer Loading: normalize offer manufacturer names
 *   - Stock RFQ Loading: normalize RFQ manufacturer names
 *   - Suggested Resale: display canonical MFR in output
 *
 * ALIAS FILE: ../Trading Analysis/Market Offer Loading/mfr-aliases.json
 *   - 165+ entries mapping common abbreviations to canonical DB names
 *   - Validated monthly via validate-mfr-aliases.js
 *   - Values MUST match exact chuboe_mfr.name in database
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Alias file (shared across all workflows) ---
const ALIAS_FILE = path.resolve(__dirname, '../Trading Analysis/Market Offer Loading/mfr-aliases.json');

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
 * Normalize a name for fuzzy comparison: strip punctuation, suffixes, lowercase.
 * "MOLEX, LLC" → "molex", "COTO TECHNOLOGY, INC." → "coto technology"
 */
function fuzzyNorm(name) {
  return name
    .replace(/[,./()]/g, ' ')           // punctuation → space
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|group|electronics|electronic|semiconductor|semi|technology|technologies|international|components|component|manufacturing|company|corporation)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Fuzzy/inference DB query for manufacturer name.
 * Tries progressively looser matching strategies:
 *   1. Punctuation-stripped exact match (e.g., "MOLEX, LLC" → "Molex LLC")
 *   2. Core-name contains match (e.g., "LATTICE SEMI" → "Lattice Semiconductor Corp")
 *   3. Slash/separator normalization (e.g., "VISHAY/DALE" → "Vishay Dale")
 * Returns { name, id, confidence } or null
 */
function queryDBFuzzy(mfrName) {
  // Strategy 1: strip punctuation and compare
  const stripped = mfrName.replace(/[,.]/g, '').trim();
  if (stripped !== mfrName) {
    const result = queryDB(stripped);
    if (result) return { ...result, confidence: 'punctuation-strip' };
  }

  // Strategy 2: replace / with space
  if (mfrName.includes('/')) {
    const slashed = mfrName.replace(/\//g, ' ').trim();
    const result = queryDB(slashed);
    if (result) return { ...result, confidence: 'slash-normalize' };
  }

  // Strategy 3: fuzzy-normalized ILIKE search
  const norm = fuzzyNorm(mfrName);
  if (norm.length >= 3) {
    try {
      const escaped = norm.replace(/'/g, "''");
      // Search for DB entries whose fuzzy-norm matches ours
      // Use the first significant word(s) to avoid false positives
      const words = norm.split(' ').filter(w => w.length >= 3);
      if (words.length === 0) return null;

      // Build ILIKE conditions for each significant word
      const conditions = words.map(w => {
        const esc = w.replace(/'/g, "''");
        return `name ILIKE '%${esc}%'`;
      }).join(' AND ');

      const sql = `SELECT chuboe_mfr_id, name, ad_client_id FROM adempiere.chuboe_mfr WHERE isactive='Y' AND ${conditions} ORDER BY LENGTH(name) ASC LIMIT 5`;

      const result = execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8',
        timeout: 10000,
      });
      const lines = result.split('\n').filter(l => {
        const t = l.trim();
        return t && !t.includes('rbash') && !t.includes('/dev/null') && !t.includes('restricted:') && !t.includes('/tmp/claude') && !t.includes('ERROR:');
      });

      if (lines.length > 0) {
        // Score candidates by fuzzy similarity
        const candidates = lines.map(l => {
          const parts = l.trim().split('|');
          if (parts.length < 2) return null;
          const dbNorm = fuzzyNorm(parts[1]);
          // Simple overlap score: what fraction of our words appear in the candidate?
          const matchedWords = words.filter(w => dbNorm.includes(w));
          const clientId = parts.length >= 3 ? parseInt(parts[2], 10) : null;
          return {
            id: parseInt(parts[0], 10),
            name: parts[1],
            isSystem: clientId === 0,
            score: matchedWords.length / words.length,
          };
        }).filter(c => c && c.score >= 0.5);

        candidates.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
        if (candidates.length > 0) {
          return { id: candidates[0].id, name: candidates[0].name, isSystem: candidates[0].isSystem, confidence: 'fuzzy-inference' };
        }
      }
    } catch (e) {
      // Fall through
    }
  }

  return null;
}

/**
 * Query chuboe_mfr table for a manufacturer name
 * Uses strict matching to avoid false positives (e.g., "Target" → "Kopin Targeting Corp")
 * Returns { name, id } or null
 */
function queryDB(mfrName) {
  try {
    const escaped = mfrName.replace(/'/g, "''");
    const sql = `SELECT chuboe_mfr_id, name, ad_client_id FROM adempiere.chuboe_mfr WHERE isactive='Y' AND (UPPER(name) = UPPER('${escaped}') OR name ILIKE '${escaped} %' OR name ILIKE '% ${escaped}' OR name ILIKE '${escaped},%' OR '${escaped}' ILIKE name || ' %') ORDER BY CASE WHEN UPPER(name) = UPPER('${escaped}') THEN 0 WHEN name ILIKE '${escaped}%' THEN 1 ELSE 2 END, LENGTH(name) ASC LIMIT 1`;

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
        const clientId = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        return { id: parseInt(parts[0], 10), name: parts[1], isSystem: clientId === 0 };
      }
      // Fallback: single column (shouldn't happen but be safe)
      return { id: null, name: parts[0], isSystem: false };
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
        const clientId = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        return { id: parseInt(parts[0], 10), name: parts[1], isSystem: clientId === 0 };
      }
      return { id: null, name: parts[0], isSystem: false };
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
 *   4. Fuzzy/inference DB query (punctuation strip, suffix strip, contains match)
 *   5. Pass-through (return as-is, cache the miss)
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

  // 3. DB lookup (strict)
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    c[upper] = { name: dbResult.name, id: dbResult.id };
    cache = c;
    saveCache();
    return dbResult.name;
  }

  // 4. Fuzzy/inference DB lookup
  const fuzzyResult = queryDBFuzzy(trimmed);
  if (fuzzyResult) {
    c[upper] = { name: fuzzyResult.name, id: fuzzyResult.id };
    cache = c;
    saveCache();
    return fuzzyResult.name;
  }

  // 5. Pass-through (cache the miss to avoid re-querying)
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
 * @returns {{ canonical: string, id: number|null, isSystem: boolean, source: string, matched: boolean }}
 */
function lookupMfr(mfrText) {
  if (!mfrText) return { canonical: '', id: null, isSystem: false, source: 'empty', matched: false };

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
    // Stale cache guard: skip if isSystem field missing (see note in main path)
    if (cached && cached.id && cached.isSystem !== undefined) {
      return { canonical: aliasName, id: cached.id, isSystem: !!cached.isSystem, source: 'alias', matched: true };
    }
    // Query DB for the alias name's ID
    const dbResult = queryDB(aliasName);
    if (dbResult) {
      c[aliasUpper] = { name: dbResult.name, id: dbResult.id, isSystem: dbResult.isSystem };
      c[upper] = { name: dbResult.name, id: dbResult.id, isSystem: dbResult.isSystem };
      cache = c;
      saveCache();
      return { canonical: dbResult.name, id: dbResult.id, isSystem: !!dbResult.isSystem, source: 'alias', matched: true };
    }
    return { canonical: aliasName, id: null, isSystem: false, source: 'alias', matched: true };
  }

  // 2. Cache (check if it was a DB hit or a miss)
  // Stale cache guard: entries written before the isSystem field existed
  // can't tell us whether the MFR is system-level (AD_Client_ID=0). Production
  // iDempiere rejects system MFR IDs in client tables, so we MUST know. Force
  // a re-resolve for any cached entry with an ID but no isSystem field.
  const c = loadCache();
  const cached = cacheGet(c, upper);
  if (cached && !(cached.id && cached.isSystem === undefined)) {
    const wasDbHit = cached.name !== trimmed && cached.name !== upper;
    return {
      canonical: cached.name || trimmed,
      id: cached.id || null,
      isSystem: !!cached.isSystem,
      source: wasDbHit ? 'cache(db)' : 'cache(passthrough)',
      matched: wasDbHit,
    };
  }

  // 3. DB (strict)
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    c[upper] = { name: dbResult.name, id: dbResult.id, isSystem: dbResult.isSystem };
    cache = c;
    saveCache();
    return { canonical: dbResult.name, id: dbResult.id, isSystem: !!dbResult.isSystem, source: 'db', matched: true };
  }

  // 4. Fuzzy/inference DB
  const fuzzyResult = queryDBFuzzy(trimmed);
  if (fuzzyResult) {
    c[upper] = { name: fuzzyResult.name, id: fuzzyResult.id, isSystem: fuzzyResult.isSystem };
    cache = c;
    saveCache();
    return { canonical: fuzzyResult.name, id: fuzzyResult.id, isSystem: !!fuzzyResult.isSystem, source: 'fuzzy(' + fuzzyResult.confidence + ')', matched: true };
  }

  // 5. Pass-through
  c[upper] = { name: trimmed, id: null };
  cache = c;
  saveCache();
  return { canonical: trimmed, id: null, isSystem: false, source: 'passthrough', matched: false };
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
