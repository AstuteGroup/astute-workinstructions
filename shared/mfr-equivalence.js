/**
 * MFR Equivalence — "are these two manufacturer strings the same company?"
 *
 * Use this from any workflow that needs to compare a customer's MFR ask
 * against a supplier's MFR label. The same logic powers:
 *   - Vortex Matches  → red-flag rows where supplier MFR ≠ customer's RFQ MFR
 *   - Quick Quote     → flag VQ-to-RFQ MFR mismatches in the output
 *   - Market Offer Matching for RFQs → same comparison for offer-to-RFQ matching
 *   - RFQ API Enrichment → score franchise API responses by MFR match
 *   - Any future "supply vs demand" workflow
 *
 * USAGE:
 *   const { canonicalMfr, computeMfrMatch } = require('../shared/mfr-equivalence');
 *
 *   const flag = computeMfrMatch(rfqMfr, supplierMfr);
 *   //   ''         → same canonical (or both blank)
 *   //   'MISMATCH' → both populated, different companies
 *   //   '?'        → exactly one side blank (one-sided unknown)
 *
 *   // Or, for two-step custom logic:
 *   const a = canonicalMfr('TYCO ELECTRONICS CORP.');  // → 'te connectivity ltd'
 *   const b = canonicalMfr('Te');                       // → 'te connectivity ltd'
 *   if (a === b) { ... }
 *
 * PIPELINE (canonicalMfr):
 *
 *   raw string
 *     ↓
 *   prenormalizeMfr — strip punctuation/whitespace, drop generic legal-entity
 *                     suffixes (Inc, Corp, Ltd, GmbH, LLC, Holdings, Group...).
 *                     Whitelist regex: only letters/digits/space/slash/&/hyphen
 *                     are kept. Handles "DIODES  INC", "PHOENIX CONTACT INC.",
 *                     "WURTH ELEKTRONIK GMBH", "TYCO ELECTRONICS CORP.",
 *                     "HRS(??)", etc. uniformly.
 *     ↓
 *   shared/mfr-lookup.normalizeMfr — 200+ alias entries from
 *                     Trading Analysis/Market Offer Loading/mfr-aliases.json
 *                     (TI / TYCO / ON SEMI / etc.) plus DB strict + DB fuzzy
 *                     fallbacks. Returns the canonical brand name from
 *                     chuboe_mfr.name.
 *     ↓
 *   acquisition chain — walks shared/data/mfr-acquisitions.json up to 5 hops
 *                     (Linear → ADI, IR → Infineon, Atmel → Microchip,
 *                     Sprague → Vishay, etc.) so brands fully absorbed by a
 *                     parent collapse to the parent.
 *     ↓
 *   _toComparable — lowercase + collapse whitespace for stable comparison
 *
 * RESULT
 *   Two MFR strings that represent the same company under any reasonable
 *   nomenclature variation collapse to the same canonical key. Genuinely
 *   different manufacturers (Littelfuse vs Good-Ark, Taiwan Semi vs On Semi,
 *   Diodes Inc vs Panjit) resolve to different canonicals and flag MISMATCH.
 *
 * EXTENDING THE EQUIVALENCE DATABASE
 *
 * To make a NEW pair of strings collapse to the same canonical, you have
 * three places to edit (pick the one that fits the case):
 *
 *   1. Add a NOMENCLATURE alias (TI / Texas Instruments / TXN / etc.)
 *      → Trading Analysis/Market Offer Loading/mfr-aliases.json
 *      → Add `"YOUR ALIAS UPPERCASE": "Canonical Brand Name"`
 *      → File is validated monthly via validate-mfr-aliases.js
 *      → Affects every workflow using shared/mfr-lookup
 *
 *   2. Add an ACQUISITION (Original brand fully absorbed by parent)
 *      → shared/data/mfr-acquisitions.json
 *      → Add `"Original Brand": "Current Owner"`
 *      → Policy: only when the original brand has been FULLY absorbed and
 *        no longer ships under its own name. Otherwise it's a Policy B/C
 *        nomenclature decision and belongs in the alias file.
 *      → Affects every workflow using shared/mfr-resolver
 *
 *   3. STRUCTURAL formatting (punctuation, whitespace, generic suffixes)
 *      → already handled by prenormalizeMfr below — no edits needed
 *
 * After editing either file, all consumers automatically benefit on next
 * process start (the alias file is reloaded per-process by mfr-lookup; the
 * acquisitions table is loaded once at module load here).
 *
 * SESSION CACHE
 *
 * canonicalMfr() memoizes raw → canonical lookups in a per-process Map so
 * repeated comparisons of the same string are O(1) after the first call.
 * Call clearCache() if you ever need to invalidate (e.g., test isolation).
 */

