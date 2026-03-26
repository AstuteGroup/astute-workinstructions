/**
 * Shared RFQ Writer — writes RFQ records to ai_writeback schema
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
 * ID MANAGEMENT:
 *   All IDs start at 9,000,000+ to avoid collisions with production.
 *   Queries ai_writeback for current max IDs before each write.
 *
 * MPN DESCRIPTION ENRICHMENT:
 *   If no description provided for a line MPN, looks up the most recent
 *   description from adempiere.chuboe_rfq_line_mpn (past 120 days).
 *   Future: API enrichment hook via opts.enrichDescription callback.
 */

const { execSync } = require('child_process');
const logger = require('./logger').createLogger('RFQWriter');
const {
  MIN_ID, IDEMPIERE_DEFAULTS: _BASE_DEFAULTS,
  psqlQuery, psqlExec, getNextId,
  cleanMpn,
} = require('./db-helpers');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

// RFQ records also need processed: 'N'
const IDEMPIERE_DEFAULTS = { ..._BASE_DEFAULTS, processed: 'N' };

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
 * Write a complete RFQ (header + lines + line MPNs) to ai_writeback.
 *
 * @param {object} opts
 * @param {number} opts.bpartnerId       - c_bpartner_id (required)
 * @param {string} opts.type             - RFQ type name: 'Stock', 'Shortage', etc. (required)
 * @param {string} [opts.description]    - Customer reference / description
 * @param {number} [opts.salesrepId]     - Salesrep ID (default: Jake Harris 1000004)
 * @param {number} [opts.statusId]       - r_status_id (default: 1000022 New)
 * @param {Array}  opts.lines            - Array of line objects (required, at least 1)
 * @param {string} opts.lines[].mpn      - Part number (required)
 * @param {string} [opts.lines[].mpnClean] - Cleaned MPN (auto-generated if omitted)
 * @param {number} [opts.lines[].mfrId]  - chuboe_mfr_id (optional)
 * @param {string} [opts.lines[].mfrText]- Manufacturer text (optional)
 * @param {number} opts.lines[].qty      - Quantity (required)
 * @param {number} [opts.lines[].targetPrice] - Target price (default: 0)
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
    salesrepId = DEFAULT_SALESREP_ID,
    statusId = DEFAULT_STATUS_ID,
    lines = [],
    enrichDescription = null,
  } = opts;

  // ── Validation ──
  if (!bpartnerId) throw new Error('rfq-writer: bpartnerId is required');
  if (!type) throw new Error('rfq-writer: type is required');
  if (!lines || lines.length === 0) throw new Error('rfq-writer: at least one line is required');

  const typeId = RFQ_TYPES[type];
  if (!typeId) throw new Error(`rfq-writer: unknown RFQ type '${type}'. Valid: ${Object.keys(RFQ_TYPES).join(', ')}`);

  // ── Get next IDs ──
  let nextRfqId = getNextId('chuboe_rfq', 'chuboe_rfq_id');
  let nextLineId = getNextId('chuboe_rfq_line', 'chuboe_rfq_line_id');
  let nextMpnId = getNextId('chuboe_rfq_line_mpn', 'chuboe_rfq_line_mpn_id');

  const rfqId = nextRfqId;
  const errors = [];
  let linesWritten = 0;
  let mpnsWritten = 0;

  // ── Insert RFQ Header ──
  const descEscaped = description ? `'${description.replace(/'/g, "''")}'` : 'NULL';
  const rfqSql = `
    INSERT INTO ai_writeback.chuboe_rfq (
      chuboe_rfq_id, ad_client_id, ad_org_id, isactive,
      created, createdby, updated, updatedby,
      c_bpartner_id, description, chuboe_rfq_type_id, r_status_id,
      processed, salesrep_id, chuboe_initialload_api,
      chuboe_csv_import, customerquotereport, chuboe_rfq_torequest_button,
      chuboe_amer_rfq2buyerqueue, chuboe_apac_rfq2buyerqueue, chuboe_emea_rfq2buyerqueue,
      chuboe_india_rfq2buyerqueue, add_pricing_api_vendor, chuboe_search_vendor,
      chuboe_search_stock, chuboe_multi_rfqtobuyerqueue, chuboe_japn_rfq2buyerqueue,
      chuboe_csv_cqmass
    ) VALUES (
      ${rfqId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, '${IDEMPIERE_DEFAULTS.isactive}',
      CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
      ${bpartnerId}, ${descEscaped}, ${typeId}, ${statusId},
      '${IDEMPIERE_DEFAULTS.processed}', ${salesrepId}, 'Y',
      'N', 'N', 'N',
      'N', 'N', 'N',
      'N', 'N', 'N',
      'N', 'N', 'N',
      'N'
    )
  `;

  const rfqOk = psqlExec(rfqSql);
  if (!rfqOk) {
    return { rfqId: null, linesWritten: 0, mpnsWritten: 0, errors: ['Failed to insert RFQ header'] };
  }
  logger.info(`RFQ header created: chuboe_rfq_id=${rfqId}, BP=${bpartnerId}, type=${type}`);

  // ── Insert Lines + Line MPNs ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = (i + 1) * 10; // Line 10, 20, 30...
    const lineId = nextLineId + i;
    const mpnId = nextMpnId + i;

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

    // ── Insert chuboe_rfq_line ──
    const lineSql = `
      INSERT INTO ai_writeback.chuboe_rfq_line (
        chuboe_rfq_line_id, ad_client_id, ad_org_id, isactive,
        created, createdby, updated, updatedby,
        chuboe_rfq_id, line, qty, priceentered
      ) VALUES (
        ${lineId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, '${IDEMPIERE_DEFAULTS.isactive}',
        CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
        ${rfqId}, ${lineNum}, ${qty}, ${targetPrice}
      )
    `;

    if (!psqlExec(lineSql)) {
      errors.push(`Failed to insert line ${i + 1} (${mpnRaw})`);
      continue;
    }
    linesWritten++;

    // ── Insert chuboe_rfq_line_mpn ──
    const mfrIdVal = line.mfrId ? line.mfrId : 'NULL';
    const mfrTextVal = line.mfrText ? `'${line.mfrText.replace(/'/g, "''")}'` : 'NULL';
    const mpnEscaped = mpnRaw.replace(/'/g, "''");
    const mpnCleanEscaped = mpnCleanVal.replace(/'/g, "''");
    const descVal = mpnDescription ? `'${mpnDescription.replace(/'/g, "''")}'` : 'NULL';
    const dateCodeVal = dateCode ? `'${dateCode.replace(/'/g, "''")}'` : 'NULL';

    const mpnSql = `
      INSERT INTO ai_writeback.chuboe_rfq_line_mpn (
        chuboe_rfq_line_mpn_id, ad_client_id, ad_org_id, isactive,
        created, createdby, updated, updatedby,
        chuboe_rfq_line_id, chuboe_rfq_id,
        chuboe_mpn, chuboe_mpn_clean,
        chuboe_mfr_id, chuboe_mfr_text,
        qty, priceentered,
        description, chuboe_date_code,
        chuboe_rfq_mpn_to_vq_button
      ) VALUES (
        ${mpnId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, '${IDEMPIERE_DEFAULTS.isactive}',
        CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
        ${lineId}, ${rfqId},
        '${mpnEscaped}', '${mpnCleanEscaped}',
        ${mfrIdVal}, ${mfrTextVal},
        ${qty}, ${targetPrice},
        ${descVal}, ${dateCodeVal},
        'N'
      )
    `;

    if (!psqlExec(mpnSql)) {
      errors.push(`Failed to insert line_mpn ${i + 1} (${mpnRaw})`);
      continue;
    }
    mpnsWritten++;
  }

  logger.info(`RFQ write complete: rfqId=${rfqId}, ${linesWritten} lines, ${mpnsWritten} MPNs${errors.length ? `, ${errors.length} errors` : ''}`);

  return { rfqId, linesWritten, mpnsWritten, errors };
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
