/**
 * MPN Normalization for Clean Matching
 *
 * MPNs in the wild come in many variations:
 * - With/without hyphens: ECP-U1C104MA5 vs ECPU1C104MA5
 * - With/without spaces: MAX 3232 vs MAX3232
 * - With/without slashes: LM358/NOPB vs LM358NOPB
 * - Leading zeros: 09552156612741 vs 9552156612741
 * - Case variations: max3232 vs MAX3232
 *
 * This module provides clean normalization (strip all special characters,
 * uppercase, strip leading zeros) for exact matching after normalization.
 *
 * This is NOT fuzzy matching (Levenshtein distance, soundex, etc.).
 * This is exact matching after both sides are cleaned.
 *
 * USAGE:
 *   const { normalizeMPN, mpnMatch } = require('../shared/mpn-normalization');
 *
 *   // Normalize before comparison
 *   const clean = normalizeMPN('ECP-U1C104MA5');  // -> 'ECPU1C104MA5'
 *
 *   // Direct comparison
 *   if (mpnMatch('ECP-U1C104MA5', 'ECPU1C104MA5')) { ... }  // -> true
 *
 *   // Array search
 *   const found = rows.find(r => mpnMatch(r.MPN, searchMPN));
 *
 * REPLACE THESE PATTERNS:
 *   ❌ String(mpn).trim().toUpperCase() === searchTerm
 *   ❌ mpn.replace(/^0+/, '') === searchTerm
 *   ✅ mpnMatch(mpn, searchTerm)
 */

/**
 * Normalize an MPN for clean matching
 *
 * Strips:
 * - All non-alphanumeric characters (hyphens, spaces, slashes, dots, etc.)
 * - Leading zeros (e.g., 09552156612741 -> 9552156612741)
 * - Case differences (uppercased)
 *
 * @param {string|null|undefined} mpn - MPN to normalize
 * @returns {string} - Normalized MPN (empty string if input is falsy)
 *
 * @example
 *   normalizeMPN('ECP-U1C104MA5')      // -> 'ECPU1C104MA5'
 *   normalizeMPN('09552156612741')    // -> '9552156612741'
 *   normalizeMPN('MAX 3232')           // -> 'MAX3232'
 *   normalizeMPN('LM358/NOPB')         // -> 'LM358NOPB'
 *   normalizeMPN(null)                 // -> ''
 */
function normalizeMPN(mpn) {
  const t = String(mpn || '').trim();
  if (!t) return '';

  // Strip all non-alphanumeric, uppercase
  const cleaned = t.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Strip leading zeros, but preserve if MPN is literally all zeros
  const stripped = cleaned.replace(/^0+/, '');
  return stripped || cleaned;
}

/**
 * Compare two MPNs for equality after normalization
 *
 * @param {string} mpn1 - First MPN
 * @param {string} mpn2 - Second MPN
 * @returns {boolean} - True if normalized forms match
 *
 * @example
 *   mpnMatch('ECP-U1C104MA5', 'ECPU1C104MA5')  // -> true
 *   mpnMatch('MAX 3232', 'MAX3232')             // -> true
 *   mpnMatch('LM358', 'LM359')                  // -> false
 */
function mpnMatch(mpn1, mpn2) {
  return normalizeMPN(mpn1) === normalizeMPN(mpn2);
}

/**
 * Find an item in an array by MPN (normalized matching)
 *
 * @param {Array} items - Array to search
 * @param {string} searchMPN - MPN to find
 * @param {string|function} mpnField - Field name or getter function for MPN
 * @returns {*} - First matching item, or undefined
 *
 * @example
 *   const rows = [{MPN: 'ECP-U1C104MA5', price: 0.25}, ...];
 *   const found = findByMPN(rows, 'ECPU1C104MA5', 'MPN');
 *
 *   // With getter function
 *   const found = findByMPN(rows, 'ECPU1C104MA5', r => r.partNumber);
 */
function findByMPN(items, searchMPN, mpnField = 'MPN') {
  const normalizedSearch = normalizeMPN(searchMPN);
  const getter = typeof mpnField === 'function'
    ? mpnField
    : (item) => item[mpnField];

  return items.find(item => normalizeMPN(getter(item)) === normalizedSearch);
}

/**
 * Filter an array by MPN (normalized matching)
 *
 * @param {Array} items - Array to filter
 * @param {string} searchMPN - MPN to match
 * @param {string|function} mpnField - Field name or getter function for MPN
 * @returns {Array} - All matching items
 *
 * @example
 *   const allMatches = filterByMPN(vqLines, 'ECP-U1C104MA5', 'chuboe_mpn');
 */
function filterByMPN(items, searchMPN, mpnField = 'MPN') {
  const normalizedSearch = normalizeMPN(searchMPN);
  const getter = typeof mpnField === 'function'
    ? mpnField
    : (item) => item[mpnField];

  return items.filter(item => normalizeMPN(getter(item)) === normalizedSearch);
}

module.exports = {
  normalizeMPN,
  mpnMatch,
  findByMPN,
  filterByMPN
};
