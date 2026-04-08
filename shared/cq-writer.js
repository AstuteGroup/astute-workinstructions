/**
 * CQ Writer — writes Customer Quote lines via iDempiere REST API
 *
 * Flat table (chuboe_cq_line) — no header. Each CQ line links to an RFQ
 * via chuboe_rfq_id + chuboe_rfq_line_id.
 *
 * USAGE:
 *   const { writeCQ, writeCQBatch } = require('../shared/cq-writer');
 *
 *   // Single line
 *   const result = await writeCQ('1141355', {
 *     mpn: 'ADS1115IDGST',
 *     cpc: 'CUST-ADC-001',
 *     qty: 500,
 *     resale: 5.25,
 *     dateCode: '24+',
 *   });
 *
 *   // Batch — array of lines against one RFQ
 *   const result = await writeCQBatch('1141355', [
 *     { mpn: 'ADS1115IDGST', qty: 500, resale: 5.25 },
 *     { mpn: 'TPS3837K33DBVR', qty: 1000, resale: 0.85 },
 *   ]);
 *
 * INPUT FORMATS:
 *   Quotes arrive in wildly different formats — single-line email quotes,
 *   1000-line Excel customer templates, Quick Quote CSV output, etc.
 *   The caller is responsible for parsing into the standard line format.
 *   This module only handles the API write + resolution logic.
 *
 * CONSUMERS:
 *   - Quick Quote finalization (future — user tweaks outside system first)
 *   - Stock RFQ pipeline "Propose Quote" step (future)
 *   - Manual CQ entry from email quotes
 *
 * RESOLUTION STRATEGY:
 *   1. RFQ search key → chuboe_rfq_id (header)
 *   2. Customer pulled from RFQ header (c_bpartner_id) unless overridden
 *   3. Each line: CPC → chuboe_rfq_line_id, falling back to MPN match
 *   4. MFR text → chuboe_mfr_id via shared/mfr-lookup.js
 */

const logger = require('./logger').createLogger('CQWriter');
const { apiPost, apiGet, resolveMFR } = require('./api-client');
const { cleanMpn } = require('./db-helpers');
const { lookupMfr } = require('./mfr-lookup');
const { resolveMfrForRow } = require('./mfr-resolver');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const DEFAULT_CURRENCY_ID = 100;       // USD
const DEFAULT_STATUS_ID = 1000027;     // Open
const DEFAULT_INCLUDE_IN_QUOTE = 'Y';

// CQ Resolution IDs (set later, not at creation)
const CQ_RESOLUTIONS = {
  'No Stock':                    1000000,
  'Bought From Authorized':      1000001,
  'Lower Price':                 1000002,
  'Pushed Demand':               1000003,
  'Won':                         1000004,
  'Lost Stock':                  1000005,
};

// Flag reason codes — things that prevent a write
const FLAG = {
  NO_RFQ:            'NO_RFQ',
  NO_RFQ_LINE:       'NO_RFQ_LINE',
  MFR_NO_MATCH:      'MFR_NO_MATCH',
  MFR_LOW_CONFIDENCE: 'MFR_LOW_CONFIDENCE',
  MISSING_FIELDS:    'MISSING_FIELDS',
  API_WRITE_ERROR:   'API_WRITE_ERROR',
};

// Mandatory fields on every CQ line
const MANDATORY_FIELDS = ['mpn', 'mfrText', 'qty', 'resale', 'leadTime'];

// ─── FIELD MAP ───────────────────────────────────────────────────────────────
// Maps line input field name → API column name.
// If a line has a value for any of these keys, it gets written.
// Fields handled separately (mpn, cpc, mfr, resale, qty) are not here.
const OPTIONAL_FIELD_MAP = {
  dateCode:     'Chuboe_Date_Code',
  leadTime:     'Chuboe_Lead_Time',
  description:  'Description',
  rohs:         'Chuboe_RoHS',
  coo:          'Chuboe_Country_Text',
  moq:          'Chuboe_MOQ',
  packaging:    'Chuboe_Packaging_Text',
  notePublic:   'Chuboe_Note_Public',
  notePrivate:  'Chuboe_Note_Private',
  hazmat:       'IsHazMat',
  poReference:  'POReference',
  leadTimeText: 'Chuboe_LeadTime_Text',
  packagingDesc:'Chuboe_Package_Desc',
  shippingAcct: 'Chuboe_ShippingAcct',
};

