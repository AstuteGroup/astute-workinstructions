/**
 * Heilind BOM-tool export mapper.
 *
 * Translates an xlsx export from heilind.com's Quick Quote BOM tool into:
 *   - VQ rows (via shared/vq-writer.js#writeVQBatch) for rows that came back
 *     with a DAC Part Number + Price1 > 0 ("priced")
 *   - Negative-cache rows (state='matched_no_price') for rows with a DAC PN
 *     but Price1 = 0
 *   - Negative-cache rows (state='not_carried') for rows with no DAC PN
 *
 * All three classes ALSO get recorded in the negative cache so that tomorrow's
 * producer doesn't re-scrape the same MPN at a comparable qty (within ±25%).
 *
 * Round-trip context (rfqSearchKey, customer, RFQ date) comes from the outbox
 * sidecar produced by heilind-rfq-candidates.js — joined to export rows by MPN.
 *
 * Why pattern C (raw export → server-side parse) vs pattern B (desktop-side
 * parse to canonical envelope): Heilind's xlsx has 18 columns with vendor-
 * specific names ("DAC Part Number", "Manufacturer_1", etc.). Parsing happens
 * server-side so it's unit-testable against fixtures and so the desktop bootstrap
 * stays site-agnostic. See desktop-scraper-contract.md § Adapter Patterns.
 *
 * For empirical notes on the BOM tool's behavior (row capacity, the matched-
 * but-no-price signature, false-negative rate, recommended settings) see
 * ../heilind-bom-tool-notes.md.
 */

const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const fs = require('fs');
const path = require('path');

const ROOT = '/home/analytics_user/workspace/astute-workinstructions';
const { writeVQBatch } = require(path.join(ROOT, 'shared/vq-writer'));
const { writePricingResult } = require(path.join(ROOT, 'shared/api-result-writer'));
const negCache = require(path.join(ROOT, 'shared/api-negative-cache'));

// -- Constants -----------------------------------------------------------------

const HEILIND_BP = {
  id: 1000351,
  name: 'Heilind Electronics',
  value: '1002355',  // c_bpartner.value (search key)
};

// chuboe_traceability_id for "Authorized Distribution Certs". Heilind is a
// franchise distributor, so all VQ rows are Authorized Distribution.
const AUTHORIZED_DISTRIBUTION_ID = 1000001;

// -- Helpers ------------------------------------------------------------------

/**
 * Parse the HTS code out of Heilind's "HTS Classification" string.
 * Format: "HTS: 8536694040 - This Line May Be Subject To Sect 122 Tariff/Surc at 9%"
 * Returns the numeric portion (max 25 chars to fit chuboe_vq_line.chuboe_hts).
 */
function parseHts(htsClassification) {
  if (!htsClassification) return null;
  const m = String(htsClassification).match(/HTS:\s*(\d{6,10})/i);
  return m ? m[1].slice(0, 25) : null;
}

/**
 * Extract the surcharge/tariff note from the HTS string (the part after the dash).
 * Returned verbatim for inclusion in vqVendorNotes — informational only.
 */
function parseHtsNote(htsClassification) {
  if (!htsClassification) return null;
  const s = String(htsClassification);
  const dashIdx = s.indexOf(' - ');
  return dashIdx > -1 ? s.slice(dashIdx + 3).trim() : null;
}

/**
 * Build vqVendorNotes from compliance/contract flags and reference fields.
 * Pipe-separated so buyers can scan quickly.
 */
