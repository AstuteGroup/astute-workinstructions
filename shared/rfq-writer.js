/**
 * Shared RFQ Writer — writes RFQ records via iDempiere REST API
 *
 * Handles all RFQ types (Stock, Shortage, PPV, etc.). Creates records across
 * three tables: chuboe_rfq (header), chuboe_rfq_line, chuboe_rfq_line_mpn.
 *
 * USAGE:
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
  } = opts;

  // ── Validation ──
  if (!bpartnerId) throw new Error('rfq-writer: bpartnerId is required');
  if (!type) throw new Error('rfq-writer: type is required. Stock pipeline = "Stock". General Customer RFQ = infer from email context (shortage/PPV/EOL keywords), or prompt the user.');
  if (!userId) throw new Error('rfq-writer: userId (contact person) is required. Resolve from email sender/CC via ad_user lookup, or prompt the user.');
  if (!lines || lines.length === 0) throw new Error('rfq-writer: at least one line is required');

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

  // ── Insert Lines + Line MPNs ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = (i + 1) * 10; // Line 10, 20, 30...

    const mpnRaw = line.mpn || '';
    const mpnCleanVal = line.mpnClean || cleanMpn(mpnRaw);
    const qty = line.qty || 0;
    const targetPrice = line.targetPrice || 0;
    const dateCode = line.dateCode || null;

    // ── Description enrichment ──
    let mpnDescription = line.description || null;
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
        if (line.cpc) linePayload.Chuboe_CPC = line.cpc;
        const lineResponse = await apiPost('chuboe_rfq_line', linePayload, {
          naturalKeyFields: ['Chuboe_RFQ_ID', 'Line'],
        });
        lineId = lineResponse.id;
        if (!lineId) throw new Error('No ID returned in response');
      } catch (e) {
        const net = isOtUnreachableError(e);
        if (net) otUnreachable = true;
        errors.push(`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert line ${i + 1} (${mpnRaw}): ${e.message}`);
        continue;
      }
      linesWritten++;
    }

    // ── Insert chuboe_rfq_line_mpn via API ──
    // Backfill: skip if this line already has this MPN (e.g. 1135619 — line
    // wrote but its line_mpn POST timed out; only the missing sub-row is added).
    if (existingMpnsByLine.has(lineId) && existingMpnsByLine.get(lineId).has((mpnCleanVal || '').toUpperCase())) {
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
      // line.mfrText is provided; OT-history path (consultOTHistory: true)
      // when we have a >=70% weighted majority MFR across CQ/VQ/offer history
      // for this MPN — operator-vetted ground truth beats prefix guess for
      // MPNs we have actually traded, and survives the prefix-resolver's known
      // overreach (CY7C, ISO*, ISL*, XC*, BCM*); falls back to MPN-prefix +
      // acquisition map when neither hits. Only set Chuboe_MFR_ID for non-
      // system records (system-level MFRs with AD_Client_ID=0 cause 500
      // errors via API).
      if (line.mfrText || mpnRaw) {
        const mfrResult = resolveMfrForRow({
          mfrText: line.mfrText,
          mpn: mpnRaw,
          consultOTHistory: true,
        });
        if (mfrResult.canonical) {
          mpnPayload.Chuboe_MFR_Text = mfrResult.canonical;
        }
        if (mfrResult.id && !mfrResult.isSystem) {
          mpnPayload.Chuboe_MFR_ID = mfrResult.id;
        }
      }
      if (mpnDescription) mpnPayload.Description = mpnDescription;
      if (dateCode) mpnPayload.Chuboe_Date_Code = dateCode;

      // Natural key includes MFR so legitimate cross-MFR AVL alternates
      // (e.g., DG441DY from both Renesas and Vishay on the same line) are
      // not collapsed. If MFR is unset on the payload, the verify path is
      // skipped — apiPost will throw on transient errors instead of risking
      // a dup retry, which is the safer default.
      await apiPost('chuboe_rfq_line_mpn', mpnPayload, {
        naturalKeyFields: ['Chuboe_RFQ_Line_ID', 'Chuboe_MPN_Clean', 'Chuboe_MFR_ID'],
      });
    } catch (e) {
      const net = isOtUnreachableError(e);
      if (net) otUnreachable = true;
      errors.push(`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert line_mpn ${i + 1} (${mpnRaw}): ${e.message}`);
      continue;
    }
    mpnsWritten++;
  }

  logger.info(`RFQ write complete: searchKey=${searchKey}, rfqId=${rfqId}, ${linesWritten} lines, ${mpnsWritten} MPNs${errors.length ? `, ${errors.length} errors` : ''}`);

  return {
    rfqId, searchKey, linesWritten, mpnsWritten, errors,
    otUnreachable,
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