// ─── RFQ RESOLUTION ──────────────────────────────────────────────────────────

let _rfqCache = new Map(); // rfqSearchKey -> { id, bpartnerId, bpName, lines, mpnToLine }

/**
 * Resolve RFQ by search key. Returns header info + CPC/MPN line maps.
 * Caches for the session.
 */
async function resolveRFQ(rfqSearchKey) {
  if (_rfqCache.has(rfqSearchKey)) return _rfqCache.get(rfqSearchKey);

  // Get RFQ header
  const rfqResult = await apiGet('Chuboe_RFQ', {
    filter: `Value eq '${rfqSearchKey}'`, top: 1
  });
  if (!rfqResult.records || rfqResult.records.length === 0) {
    return null;
  }
  const rfq = rfqResult.records[0];
  const rfqId = rfq.id;
  const bpartnerId = rfq.C_BPartner_ID?.id || rfq.C_BPartner_ID;
  const bpName = rfq.C_BPartner_ID?.identifier || null;

  // Get all RFQ lines — build CPC→lineId map
  let allLines = [];
  let skip = 0;
  while (true) {
    const batch = await apiGet('Chuboe_RFQ_Line', {
      filter: `Chuboe_RFQ_ID eq ${rfqId}`, top: 100, skip, orderby: 'Line'
    });
    if (batch.records) allLines = allLines.concat(batch.records);
    if (!batch.records || batch.records.length < 100) break;
    skip += 100;
  }
  const cpcToLine = new Map();
  for (const l of allLines) {
    if (l.Chuboe_CPC) cpcToLine.set(l.Chuboe_CPC, l.id);
  }

  // Get all RFQ Line MPNs — build MPN→lineId map
  let allMpns = [];
  skip = 0;
  while (true) {
    const batch = await apiGet('Chuboe_RFQ_Line_MPN', {
      filter: `Chuboe_RFQ_ID eq ${rfqId}`, top: 100, skip
    });
    if (batch.records) allMpns = allMpns.concat(batch.records);
    if (!batch.records || batch.records.length < 100) break;
    skip += 100;
  }
  const mpnToLine = new Map();
  for (const m of allMpns) {
    const mpn = (m.Chuboe_MPN || '').toUpperCase();
    const lineId = m.Chuboe_RFQ_Line_ID?.id || m.Chuboe_RFQ_Line_ID;
    if (mpn && lineId) mpnToLine.set(mpn, lineId);
  }

  // Also build MPN clean → lineId for fuzzy matching
  const mpnCleanToLine = new Map();
  for (const m of allMpns) {
    const mpnClean = (m.Chuboe_MPN_Clean || '').toUpperCase();
    const lineId = m.Chuboe_RFQ_Line_ID?.id || m.Chuboe_RFQ_Line_ID;
    if (mpnClean && lineId) mpnCleanToLine.set(mpnClean, lineId);
  }

  const entry = {
    id: rfqId, bpartnerId, bpName,
    lines: cpcToLine, mpnToLine, mpnCleanToLine,
    lineCount: allLines.length, mpnCount: allMpns.length,
  };
  _rfqCache.set(rfqSearchKey, entry);
  logger.info(`RFQ ${rfqSearchKey} resolved: ID ${rfqId}, customer=${bpName} (${bpartnerId}), ${cpcToLine.size} CPCs, ${mpnToLine.size} MPNs`);
  return entry;
}

/**
 * Resolve a CQ line to its RFQ line ID.
 * Priority: CPC exact → MPN exact → MPN clean → null
 */
