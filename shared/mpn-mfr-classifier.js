/**
 * MPN → Original Manufacturer Classifier
 *
 * Given an MPN with NO manufacturer specified, infer the ORIGINAL manufacturer
 * by matching the MPN against a curated prefix table. Returns the brand as it
 * existed when the part was made — acquisitions are NOT applied here. The
 * caller (typically `shared/mfr-resolver.js`) decides whether to remap to the
 * current owner via the acquisition table.
 *
 * Why this is separate from `shared/mfr-lookup.js`:
 *   - mfr-lookup answers: "this row says 'LINEAR TECH' — what's the canonical
 *     iDempiere record?" Input is a brand string. Lookup is dictionary.
 *   - mpn-mfr-classifier answers: "this row has MPN 'LTC1485' and no MFR —
 *     who made it?" Input is an MPN. Lookup is prefix-pattern matching with
 *     longest-match priority.
 *
 *   Different inputs, different data sources, different match algorithms,
 *   different failure modes. See sourcing-roadmap.md § C15 for the full
 *   architectural rationale.
 *
 * Why this is separate from `shared/mpn-classifier.js`:
 *   That existing classifier buckets parts that returned ZERO franchise hits
 *   into actionable sub-categories (mil-spec / customer-internal AML / unknown).
 *   It is purpose-built and explicitly NOT a general MPN classifier — its
 *   own docstring warns against general use. This new file handles the
 *   different question of "what brand does this MPN belong to?" and stays
 *   out of mpn-classifier's lane.
 *
 * USAGE:
 *   const { classifyMpnToMfr, listPrefixes } = require('../shared/mpn-mfr-classifier');
 *
 *   const r = classifyMpnToMfr('LTC1485');
 *   // → { matched: true, mfr: 'Linear Technology Corp', prefix: 'LTC',
 *   //     source: 'prefix-table', confidence: 'high' }
 *
 *   const r2 = classifyMpnToMfr('XCVU9P-2FLGB2104I');
 *   // → { matched: true, mfr: 'Xilinx Inc', prefix: 'XC', source: 'prefix-table', confidence: 'high' }
 *
 *   const r3 = classifyMpnToMfr('GE-INTERNAL-WHATEVER-001');
 *   // → { matched: false, mfr: null, prefix: null, source: 'no-match' }
 *
 * RESOLUTION ORDER (longest-match wins):
 *   1. Normalize MPN: uppercase, strip whitespace
 *   2. Find ALL prefixes from the table that match the start of the MPN
 *   3. Pick the LONGEST one (so 'LTC1485' matches 'LTC' over 'LT')
 *   4. Return the associated MFR + prefix + source tag
 *
 *   Confidence is currently always 'high' for direct prefix hits — future
 *   work may downgrade short-prefix matches (1-2 chars) to 'medium' since
 *   they have higher false-positive risk.
 *
 * DATA: shared/data/mpn-prefixes.json (hand-curated, expand by mining VQ
 * history for (mpn_prefix, mfr) pairs that appear together >N times).
 */

const fs = require('fs');
const path = require('path');

const PREFIX_FILE = path.resolve(__dirname, 'data/mpn-prefixes.json');

let _prefixCache = null;
let _sortedPrefixes = null; // sorted longest-first for fast longest-match scan

/**
 * Load and cache the prefix table. Sorts prefixes by length descending so the
 * first match in a linear scan is the longest one.
 */
function loadPrefixes() {
  if (_prefixCache) return { prefixes: _prefixCache, sorted: _sortedPrefixes };

  try {
    const raw = fs.readFileSync(PREFIX_FILE, 'utf-8');
    const data = JSON.parse(raw);
    _prefixCache = data.prefixes || {};
  } catch (err) {
    console.error(`[mpn-mfr-classifier] Failed to load ${PREFIX_FILE}: ${err.message}`);
    _prefixCache = {};
  }

  _sortedPrefixes = Object.keys(_prefixCache)
    .filter(k => !k.startsWith('_'))
    .sort((a, b) => b.length - a.length); // longest first

  return { prefixes: _prefixCache, sorted: _sortedPrefixes };
}

/**
 * Normalize an MPN for prefix matching: uppercase, strip whitespace and
 * leading non-alphanumeric chars. Does NOT strip dashes or interior dots —
 * those can be part of the brand-significant prefix (e.g., "EP-1" vs "EP1").
 */
function normalizeMpn(mpn) {
  if (!mpn) return '';
  return String(mpn).trim().toUpperCase().replace(/^[^A-Z0-9]+/, '');
}

/**
 * Classify an MPN to its original manufacturer via prefix matching.
 *
 * @param {string} mpn - The manufacturer part number (no MFR string needed)
 * @returns {{matched: boolean, mfr: string|null, prefix: string|null, source: string, confidence?: string, notes?: string}}
 */
function classifyMpnToMfr(mpn) {
  const normalized = normalizeMpn(mpn);
  if (!normalized) {
    return { matched: false, mfr: null, prefix: null, source: 'empty-input' };
  }

  const { prefixes, sorted } = loadPrefixes();

  for (const prefix of sorted) {
    if (normalized.startsWith(prefix)) {
      const entry = prefixes[prefix];
      // Confidence heuristic: very short prefixes (1-2 chars) are more
      // collision-prone, downgrade to 'medium'.
      const confidence = prefix.length >= 3 ? 'high' : 'medium';
      return {
        matched: true,
        mfr: entry.mfr,
        prefix,
        source: 'prefix-table',
        confidence,
        notes: entry.notes || null,
      };
    }
  }

  return { matched: false, mfr: null, prefix: null, source: 'no-match' };
}

/**
 * Return the loaded prefix table (for inspection / testing / management UIs).
 * Excludes underscore-prefixed metadata keys.
 */
function listPrefixes() {
  const { prefixes } = loadPrefixes();
  return Object.fromEntries(
    Object.entries(prefixes).filter(([k]) => !k.startsWith('_'))
  );
}

/**
 * Force a reload of the prefix file. Useful in tests or after editing the
 * JSON without restarting the process.
 */
function reloadPrefixes() {
  _prefixCache = null;
  _sortedPrefixes = null;
  return loadPrefixes();
}

module.exports = {
  classifyMpnToMfr,
  listPrefixes,
  reloadPrefixes,
  normalizeMpn, // exported for testing
};
