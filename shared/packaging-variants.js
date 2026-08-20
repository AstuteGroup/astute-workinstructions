/**
 * Packaging Variant Expansion Module
 *
 * Generates packaging variant MPNs based on manufacturer-level suffix rules.
 * Rules are stored in the database (chuboe_mfr_packaging_suffix) and cached.
 *
 * Architecture:
 *   - Store suffix rules at MFR level, not MPN level (~2000 rows vs millions)
 *   - At query time, apply rules to generate candidate variants
 *   - Type A franchises (DigiKey) return variants automatically - use their response
 *   - Type B franchises need us to generate + query each variant
 *
 * NOTE: Restricted Manufacturers
 *   Packaging variant expansion runs for ALL manufacturers, including restricted.
 *   We still profile restricted parts for market intelligence.
 *   The restriction check applies at BUYING (VQ creation), not at profiling.
 *   See: shared/restricted-mfrs.js
 *
 * See: scripts/audit-franchise-variant-behavior.js for API type classification
 * See: docs/packaging-variants.md for full documentation
 *
 * @module shared/packaging-variants
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CACHE ──────────────────────────────────────────────────────────────────

const CACHE_FILE = path.resolve(__dirname, 'data/mfr-suffix-rules.json');
let _suffixRulesCache = null;
let _cacheLoadedAt = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Load suffix rules from cache file.
 * Falls back to hardcoded defaults if no cache exists.
 */
function loadSuffixRules() {
  // Check if cache is fresh
  if (_suffixRulesCache && _cacheLoadedAt && (Date.now() - _cacheLoadedAt < CACHE_TTL_MS)) {
    return _suffixRulesCache;
  }

  // Try to load from file
  if (fs.existsSync(CACHE_FILE)) {
    try {
      _suffixRulesCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      _cacheLoadedAt = Date.now();
      return _suffixRulesCache;
    } catch (err) {
      console.warn(`[packaging-variants] Failed to load cache: ${err.message}`);
    }
  }

  // Fall back to hardcoded defaults (bootstrap)
  _suffixRulesCache = getDefaultSuffixRules();
  _cacheLoadedAt = Date.now();
  return _suffixRulesCache;
}

/**
 * Verified suffix rules from manufacturer documentation.
 *
 * Sources:
 * - Vishay: https://forum.digikey.com/t/vishay-08-and-18-suffix-callouts-in-part-number-bat54a-g3/8626
 * - Nexperia: https://www.tti.com/content/ttiinc/en/manufacturers/nexperia/resources/nexperia-suffixes.html
 * - Murata: https://forum.digikey.com/t/murata-capacitor-suffix/48328
 * - Panasonic: https://forum.digikey.com/t/panasonic-discrete-smd-products-00l-suffix-meaning/13526
 * - Samtec: https://www.samtec.com/products/tle-102-01-g-dv-tr
 */
