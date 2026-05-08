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
 *   });
 *
 * RETURN:
 *   {
 *     written:  [{ vqLineId, line, mpn, vendor, cost, qty }, ...],
 *     skipped:  [{ ...quote, reason }, ...],   // VENDOR_NOT_FOUND, VENDOR_SUSPENDED, NO_MPN_MATCH
 *     failed:   [{ ...quote, reason, error }, ...],
 *     coverage: [{ lineNo, lineId, rfqQty, mpns: [...], vqsToday, vqsTotal }, ...],
 *     gaps:     [lineNo, ...],                  // lines with 0 VQs after this batch
 *   }
 */

const { execFileSync } = require('child_process');
const { writeVQFromAPI } = require('./vq-writer');
const { resolveBP, apiGet } = require('./api-client');
const logger = require('./logger').createLogger('LoadBulkSummary');

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
const SUSPENDED_VTYPE_ID = 1000004;

// ─── Vendor type cache ─────────────────────────────────────────────────────
const _vtypeCache = new Map();

async function getBPVendorType(bpId) {
  if (_vtypeCache.has(bpId)) return _vtypeCache.get(bpId);
  const res = await apiGet('C_BPartner', { filter: `C_BPartner_ID eq ${bpId}`, top: 1 });
  const vt = res.records?.[0]?.Chuboe_VendorType_ID?.id || res.records?.[0]?.Chuboe_VendorType_ID || null;
  _vtypeCache.set(bpId, vt);
  return vt;
}

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
  // Partial: target is a prefix of an accepted MPN, or vice versa, with min overlap of 8 chars
  for (const ln of lines) {
    for (const m of ln.mpns) {
      const accepted = normalizeMpnForMatch(m.mpn);
      if (accepted.length >= 8 && target.length >= 8) {
        if (accepted.startsWith(target) || target.startsWith(accepted)) {
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
async function loadBulkSummary({ rfqSearchKey, buyerId, quotes, dryRun = false }) {
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
    const bp = await resolveBP(q.vendorSearchKey, q.vendorName);
    if (!bp) {
      skipped.push({ ...q, reason: 'VENDOR_NOT_FOUND', detail: `${q.vendorName || q.vendorSearchKey} not in BP table` });
      continue;
    }

    // c. Skip Suspended vendor type
    const vtypeId = await getBPVendorType(bp.id);
    if (vtypeId === SUSPENDED_VTYPE_ID) {
      skipped.push({ ...q, reason: 'VENDOR_SUSPENDED', detail: `${bp.name} is Suspended (vtype 1000004)` });
      continue;
    }

    // d. Build synthetic distributor stub
    const cooId = resolveCoo(q.coo);
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
    };

    if (dryRun) {
      written.push({
        dryRun: true, line: lineMatch.lineNo, mpn: q.mpn, vendor: bp.name,
        cost: q.cost, qty: q.qty, fuzzyMatch: !!lineMatch.fuzzy,
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
      });

      if (result.written.length > 0) {
        const w = result.written[0];
        written.push({
          vqLineId: w.vqLineId, line: lineMatch.lineNo, mpn: q.mpn,
          vendor: bp.name, cost: q.cost, qty: q.qty,
          fuzzyMatch: !!lineMatch.fuzzy,
        });
        writtenByLine.set(lineMatch.lineNo, (writtenByLine.get(lineMatch.lineNo) || 0) + 1);
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

module.exports = { loadBulkSummary, COO_MAP, resolveCoo, matchMpnToLine };
