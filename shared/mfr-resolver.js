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
 *   //     source: 'text-alias', confidence: 'high', acquisitionApplied: false }
 *
 *   // MPN path — no MFR text, inferred from prefix + acquisition map applied
 *   resolveMfrForRow({ mpn: 'LTC1485' });
 *   // → { matched: true, canonical: 'Analog Devices Inc', id: 1000006,
 *   //     source: 'mpn-prefix+acquisition', originalMfr: 'Linear Technology Corp',
 *   //     prefix: 'LTC', confidence: 'high', acquisitionApplied: true }
 *
 *   // MPN path — inferred but NO acquisition (caller wants original brand)
 *   resolveMfrForRow({ mpn: 'LTC1485', applyAcquisitionMap: false });
 *   // → { matched: true, canonical: 'Linear Technology Corp', id: 1000037,
 *   //     source: 'mpn-prefix', prefix: 'LTC', confidence: 'high',
 *   //     acquisitionApplied: false }
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
  const { mfrText, mpn, applyAcquisitionMap = true } = opts;

  // Path 1: text provided → mfr-lookup wins (Policy D #1: preserve source intent)
  if (mfrText && String(mfrText).trim()) {
    const result = lookupMfr(mfrText);
    return {
      matched: !!result.matched,
      canonical: result.canonical || null,
      id: result.id || null,
      isSystem: !!result.isSystem,
      source: 'text-' + (result.source || 'unknown'),
      confidence: result.matched ? 'high' : 'low',
      acquisitionApplied: false,
    };
  }

  // Path 2: no text but MPN provided → classify by prefix + optionally remap (Policy D #3)
  if (mpn && String(mpn).trim()) {
    const classified = classifyMpnToMfr(mpn);
    if (!classified.matched) {
      return {
        matched: false,
        canonical: null,
        id: null,
        source: 'mpn-no-prefix-match',
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
      source: wasRemapped ? 'mpn-prefix+acquisition' : 'mpn-prefix',
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
