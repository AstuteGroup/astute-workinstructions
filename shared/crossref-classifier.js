/**
 * Cross-Ref Classifier — decides what to do when the franchise API returns
 * a different MPN than what was searched.
 *
 * Layered ON TOP of vq-writer's existing checkMpnCrossRef:
 *   - checkMpnCrossRef already auto-writes clean packaging variants (-T, -TR,
 *     and length-preserving trailing-char swaps) via stripPackaging + the
 *     length-based last-char check.
 *   - This classifier only runs when checkMpnCrossRef returns mismatch=true.
 *
 * Four-way decision:
 *   drop          — RFQ MFR text blank. No inference base. Silent skip.
 *                   (Volume: ~15 lines / 14 RFQs at len ≤5 over 90d.)
 *   auto-reject   — RFQ MFR set + supplier MFR set + computeMfrMatch MISMATCH.
 *                   Catches the HPE/Dell/Brocade reseller-brand pattern where
 *                   DigiKey returns a real component MFR (TI etc.). Silent
 *                   skip; counted in digest.
 *   auto-approve  — MFR match + RFQ MPN is exact prefix of returned MPN.
 *                   Covers MAX9295A → MAX9295AGTJ/V+T, 74HC04D → 74HC04D-T,
 *                   etc. that stripPackaging didn't auto-write. VQ writes
 *                   immediately with an audit note.
 *   pending       — MFR match + MPN stem differs more substantially. Goes
 *                   into the per-RFQ staging queue for operator review.
 *
 * The MFR match check uses shared/mfr-equivalence which canonicalizes via
 * the alias file + acquisitions chain. It does NOT require either side's
 * MFR to be resolved in OT's chuboe_mfr table — pure text comparison —
 * so it's decoupled from the MFR Reconciler's daily backfill cadence.
 *
 * Returns:
 *   {
 *     decision: 'drop' | 'auto-reject' | 'auto-approve' | 'pending',
 *     reason: string,   // short tag for logging/counters
 *     note: string|null // audit-trail string for Chuboe_Note_User when auto-approve
 *   }
 */

const { computeMfrMatch } = require('./mfr-equivalence');

function normalizeMpn(s) {
  return String(s || '').trim().toUpperCase();
}

/**
 * Is `searched` an exact prefix of `returned` after light normalization?
 * Case-insensitive; trims whitespace. No separator-stripping (we want true
 * prefix, not the more permissive stripPackaging logic that already auto-
 * writes packaging variants in vq-writer).
 */
function isCleanPrefix(searched, returned) {
  const s = normalizeMpn(searched);
  const r = normalizeMpn(returned);
  if (!s || !r) return false;
  if (s === r) return false; // exact match should never have hit the classifier
  if (s.length >= r.length) return false; // searched can't be a strict prefix
  return r.startsWith(s);
}

/**
 * Classify a cross-ref candidate.
 *
 * @param {object} ctx
 * @param {string} ctx.searchedMpn       - MPN the customer/scraper asked for
 * @param {string} ctx.returnedMpn       - MPN the supplier returned
 * @param {string} ctx.rfqMfrText        - MFR text on the RFQ line (may be blank)
 * @param {string} ctx.supplierMfrText   - MFR text from the API row (may be blank)
 * @returns {{decision: string, reason: string, note: string|null}}
 */
function classifyCrossRef(ctx) {
  const { searchedMpn, returnedMpn, rfqMfrText, supplierMfrText } = ctx;

  const rfqMfr = String(rfqMfrText || '').trim();
  const supplierMfr = String(supplierMfrText || '').trim();

  // 1. drop: no inference base
  if (!rfqMfr) {
    return {
      decision: 'drop',
      reason: 'BLANK_RFQ_MFR',
      note: null,
    };
  }

  // 2. MFR comparison via canonical equivalence
  const matchFlag = computeMfrMatch(rfqMfr, supplierMfr);
  if (matchFlag === 'MISMATCH') {
    return {
      decision: 'auto-reject',
      reason: 'MFR_MISMATCH',
      note: null,
    };
  }
  if (matchFlag === '?') {
    // One side blank — supplier didn't return MFR. Defer to operator rather
    // than risk auto-approval on a half-blank comparison.
    return {
      decision: 'pending',
      reason: 'SUPPLIER_MFR_BLANK',
      note: null,
    };
  }

  // MFR matches (matchFlag === '')
  // 3. auto-approve: RFQ MPN is clean prefix of returned MPN
  if (isCleanPrefix(searchedMpn, returnedMpn)) {
    return {
      decision: 'auto-approve',
      reason: 'PREFIX_VARIANT',
      note: `Cross-ref auto-approved: ${searchedMpn} → ${returnedMpn} (prefix variant + MFR match)`,
    };
  }

  // 4. pending: MFR match but stem differs
  return {
    decision: 'pending',
    reason: 'STEM_DIFFERS',
    note: null,
  };
}

module.exports = {
  classifyCrossRef,
  isCleanPrefix, // exported for tests
};
