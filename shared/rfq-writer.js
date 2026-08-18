/**
 * Shared RFQ Writer — writes RFQ records via iDempiere REST API
 *
 * Handles all RFQ types (Stock, Shortage, PPV, etc.). Creates records across
 * three tables: chuboe_rfq (header), chuboe_rfq_line, chuboe_rfq_line_mpn.
 *
 * USAGE (Legacy — one MPN per line):
 *   const { writeRFQ } = require('../shared/rfq-writer');
 *
 *   const result = await writeRFQ({
 *     bpartnerId: 1000190,
 *     type: 'Stock',                          // maps to chuboe_rfq_type_id
 *     description: 'RFQ #790665 from Diego',  // customer reference (optional)
 *     salesrepId: 1000004,                     // defaults to Jake Harris
 *     lines: [
 *       { mpn: '561R10TCCT12', mfrId: 1019796, qty: 200, targetPrice: 0 }
 *     ]
 *   });
 *   // result: { rfqId: 9000001, linesWritten: 1, mpnsWritten: 1 }
 *
 * USAGE (Multi-MPN per CPC — for customer AVLs):
 *   const result = await writeRFQ({
 *     bpartnerId: 1000287, // Sanmina
 *     type: 'PPV',
 *     lines: [
 *       {
 *         cpc: 'LFNG035-4038-001',           // Customer Part Code
 *         qty: 1000,
 *         targetPrice: 1.16,
 *         mpns: [                             // Multiple approved MPNs per CPC
 *           { mpn: 'TPS7A3001DGNR', mfr: 'Texas Instruments' },
 *           { mpn: 'TPS7A3001DCNR', mfr: 'Texas Instruments' }  // alternate
 *         ]
 *       }
 *     ]
 *   });
 *   // result: { rfqId: 9000001, linesWritten: 1, mpnsWritten: 2,
 *   //           multiMpnFormat: true, mpnDetails: {...} }
 *
 * CONSUMERS:
 *   - Stock RFQ Loading
 *   - (Future) VQ-driven RFQ creation, other RFQ workflows
 *
 * SCOPE — WHAT THIS WRITER DOES NOT DO:
 *   This module writes ONLY the RFQ header, lines, and line MPN children.
 *   It does NOT write VQs (chuboe_vq_line). VQs are supplier quote responses
 *   and are written separately via shared/vq-writer.js (writeVQBatch) by the
 *   VQ Loading workflow once supplier quotes come back.
 *
 *   Note: After an RFQ is created in production, you may see a non-zero
 *   `chuboe_vq_count` on some lines in OT. This is a denormalized counter
 *   populated by a server-side bean callout during line/MPN creation; it is
 *   NOT driven by actual VQ child rows pointing at the new RFQ. OT does not
 *   associate VQs from other RFQs with new RFQs — the count is cosmetic and
 *   does not represent live VQ data attached to this RFQ.
 *
 * ID MANAGEMENT:
 *   IDs are assigned server-side by iDempiere via the REST API.
 *   Parent IDs are extracted from POST responses and passed to child records.
 *
 * MPN DESCRIPTION ENRICHMENT:
 *   If no description provided for a line MPN, looks up the most recent
 *   description from adempiere.chuboe_rfq_line_mpn (past 120 days).
 *   Future: API enrichment hook via opts.enrichDescription callback.
 */

const logger = require('./logger').createLogger('RFQWriter');
const { apiPost } = require('./api-client');
const { psqlQuery, cleanMpn } = require('./db-helpers');
const { lookupMfr } = require('./mfr-lookup');
const { resolveMfrForRow } = require('./mfr-resolver');
const { validateUserIsActive } = require('./partner-lookup');
const otBudget = require('./ot-api-budget');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const DEFAULT_SALESREP_ID = 1000004; // Jake Harris
const DEFAULT_STATUS_ID = 1000022;   // New

// RFQ type name → chuboe_rfq_type_id mapping
const RFQ_TYPES = {
  'Shortage':             1000000,
  'PPV':                  1000001,
  'EOL/LTB':              1000003,
  '3PL/VMI':              1000004,
  'Proactive Offer':      1000005,
  'Import':               1000006,
  'Stock':                1000007,
  'Hot Parts':            1000013,
  'Astute Franchised':    1000002,
  'Unqualified Spot RFQ': 1000012,
};

// ─── MPN DESCRIPTION ENRICHMENT ──────────────────────────────────────────────

