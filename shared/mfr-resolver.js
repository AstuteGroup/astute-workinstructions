/**
 * MFR Resolver — single entry point for "what manufacturer is this row?"
 *
 * Combines two underlying cogs and applies acquisition policy:
 *
 *   1. shared/mfr-lookup.js     — text path: source provides a brand string,
 *                                 we resolve to the canonical iDempiere record
 *                                 (Policy D #1: preserve source intent)
 *   2. shared/mpn-mfr-classifier.js — MPN path: source has no MFR, we infer
 *                                     the original maker from the part number
 *                                     prefix (Policy D #3 step 1)
 *   3. shared/data/mfr-acquisitions.json — acquisition map: original maker →
 *                                          current owner. Applied ONLY to the
 *                                          MPN-inference path, never to
 *                                          source-provided text (Policy D #3
 *                                          step 2)
 *
 * Policy D recap (decided 2026-04-08):
 *   - Source has a specific MFR string → preserve as-is, normalize to
 *     canonical record (Policy D #1)
 *   - Multiple iDempiere records for the same brand → pick one canonical
 *     (Policy D #2 — handled by mfr-aliases.json + mfr-lookup.js)
 *   - Source has NO MFR → infer from MPN, attribute to current owner if the
 *     original maker has been acquired (Policy D #3)
 *
 * USAGE:
 *
 *   const { resolveMfrForRow } = require('../shared/mfr-resolver');
 *
 *   // Text path — source-provided MFR, resolved to canonical record
 *   resolveMfrForRow({ mfrText: 'LINEAR TECH' });
 *   // → { matched: true, canonical: 'Linear Technology Corp', id: 1000037,
 *   //     path: 'text', source: 'alias', confidence: 'high', acquisitionApplied: false }
 *
 *   // MPN path — no MFR text, inferred from prefix + acquisition map applied
 *   resolveMfrForRow({ mpn: 'LTC1485' });
 *   // → { matched: true, canonical: 'Analog Devices Inc', id: 1000006,
 *   //     path: 'mpn', source: 'prefix+acquisition',
 *   //     originalMfr: 'Linear Technology Corp', prefix: 'LTC',
 *   //     confidence: 'high', acquisitionApplied: true }
 *
 *   // MPN path — inferred but NO acquisition (caller wants original brand)
 *   resolveMfrForRow({ mpn: 'LTC1485', applyAcquisitionMap: false });
 *   // → { matched: true, canonical: 'Linear Technology Corp', id: 1000037,
 *   //     path: 'mpn', source: 'prefix', prefix: 'LTC', confidence: 'high',
 *   //     acquisitionApplied: false }
 *
 * SHAPE COMPATIBILITY:
 *   The text path passes through the underlying lookupMfr `source` field
 *   unchanged ('alias' / 'cache' / 'db' / 'fuzzy(strict)' / 'pass-through').
 *   Existing writer logic that does `source.startsWith('fuzzy(')` or
 *   `source === 'alias'` keeps working. Use the new `path` field
 *   ('text' / 'mpn' / 'none') to distinguish which underlying lookup ran.
 *
 *   // Both provided — text wins (Policy D #1)
 *   resolveMfrForRow({ mfrText: 'LINEAR TECH', mpn: 'LTC1485' });
 *   // → text path result, MPN ignored
 *
 *   // Neither provided
 *   resolveMfrForRow({});
 *   // → { matched: false, canonical: null, id: null, source: 'no-input' }
 *
 * BACKWARD COMPAT:
 *   The existing four steady-state writers (rfq-writer, vq-writer, offer-writeback,
 *   cq-writer) call lookupMfr() directly. They keep working — this resolver
 *   is additive. Migrate them on demand: replace `lookupMfr(mfrText)` with
 *   `resolveMfrForRow({ mfrText, mpn })` and the writer gains MPN inference
 *   for free without losing the existing text-path behavior.
 */