function getDefaultSuffixRules() {
  return {
    // ═══════════════════════════════════════════════════════════════════════
    // SEMICONDUCTORS - verified from DigiKey/manufacturer docs
    // ═══════════════════════════════════════════════════════════════════════

    // Texas Instruments - R=7" reel, T=13" reel
    'Texas Instruments': {
      suffixGroups: {
        REEL_SIZE: ['R', 'T'],
      },
      suffixes: [
        { suffix: 'R', group: 'REEL_SIZE', packaging: 'TAPE_REEL_7' },
        { suffix: 'T', group: 'REEL_SIZE', packaging: 'TAPE_REEL_13' },
      ],
    },

    // Analog Devices (includes Linear, Maxim)
    'Analog Devices': {
      suffixGroups: {
        REEL_SIZE: ['REEL', 'REEL7', 'RZ', 'R2'],
      },
      suffixes: [
        { suffix: 'REEL', group: 'REEL_SIZE', packaging: 'TAPE_REEL_13' },
        { suffix: 'REEL7', group: 'REEL_SIZE', packaging: 'TAPE_REEL_7' },
        { suffix: 'RZ', group: 'REEL_SIZE', packaging: 'TAPE_REEL_7' },
        { suffix: 'R2', group: 'REEL_SIZE', packaging: 'TAPE_REEL' },
      ],
    },

    // Infineon (includes IR) - PBF=tube, TRPBF=tape&reel (both lead-free)
    'Infineon': {
      suffixGroups: {
        LEAD_FREE_PKG: ['PBF', 'TRPBF'],
      },
      suffixes: [
        { suffix: 'PBF', group: 'LEAD_FREE_PKG', packaging: 'TUBE' },
        { suffix: 'TRPBF', group: 'LEAD_FREE_PKG', packaging: 'TAPE_REEL' },
      ],
    },

    // STMicroelectronics - TR=tape&reel
    'STMicroelectronics': {
      suffixGroups: {
        PACKAGING: ['TR'],
      },
      suffixes: [
        { suffix: 'TR', group: 'PACKAGING', packaging: 'TAPE_REEL' },
      ],
    },

    // ON Semiconductor - G=bulk, T1G/TG=tape&reel
    'ON Semiconductor': {
      suffixGroups: {
        PACKAGING: ['G', 'T1G', 'TG'],
      },
      suffixes: [
        { suffix: 'G', group: 'PACKAGING', packaging: 'BULK' },
        { suffix: 'T1G', group: 'PACKAGING', packaging: 'TAPE_REEL' },
        { suffix: 'TG', group: 'PACKAGING', packaging: 'TAPE_REEL' },
      ],
    },

    // NXP
    'NXP': {
      suffixGroups: {
        PACKAGING: ['J', 'T', 'U'],
      },
      suffixes: [
        { suffix: 'J', group: 'PACKAGING', packaging: 'TUBE' },
        { suffix: 'T', group: 'PACKAGING', packaging: 'TAPE_REEL' },
        { suffix: 'U', group: 'PACKAGING', packaging: 'TAPE_REEL' },
      ],
    },

    // Microchip (includes Atmel)
    'Microchip': {
      suffixGroups: {
        PACKAGING: ['T', 'CT'],
      },
      suffixes: [
        { suffix: 'T', group: 'PACKAGING', packaging: 'TAPE' },
        { suffix: 'CT', group: 'PACKAGING', packaging: 'CUT_TAPE' },
      ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PASSIVES - verified from manufacturer docs (different conventions!)
    // ═══════════════════════════════════════════════════════════════════════

    // Vishay - uses 2-digit numeric suffixes: 08=7" reel, 18=13" reel
    // Also ED/EE for CRCW resistors: ED=7", EE=13"
    // Source: https://forum.digikey.com/t/vishay-08-and-18-suffix-callouts-in-part-number-bat54a-g3/8626
    'Vishay': {
      suffixGroups: {
        REEL_SIZE_NUMERIC: ['08', '18'],
        REEL_SIZE_CRCW: ['ED', 'EE'],
        REEL_SIZE_E: ['E3', 'EA'],
      },
      suffixes: [
        { suffix: '08', group: 'REEL_SIZE_NUMERIC', packaging: 'TAPE_REEL_7' },
        { suffix: '18', group: 'REEL_SIZE_NUMERIC', packaging: 'TAPE_REEL_13' },
        { suffix: 'ED', group: 'REEL_SIZE_CRCW', packaging: 'TAPE_REEL_7' },
        { suffix: 'EE', group: 'REEL_SIZE_CRCW', packaging: 'TAPE_REEL_13' },
        { suffix: 'E3', group: 'REEL_SIZE_E', packaging: 'TAPE_REEL' },
        { suffix: 'EA', group: 'REEL_SIZE_E', packaging: 'TAPE_REEL' },
      ],
    },

    // Murata - D=4000pc reel, J=10000pc reel, L=tape&reel
    // Source: https://forum.digikey.com/t/murata-capacitor-suffix/48328
    'Murata': {
      suffixGroups: {
        REEL_QTY: ['D', 'J', 'L'],
      },
      suffixes: [
        { suffix: 'D', group: 'REEL_QTY', packaging: 'TAPE_REEL_4000' },
        { suffix: 'J', group: 'REEL_QTY', packaging: 'TAPE_REEL_10000' },
        { suffix: 'L', group: 'REEL_QTY', packaging: 'TAPE_REEL' },
      ],
    },

    // Panasonic - L/00L=tape&reel, A=tape&reel (ERG series)
    // Source: https://forum.digikey.com/t/panasonic-discrete-smd-products-00l-suffix-meaning/13526
    'Panasonic': {
      suffixGroups: {
        PACKAGING: ['L', '00L', 'A'],
      },
      suffixes: [
        { suffix: 'L', group: 'PACKAGING', packaging: 'TAPE_REEL' },
        { suffix: '00L', group: 'PACKAGING', packaging: 'TAPE_REEL' },
        { suffix: 'A', group: 'PACKAGING', packaging: 'TAPE_REEL' },
      ],
    },

    // Nexperia - uses 3-digit numeric codes (,215 = 7" reel standard)
    // Source: https://www.tti.com/content/ttiinc/en/manufacturers/nexperia/resources/nexperia-suffixes.html
    // Note: Nexperia suffixes are complex - ,215 is most common for 7" reel
    'Nexperia': {
      suffixGroups: {
        REEL_CODE: [',215', ',235'],
      },
      suffixes: [
        { suffix: ',215', group: 'REEL_CODE', packaging: 'TAPE_REEL_7' },
        { suffix: ',235', group: 'REEL_CODE', packaging: 'TAPE_REEL_13' },
      ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // CONNECTORS - verified from manufacturer docs
    // ═══════════════════════════════════════════════════════════════════════

    // Samtec - -TR suffix = tape & reel
    // Source: https://www.samtec.com/products/tle-102-01-g-dv-tr
    'Samtec': {
      suffixGroups: {
        PACKAGING: ['-TR', 'TR'],
      },
      suffixes: [
        { suffix: '-TR', group: 'PACKAGING', packaging: 'TAPE_REEL' },
        { suffix: 'TR', group: 'PACKAGING', packaging: 'TAPE_REEL' },
      ],
    },
  };
}

/**
 * Save suffix rules to cache file.
 */
function saveSuffixRules(rules) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(rules, null, 2));
  _suffixRulesCache = rules;
  _cacheLoadedAt = Date.now();
}

// ─── SUFFIX DETECTION ───────────────────────────────────────────────────────

/**
 * Detect which suffix (if any) an MPN ends with for a given manufacturer.
 *
 * @param {string} mpn - The MPN to analyze
 * @param {string} mfr - Manufacturer name (will be normalized)
 * @returns {Object|null} { suffix, group, packaging } or null if no match
 */
function detectSuffix(mpn, mfr) {
  if (!mpn || !mfr) return null;

  const rules = loadSuffixRules();
  const mfrRules = findMfrRules(mfr, rules);
  if (!mfrRules || !mfrRules.suffixes) return null;

  const mpnUpper = mpn.toUpperCase();

  // Sort suffixes by length (longest first) to avoid partial matches
  const sortedSuffixes = [...mfrRules.suffixes].sort((a, b) => b.suffix.length - a.suffix.length);

  for (const rule of sortedSuffixes) {
    if (mpnUpper.endsWith(rule.suffix)) {
      return {
        suffix: rule.suffix,
        group: rule.group,
        packaging: rule.packaging,
      };
    }
  }

  return null;
}

/**
 * Find rules for a manufacturer (handles aliases).
 */
function findMfrRules(mfr, rules) {
  if (!mfr) return null;

  const mfrUpper = mfr.toUpperCase();

  // Direct match
  for (const [key, value] of Object.entries(rules)) {
    if (key.toUpperCase() === mfrUpper) return value;
  }

  // Alias matching
  const aliases = {
    'TI': 'Texas Instruments',
    'TEXAS INSTRUMENTS INC': 'Texas Instruments',
    'TEXAS INSTRUMENTS INCORPORATED': 'Texas Instruments',
    'ADI': 'Analog Devices',
    'ANALOG DEVICES INC': 'Analog Devices',
    'LINEAR TECHNOLOGY': 'Analog Devices',
    'LINEAR': 'Analog Devices',
    'MAXIM': 'Analog Devices',
    'MAXIM INTEGRATED': 'Analog Devices',
    'MICROCHIP TECHNOLOGY': 'Microchip',
    'ATMEL': 'Microchip',
    'INFINEON TECHNOLOGIES': 'Infineon',
    'INTERNATIONAL RECTIFIER': 'Infineon',
    'IR': 'Infineon',
    'ST': 'STMicroelectronics',
    'STMICRO': 'STMicroelectronics',
    'ONSEMI': 'ON Semiconductor',
    'ON SEMI': 'ON Semiconductor',
    'NXP SEMICONDUCTORS': 'NXP',
  };

  const canonical = aliases[mfrUpper];
  if (canonical) {
    return rules[canonical] || null;
  }

  return null;
}

// ─── VARIANT EXPANSION ──────────────────────────────────────────────────────

/**
 * Generate packaging variant MPNs for a given MPN and manufacturer.
 *
 * @param {string} mpn - The base MPN
 * @param {string} mfr - Manufacturer name
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.includeOriginal=true] - Include the original MPN in results
 * @returns {string[]} Array of variant MPNs
 */
function expandPackagingVariants(mpn, mfr, opts = {}) {
  const { includeOriginal = true } = opts;

  if (!mpn || !mfr) {
    return includeOriginal ? [mpn] : [];
  }

  const rules = loadSuffixRules();
  const mfrRules = findMfrRules(mfr, rules);

  if (!mfrRules || !mfrRules.suffixes || !mfrRules.suffixGroups) {
    return includeOriginal ? [mpn] : [];
  }

  const mpnUpper = mpn.toUpperCase();
  const variants = new Set();

  if (includeOriginal) variants.add(mpn);

  // Detect current suffix
  const detected = detectSuffix(mpn, mfr);

  if (detected && mfrRules.suffixGroups[detected.group]) {
    // Replace suffix with each other suffix in the same group
    const baseMpn = mpnUpper.slice(0, -detected.suffix.length);
    const groupSuffixes = mfrRules.suffixGroups[detected.group];

    for (const altSuffix of groupSuffixes) {
      if (altSuffix !== detected.suffix) {
        variants.add(baseMpn + altSuffix);
      }
    }
  } else {
    // No suffix detected - try appending common reel suffixes
    // Only do this for the REEL_SIZE group (most common substitution)
    const reelGroup = mfrRules.suffixGroups.REEL_SIZE;
    if (reelGroup) {
      for (const suffix of reelGroup) {
        variants.add(mpnUpper + suffix);
      }
    }
  }

  return [...variants];
}

/**
 * Check if two MPNs are packaging variants of each other.
 *
 * @param {string} mpn1 - First MPN
 * @param {string} mpn2 - Second MPN
 * @param {string} mfr - Manufacturer name
 * @returns {boolean} True if they're packaging variants
 */
function arePackagingVariants(mpn1, mpn2, mfr) {
  if (!mpn1 || !mpn2 || !mfr) return false;
  if (mpn1.toUpperCase() === mpn2.toUpperCase()) return true;

  const variants1 = expandPackagingVariants(mpn1, mfr);
  return variants1.some(v => v.toUpperCase() === mpn2.toUpperCase());
}

// ─── RULE UPDATES ───────────────────────────────────────────────────────────

/**
 * Learn a new suffix pattern from observed data.
 * Call this when discovery finds new patterns.
 *
 * @param {string} mfr - Manufacturer name
 * @param {string} suffix - The suffix observed
 * @param {string} group - Suffix group (e.g., 'REEL_SIZE')
 * @param {string} [packaging] - Packaging type
 */
function learnSuffixPattern(mfr, suffix, group, packaging = null) {
  const rules = loadSuffixRules();

  // Find or create MFR entry
  let mfrRules = findMfrRules(mfr, rules);
  if (!mfrRules) {
    rules[mfr] = { suffixGroups: {}, suffixes: [] };
    mfrRules = rules[mfr];
  }

  // Add to suffix group
  if (!mfrRules.suffixGroups[group]) {
    mfrRules.suffixGroups[group] = [];
  }
  if (!mfrRules.suffixGroups[group].includes(suffix)) {
    mfrRules.suffixGroups[group].push(suffix);
  }

  // Add to suffixes array
  const existing = mfrRules.suffixes.find(s => s.suffix === suffix);
  if (!existing) {
    mfrRules.suffixes.push({ suffix, group, packaging });
  }

  saveSuffixRules(rules);
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  // Main functions
  expandPackagingVariants,
  detectSuffix,
  arePackagingVariants,

  // Rule management
  loadSuffixRules,
  saveSuffixRules,
  learnSuffixPattern,

  // Utilities
  findMfrRules,
  getDefaultSuffixRules,

  // For testing
  _clearCache: () => { _suffixRulesCache = null; _cacheLoadedAt = null; },
};
