/**
 * Packaging Lookup — string → chuboe_packaging_id resolver with factory-pack policy
 *
 * Single source of truth for converting freetext packaging strings ("reel",
 * "Tape & Reel", "T&R", "cut tape", etc.) to the canonical chuboe_packaging
 * record IDs used by chuboe_vq_line.Chuboe_Packaging_ID and
 * chuboe_cq_line.Chuboe_Packaging_ID.
 *
 * Why this exists as a separate cog:
 *   Originally lived inside shared/vq-writer.js. Promoted to a shared module
 *   2026-04-08 (sourcing-roadmap C9b) so cq-writer can call the same resolver
 *   and populate Chuboe_Packaging_ID alongside Chuboe_Packaging_Text instead
 *   of writing text-only IDs that lose joinability — same shape as the C8/C15
 *   MFR text-vs-ID gap fix.
 *
 * USAGE:
 *
 *   const { normalizePackaging, PACKAGING_MAP } = require('./packaging-lookup');
 *
 *   // Default: NO factory upgrade (caller has no qty/spq context)
 *   normalizePackaging('Reel');
 *   // → 1000004 (REEL — plain variant, conservative default)
 *
 *   // Path 1 — input string explicitly claims factory (works for any vendor type)
 *   normalizePackaging('MFR Reel');           // → 1000001 (F-REEL — explicit marker)
 *   normalizePackaging('Factory Sealed Tube'); // → 1000003 (F-TUBE)
 *   normalizePackaging('F-REEL');             // → 1000001
 *   normalizePackaging('OEM tray');           // → 1000002 (F-TRAY)
 *
 *   // Path 2 — authorized vendor + full factory pack qty
 *   normalizePackaging('Reel', { qty: 1000, spq: 1000, isAuthorized: true });
 *   // → 1000001 (F-REEL)
 *
 *   normalizePackaging('Reel', { qty: 5000, spq: 1000, isAuthorized: true });
 *   // → 1000001 (F-REEL — 5 sealed reels)
 *
 *   // Partial qty → can't be factory by definition
 *   normalizePackaging('Reel', { qty: 750, spq: 1000, isAuthorized: true });
 *   // → 1000004 (REEL — partial, plain variant)
 *
 *   // Broker without explicit factory marker → conservative plain variant
 *   normalizePackaging('Reel', { qty: 1000, spq: 1000, isAuthorized: false });
 *   // → 1000004 (REEL — can't verify sealed without explicit claim)
 *
 *   normalizePackaging('CUT TAPE'); // → 1000006 (always, no F variant)
 *   normalizePackaging('something'); // → null (caller decides fallback)
 *   normalizePackaging('');           // → null
 *   normalizePackaging(null);         // → null
 *
 * POLICY (decided 2026-04-08):
 *
 *   1. **Factory-sealed (F-REEL / F-TRAY / F-TUBE) is the answer when ANY of:**
 *      a) The input string has an explicit factory marker
 *         ("mfr", "factory", "sealed", "oem", or "f-reel"/"f-tray"/"f-tube")
 *         — works for ANY vendor type. A broker who clearly states "MFR
 *         reel" is making a verifiable claim that the stock is still in
 *         original sealed packaging. Trust the explicit signal.
 *      b) Vendor is franchise or mfr-direct (authorized channel) AND the
 *         quoted qty matches the manufacturer's SPQ exactly OR is a clean
 *         integer multiple (5,000 from a 1,000 SPQ part = 5 sealed reels).
 *         Authorized channels ship factory packs by default — if the qty
 *         lines up, it's factory sealed.
 *
 *      Anything else → plain variant. The original cog erroneously mapped
 *      every "reel" string to F-REEL regardless of partial vs full pack;
 *      that was a bug. Partials can't be factory-sealed by definition, and
 *      broker stock without an explicit claim can't be verified sealed.
 *
 *   2. **Default (no context, no marker) is the plain variant**, NOT the
 *      F-variant. A caller that doesn't pass qty/spq/isAuthorized AND whose
 *      input string has no factory marker should get the conservative
 *      answer. Under-claiming "factory" is much safer than over-claiming —
 *      operators can upgrade to F at PO time, but misattributing partial
 *      or unverified stock as factory creates downstream PO bugs.
 *
 *   3. **Tube has no plain variant in chuboe_packaging.** F-TUBE (1000003)
 *      is the only tube ID. Tubes that don't qualify as factory-sealed
 *      (partial, or broker, or no SPQ) return NULL — caller must decide.
 *
 *   4. **CUT TAPE (1000006) is always returned for cut-tape inputs.**
 *      Cut tape is never factory-sealed by definition.
 *
 *   5. **BULK / BOX / AMMO** have no F-variant distinction — same ID
 *      regardless of context.
 *
 *   6. **Unknown inputs return NULL.** Callers decide their own fallback
 *      (typically opts.packagingId, or leave Chuboe_Packaging_ID unset and
 *      let downstream PO processing surface the gap). NEVER auto-fall-back
 *      to OTHER (1000010) — silent OTHER attribution buries data quality.
 *
 *   7. **Packaging is Tier 2** (only required at PO conversion). Writes
 *      with null packaging are valid at VQ/CQ load time — don't block.
 *
 * KNOWN GAPS:
 *   - chuboe_packaging.OTHER (1000010) is intentionally NOT in PACKAGING_MAP
 *   - Plain TUBE has no record in chuboe_packaging — tubes that aren't
 *     factory-sealed return null
 *
 * CONSUMERS:
 *   - shared/vq-writer.js — primary user (passes qty/spq/isAuthorized)
 *   - shared/cq-writer.js — added 2026-04-08 (C9c)
 *   - Future: any writer that needs string → packaging-id resolution
 */

