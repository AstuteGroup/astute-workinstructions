/**
 * Bulk Summary VQ Loader
 *
 * Writes a batch of broker/APAC quotes (Type 2 bulk-summary email) directly
 * into chuboe_vq_line via the iDempiere REST API. The caller is responsible
 * for extraction (manual today, LLM-driven later) — this function takes a
 * structured `quotes` array and handles the deterministic plumbing:
 *
 *   - Resolve RFQ + line IDs + accepted MPN alternates (incl. AVL alts)
 *   - Resolve vendor BPs (search key first, name fallback)
 *   - Skip vendors flagged Suspended (vendor type 1000004)
 *   - Match each quoted MPN against the line's accepted MPNs
 *   - Map COO names to C_Country_ID (PENDING if unknown / blank)
 *   - Build synthetic distributor stubs and call writeVQFromAPI
 *   - Aggregate per-line coverage + uncovered-line gap report
 *
 * USAGE:
 *   const { loadBulkSummary } = require('../shared/load-bulk-summary');
 *
 *   const result = await loadBulkSummary({
 *     rfqSearchKey: '1132932',
 *     buyerId: 1006326,                  // AD_User_ID of the sourcing person
 *     quotes: [
 *       {
 *         vendorName: 'Howeher',         // OR vendorSearchKey
 *         mpn: 'DH82029PCH S LKM8',
 *         mfr: 'Intel',
 *         qty: 330,
 *         cost: 62.21,
 *         leadTime: '3-4 days',          // optional; defaults to 'stock'
 *         dateCode: '18+',
 *         coo: 'Malaysia',               // optional; PENDING if blank
 *         packaging: null,               // 'REEL' | 'TRAY' | null
 *         vendorNotes: 'reconfirm COO',  // free text → Chuboe_Note_User
 *         vendorQuotedMpn: null,         // populates "Quoted MPN: X" if differs
 *       },
 *       // ...
 *     ],
 *     unknownVendorPlaceholderBpId: 1009999,  // optional: when vendor BP doesn't
 *                                              // exist, use this placeholder BP and
 *                                              // store vendor name in VQ notes
 *   });
 *
 * RETURN:
 *   {
 *     written:  [{ vqLineId, line, mpn, vendor, cost, qty }, ...],
 *     skipped:  [{ ...quote, reason }, ...],   // VENDOR_NOT_FOUND, NO_MPN_MATCH
 *     failed:   [{ ...quote, reason, error }, ...],
 *     coverage: [{ lineNo, lineId, rfqQty, mpns: [...], vqsToday, vqsTotal }, ...],
 *     gaps:     [lineNo, ...],                  // lines with 0 VQs after this batch
 *   }
 */

const { execFileSync } = require('child_process');
const { writeVQFromAPI } = require('./vq-writer');
const { resolveBP } = require('./api-client');
const { resolveBPHistorical } = require('./partner-lookup');
const logger = require('./logger').createLogger('LoadBulkSummary');

// Currency ISO code → C_Currency_ID. Verified against c_currency (2026-05-14).
// Default is USD (100) — only set non-default for explicit non-USD quotes.
// vq-writer.js (writeVQFromAPI) already accepts currencyId on the stub.
const CURRENCY_MAP = {
  USD: 100,
  EUR: 102,
  GBP: 114,
  JPY: 113,
  CAD: 116,
  AUD: 120,
  HKD: 258,
  TWD: 289,
  SGD: 307,
  MYR: 301,
  KRW: 330,
  CNY: 332,
  THB: 206,
  VND: 234,
  IDR: 303,
  PHP: 153,
  INR: 304,
};
const DEFAULT_CURRENCY_ID = CURRENCY_MAP.USD;

function resolveCurrency(isoCode) {
  if (!isoCode) return DEFAULT_CURRENCY_ID;
  const upper = String(isoCode).toUpperCase().trim();
  const id = CURRENCY_MAP[upper];
  return Number.isFinite(id) ? id : DEFAULT_CURRENCY_ID;
}

// COO name → C_Country_ID. Verified against c_country (2026-04-27).
// Add more as bulk summaries surface other origins.
const COO_MAP = {
  'china': 153,
  'malaysia': 238,
  'philippines': 278,
  'taiwan': 316,
  'thailand': 319,
  'hong kong': 196,
  'singapore': 295,
  'south korea': 234,
  'korea': 234,
  'japan': 220,
  'vietnam': 'pending',  // resolve at runtime if needed
  'viet nam': 'pending',
  'united states': 100,
  'usa': 100,
  'us': 100,
};

const PENDING_COUNTRY_ID = 1000001;