function resolveRFQLine(rfq, cpc, mpn) {
  // 1. CPC exact match
  if (cpc && rfq.lines.has(cpc)) return rfq.lines.get(cpc);

  // 2. MPN exact match
  const upper = (mpn || '').toUpperCase();
  if (upper && rfq.mpnToLine.has(upper)) return rfq.mpnToLine.get(upper);

  // 3. MPN clean match
  const cleaned = cleanMpn(mpn || '').toUpperCase();
  if (cleaned && rfq.mpnCleanToLine.has(cleaned)) return rfq.mpnCleanToLine.get(cleaned);

  // 4. Try stripping common suffixes from MPN
  const stripped = upper.replace(/-(R7|RL7|REEL7|ND|R|TR|CT)$/i, '').replace(/T$/, '');
  if (stripped !== upper && rfq.mpnToLine.has(stripped)) return rfq.mpnToLine.get(stripped);

  return null;
}

// ─── MFR RESOLUTION ──────────────────────────────────────────────────────────

/**
 * Resolve MFR for a CQ line via the unified resolver. Tries the source-provided
 * MFR text first (Policy D #1: preserve source intent), falls back to MPN-prefix
 * inference + acquisition map when text is empty (Policy D #3).
 *
 * Returns { id, canonical, flagReason, path, acquisitionApplied } or null fields.
 */
async function resolveMfrForCQ(mfrText, mpn) {
  if (!mfrText && !mpn) return { id: null, canonical: null, flagReason: null, path: 'none' };

  const mfrResult = resolveMfrForRow({ mfrText, mpn });

  if (!mfrResult.matched) {
    return { id: null, canonical: mfrText || null, flagReason: FLAG.MFR_NO_MATCH, path: mfrResult.path };
  }

  // Low-confidence fuzzy on the text path → flag but still write with text
  if (mfrResult.path === 'text' && mfrResult.source.startsWith('fuzzy(')) {
    const conf = mfrResult.source.match(/fuzzy\((\w+)\)/)?.[1];
    if (conf === 'low') {
      return { id: null, canonical: mfrResult.canonical, flagReason: FLAG.MFR_LOW_CONFIDENCE, path: mfrResult.path };
    }
  }

  // MPN-path matches with short prefix (medium confidence) → flag for review.
  // Currently classifyMpnToMfr returns confidence='medium' for prefixes < 3 chars.
  if (mfrResult.path === 'mpn' && mfrResult.confidence === 'medium') {
    return { id: null, canonical: mfrResult.canonical, flagReason: FLAG.MFR_LOW_CONFIDENCE, path: mfrResult.path };
  }

  const canonical = mfrResult.canonical || mfrText;
  // Re-resolve via api-client.resolveMFR to ensure target system has the record
  // (mfr-resolver's lookupMfr step uses the local cache; resolveMFR confirms
  // against the live API and respects isSystem).
  const resolved = await resolveMFR(canonical);

  return {
    id: (resolved && !resolved.isSystem) ? resolved.id : null,
    canonical,
    flagReason: null,
    path: mfrResult.path,
    acquisitionApplied: !!mfrResult.acquisitionApplied,
  };
}

// ─── SINGLE CQ WRITE ────────────────────────────────────────────────────────

/**
 * Write a single CQ line to the system.
 *
 * @param {string} rfqSearchKey - RFQ document number (e.g., '1141355')
 * @param {Object} line - Quote line data
 * @param {string} line.mpn - Part number (mandatory)
 * @param {string} line.mfrText - Manufacturer name (mandatory)
 * @param {number} line.qty - Quantity (mandatory)
 * @param {number} line.resale - Sell price to customer (mandatory)
 * @param {string} line.leadTime - Lead time (mandatory)
 * @param {string} [line.cpc] - Customer part code (preferred for line resolution)
 * @param {string} [line.dateCode] - Date code
 * @param {string} [line.description] - Part description
 * @param {string} [line.rohs] - RoHS status
 * @param {string} [line.coo] - Country of origin (text, e.g., 'US', 'China')
 * @param {string} [line.moq] - Minimum order quantity
 * @param {string} [line.packaging] - Packaging type text
 * @param {string} [line.notePublic] - Public note (visible to customer)
 * @param {string} [line.notePrivate] - Private note (internal only)
 * @param {Object} [opts]
 * @param {number} [opts.bpartnerId] - Override customer (default: from RFQ header)
 * @param {number} [opts.currencyId=100] - Currency (default: USD)
 * @param {boolean} [opts.includeInQuote=true] - Include in quote document
 * @returns {{ written: Object|null, flagged: Object|null, error: string|null }}
 */