const fs = require('fs');
const path = require('path');

const { lookupMfr } = require('./mfr-lookup');
const { classifyMpnToMfr } = require('./mpn-mfr-classifier');

const ACQ_FILE = path.resolve(__dirname, 'data/mfr-acquisitions.json');

let _acqCache = null;

function loadAcquisitions() {
  if (_acqCache) return _acqCache;
  try {
    const raw = fs.readFileSync(ACQ_FILE, 'utf-8');
    const data = JSON.parse(raw);
    _acqCache = data.acquisitions || {};
  } catch (err) {
    console.error(`[mfr-resolver] Failed to load ${ACQ_FILE}: ${err.message}`);
    _acqCache = {};
  }
  return _acqCache;
}

/**
 * Apply the acquisition map: if `mfrName` is a known acquired brand, return
 * the current owner's name. Otherwise return the input unchanged.
 *
 * Iterative resolution: if the current owner has ALSO been acquired (rare —
 * e.g., a chain like A → B → C), follow the chain. Cap at 5 hops to guard
 * against accidental cycles in the data file.
 */
function applyAcquisition(mfrName) {
  if (!mfrName) return mfrName;
  const acq = loadAcquisitions();
  let current = mfrName;
  let hops = 0;
  while (acq[current] && acq[current] !== current && hops < 5) {
    current = acq[current];
    hops++;
  }
  return current;
}

/**
 * Single entry point for resolving a row's manufacturer. Picks the right
 * underlying cog based on what the row provides.
 *
 * @param {object} opts
 * @param {string} [opts.mfrText] - MFR string from the source row (if any)
 * @param {string} [opts.mpn] - MPN for inference fallback when mfrText is empty
 * @param {boolean} [opts.applyAcquisitionMap=true] - Whether to remap to
 *   current owner on the MPN path. Has no effect on the text path (Policy D #1
 *   says preserve source intent — text always wins as-is).
 *
 * @returns {object} Resolution result. Always includes `matched`, `canonical`,
 *   `id`, `source`. Includes `acquisitionApplied` (bool) and `originalMfr`
 *   (string) when an acquisition mapping was used. Includes `prefix` and
 *   `confidence` when the MPN path was used.
 */