// chuboe_packaging IDs (verified against DB 2026-04-08)
const PKG = {
  F_REEL:   1000001,
  F_TRAY:   1000002,
  F_TUBE:   1000003,
  REEL:     1000004,  // plain (non-factory)
  TRAY:     1000005,  // plain (non-factory)
  CUT_TAPE: 1000006,
  BOX:      1000007,
  BULK:     1000008,
  AMMO:     1000009,
  // OTHER (1000010) is intentionally NOT mapped — see Policy #6
};

// Family classification of normalized input strings.
// Each family has a `factoryId` (used when qualifies for factory) and
// `plainId` (the conservative default). `null` plainId means there's no
// plain variant in chuboe_packaging — caller falls back to null.
const FAMILY = {
  REEL:     { factoryId: PKG.F_REEL, plainId: PKG.REEL },
  TRAY:     { factoryId: PKG.F_TRAY, plainId: PKG.TRAY },
  TUBE:     { factoryId: PKG.F_TUBE, plainId: null },     // no plain TUBE in DB
  CUT_TAPE: { factoryId: PKG.CUT_TAPE, plainId: PKG.CUT_TAPE }, // always cut tape
  BULK:     { factoryId: PKG.BULK, plainId: PKG.BULK },
  BOX:      { factoryId: PKG.BOX, plainId: PKG.BOX },
  AMMO:     { factoryId: PKG.AMMO, plainId: PKG.AMMO },
};

// Normalized input string → family classification.
// Inputs are lowercased + whitespace-collapsed before lookup.
const STRING_TO_FAMILY = {
  'reel':           'REEL',
  'tape and reel':  'REEL',
  'tape & reel':    'REEL',
  't&r':            'REEL',
  'tr':             'REEL',
  'digi-reel':      'REEL',
  'digireel':       'REEL',
  'tray':           'TRAY',
  'f-tray':         'TRAY',
  'ftray':          'TRAY',
  'tube':           'TUBE',
  'f-tube':         'TUBE',
  'ftube':          'TUBE',
  'cut tape':       'CUT_TAPE',
  'cuttape':        'CUT_TAPE',
  'ct':             'CUT_TAPE',
  'bulk':           'BULK',
  'each':           'BULK',
  'bag':            'BULK',
  'ea':             'BULK',
  'box':            'BOX',
  'ammo':           'AMMO',
  'ammo pack':      'AMMO',
};

// LEGACY EXPORT — flat string → ID map. Kept for backward compatibility with
// any caller that imports PACKAGING_MAP directly. Reflects the OLD always-
// F-variant policy and should NOT be used for new code. Use normalizePackaging()
// with proper context instead.
const PACKAGING_MAP = {
  'reel': PKG.F_REEL,
  'tape and reel': PKG.F_REEL,
  'tape & reel': PKG.F_REEL,
  't&r': PKG.F_REEL,
  'tr': PKG.F_REEL,
  'digi-reel': PKG.F_REEL,
  'digireel': PKG.F_REEL,
  'cut tape': PKG.CUT_TAPE,
  'cuttape': PKG.CUT_TAPE,
  'ct': PKG.CUT_TAPE,
  'tube': PKG.F_TUBE,
  'f-tube': PKG.F_TUBE,
  'ftube': PKG.F_TUBE,
  'tray': PKG.F_TRAY,
  'f-tray': PKG.F_TRAY,
  'ftray': PKG.F_TRAY,
  'bulk': PKG.BULK,
  'each': PKG.BULK,
  'bag': PKG.BULK,
  'ea': PKG.BULK,
  'box': PKG.BOX,
  'ammo': PKG.AMMO,
  'ammo pack': PKG.AMMO,
};

