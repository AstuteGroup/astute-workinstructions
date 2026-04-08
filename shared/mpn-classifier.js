/**
 * MPN Classifier — heuristic sub-classification for parts that don't return
 * any franchise listing. Used by Market Offer Analysis Step 3a (and any other
 * workflow that needs to bucket "no franchise hit" lines into actionable
 * categories).
 *
 * **Why this exists:** When a franchise API run returns zero distributors
 * carrying a part, the meaning depends entirely on what KIND of part it is:
 *
 *   - **Customer-internal AML codes** (e.g., GE's "FK23011P1 REV B (SCRN)") →
 *     The customer should resolve these on their side. Astute can't sell parts
 *     by their internal codes — push back on the customer to provide industry
 *     MPNs or cross-references.
 *
 *   - **Mil-spec / one-off parts** (e.g., "5962-88565022A", "JANTX1N4969") →
 *     Legitimate industry parts, just obscure. Franchise rarely stocks them.
 *     Different conversation than internals — may warrant manual broker
 *     channel research, or they're genuinely low-volume and not worth
 *     pursuing.
 *
 *   - **Unknown / other** → Anything that doesn't match either pattern.
 *     Catch-all bucket; research case-by-case.
 *
 * Bucketing these correctly is what turns "65% of GE's lot has no franchise
 * coverage" (vague, defeatist) into "X are GE-internal AML codes that GE needs
 * to resolve, Y are mil-spec one-offs we'd source manually, Z are unknown"
 * (actionable, by sub-bucket).
 *
 * USAGE:
 *   const { classifyMpnNonFranchise } = require('../shared/mpn-classifier');
 *   const cls = classifyMpnNonFranchise('FK23011P1 REV B (SCRN)');
 *   // → 'NO_LISTING_INTERNAL'
 *
 *   const cls2 = classifyMpnNonFranchise('5962-88565022A');
 *   // → 'NO_LISTING_MILSPEC'
 *
 *   const cls3 = classifyMpnNonFranchise('CD4007BLCC', 'TI', 'CUST-001');
 *   // → 'NO_LISTING_INTERNAL' (CPC differs from MPN)
 *
 * RETURNS one of:
 *   - 'NO_LISTING_INTERNAL'  — looks like a customer-internal code
 *   - 'NO_LISTING_MILSPEC'   — looks like a mil-spec / industry one-off
 *   - 'NO_LISTING_UNKNOWN'   — neither; catch-all
 *
 * NOTE: This function should ONLY be called for lines where the franchise
 * APIs returned zero carriers. Don't use it as a general MPN classifier —
 * many parts that match these patterns are perfectly mainstream and DO have
 * franchise coverage. The classifier is purpose-built for the "no franchise
 * hit" sub-bucketing question.
 */

// ─── HEURISTIC PATTERNS ──────────────────────────────────────────────────────

// Customer-internal markers — these almost never appear in industry MPNs
const INTERNAL_PATTERNS = [
  /\bREV\s+[A-Z][A-Z0-9]?\b/i,           // "REV B", "REV AB" — revision markers
  /\((SCRN|PROG|SCREENED|PROGRAMMED|PREP|TESTED|MARKED)\)/i,  // process annotations
  /\bSCRN\b|\bPROG\b/i,                  // bare process tags
  /\(.*[A-Z]+.*\)/,                       // any all-caps annotation in parens (catches GE patterns like (SCRN), (PROG))
];

// Mil-spec / industry standard patterns — well-known prefix conventions
const MILSPEC_PATTERNS = [
  /^5962-/i,                              // SMD (Standard Microcircuit Drawing) — 5962-XXXXXXX
  /^JANTX[A-Z0-9]/i,                      // JANTX — JEDEC mil-spec passive
  /^JAN[A-Z]/i,                           // JAN[*] — JEDEC mil-spec
  /^M[0-9]+\//,                           // M*-numbered drawings (e.g., M83421/01-5136R, M22759/...)
  /^MS[0-9]/i,                            // MS-numbered drawings
  /^MIL-/i,                               // MIL-prefix
  /^M83?[0-9]+\//,                        // common M83/M85 drawings
  /^DSC[0-9]/i,                           // some DSC drawings
];

// ─── MAIN ────────────────────────────────────────────────────────────────────

/**
 * Classify an MPN that returned zero franchise carriers.
 *
 * @param {string} mpn        - The MPN as written on the offer line
 * @param {string} [mfrText]  - Optional MFR text (rarely useful but provided for completeness)
 * @param {string} [cpc]      - Optional customer part code from the offer line
 * @returns {'NO_LISTING_INTERNAL' | 'NO_LISTING_MILSPEC' | 'NO_LISTING_UNKNOWN'}
 */
function classifyMpnNonFranchise(mpn, mfrText, cpc) {
  if (!mpn || typeof mpn !== 'string') return 'NO_LISTING_UNKNOWN';
  const m = mpn.trim();
  if (!m) return 'NO_LISTING_UNKNOWN';

  // Check internal patterns first — they're the most specific
  for (const re of INTERNAL_PATTERNS) {
    if (re.test(m)) return 'NO_LISTING_INTERNAL';
  }

  // CPC differs from MPN → strong internal signal (the customer has their own
  // code AND a different MPN, meaning the MPN field probably has their CPC too)
  if (cpc && cpc.trim() && cpc.trim() !== m) {
    return 'NO_LISTING_INTERNAL';
  }

  // Mil-spec patterns
  for (const re of MILSPEC_PATTERNS) {
    if (re.test(m)) return 'NO_LISTING_MILSPEC';
  }

  // Default — unknown
  return 'NO_LISTING_UNKNOWN';
}

/**
 * Convenience: classify a batch and return a count breakdown.
 * Useful for lot-level summaries.
 *
 * @param {Array<{mpn, mfrText?, cpc?}>} lines
 * @returns {{ NO_LISTING_INTERNAL: number, NO_LISTING_MILSPEC: number, NO_LISTING_UNKNOWN: number }}
 */
function classifyBatch(lines) {
  const counts = { NO_LISTING_INTERNAL: 0, NO_LISTING_MILSPEC: 0, NO_LISTING_UNKNOWN: 0 };
  for (const l of lines) {
    const cls = classifyMpnNonFranchise(l.mpn, l.mfrText, l.cpc);
    counts[cls] = (counts[cls] || 0) + 1;
  }
  return counts;
}

module.exports = {
  classifyMpnNonFranchise,
  classifyBatch,
  // Exported for testing
  INTERNAL_PATTERNS,
  MILSPEC_PATTERNS,
};
