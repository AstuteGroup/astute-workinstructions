/**
 * MPN match — "is this candidate part the same part the user searched for?"
 *
 * Used by every franchise distributor parser to reject "you might also like"
 * recommendations that the distributor's keyword search returns when the
 * exact MPN isn't carried. Without this guard, parsers fall back to
 * `products[0]` and silently report a totally different part as if it were
 * the searched MPN — producing wrong sourcing decisions.
 *
 * Match tiers:
 *   exact   — same after normalize (strip dashes/spaces, uppercase)
 *   variant — one side prefix-contains the other (after normalize), with both
 *             sides ≥ MIN_LEN. Catches packaging-suffix variants:
 *               LM358N ↔ LM358N/NOPB
 *               CRCW0402-T/R ↔ CRCW0402
 *               TPS5430 ↔ TPS5430DDA
 *             without us having to enumerate every distributor's suffix
 *             conventions.
 *   null    — no match
 *
 * Optional MFR veto: if the caller passes the searched MFR and the candidate's
 * MFR resolves to MISMATCH (per shared/mfr-equivalence — handles aliases +
 * acquisitions), the candidate is rejected. This catches cases where the MPN
 * "looks similar" but the MFR is a totally different company.
 *
 * USAGE:
 *   const { mpnMatch, pickBestCandidate, normalize } = require('../shared/mpn-match');
 *
 *   const m = mpnMatch('LM358N', 'LM358N/NOPB', { mfr: 'TI', candidateMfr: 'Texas Instruments' });
 *   // → { matchType: 'variant' }
 *
 *   const best = pickBestCandidate(parts, {
 *     getMpn: p => p.ManufacturerPartNumber,
 *     getMfr: p => p.Manufacturer,
 *     getStock: p => parseAvailability(p.AvailabilityInStock),
 *     searched: 'LM358N',
 *     opts: { mfr: 'TI' },
 *   });
 *   if (!best) return result;  // no match — never fall back to parts[0]
 */

const { computeMfrMatch } = require('./mfr-equivalence');

// Minimum normalized length to allow a prefix/variant match. Below this we
// only allow exact matches — too short a search is too easily prefix-bombed
// by unrelated parts (e.g., "LM78" matching dozens of unrelated regulators).
const MIN_LEN = 5;

function normalize(mpn) {
  if (!mpn) return '';
  return String(mpn).replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Return { matchType: 'exact' | 'variant' } or null.
 */
function mpnMatch(searched, candidate, opts = {}) {
  const ns = normalize(searched);
  const nc = normalize(candidate);
  if (!ns || !nc) return null;

  // MFR veto — only if both sides provided. MISMATCH = both populated,
  // different companies (after acquisition + alias resolution).
  if (opts.mfr && opts.candidateMfr) {
    const flag = computeMfrMatch(opts.mfr, opts.candidateMfr);
    if (flag === 'MISMATCH') return null;
  }

  if (ns === nc) return { matchType: 'exact' };

  if (ns.length >= MIN_LEN && nc.length >= MIN_LEN) {
    if (nc.startsWith(ns) || ns.startsWith(nc)) {
      return { matchType: 'variant' };
    }
  }

  return null;
}

/**
 * Pick the best candidate from a result list.
 *
 * @param {Array} candidates - raw API result objects
 * @param {Object} cfg
 * @param {Function} cfg.getMpn   - extract MPN from candidate
 * @param {Function} [cfg.getMfr] - extract MFR from candidate (enables MFR veto)
 * @param {Function} [cfg.getStock] - extract stock qty (used to break ties)
 * @param {string}   cfg.searched - the searched MPN
 * @param {Object}   [cfg.opts]   - { mfr } - searched MFR for veto
 *
 * @returns {{ candidate: Object, matchType: 'exact'|'variant' } | null}
 */
function pickBestCandidate(candidates, cfg) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const { getMpn, getMfr, getStock, searched, opts = {} } = cfg;

  const scored = [];
  for (const c of candidates) {
    const candidateMfr = getMfr ? getMfr(c) : null;
    const m = mpnMatch(searched, getMpn(c), { mfr: opts.mfr, candidateMfr });
    if (m) {
      scored.push({
        c,
        matchType: m.matchType,
        stock: getStock ? (Number(getStock(c)) || 0) : 0,
      });
    }
  }
  if (scored.length === 0) return null;

  // Prefer exact > variant; within tier, prefer higher stock.
  scored.sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === 'exact' ? -1 : 1;
    return b.stock - a.stock;
  });
  return { candidate: scored[0].c, matchType: scored[0].matchType };
}

module.exports = { normalize, mpnMatch, pickBestCandidate, MIN_LEN };