function buildVendorNotes({ ncnr, dacPN, htsNote, heilindMfrNote }) {
  const parts = [];
  if (ncnr === 'YES') parts.push('NCNR');
  if (dacPN) parts.push(`Heilind PN: ${dacPN}`);
  if (heilindMfrNote) parts.push(heilindMfrNote);
  if (htsNote) parts.push(htsNote);
  return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * Classify a Heilind export row into one of three result classes.
 */
function classifyRow(row) {
  const dacPN = row['DAC Part Number'];
  const price1 = Number(row['Price1']) || 0;
  if (!dacPN) return 'not_carried';
  if (price1 > 0) return 'priced';
  return 'matched_no_price';
}

/**
 * Build a canonical franchiseResults-shape envelope entry for one priced
 * export row. The shape matches what shared/franchise-api.js produces, so
 * writeVQBatch consumes it unchanged.
 *
 * Note: Heilind's BOM tool returns only the price at the qty we submitted —
 * not the full ladder. So priceBreaks contains exactly one entry. Callers
 * that lean on priceAtQty(buyQty) will always get this single tier back,
 * which can mis-price RFQs whose qty differs significantly from what we
 * submitted. The qty-proximity guard on cache retrieval (±25%) is the
 * protection — see api-negative-cache.js.
 */
function buildEnvelopeEntry(row, sidecarItem) {
  // Coerce MPN to string — XLSX parses all-digit MPN cells (e.g., Molex
  // "5055721300") as JS numbers, and downstream code does mpn.toUpperCase().
  // Same for DAC PN, MFR fields, lead time — anything we pass through to
  // vq-writer or store as text.
  const mpn = row['MPN'] != null ? String(row['MPN']) : '';
  const price1 = Number(row['Price1']) || 0;
  const requestedQty = Number(row['Qty']) || sidecarItem.qty;
  const stock = (Number(row['AvailStock']) || 0)
              + (Number(row['Factory Stock']) || 0);
  const leadTime = row['LeadTime'] != null ? String(row['LeadTime']) : null;
  const dacPN = row['DAC Part Number'] != null ? String(row['DAC Part Number']) : null;
  const heilindCanonicalMfr = row['Manufacturer_1'] != null ? String(row['Manufacturer_1'])
                            : row['Manufacturer']   != null ? String(row['Manufacturer'])
                            : null;
  const hts = parseHts(row['HTS Classification']);
  const htsNote = parseHtsNote(row['HTS Classification']);

  const vqRohs =
    row['ROHS'] === 'YES' ? 'Y' :
    row['ROHS'] === 'NO'  ? 'N' :
    null;

  // vqManufacturer is the RFQ's original MFR text (sidecarItem.mfr) — NOT
  // Heilind's canonical brand string ("CONEC (AMPHENOL)" etc.). Reasons:
  //   1. Matches the rule we agreed on — don't rewrite the RFQ's MFR text
  //   2. Heilind's parens-wrapped acquisition notation ("CONEC (AMPHENOL)",
  //      "POSITRONIC (AMPHENOL)") triggers an iDempiere server-side 500 on
  //      the chuboe_mfr name lookup ("Cannot invoke String.hashCode()
  //      because methodName is null"). Using the cleaner RFQ-side MFR avoids it.
  //   3. shared/mfr-equivalence handles cross-form mapping downstream anyway.
  // Heilind's canonical goes into vqVendorNotes only when it differs from the
  // RFQ's MFR text — informational reference for the buyer.
  const rfqMfr = sidecarItem.mfr;
  const heilindMfrNote = (heilindCanonicalMfr && heilindCanonicalMfr !== rfqMfr)
    ? `Heilind MFR: ${heilindCanonicalMfr}`
    : null;

  const item = {
    // writeVQBatch reads item.mpn for pre-resolution; writeVQFromAPI reads
    // searchedMpn. We populate both with the same value to satisfy both code paths.
    mpn,
    searchedMpn: mpn,
    cpc: null,                            // could be JOINed from chuboe_rfq_line_mpn if needed
    rfqQty: requestedQty,
    rfqMfrText: rfqMfr,
    franchiseResults: {
      distributors: [{
        distributor: 'heilind',
        name: HEILIND_BP.name,
        bpName: HEILIND_BP.name,
        bpValue: HEILIND_BP.value,
        found: true,
        vqMpn: mpn,                          // Heilind echoes our input MPN in this column
        vqManufacturer: rfqMfr,              // RFQ's original MFR text — see comment above
        vqDescription: null,
        vqDateCode: null,                    // Heilind doesn't surface date code on BOM-tool path
        vqRohs,
        vqHts: hts,
        vqEccn: null,                        // Heilind doesn't surface ECCN
        vqPackaging: null,                   // Not in export columns
        vqSpq: row['Mult'] != null ? String(row['Mult']) : null,
        vqMoq: row['Min']  != null ? String(row['Min'])  : null,
        vqCooCountryId: null,                // → PENDING server-side
        vqLeadTime: leadTime,
        vqVendorNotes: buildVendorNotes({ ncnr: row['NCNR'], dacPN, htsNote, heilindMfrNote }),
        currencyId: null,                    // null = USD (100)
        franchiseQty: stock,
        priceBreaks: [
          // Single-tier ladder — Heilind only quotes at the qty we ask for.
          // See module header for the price-ladder caveat.
          { qty: requestedQty, unitPrice: price1 },
        ],
        sourceUrl: 'https://www.heilind.com/',
        fetchedAt: new Date().toISOString(),
      }],
    },
  };
  return item;
}

// -- Main entrypoint -----------------------------------------------------------

/**
 * Process a Heilind export + its outbox sidecar.
 *
 * @param {object} opts
 * @param {string} opts.exportPath  - path to inbox/heilind/<file>.xlsx
 * @param {string} opts.sidecarPath - path to outbox/heilind/<file>.meta.json
 * @param {boolean} [opts.dryRun]   - if true, don't write VQs or cache rows
 * @returns {Promise<object>}        - summary { rows, priced, matched_no_price, not_carried, writeResults, cacheResults }
 */
async function processExport({ exportPath, sidecarPath, dryRun = false }) {
  // -- Load files
  if (!fs.existsSync(exportPath)) throw new Error(`Export file not found: ${exportPath}`);
  if (!fs.existsSync(sidecarPath)) throw new Error(`Sidecar not found: ${sidecarPath}`);

  const wb = XLSX.readFile(exportPath);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: true });

  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  const itemsByMpn = new Map();
  for (const item of sidecar.items) {
    itemsByMpn.set(String(item.mpn).toUpperCase().trim(), item);
  }

  // -- Classify rows
  const priced = [];
  const matchedNoPrice = [];
  const notCarried = [];
  const orphanRows = [];  // export rows whose MPN isn't in the sidecar — log for debug
  for (const row of rows) {
    if (!row['MPN']) continue;
    const mpnKey = String(row['MPN']).toUpperCase().trim();
    if (!itemsByMpn.has(mpnKey)) {
      orphanRows.push(row);
      continue;
    }
    const cls = classifyRow(row);
    if      (cls === 'priced')             priced.push(row);
    else if (cls === 'matched_no_price') matchedNoPrice.push(row);
    else                                   notCarried.push(row);
  }

  // -- Group priced rows by rfqSearchKey from sidecar
  const pricedByRfq = new Map();
  for (const row of priced) {
    const mpnKey = String(row['MPN']).toUpperCase().trim();
    const sidecarItem = itemsByMpn.get(mpnKey);
    const rfq = sidecarItem.context.rfqSearchKey;
    if (!pricedByRfq.has(rfq)) pricedByRfq.set(rfq, []);
    pricedByRfq.get(rfq).push(buildEnvelopeEntry(row, sidecarItem));
  }

  // -- Write priced VQs per RFQ
  const writeResults = [];
  let pricingResultsWritten = 0;
  let pricingResultsFailed = 0;

  if (!dryRun) {
    for (const [rfqSearchKey, envelopes] of pricedByRfq) {
      // (a) VQ writes
      try {
        const result = await writeVQBatch(rfqSearchKey, envelopes);
        writeResults.push({ rfqSearchKey, lines: envelopes.length, ...result });
      } catch (e) {
        writeResults.push({ rfqSearchKey, lines: envelopes.length, error: e.message });
      }

      // (b) Standard pricing-cache writes — per the "everything goes back to
      // the same place" rule in distributor-scrape-loading.md § Storage Rule.
      // Writes one chuboe_pricing_api_result row per envelope, tagged with
      // source='heilind-scrape'. This is what makes Heilind data visible to
      // enrich-poller, Vortex, Quick Quote, etc. via the standard cache path.
      for (const env of envelopes) {
        try {
          const r = await writePricingResult({
            searchResult: env.franchiseResults,
            mpn: env.mpn,
            qty: env.rfqQty,
            source: 'heilind-scrape',
          });
          if (r.success) pricingResultsWritten++;
          else pricingResultsFailed++;
        } catch (e) {
          pricingResultsFailed++;
        }
      }
    }
  } else {
    for (const [rfqSearchKey, envelopes] of pricedByRfq) {
      writeResults.push({ rfqSearchKey, lines: envelopes.length, dryRun: true });
    }
  }

  // -- Record all three classes in negative cache
  const cacheResults = { carried: 0, matched_no_price: 0, not_carried: 0, skipped: 0 };
  const cacheRecord = (row, result) => {
    const mpnKey = String(row['MPN']).toUpperCase().trim();
    const sidecarItem = itemsByMpn.get(mpnKey);
    const requestedQty = Number(row['Qty']) || sidecarItem.qty || 1;
    if (dryRun) {
      cacheResults[result === 'carried' ? 'carried' : result]++;
      return;
    }
    const opts = {
      mpn: row['MPN'],
      mfr: sidecarItem.mfr,
      disty: 'heilind',
      result,
      requestedQty,
    };
    if (result === 'carried') {
      opts.costUnit = Number(row['Price1']) || null;
      opts.stockQty = (Number(row['AvailStock']) || 0) + (Number(row['Factory Stock']) || 0);
      opts.priceBreaksN = 1;
    }
    const res = negCache.record(opts);
    res.cached ? cacheResults[result === 'carried' ? 'carried' : result]++ : cacheResults.skipped++;
  };
  for (const row of priced)         cacheRecord(row, 'carried');
  for (const row of matchedNoPrice) cacheRecord(row, 'matched_no_price');
  for (const row of notCarried)     cacheRecord(row, 'not_carried');

  return {
    rows: rows.length,
    priced: priced.length,
    matched_no_price: matchedNoPrice.length,
    not_carried: notCarried.length,
    orphans: orphanRows.length,
    rfqsAffected: pricedByRfq.size,
    writeResults,
    cacheResults,
    pricingResults: { written: pricingResultsWritten, failed: pricingResultsFailed },
    dryRun,
  };
}