/**
 * Look up the most recent description for an MPN from the system (past 120 days).
 *
 * @param {string} mpnClean - Cleaned MPN (alphanumeric only)
 * @returns {string|null} Description if found, null otherwise
 */
function lookupMpnDescription(mpnClean) {
  if (!mpnClean) return null;

  const escaped = mpnClean.replace(/'/g, "''");
  const sql = `SELECT description FROM adempiere.chuboe_rfq_line_mpn WHERE chuboe_mpn_clean = '${escaped}' AND isactive = 'Y' AND description IS NOT NULL AND description <> '' AND created > NOW() - INTERVAL '120 days' ORDER BY created DESC LIMIT 1`;

  const result = psqlQuery(sql);
  return result || null;
}

// ─── MAIN WRITER ─────────────────────────────────────────────────────────────

/**
 * Write a complete RFQ (header + lines + line MPNs) via iDempiere REST API.
 *
 * @param {object} opts
 * @param {number} opts.bpartnerId       - c_bpartner_id (required)
 * @param {string} opts.type             - RFQ type name: 'Stock', 'Shortage', etc. (required)
 * @param {string} [opts.description]    - Customer reference / description
 * @param {string} [opts.bpName]         - Free-text BPName on chuboe_rfq.bpname.
 *                                         Surface the parsed customer name on the
 *                                         header so buyers can identify who an
 *                                         Unqualified Broker email came from, or
 *                                         to mirror the matched BP name for at-a-
 *                                         glance lookup.
 * @param {number} [opts.salesrepId]     - Salesrep ID (default: Jake Harris 1000004)
 * @param {number} [opts.userId]         - Chuboe_User_ID (contact person on RFQ header)
 * @param {number} [opts.statusId]       - r_status_id (default: 1000022 New)
 * @param {Array}  opts.lines            - Array of line objects (required, at least 1)
 * @param {string} opts.lines[].mpn      - Part number (required)
 * @param {string} [opts.lines[].mpnClean] - Cleaned MPN (auto-generated if omitted)
 * @param {number} [opts.lines[].mfrId]  - chuboe_mfr_id (optional)
 * @param {string} [opts.lines[].mfrText]- Manufacturer text (optional)
 * @param {number} opts.lines[].qty      - Quantity (required)
 * @param {number} [opts.lines[].targetPrice] - Target price (default: 0)
 * @param {string} [opts.lines[].cpc]    - Customer part code (optional, written to RFQ line)
 * @param {string} [opts.lines[].description] - Part description (enriched from system if missing)
 * @param {string} [opts.lines[].dateCode] - Date code (optional)
 * @param {Function} [opts.enrichDescription] - Async callback(mpn, mpnClean) → description string.
 *                                              Called when no description found in system.
 *                                              Future hook for API enrichment.
 * @returns {object} { rfqId, linesWritten, mpnsWritten, errors }
 */
async function writeRFQ(opts) {
  const {
    bpartnerId,
    type,
    description = null,
    bpName = null,
    salesrepId = DEFAULT_SALESREP_ID,
    userId = null,
    statusId = DEFAULT_STATUS_ID,
    lines = [],
    enrichDescription = null,
    // Resume/backfill: when set, skip the header POST (the RFQ already exists)
    // and write only the lines/line_mpns not already present — used by the
    // resumer to backfill an RFQ that was partially written when OT died
    // mid-write. The header natural key (BP+type+salesrep) is NOT unique, so a
    // plain re-run would duplicate the header; this path avoids that.
    existingRfqId = null,
    existingSearchKey = null,
    // Sidecar replays: when true, bypass the global OT write budget check.
    // Recovery operations should not compete with normal flow for budget.
    skipBudgetCheck = false,
  } = opts;

  // ── Validation ──
  if (!bpartnerId) throw new Error('rfq-writer: bpartnerId is required');
  if (!type) throw new Error('rfq-writer: type is required. Stock pipeline = "Stock". General Customer RFQ = infer from email context (shortage/PPV/EOL keywords), or prompt the user.');
  if (!userId) throw new Error('rfq-writer: userId (contact person) is required. Resolve from email sender/CC via ad_user lookup, or prompt the user.');
  if (!lines || lines.length === 0) throw new Error('rfq-writer: at least one line is required');

  // Validate salesrep and contact are active users (bug fix 2026-08-18: agent
  // assigned inactive Hugo Ogalde as seller; inactive users must be rejected)
  const salesrepCheck = validateUserIsActive(salesrepId);
  if (!salesrepCheck.valid) {
    throw new Error(`rfq-writer: salesrepId validation failed — ${salesrepCheck.reason}`);
  }
  const userCheck = validateUserIsActive(userId);
  if (!userCheck.valid) {
    throw new Error(`rfq-writer: userId (contact) validation failed — ${userCheck.reason}`);
  }

  const typeId = RFQ_TYPES[type];
  if (!typeId) throw new Error(`rfq-writer: unknown RFQ type '${type}'. Valid: ${Object.keys(RFQ_TYPES).join(', ')}`);

  const errors = [];
  let linesWritten = 0;
  let mpnsWritten = 0;
  let otUnreachable = false;   // set when any write hit a network/transport failure (OT down) — retryable
  const { isOtUnreachableError } = require('./ot-error');

  // ── Insert RFQ Header via API ──
  // Column names MUST be exact PascalCase from ad_column.columnname
  // See shared/data-model.md "REST API Column Names" for tricky casing
  // NOTE: Omit button/flag fields (e.g., Chuboe_RFQ_ToRequest_Button) —
  //   API rejects string 'N' on button columns. Server defaults handle these.
  const rfqPayload = {
    C_BPartner_ID: bpartnerId,
    Chuboe_RFQ_Type_ID: typeId,
    SalesRep_ID: salesrepId,
    R_Status_ID: statusId,
  };
  if (description) rfqPayload.Description = description;
  if (bpName) rfqPayload.BPName = bpName;
  if (userId) rfqPayload.Chuboe_User_ID = userId;

  let rfqId;
  let searchKey = null; // Value field — the user-facing RFQ number in OT

  // Backfill mode: the RFQ already exists (partial write during an OT outage).
  // Skip the header POST — re-POSTing duplicates the header (its
  // BP+type+salesrep natural key is NOT unique). Pre-fetch what's already in
  // OT so the line loop writes only the gaps (lines + line_mpns).
  const existingLines = new Map();        // lineNum -> chuboe_rfq_line_id
  const existingMpnsByLine = new Map();   // chuboe_rfq_line_id -> Set(MPN_CLEAN, uppercased)
  if (existingRfqId) {
    rfqId = existingRfqId;
    searchKey = existingSearchKey || null;
    try {
      const rows = psqlQuery(
        `SELECT rl.line, rl.chuboe_rfq_line_id, ` +
        `COALESCE(string_agg(rlm.chuboe_mpn_clean, ',') FILTER (WHERE rlm.isactive='Y'), '') ` +
        `FROM adempiere.chuboe_rfq_line rl ` +
        `LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
        `WHERE rl.chuboe_rfq_id = ${parseInt(existingRfqId, 10)} AND rl.isactive='Y' ` +
        `GROUP BY rl.line, rl.chuboe_rfq_line_id`
      );
      for (const row of (rows || '').split('\n')) {
        if (!row.trim()) continue;
        const [lineStr, idStr, mpnCsv] = row.split('|');
        const ln = parseInt(lineStr, 10);
        const id = parseInt(idStr, 10);
        if (isNaN(ln) || isNaN(id)) continue;
        existingLines.set(ln, id);
        existingMpnsByLine.set(id, new Set(
          (mpnCsv || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
        ));
      }
      logger.info(`RFQ backfill mode: rfqId=${rfqId}, ${existingLines.size} line(s) already present`);
    } catch (e) {
      // Can't read existing state → abort backfill rather than risk duplicates.
      return { rfqId, searchKey, linesWritten: 0, mpnsWritten: 0,
        errors: [`Backfill pre-fetch failed for rfqId ${rfqId}: ${e.message}`], otUnreachable: false };
    }
  } else {
    try {
      // naturalKeyFields enables apiPost's verify-after-error retry path:
      // on a transient network/5xx, it GETs back any row created since the
      // POST started matching (BP, type, salesrep) — if found, returns it
      // (no dup); if not, retries the POST. Without this, intermittent
      // network flaps left emails in INBOX with no header written.
      // Discovered 2026-05-06 during the 50% POST-failure run.
      const rfqResponse = await apiPost('chuboe_rfq', rfqPayload, {
        naturalKeyFields: ['C_BPartner_ID', 'Chuboe_RFQ_Type_ID', 'SalesRep_ID'],
        context: 'rfq-loading',
      });
      rfqId = rfqResponse.id;
      searchKey = rfqResponse.Value || rfqResponse.value || null;
      if (!rfqId) throw new Error('No ID returned in response');
    } catch (e) {
      const net = isOtUnreachableError(e);
      return {
        rfqId: null, searchKey: null, linesWritten: 0, mpnsWritten: 0,
        errors: [`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert RFQ header: ${e.message}`],
        otUnreachable: net,
        // Header never wrote → nothing orphaned in OT. Resume re-runs writeRFQ fresh.
        pending: net ? { rfqId: null, searchKey: null, stage: 'header' } : undefined,
      };
    }
    logger.info(`RFQ header created: searchKey=${searchKey}, chuboe_rfq_id=${rfqId}, BP=${bpartnerId}, type=${type}`);
  }

  // ── CHUNKED MODE for large RFQs (BOMs) ──
  // Large BOMs would overwhelm the API without pacing. Write in chunks with delays.
  const LARGE_RFQ_THRESHOLD = 500;  // lines
  const CHUNK_SIZE = 150;           // lines per chunk
  const CHUNK_DELAY_MS = 2000;      // 2s between chunks
  const useChunkedMode = lines.length > LARGE_RFQ_THRESHOLD;

  // Estimate API writes: 1 line per input + N mpns per line
  // For multi-MPN format, count actual MPNs; for legacy, assume 1 MPN per line
  const estimatedMpns = lines.reduce((acc, l) => {
    if (Array.isArray(l.mpns)) return acc + l.mpns.length;
    return acc + 1;
  }, 0);
  const estimatedWrites = lines.length + estimatedMpns;

  if (useChunkedMode) {
    // Chunked mode: still check daily limit (skip burst checks - we self-pace)
    // Prevents perfect storm of normal loads + huge file exceeding daily cap
    if (!skipBudgetCheck) {
      const status = otBudget.getStatus();
      const dailyUsed = parseInt(status.globalBudget.lastDay.split('/')[0], 10) || 0;
      const dailyLimit = otBudget.LIMITS.maxWritesPerDay;
      if (dailyUsed + estimatedWrites > dailyLimit) {
        logger.warn(`Daily budget would be exceeded: ${dailyUsed}/${dailyLimit} + ${estimatedWrites} estimated`);
        return {
          rfqId,
          searchKey,
          linesWritten: 0,
          mpnsWritten: 0,
          errors: [],
          rateLimited: true,
          rateLimitReason: `Daily limit: ${dailyUsed}/${dailyLimit} used, need ${estimatedWrites} more`,
          otUnreachable: false,
        };
      }
    }
    logger.info(`Large RFQ detected (${lines.length} lines) — using chunked mode with ${CHUNK_SIZE}-line chunks and ${CHUNK_DELAY_MS}ms delays`);
  } else if (!skipBudgetCheck) {
    // Budget check for smaller RFQs (large ones self-pace via chunking)
    // Skipped for sidecar replays (recovery operations bypass budget)
    const globalCheck = otBudget.checkBudget({
      table: 'chuboe_rfq_line',
      count: estimatedWrites,
      caller: 'rfq-writer',
    });
    if (!globalCheck.allowed) {
      logger.warn(`Global budget exhausted: ${globalCheck.reason}`);
      return {
        rfqId,
        searchKey,
        linesWritten: 0,
        mpnsWritten: 0,
        errors: [],
        rateLimited: true,
        rateLimitReason: globalCheck.reason,
        otUnreachable: false,
      };
    }
  }

  // Helper for chunked delay
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ── Detect multi-MPN format and normalize ──
  // Multi-MPN format: lines have `mpns[]` array with multiple MPN records per CPC
  // Legacy format: lines have a single `mpn` field
  const isMultiMpnFormat = lines.some(l => Array.isArray(l.mpns) && l.mpns.length > 0);

  // Normalize lines to internal format: each entry has cpc (optional), qty, targetPrice,
  // and mpns[] array (even if just one MPN)
  const normalizedLines = isMultiMpnFormat
    ? lines.map(l => ({
        cpc: l.cpc || null,
        qty: l.qty || 0,
        targetPrice: l.targetPrice || 0,
        description: l.description || null,
        mpns: (l.mpns || []).map(m => ({
          mpn: m.mpn || '',
          mpnClean: m.mpnClean || cleanMpn(m.mpn || ''),
          mfr: m.mfr || null,
          mfrText: m.mfrText || m.mfr || null,
          dateCode: m.dateCode || l.dateCode || null,
          description: m.description || l.description || null,
        })),
      }))
    : lines.map(l => ({
        cpc: l.cpc || null,
        qty: l.qty || 0,
        targetPrice: l.targetPrice || 0,
        description: l.description || null,
        mpns: [{
          mpn: l.mpn || '',
          mpnClean: l.mpnClean || cleanMpn(l.mpn || ''),
          mfr: l.mfr || null,
          mfrText: l.mfrText || l.mfr || null,
          dateCode: l.dateCode || null,
          description: l.description || null,
        }],
      }));

  // Track per-CPC MPN details for return value
  const mpnDetails = {};

  // ── Insert Lines + Line MPNs ──
  for (let i = 0; i < normalizedLines.length; i++) {
    // Chunked mode: pause between chunks to stay under rate limits
    if (useChunkedMode && i > 0 && i % CHUNK_SIZE === 0) {
      const chunkNum = Math.floor(i / CHUNK_SIZE);
      const totalChunks = Math.ceil(lines.length / CHUNK_SIZE);
      logger.info(`Chunk ${chunkNum}/${totalChunks} complete (${linesWritten} lines written). Pausing ${CHUNK_DELAY_MS}ms...`);
      await sleep(CHUNK_DELAY_MS);
    }

    const normLine = normalizedLines[i];
    const lineNum = (i + 1) * 10; // Line 10, 20, 30...

    const qty = normLine.qty;
    const targetPrice = normLine.targetPrice;
    const cpc = normLine.cpc;

    // For display and error messages, use first MPN
    const firstMpn = normLine.mpns[0]?.mpn || '(no MPN)';

    // ── Insert chuboe_rfq_line via API ──
    let lineId;
    if (existingLines.has(lineNum)) {
      // Backfill: this line already exists — reuse its id and write only its
      // missing line_mpn below. Don't re-POST (would duplicate the line).
      lineId = existingLines.get(lineNum);
    } else {
      try {
        const linePayload = {
          Chuboe_RFQ_ID: rfqId,
          Line: lineNum,
          Qty: qty,
          PriceEntered: targetPrice,
        };
        if (cpc) linePayload.Chuboe_CPC = cpc;
        const lineResponse = await apiPost('chuboe_rfq_line', linePayload, {
          naturalKeyFields: ['Chuboe_RFQ_ID', 'Line'],
          context: 'rfq-loading',
        });
        lineId = lineResponse.id;
        if (!lineId) throw new Error('No ID returned in response');
      } catch (e) {
        const net = isOtUnreachableError(e);
        if (net) otUnreachable = true;
        errors.push(`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert line ${i + 1} (${firstMpn}): ${e.message}`);
        continue;
      }
      linesWritten++;
    }

    // Track MPN details for this CPC (for return value)
    const cpcKey = cpc || `line_${lineNum}`;
    mpnDetails[cpcKey] = { lineId, mpns: [] };

    // ── Insert chuboe_rfq_line_mpn via API (one per MPN in mpns array) ──
    for (const mpnEntry of normLine.mpns) {
      const mpnRaw = mpnEntry.mpn || '';
      const mpnCleanVal = mpnEntry.mpnClean || cleanMpn(mpnRaw);
      const dateCode = mpnEntry.dateCode || null;

      // ── Description enrichment ──
      let mpnDescription = mpnEntry.description || null;
      if (!mpnDescription) {
        // Try system lookup (past 120 days)
        mpnDescription = lookupMpnDescription(mpnCleanVal);
        if (mpnDescription) {
          logger.debug(`Enriched ${mpnRaw} description from system: "${mpnDescription}"`);
        }
      }
      if (!mpnDescription && enrichDescription) {
        // Future: API enrichment callback
        try {
          mpnDescription = await enrichDescription(mpnRaw, mpnCleanVal);
          if (mpnDescription) {
            logger.debug(`Enriched ${mpnRaw} description from API: "${mpnDescription}"`);
          }
        } catch (e) {
          logger.warn(`Description enrichment failed for ${mpnRaw}: ${e.message}`);
        }
      }

      // Backfill: skip if this line already has this MPN (e.g. 1135619 — line
      // wrote but its line_mpn POST timed out; only the missing sub-row is added).
      if (existingMpnsByLine.has(lineId) && existingMpnsByLine.get(lineId).has((mpnCleanVal || '').toUpperCase())) {
        mpnDetails[cpcKey].mpns.push({ mpn: mpnRaw, status: 'already_exists' });
        continue;
      }

      try {
        const mpnPayload = {
          Chuboe_RFQ_Line_ID: lineId,
          Chuboe_RFQ_ID: rfqId,
          Chuboe_MPN: mpnRaw,
          Chuboe_MPN_Clean: mpnCleanVal,
          Qty: qty,
          PriceEntered: targetPrice,
          // Omit button fields — API rejects string 'N' on button columns
        };
        // MFR resolution via the unified resolver: text path (Policy D #1) when
        // mfrText is provided; OT-history path (consultOTHistory: true)
        // when we have a >=70% weighted majority MFR across CQ/VQ/offer history
        // for this MPN — operator-vetted ground truth beats prefix guess for
        // MPNs we have actually traded, and survives the prefix-resolver's known
        // overreach (CY7C, ISO*, ISL*, XC*, BCM*); falls back to MPN-prefix +
        // acquisition map when neither hits.
        // Never send Chuboe_MFR_ID — server resolves from canonical name.
        if (mpnEntry.mfrText || mpnRaw) {
          const mfrResult = resolveMfrForRow({
            mfrText: mpnEntry.mfrText,
            mpn: mpnRaw,
            consultOTHistory: true,
          });
          if (mfrResult.canonical) {
            mpnPayload.Chuboe_MFR_Text = mfrResult.canonical;  // exact chuboe_mfr.name
          }
        }
        if (mpnDescription) mpnPayload.Description = mpnDescription;
        if (dateCode) mpnPayload.Chuboe_Date_Code = dateCode;

        // Natural key: MFR resolved server-side from text, so use text field here.
        // If MFR text is unset, verify path is skipped — apiPost will throw on
        // transient errors instead of risking a dup retry.
        await apiPost('chuboe_rfq_line_mpn', mpnPayload, {
          naturalKeyFields: ['Chuboe_RFQ_Line_ID', 'Chuboe_MPN_Clean', 'Chuboe_MFR_Text'],
          context: 'rfq-loading',
        });
        mpnDetails[cpcKey].mpns.push({ mpn: mpnRaw, status: 'written' });
      } catch (e) {
        const net = isOtUnreachableError(e);
        if (net) otUnreachable = true;
        errors.push(`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert line_mpn ${i + 1} (${mpnRaw}): ${e.message}`);
        mpnDetails[cpcKey].mpns.push({ mpn: mpnRaw, status: 'error', error: e.message });
        continue;
      }
      mpnsWritten++;
    }
  }

  const chunkedNote = useChunkedMode ? ` [chunked: ${Math.ceil(lines.length / CHUNK_SIZE)} chunks]` : '';
  logger.info(`RFQ write complete: searchKey=${searchKey}, rfqId=${rfqId}, ${linesWritten} lines, ${mpnsWritten} MPNs${errors.length ? `, ${errors.length} errors` : ''}${chunkedNote}`);

  return {
    rfqId, searchKey, linesWritten, mpnsWritten, errors,
    otUnreachable, chunkedMode: useChunkedMode,
    // Multi-MPN format: include per-CPC tracking for audit
    multiMpnFormat: isMultiMpnFormat,
    mpnDetails: isMultiMpnFormat ? mpnDetails : undefined,
    // Header wrote but some lines/line_mpns may not have (OT died mid-RFQ).
    // Resume backfills the gaps against this existing rfqId — never re-POSTs
    // the header (its natural key BP+type+salesrep is not unique → would dup).
    pending: otUnreachable ? { rfqId, searchKey, stage: 'lines' } : undefined,
  };
}

// ─── UTILITY: Look up MFR ID by canonical name ──────────────────────────────

/**
 * Resolve a manufacturer name to its chuboe_mfr_id.
 * Uses the generic/shortest name match (what you'd pick in the UI).
 *
 * @param {string} mfrName - Manufacturer name (canonical or raw)
 * @returns {number|null} chuboe_mfr_id or null
 */
function lookupMfrId(mfrName) {
  if (!mfrName) return null;
  const escaped = mfrName.replace(/'/g, "''");
  const sql = `SELECT chuboe_mfr_id FROM adempiere.chuboe_mfr WHERE isactive='Y' AND (UPPER(name) = UPPER('${escaped}') OR name ILIKE '${escaped} %' OR name ILIKE '${escaped},%') ORDER BY LENGTH(name) ASC LIMIT 1`;
  const result = psqlQuery(sql);
  const id = parseInt(result, 10);
  return isNaN(id) ? null : id;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  writeRFQ,
  lookupMfrId,
  lookupMpnDescription,
  cleanMpn,
  RFQ_TYPES,
};