// ─── RFQ metadata ──────────────────────────────────────────────────────────
function fetchRfqMeta(rfqSearchKey) {
  const sql = `
    SELECT rl.line, rl.chuboe_rfq_line_id, rl.qty, lm.chuboe_mpn, lm.chuboe_mfr_text
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id AND rl.isactive='Y'
    LEFT JOIN adempiere.chuboe_rfq_line_mpn lm ON rl.chuboe_rfq_line_id = lm.chuboe_rfq_line_id AND lm.isactive='Y'
    WHERE r.value = '${rfqSearchKey}' AND r.isactive='Y'
    ORDER BY rl.line, lm.chuboe_mpn;
  `;
  const out = execFileSync('psql', ['-A', '-F|', '-t', '-c', sql], { encoding: 'utf8' });
  const lineMap = new Map();
  for (const row of out.trim().split('\n').filter(Boolean)) {
    const [line, lineId, qty, mpn, mfr] = row.split('|');
    const ln = Number(line);
    // Guard against blank/continuation rows (psql can emit a trailing empty
    // line under some terminal settings; -t suppresses headers but not
    // always trailing whitespace). Real RFQ lines start at 10.
    if (!Number.isFinite(ln) || ln <= 0) continue;
    if (!lineMap.has(ln)) {
      lineMap.set(ln, { lineNo: ln, lineId: Number(lineId), rfqQty: Number(qty), mpns: [] });
    }
    if (mpn) lineMap.get(ln).mpns.push({ mpn, mfr: mfr || '' });
  }
  return Array.from(lineMap.values()).sort((a, b) => a.lineNo - b.lineNo);
}

// ─── MPN matching ──────────────────────────────────────────────────────────
//
// Matches quoted MPN against any of the line's accepted MPNs (incl. AVL alts).
// Tier 1: exact (case-insensitive, whitespace-collapsed).
// Tier 2: strip common suffixes / variants and try again.
// Returns the matched line object, or null.
function normalizeMpnForMatch(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
}

function matchMpnToLine(quotedMpn, lines) {
  const target = normalizeMpnForMatch(quotedMpn);
  if (!target) return null;
  // Exact normalized match
  for (const ln of lines) {
    for (const m of ln.mpns) {
      if (normalizeMpnForMatch(m.mpn) === target) return { ...ln, matchedMpn: m.mpn };
    }
  }
  // Partial: one MPN is a strict prefix of the other (packaging suffix etc.).
  //
  // Threshold: the SHORTER side must be ≥ 6 chars. Symmetric ≥8 (the older
  // gate) over-rejected — RFQ MPNs like FSM17PL (7 chars) couldn't accept
  // any cross-ref offer because the length check failed before the prefix
  // check ran (UID 8541, Ivy 5/21 — Wellida FSM17PL-TP rejected upstream of
  // the writer's cross-ref classifier). Asymmetric ≥6 keeps the false-
  // positive guard (no 3-4 char prefix collisions) while admitting real
  // packaging-variant cross-refs. The writer's cross-ref classifier is the
  // downstream gate that decides auto-approve vs. flag.
  for (const ln of lines) {
    for (const m of ln.mpns) {
      const accepted = normalizeMpnForMatch(m.mpn);
      if (accepted.startsWith(target) || target.startsWith(accepted)) {
        const shorter = Math.min(accepted.length, target.length);
        if (shorter >= 6) {
          return { ...ln, matchedMpn: m.mpn, fuzzy: true };
        }
      }
    }
  }
  return null;
}

// ─── COO ───────────────────────────────────────────────────────────────────
function resolveCoo(cooName) {
  if (!cooName) return PENDING_COUNTRY_ID;
  const key = String(cooName).toLowerCase().trim();
  const v = COO_MAP[key];
  if (typeof v === 'number') return v;
  return PENDING_COUNTRY_ID;
}