const fs = require('fs');
const path = require('path');
const sharedMfrLookup = require('./mfr-lookup');

const acquisitionsPath = path.resolve(__dirname, 'data/mfr-acquisitions.json');

/**
 * Lowercase + collapse whitespace. Final form used for comparison.
 * Internal helper, not exported.
 */
function _toComparable(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Strip punctuation, collapse whitespace, drop generic legal-entity suffixes.
 * Returns an UPPERCASE form ready for the alias file lookup.
 *
 * Whitelist: keeps letters, digits, whitespace, slash, ampersand, hyphen.
 * Slash/&/hyphen are kept because they appear in legitimate brand names like
 * "TE/Tyco", "P&S Technologies", "Good-Ark".
 *
 * Suffix strip is iterative so multiple stack: "Foo Holdings LLC" → "Foo".
 */
function prenormalizeMfr(s) {
  if (!s) return '';
  let r = String(s)
    .replace(/[^A-Za-z0-9\s/&\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const suffix = /\s+(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|GMBH|AG|SA|NV|BV|LLC|HOLDINGS|HLDG|HLDGS|GROUP)$/;
  while (suffix.test(r)) {
    r = r.replace(suffix, '').trim();
  }
  return r;
}

/**
 * Load and pre-normalize the acquisitions table once at module load.
 * Both keys and values are run through the same prenormalize → alias-resolve
 * → comparable pipeline that canonicalMfr uses for inputs, so the chain walks
 * cleanly without case/suffix mismatches.
 */
const ACQUISITIONS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(acquisitionsPath, 'utf-8')).acquisitions || {};
    const m = new Map();
    for (const [original, owner] of Object.entries(raw)) {
      const preK = prenormalizeMfr(original);
      const preV = prenormalizeMfr(owner);
      const k = _toComparable(sharedMfrLookup.normalizeMfr(preK) || preK);
      const v = _toComparable(sharedMfrLookup.normalizeMfr(preV) || preV);
      if (k && v && k !== v) m.set(k, v);
    }
    return m;
  } catch (e) {
    console.warn(`[mfr-equivalence] Could not load mfr-acquisitions.json: ${e.message}`);
    return new Map();
  }
})();

// Per-process memo. raw input string → final canonical form.
const _canonicalCache = new Map();

/**
 * Resolve a raw MFR string to its final canonical company name.
 * See module header for the full pipeline.
 *
 * @param {string} s - Raw MFR string from any source
 * @returns {string} Lowercased canonical key, or '' if input is empty
 */
function canonicalMfr(s) {
  if (!s) return '';
  if (_canonicalCache.has(s)) return _canonicalCache.get(s);

  // Tier 0: prenormalize — strip punctuation/whitespace/suffixes for
  // consistent input regardless of source formatting.
  const pre = prenormalizeMfr(s);
  if (!pre) { _canonicalCache.set(s, ''); return ''; }

  // Tier 1+2: alias file + cache + DB via shared lookup
  const aliasResolved = sharedMfrLookup.normalizeMfr(pre) || pre;
  let canonical = _toComparable(aliasResolved);

  // Tier 3: walk the acquisition chain (capped at 5 hops to avoid loops)
  for (let i = 0; i < 5; i++) {
    const next = ACQUISITIONS.get(canonical);
    if (!next || next === canonical) break;
    canonical = next;
  }

  _canonicalCache.set(s, canonical);
  return canonical;
}

/**
 * Compute the MFR match flag for an (rfqMfr, supplierMfr) pair.
 *
 * @param {string} rfqMfr - The customer/RFQ side manufacturer ask
 * @param {string} supplierMfr - The supplier/VQ/offer side manufacturer label
 * @returns {''|'MISMATCH'|'?'}
 *   ''         → same canonical company (or both blank)
 *   'MISMATCH' → both populated but resolve to different canonical companies
 *   '?'        → exactly one side blank (one-sided unknown)
 */
function computeMfrMatch(rfqMfr, supplierMfr) {
  const a = canonicalMfr(rfqMfr);
  const b = canonicalMfr(supplierMfr);
  if (a === b) return '';
  if (!a || !b) return '?';
  return 'MISMATCH';
}

/**
 * Invalidate the per-process canonical cache. Call from tests that need
 * clean isolation, or after editing the alias/acquisition files mid-process.
 */
function clearCache() {
  _canonicalCache.clear();
}

module.exports = {
  prenormalizeMfr,
  canonicalMfr,
  computeMfrMatch,
  clearCache,
};