/**
 * Pair a raw Heilind export file at exportPath with its outbox sidecar.
 * Returns the most recent outbox/heilind/*.meta.json with mtime ≤ exportPath's
 * mtime (the export must have been generated after the request that produced it).
 * Returns null if no sidecar is found.
 *
 * Used by inbox-watcher.js to dispatch a Heilind-source inbox file and by
 * process-heilind-export.js for manual one-shot runs.
 */
function autoPairSidecar(exportPath) {
  const outboxDir = '/home/analytics_user/workspace/outbox/heilind';
  if (!fs.existsSync(outboxDir)) return null;
  const exportMtime = fs.statSync(exportPath).mtime;
  const candidates = fs.readdirSync(outboxDir)
    .filter(n => n.endsWith('.meta.json'))
    .map(n => {
      const full = path.join(outboxDir, n);
      return { full, mtime: fs.statSync(full).mtime };
    })
    .filter(c => c.mtime <= exportMtime)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full || null;
}

/**
 * File-type filter — the watcher uses this to decide whether an inbox file
 * is a Heilind export it should process. Today we accept .xlsx; .md / .txt /
 * .partial / .meta.json / .error.json are ignored.
 */
function isProcessableFile(filename) {
  return /\.xlsx$/i.test(filename) && !filename.endsWith('.partial');
}

module.exports = {
  processExport,
  autoPairSidecar,
  isProcessableFile,
  classifyRow,
  parseHts,
  parseHtsNote,
  buildVendorNotes,
  buildEnvelopeEntry,
  HEILIND_BP,
  AUTHORIZED_DISTRIBUTION_ID,
};