// ─── Notes ─────────────────────────────────────────────────────────────────
function buildNotes(q) {
  const parts = [];
  if (q.vendorQuotedMpn && q.vendorQuotedMpn !== q.mpn) {
    parts.push(`Quoted MPN: ${q.vendorQuotedMpn}`);
  }
  if (q.vendorNotes) parts.push(q.vendorNotes);
  return parts.join(' | ');
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function loadBulkSummary({ rfqSearchKey, buyerId, quotes, dryRun = false, unknownVendorPlaceholderBpId = null }) {
  if (!rfqSearchKey) throw new Error('rfqSearchKey required');
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error('quotes[] required and non-empty');
  }

  logger.info(`Loading ${quotes.length} quotes for RFQ ${rfqSearchKey}${dryRun ? ' (DRY RUN)' : ''}`);

  // 1. Fetch RFQ structure
  const lines = fetchRfqMeta(rfqSearchKey);
  if (lines.length === 0) {
    throw new Error(`RFQ ${rfqSearchKey} has no active lines (or doesn't exist)`);
  }
  logger.info(`  RFQ has ${lines.length} lines, ${lines.reduce((a, l) => a + l.mpns.length, 0)} accepted MPNs`);

  const written = [];
  const skipped = [];
  const failed = [];
  const writtenByLine = new Map();

  for (const q of quotes) {
    // a. Match MPN to RFQ line
    const lineMatch = matchMpnToLine(q.mpn, lines);
    if (!lineMatch) {
      skipped.push({ ...q, reason: 'NO_MPN_MATCH', detail: `${q.mpn} doesn't match any line MPN` });
      continue;
    }

    // b. Resolve vendor BP (search key first, name fallback)
    let bp = await resolveBP(q.vendorSearchKey, q.vendorName);

    // b'. Historical fallback for short broker labels that the strict name
    // resolver can't tokenize ("Yuexunfa" vs "YUE XUN FA INTERNATIONAL
    // LIMITED"). Queries recent VQ history for a uniquely-matching BP and
    // reuses it. See shared/partner-lookup.js resolveBPHistorical(). Only
    // fires when (a) the agent did NOT supply a searchKey and (b) the
    // primary resolver returned nothing.
    if (!bp && !q.vendorSearchKey && q.vendorName) {
      const hist = resolveBPHistorical(q.vendorName);
      if (hist) {
        logger.info(`Historical BP fallback: '${q.vendorName}' → ${hist.id} (${hist.name}) [${hist.vqCount} VQs in last ${hist.lookbackDays}d]`);
        bp = { id: hist.id, name: hist.name, searchKey: hist.searchKey };
      }
    }

    if (!bp) {
      skipped.push({ ...q, reason: 'VENDOR_NOT_FOUND', detail: `${q.vendorName || q.vendorSearchKey} not in BP table` });
      continue;
    }

    // c. Build synthetic distributor stub
    //
    // Note: Suspended (vtype 1000004) / Prohibited (vtype 1000005) BPs are NOT
    // gated here. Loading is data capture; the approval flow downstream is the
    // gate for buying from a restricted vendor. See shared/agent-philosophy.md
    // § "Loading is data capture" and shared/disqualified-vendor-types.js
    // (the module is still in place as a label provider for anyone who wants
    // to display vendor status downstream — it just doesn't decide skips).
    const cooId = resolveCoo(q.coo);
    const currencyId = resolveCurrency(q.currency);
    const stub = {
      found: true,
      name: q.vendorName || bp.name,
      bpValue: bp.searchKey,
      vqMpn: q.mpn,
      vqManufacturer: q.mfr,
      franchiseRfqPrice: q.cost,
      vqPrice: q.cost,
      franchiseQty: q.qty,
      vqLeadTime: q.leadTime || 'stock',
      vqDateCode: q.dateCode || null,
      vqVendorNotes: buildNotes(q),
      vqCooCountryId: cooId,
      vqPackaging: q.packaging || null,
      vqRohs: q.rohs || null,
      vqHts: null,
      vqEccn: null,
      currencyId,  // c_currency_id — defaults to USD (100) when q.currency is blank
    };

    // No-bid capture (qty 0 AND cost 0): the vendor was asked and explicitly
    // declined / has no stock. We WANT this "we asked, no" signal in OT.
    //
    // The catch: this path round-trips the stub through writeVQFromAPI ->
    // extractStockAndLtRows -> synthesizeStockLtVqLines, and synthesize only
    // emits a row when stockQty>0 OR ltPrice>0. A 0/0 stub therefore produces
    // ZERO rows, never reaches vq-writer's no-bid filter (cost===0 && qty===0,
    // added in 1d36cc2), and surfaces as `WRITE_FAILED: unknown` — which then
    // trips the failure-rate gate. This is exactly what bit UID 8655 (Ivy,
    // 5/25): 7 "NO STK" ADUM4402CRWZ rows reported as failures, on each of the
    // two RFQs carrying that MPN (1135455 + 1133119).
    //
    // Fix: hand extractStockAndLtRows a pre-built vqLines[] entry (franchise-
    // api.js:1212 returns it verbatim, bypassing synthesize). The no-bid filter
    // then accepts it and the writer builds a Cost:0/Qty:0 payload (both pass
    // Tier-1 validation — the check is `== null || === ''`, not falsiness).
    // Per vq-loading.md § No-bid records: qty 0, cost 0, lead time BLANK (NOT
    // "stock"), reason in notes.
    //
    // Scoped to this broker-email path on purpose. A 0/0 *franchise* API result
    // means "distributor doesn't carry it" and belongs in the negative cache,
    // NOT a VQ — so synthesize's price>0 gate is correct for that caller and is
    // left untouched. (Sibling-writer note per the parallel-writer discipline:
    // the only other writeVQFromAPI caller is the franchise enrichment path,
    // which must NOT start emitting no-bid VQs.)
    const isNoBid = (Number(q.cost) || 0) === 0 && (Number(q.qty) || 0) === 0;
    if (isNoBid) {
      const rawNote = buildNotes(q);
      const noBidNote = /no[\s-]?bid/i.test(rawNote)
        ? rawNote
        : `No-bid${rawNote ? ` - ${rawNote}` : ' - out of stock'}`;
      stub.vqLeadTime = '';              // blank per doc — NOT "stock"
      stub.vqVendorNotes = noBidNote;
      stub.vqLines = [{
        vendorBP: bp.searchKey,
        vendorName: q.vendorName || bp.name,
        channel: q.vendorName || bp.name,
        mpn: q.mpn,
        manufacturer: q.mfr,
        qty: 0,
        stock: 0,                        // actual stock for cache envelope
        cost: 0,
        leadTime: null,                  // null -> Chuboe_Lead_Time blank
        dateCode: q.dateCode || null,
        moq: null,
        spq: null,
        vendorNotes: noBidNote,
        currencyId,
      }];
    }

    if (dryRun) {
      written.push({
        dryRun: true, line: lineMatch.lineNo, mpn: q.mpn, vendor: bp.name,
        cost: q.cost, qty: q.qty, fuzzyMatch: !!lineMatch.fuzzy, noBid: isNoBid,
      });
      writtenByLine.set(lineMatch.lineNo, (writtenByLine.get(lineMatch.lineNo) || 0) + 1);
      continue;
    }

    // e. Write VQ via the canonical writer
    try {
      const result = await writeVQFromAPI(rfqSearchKey, '', { distributors: [stub] }, {
        searchedMpn: q.mpn,
        buyerId,
        rfqQty: lineMatch.rfqQty,
        _rfqLineIdOverride: lineMatch.lineId,
        unknownVendorPlaceholderBpId,  // allow loading without BP when vendor doesn't exist
      });

      if (result.written.length > 0) {
        const w = result.written[0];
        written.push({
          vqLineId: w.vqLineId, line: lineMatch.lineNo, mpn: q.mpn,
          vendor: bp.name, cost: q.cost, qty: q.qty,
          fuzzyMatch: !!lineMatch.fuzzy,
          // Preserve the agent's original vendor label so handler-level
          // clarify-suppression can exact-match agent labels (e.g., the
          // 'Savilter' typo on UID 8563) without depending on canonical-name
          // substring/fuzzy matching downstream.
          originalVendorLabel: q.vendorName || q.vendorSearchKey || null,
          bpId: bp.id,
          noBid: isNoBid,
        });
        writtenByLine.set(lineMatch.lineNo, (writtenByLine.get(lineMatch.lineNo) || 0) + 1);
      } else if (result.skipped && result.skipped.length > 0) {
        // writeVQFromAPI routes pre-existing duplicates (and other intentional
        // no-writes) to skipped[]. Surface that bucket here — otherwise the
        // breadcrumb mis-counts duplicates as `failed`, which is exactly what
        // bit UID 8541 (RFQ 1133479) on 5/21: 58 dups from the 5/20 sister
        // load came back as `failed: 73, detail: unknown` because this branch
        // wasn't reading result.skipped[].
        const s = result.skipped[0];
        skipped.push({
          ...q,
          reason: s.reason || 'WRITER_SKIPPED',
          detail: s.detail || `Writer skipped: ${s.reason || 'unknown'}`,
          vqLineId: s.vqLineId || null,
        });
      } else {
        const flagDetail = result.flagged.concat(result.failed);
        failed.push({
          ...q, reason: 'WRITE_FAILED',
          detail: flagDetail.length > 0 ? flagDetail[0].reason + ': ' + flagDetail[0].detail : 'unknown'
        });
      }
    } catch (err) {
      failed.push({ ...q, reason: 'WRITE_ERROR', error: err.message });
    }
  }

  // 2. Coverage report
  const coverage = lines.map(ln => ({
    lineNo: ln.lineNo,
    lineId: ln.lineId,
    rfqQty: ln.rfqQty,
    mpns: ln.mpns.map(m => m.mpn),
    vqsThisBatch: writtenByLine.get(ln.lineNo) || 0,
  }));
  const gaps = coverage.filter(c => c.vqsThisBatch === 0).map(c => c.lineNo);

  logger.info(`  Done: ${written.length} written, ${skipped.length} skipped, ${failed.length} failed`);
  logger.info(`  Coverage: ${coverage.length - gaps.length}/${coverage.length} lines hit; gaps: ${gaps.join(', ') || 'none'}`);

  return { written, skipped, failed, coverage, gaps };
}

module.exports = { loadBulkSummary, COO_MAP, resolveCoo, CURRENCY_MAP, resolveCurrency, matchMpnToLine };