/**
 * Determine whether the qty represents a full factory pack quantity:
 *   - qty must be a positive number
 *   - spq must be a positive number
 *   - qty must equal spq OR be an exact integer multiple of spq
 *
 * Returns false on any missing/invalid input.
 */
function isFullFactoryQty(qty, spq) {
  const q = Number(qty);
  const s = Number(spq);
  if (!Number.isFinite(q) || q <= 0) return false;
  if (!Number.isFinite(s) || s <= 0) return false;
  if (q < s) return false;
  // Exact multiple check (use ratio with rounding tolerance)
  const ratio = q / s;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

// Tokens in the input string that explicitly claim factory packaging.
// "f-reel" / "f-tray" / "f-tube" — explicit F prefix
// "mfr" / "factory" / "sealed" / "oem" — qualifier words
// Any of these in the (lowercased) input flips the factory flag regardless of
// vendor type or qty/spq math.
const FACTORY_MARKER_REGEX = /\b(?:mfr|factory|sealed|oem|f[-\s]?(?:reel|tray|tube))\b/i;

/**
 * Detect whether the input string explicitly claims factory packaging.
 * Returns true if the string contains an "mfr" / "factory" / "sealed" / "oem"
 * token, or starts with the "F-" prefix (F-REEL / F-TRAY / F-TUBE).
 */
function hasExplicitFactoryMarker(text) {
  if (!text) return false;
  return FACTORY_MARKER_REGEX.test(String(text));
}

/**
 * Strip factory marker tokens from the input so it can be classified by
 * family. "MFR Reel" → "reel", "Factory Sealed Tube" → "tube",
 * "F-REEL" → "reel", "f reel" → "reel".
 *
 * Used internally to feed STRING_TO_FAMILY lookup after we've already
 * detected (or not) an explicit factory marker.
 */
function stripFactoryMarkers(text) {
  return String(text)
    .toLowerCase()
    .replace(/\bf[-\s]?(reel|tray|tube)\b/g, '$1')  // "f-reel" / "f reel" → "reel"
    .replace(/\b(mfr|factory|sealed|oem)\b/g, '')   // remove qualifier words
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a packaging string to its chuboe_packaging_id, applying the
 * factory-pack policy.
 *
 * Three paths to the factory variant (in order of precedence):
 *   1. Explicit factory marker in the input string (works for any vendor)
 *   2. Authorized vendor + full factory pack qty (qty matches or multiplies SPQ)
 *   3. Otherwise → plain variant
 *
 * @param {string|null|undefined} text - Raw packaging string
 * @param {object} [opts]
 * @param {number} [opts.qty] - The quoted quantity
 * @param {number} [opts.spq] - Manufacturer's standard package quantity
 * @param {boolean} [opts.isAuthorized] - True if vendor is franchise / mfr-direct /
 *   catalog distributor / online distributor (authorized channel that ships
 *   factory-sealed packs by default). Caller computes this from vendor type.
 * @returns {number|null} chuboe_packaging_id, or null if no match
 */
function normalizePackaging(text, opts = {}) {
  if (!text) return null;

  // Detect explicit factory marker BEFORE stripping anything
  const explicitFactory = hasExplicitFactoryMarker(text);

  // Try direct lookup first (covers the canonical entries like "reel",
  // "f-reel", "tape and reel", etc.)
  let key = String(text).toLowerCase().trim().replace(/\s+/g, ' ');
  let familyName = STRING_TO_FAMILY[key];

  // If no direct hit and the input has factory markers, strip them and try
  // again (handles compound forms like "MFR reel", "factory sealed tube")
  if (!familyName && explicitFactory) {
    key = stripFactoryMarkers(text);
    familyName = STRING_TO_FAMILY[key];
  }

  if (!familyName) return null;

  const family = FAMILY[familyName];

  // Cut tape, bulk, box, ammo: factory and plain are the same ID
  if (family.factoryId === family.plainId) {
    return family.factoryId;
  }

  // Reel / Tray / Tube: factory upgrade via either explicit marker OR
  // (authorized vendor AND full pack qty)
  const qualifiesForFactory = explicitFactory
    || (!!opts.isAuthorized && isFullFactoryQty(opts.qty, opts.spq));

  if (qualifiesForFactory) {
    return family.factoryId;
  }

  // Conservative default: plain variant. For TUBE this is null (no plain
  // record in DB) — caller decides what to do.
  return family.plainId;
}

module.exports = {
  PKG,
  PACKAGING_MAP,           // legacy — see warning above
  normalizePackaging,
  isFullFactoryQty,        // exported for testing
  hasExplicitFactoryMarker,// exported for testing
  stripFactoryMarkers,     // exported for testing
};