async function writeCQ(rfqSearchKey, line, opts = {}) {
  const result = await writeCQBatch(rfqSearchKey, [line], opts);
  return {
    written: result.written[0] || null,
    flagged: result.flagged[0] || null,
    error: result.failed[0]?.detail || null,
  };
}

// ─── BATCH CQ WRITE ─────────────────────────────────────────────────────────

/**
 * Write multiple CQ lines against a single RFQ.
 *
 * @param {string} rfqSearchKey - RFQ document number
 * @param {Array<Object>} lines - Array of quote lines (see writeCQ for line format)
 * @param {Object} [opts]
 * @param {number} [opts.bpartnerId] - Override customer for all lines
 * @param {number} [opts.currencyId=100] - Currency
 * @param {boolean} [opts.includeInQuote=true] - Include in quote
 * @param {number} [opts.delayMs=50] - Delay between API writes (rate limiting)
 * @param {boolean} [opts.skipUnresolved=false] - If true, skip lines that can't resolve to RFQ line. If false (default), flag them.
 * @returns {{ written: Array, flagged: Array, failed: Array, summary: Object }}
 */
async function writeCQBatch(rfqSearchKey, lines, opts = {}) {
  const currencyId = opts.currencyId || DEFAULT_CURRENCY_ID;
  const includeInQuote = opts.includeInQuote !== false;
  const delayMs = opts.delayMs || 50;

  const written = [];
  const flagged = [];
  const failed = [];

  // ── Resolve RFQ ──
  const rfq = await resolveRFQ(rfqSearchKey);
  if (!rfq) {
    // Can't proceed without RFQ
    for (const line of lines) {
      flagged.push({
        mpn: line.mpn, cpc: line.cpc, resale: line.resale,
        reason: FLAG.NO_RFQ,
        detail: `RFQ '${rfqSearchKey}' not found`,
      });
    }
    return { written, flagged, failed, summary: buildSummary(lines.length, written, flagged, failed) };
  }

  const bpartnerId = opts.bpartnerId || rfq.bpartnerId;
  logger.info(`Writing ${lines.length} CQ lines for RFQ ${rfqSearchKey} (customer: ${rfq.bpName || bpartnerId})`);

  // ── Process each line ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mpn = line.mpn || '';
    const cpc = line.cpc || '';
    const resale = line.resale;

    // Validate mandatory fields
    const missing = [];
    if (!mpn) missing.push('mpn');
    if (!line.mfrText) missing.push('mfrText');
    if (line.qty == null || line.qty <= 0) missing.push('qty');
    if (resale == null || resale <= 0) missing.push('resale');
    if (!line.leadTime) missing.push('leadTime');
    if (missing.length > 0) {
      flagged.push({
        mpn, cpc, resale, qty: line.qty, mfrText: line.mfrText, leadTime: line.leadTime, lineIndex: i,
        reason: FLAG.MISSING_FIELDS,
        detail: `Missing: ${missing.join(', ')}`,
      });
      continue;
    }

    // Resolve RFQ line
    const rfqLineId = resolveRFQLine(rfq, cpc, mpn);
    if (!rfqLineId) {
      flagged.push({
        mpn, cpc, resale, lineIndex: i,
        reason: FLAG.NO_RFQ_LINE,
        detail: `${cpc ? `CPC '${cpc}'` : `MPN '${mpn}'`} not found in RFQ ${rfqSearchKey} (${rfq.lineCount} lines, ${rfq.mpnCount} MPNs)`,
      });
      continue;
    }

    // Resolve MFR — text path if provided (Policy D #1), MPN inference fallback
    // when text is empty (Policy D #3). resolveMfrForCQ handles both.
    let mfrId = null;
    let mfrCanonical = null;
    if (line.mfrText || mpn) {
      const mfr = await resolveMfrForCQ(line.mfrText, mpn);
      mfrId = mfr.id;
      mfrCanonical = mfr.canonical;
      if (mfr.flagReason) {
        // MFR issues are warnings, not blockers — write with text, flag for review
        const sourceTag = line.mfrText ? `text: '${line.mfrText}'` : `mpn-inferred: '${mpn}'`;
        logger.warn(`MFR warning for ${mpn}: ${mfr.flagReason} (${sourceTag})`);
      } else if (mfr.acquisitionApplied) {
        // Audit trail: MPN inference triggered an acquisition remap
        logger.info(`MFR inferred from MPN '${mpn}' via prefix → ${mfrCanonical} (acquisition applied)`);
      }
    }

    // Build payload
    const payload = {
      Chuboe_RFQ_ID: rfq.id,
      Chuboe_RFQ_Line_ID: rfqLineId,
      C_BPartner_ID: bpartnerId,
      Chuboe_MPN: mpn || null,
      Chuboe_MPN_Clean: mpn ? cleanMpn(mpn) : null,
      PriceEntered: resale,
      Qty: line.qty || 0,
      C_Currency_ID: currencyId,
      R_Status_ID: DEFAULT_STATUS_ID,
      IsChuboeIncludeInQuote: includeInQuote ? 'Y' : 'N',
      IsSold: 'N',
      Processed: 'N',
    };

    // CPC (needs clean variant)
    if (cpc) {
      payload.Chuboe_CPC = cpc;
      payload.Chuboe_CPC_Clean = cleanMpn(cpc);
    }
    // MFR resolution: only set MFR ID if non-system record.
    // System-level MFR records (AD_Client_ID=0) cause 500 errors via API.
    if (mfrId) payload.Chuboe_MFR_ID = mfrId;
    if (mfrCanonical) payload.Chuboe_MFR_Text = mfrCanonical;

    // All other optional fields — populate anything the caller provided
    for (const [inputKey, apiCol] of Object.entries(OPTIONAL_FIELD_MAP)) {
      const val = line[inputKey];
      if (val != null && val !== '') {
        payload[apiCol] = String(val);
      }
    }

    // Write to API
    try {
      const result = await apiPost('Chuboe_CQ_Line', payload);
      written.push({
        cqLineId: result.id,
        rfqId: rfq.id,
        rfqLineId,
        mpn, cpc, resale,
        qty: line.qty || 0,
        mfr: mfrCanonical,
        lineIndex: i,
      });
    } catch (e) {
      failed.push({
        mpn, cpc, resale, lineIndex: i,
        reason: FLAG.API_WRITE_ERROR,
        detail: e.message.substring(0, 300),
      });
    }

    // Rate limiting between writes
    if (i < lines.length - 1 && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const summary = buildSummary(lines.length, written, flagged, failed);
  logger.info(`CQ write complete for RFQ ${rfqSearchKey}: ${summary.written}/${summary.total} written, ${summary.flagged} flagged, ${summary.failed} failed`);

  return { written, flagged, failed, summary };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildSummary(total, written, flagged, failed) {
  const byReason = {};
  for (const f of flagged) {
    byReason[f.reason] = (byReason[f.reason] || 0) + 1;
  }
  for (const f of failed) {
    byReason[f.reason] = (byReason[f.reason] || 0) + 1;
  }
  return {
    total,
    written: written.length,
    flagged: flagged.length,
    failed: failed.length,
    byReason,
  };
}

// ─── CACHE MANAGEMENT ────────────────────────────────────────────────────────

function clearCaches() {
  _rfqCache = new Map();
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  writeCQ,
  writeCQBatch,
  clearCaches,
  FLAG,
  MANDATORY_FIELDS,
  OPTIONAL_FIELD_MAP,
  CQ_RESOLUTIONS,
  DEFAULT_STATUS_ID,
};