function resolveMfrForRow(opts = {}) {
  const {
    mfrText, mpn,
    applyAcquisitionMap = true,
    consultOTHistory = false,
    consultMfrHistory = false,
  } = opts;

  // Path 1: text provided → mfr-lookup wins (Policy D #1: preserve source intent)
  //
  // Return-shape note: we PASS THROUGH the underlying lookupMfr source field
  // unchanged ('alias' / 'cache' / 'db' / 'fuzzy(strict)' / 'pass-through' /
  // etc.) so existing writer confidence-check logic that does
  // `source.startsWith('fuzzy(')` or `source === 'alias'` keeps working after
  // migration. Use the `path` field to distinguish text-path from mpn-path
  // results.
  if (mfrText && String(mfrText).trim()) {
    const result = lookupMfr(mfrText);

    // Path 1.4 (opt-in): historical-VQ fallback for raw labels that lookupMfr
    // couldn't connect to a canonical chuboe_mfr row. Mirrors
    // partner-lookup.resolveBPHistorical on the MFR axis. When the same raw
    // label has been previously resolved by another load (often via fuzzy or
    // operator correction), reuse that id. Filtered to non-system MFRs only —
    // system IDs (ad_client_id=0) would trip the bean callout on client writes.
    // Opt-in via consultMfrHistory so non-write callers (Vortex / Quick Quote /
    // analysis) don't take the DB hit on a miss.
    if (!result.matched && consultMfrHistory) {
      let hist = null;
      try {
        const { resolveMfrFromVqHistory } = require('./mfr-from-vq-history');
        hist = resolveMfrFromVqHistory(mfrText);
      } catch (_) { /* fall through to pass-through below */ }
      if (hist && hist.id) {
        return {
          matched: true,
          canonical: hist.name,
          id: hist.id,
          isSystem: false,
          path: 'text',
          source: `historical-vq(${hist.rowCount}/${hist.totalNonNull}, ${hist.ratio})`,
          confidence: hist.ratio >= 0.90 ? 'high' : 'medium',
          acquisitionApplied: false,
        };
      }
    }

    return {
      matched: !!result.matched,
      canonical: result.canonical || null,
      id: result.id || null,
      isSystem: !!result.isSystem,
      path: 'text',
      source: result.source || 'unknown',
      confidence: result.matched ? 'high' : 'low',
      acquisitionApplied: false,
    };
  }

  // Path 1.5 (opt-in): consult OT trading history before prefix inference.
  // Rationale: prefix-based inference has known overreach (ISO*, ISL*, XC*,
  // BCM*, CY7C, etc.) and applies acquisitions blindly. OT history is operator-
  // vetted ground truth for any MPN we have actually traded — sold CQs and
  // purchased VQs are money-changed-hands signal. When OT consistently labels
  // an MPN with one MFR (>=70% weighted majority across CQ/VQ/offer rows in
  // last 2 years), prefer that over a prefix guess. Opt-in via consultOTHistory
  // so existing callers that can't afford a DB hit per call (Vortex Matches,
  // Market Offer Matching, etc.) aren't surprised.
  if (consultOTHistory && mpn && String(mpn).trim()) {
    let otHit = null;
    try {
      const { resolveMfrFromOTHistory } = require('./mfr-from-ot-history');
      otHit = resolveMfrFromOTHistory(mpn);
    } catch (e) {
      if (e && e.code === 'PSQL_INFRA') throw e;
      // any other failure: fall through to prefix path
    }
    if (otHit && otHit.mfr) {
      const idLookup = lookupMfr(otHit.mfr);
      return {
        matched: true,
        canonical: idLookup.canonical || otHit.mfr,
        id: idLookup.id || null,
        isSystem: !!idLookup.isSystem,
        path: 'ot-history',
        source: `ot-history-${otHit.confidence}`,
        confidence: otHit.confidence,
        otHistory: otHit,
        acquisitionApplied: false,
      };
    }
  }

  // Path 2: no text but MPN provided → classify by prefix + optionally remap (Policy D #3)
  if (mpn && String(mpn).trim()) {
    const classified = classifyMpnToMfr(mpn);
    if (!classified.matched) {
      return {
        matched: false,
        canonical: null,
        id: null,
        path: 'mpn',
        source: 'no-prefix-match',
        prefix: null,
        confidence: 'none',
        acquisitionApplied: false,
      };
    }

    const originalMfr = classified.mfr;
    const finalMfr = applyAcquisitionMap ? applyAcquisition(originalMfr) : originalMfr;
    const wasRemapped = finalMfr !== originalMfr;

    // Resolve the final MFR name to its iDempiere ID via the text path
    // (lookupMfr handles the canonical record + isSystem flag)
    const idLookup = lookupMfr(finalMfr);

    return {
      matched: true,
      canonical: idLookup.canonical || finalMfr,
      id: idLookup.id || null,
      isSystem: !!idLookup.isSystem,
      path: 'mpn',
      source: wasRemapped ? 'prefix+acquisition' : 'prefix',
      prefix: classified.prefix,
      confidence: classified.confidence || 'high',
      originalMfr: wasRemapped ? originalMfr : undefined,
      acquisitionApplied: wasRemapped,
      notes: classified.notes || undefined,
    };
  }

  // Path 3: nothing to work with
  return {
    matched: false,
    canonical: null,
    id: null,
    path: 'none',
    source: 'no-input',
    confidence: 'none',
    acquisitionApplied: false,
  };
}

module.exports = {
  resolveMfrForRow,
  applyAcquisition,   // exported for testing
  loadAcquisitions,   // exported for testing
};
