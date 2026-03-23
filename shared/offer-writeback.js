/**
 * Shared Offer Writer — writes market offers to ai_writeback schema
 *
 * Handles all offer types (Customer Excess, Broker Stock, Inventory Stock, etc.).
 * Creates records across three tables:
 *   - chuboe_offer (header)
 *   - chuboe_offer_line (line items)
 *   - chuboe_offer_line_mpn (MPN cross-references, optional)
 *
 * USAGE:
 *   const { writeOffer } = require('../shared/offer-writeback');
 *
 *   const result = await writeOffer({
 *     bpartnerId: 1000332,              // Astute Electronics Inc
 *     offerTypeId: 1000008,             // Stock - Austin Warehouse
 *     description: 'Weekly inventory refresh 2026-03-23',
 *     lines: [
 *       { mpn: 'ADS1115IDGST', mfrText: 'Texas Instruments', qty: 500, price: 3.50, dateCode: '2024+' }
 *     ]
 *   });
 *   // result: { offerId: 9000000, linesWritten: 1, mpnsWritten: 1, errors: [] }
 *
 * CONSUMERS:
 *   - Market Offer Uploading (customer excess, broker stock)
 *   - Inventory File Cleanup (own stock by warehouse)
 *   - (Future) VQ Loading, automated offer capture
 *
 * ID MANAGEMENT:
 *   All IDs start at 9,000,000+ to avoid collisions with production.
 *   Queries ai_writeback for current max IDs before each write.
 */

const { execSync } = require('child_process');
const logger = require('./logger').createLogger('OfferWriter');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const IDEMPIERE_DEFAULTS = {
  ad_client_id: 1000000,
  ad_org_id: 0,
  isactive: 'Y',
  createdby: 1000004,  // Jake Harris
  updatedby: 1000004,
};

const MIN_ID = 9000000;

// Offer type name → chuboe_offer_type_id mapping
const OFFER_TYPES = {
  'Customer Excess':                1000000,
  'Broker Stock Offer':             1000001,
  'Franchise Offers':               1000002,
  'Customer Lead Time Buy':         1000003,
  'Franchise Stock Offers':         1000004,
  'Requested Quote':                1000005,
  'Stock - Stevenage':              1000006,
  'Stock - Austin Warehouse':       1000008,
  'Stock - Hong Kong Warehouse':    1000009,
  'Customer Lot/Line Bid':          1000013,
  'Stock - Philippines Warehouse':  1000014,
  'Hot Parts':                      1000015,
  'Disty Book Cost':                1000016,
  'Stock-IC Source':                1000017,
  'Unqualified Spot RFQ-IC Source': 1000018,
  'Stock-NetComp':                  1000019,
  'Unqualified Spot RFQ-NetComp':   1000020,
  'Stock-ERAI':                     1000021,
  'Unqualified Spot RFQ-ERAI':      1000022,
  'Stock-Partstack':                1000023,
  'Unqualified Spot RFQ-Partstack': 1000024,
  'LAM Kitting Inventory':          1000025,
  'Manufacturer Cross Reference':   1000027,
};

// ─── DATABASE HELPERS ────────────────────────────────────────────────────────

/**
 * Run a psql query and return raw output.
 * Filters out rbash noise lines.
 */
function psqlQuery(sql, timeout = 15000) {
  try {
    const result = execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout,
    });
    const lines = result.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') &&
             !t.includes('/dev/null') && !t.includes('restricted:') &&
             !t.includes('/tmp/claude');
    });
    return lines.join('\n').trim();
  } catch (e) {
    const combined = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    const lines = combined.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') &&
             !t.includes('/dev/null') && !t.includes('restricted:') &&
             !t.includes('/tmp/claude') && !t.includes('ERROR:');
    });
    return lines.join('\n').trim();
  }
}

/**
 * Run an INSERT/UPDATE statement. Returns true on success.
 */
function psqlExec(sql, timeout = 15000) {
  try {
    const result = execSync(`psql -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout,
    });
    return result.includes('INSERT') || result.includes('UPDATE') || result.includes('DELETE');
  } catch (e) {
    const msg = (e.stderr || '') + (e.stdout || '');
    logger.error('SQL exec failed:', msg.slice(0, 500));
    return false;
  }
}

// ─── ID MANAGEMENT ───────────────────────────────────────────────────────────

/**
 * Get the next safe ID for a given ai_writeback table/column.
 * Returns MAX(existing) + 1, or MIN_ID if table is empty.
 */
function getNextId(table, column) {
  const result = psqlQuery(`SELECT COALESCE(MAX(${column}), ${MIN_ID - 1}) FROM ai_writeback.${table}`);
  const maxId = parseInt(result, 10);
  if (isNaN(maxId) || maxId < MIN_ID) return MIN_ID;
  return maxId + 1;
}

// ─── MPN CLEANING ────────────────────────────────────────────────────────────

/**
 * Clean an MPN by removing non-alphanumeric characters (matching iDempiere behavior).
 */
function cleanMpn(mpn) {
  if (!mpn) return '';
  return mpn.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ─── SQL VALUE HELPERS ───────────────────────────────────────────────────────

function sqlStr(val) {
  if (val === null || val === undefined || val === '') return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function sqlNum(val) {
  if (val === null || val === undefined || val === '') return 'NULL';
  const n = Number(val);
  return isNaN(n) ? 'NULL' : String(n);
}

// ─── MAIN WRITER ─────────────────────────────────────────────────────────────

/**
 * Write a complete offer (header + lines + optional line MPNs) to ai_writeback.
 *
 * @param {object} opts
 * @param {number} opts.bpartnerId          - c_bpartner_id (required)
 * @param {number|string} opts.offerTypeId  - chuboe_offer_type_id or type name string (required)
 * @param {string} [opts.description]       - Offer description (e.g., "Weekly inventory 2026-03-23")
 * @param {string} [opts.datetrx]           - Transaction date (ISO string). Defaults to now.
 * @param {number} [opts.userId]            - chuboe_user_id (optional)
 * @param {number} [opts.buyerId]           - chuboe_buyer_id (optional)
 * @param {boolean} [opts.writeMpnRecords=false] - Also write chuboe_offer_line_mpn records
 * @param {Array}  opts.lines               - Array of line objects (required, at least 1)
 * @param {string} opts.lines[].mpn         - Part number (required)
 * @param {string} [opts.lines[].mpnClean]  - Cleaned MPN (auto-generated if omitted)
 * @param {number} [opts.lines[].mfrId]     - chuboe_mfr_id (optional)
 * @param {string} [opts.lines[].mfrText]   - Manufacturer text (optional)
 * @param {number} [opts.lines[].qty]       - Quantity (optional but typical)
 * @param {number} [opts.lines[].price]     - Unit price / PriceEntered (optional)
 * @param {string} [opts.lines[].dateCode]  - Date code (optional)
 * @param {string} [opts.lines[].leadTime]  - Lead time (optional)
 * @param {string} [opts.lines[].packageDesc] - Package description (optional)
 * @param {number} [opts.lines[].countryId] - c_country_id (optional)
 * @param {number} [opts.lines[].currencyId]- c_currency_id (optional)
 * @param {string} [opts.lines[].description] - Line-level description (optional)
 * @param {string} [opts.lines[].moq]       - Minimum order quantity (optional)
 * @param {string} [opts.lines[].spq]       - Standard pack quantity (optional)
 * @param {string} [opts.lines[].cpc]       - Customer part code (optional)
 * @param {string} [opts.lines[].cpcClean]  - Cleaned CPC (optional)
 * @param {number} [opts.lines[].recommendedResale] - Suggested resale price (optional)
 * @returns {object} { offerId, linesWritten, mpnsWritten, errors }
 */
async function writeOffer(opts) {
  const {
    bpartnerId,
    offerTypeId: rawOfferType,
    description = null,
    datetrx = null,
    userId = null,
    buyerId = null,
    writeMpnRecords = false,
    lines = [],
  } = opts;

  // ── Validation ──
  if (!bpartnerId) throw new Error('offer-writeback: bpartnerId is required');
  if (!rawOfferType) throw new Error('offer-writeback: offerTypeId is required');
  if (!lines || lines.length === 0) throw new Error('offer-writeback: at least one line is required');

  // Resolve type: accept either numeric ID or string name
  let offerTypeId;
  if (typeof rawOfferType === 'string' && isNaN(Number(rawOfferType))) {
    offerTypeId = OFFER_TYPES[rawOfferType];
    if (!offerTypeId) throw new Error(`offer-writeback: unknown offer type '${rawOfferType}'. Valid: ${Object.keys(OFFER_TYPES).join(', ')}`);
  } else {
    offerTypeId = Number(rawOfferType);
  }

  // ── Get next IDs ──
  let nextOfferId = getNextId('chuboe_offer', 'chuboe_offer_id');
  let nextLineId = getNextId('chuboe_offer_line', 'chuboe_offer_line_id');
  let nextMpnId = writeMpnRecords ? getNextId('chuboe_offer_line_mpn', 'chuboe_offer_line_mpn_id') : 0;

  const offerId = nextOfferId;
  const errors = [];
  let linesWritten = 0;
  let mpnsWritten = 0;

  // ── Insert Offer Header ──
  const headerSql = `
    INSERT INTO ai_writeback.chuboe_offer (
      chuboe_offer_id, ad_client_id, ad_org_id, isactive,
      created, createdby, updated, updatedby,
      c_bpartner_id, chuboe_offer_type_id, description, datetrx,
      chuboe_user_id, chuboe_buyer_id,
      chuboe_csv_import, chuboe_pulllmarketofferinto,
      add_pricing_api_vendor, chuboe_search_vendor
    ) VALUES (
      ${offerId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, '${IDEMPIERE_DEFAULTS.isactive}',
      CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
      ${bpartnerId}, ${offerTypeId}, ${sqlStr(description)}, ${datetrx ? sqlStr(datetrx) : 'CURRENT_TIMESTAMP'},
      ${sqlNum(userId)}, ${sqlNum(buyerId)},
      'N', 'N',
      'N', 'N'
    )
  `;

  const headerOk = psqlExec(headerSql);
  if (!headerOk) {
    return { offerId: null, linesWritten: 0, mpnsWritten: 0, errors: ['Failed to insert offer header'] };
  }
  logger.info(`Offer header created: chuboe_offer_id=${offerId}, BP=${bpartnerId}, type=${offerTypeId}`);

  // ── Insert Lines ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = (i + 1) * 10; // Line 10, 20, 30...
    const lineId = nextLineId + i;

    const mpnRaw = line.mpn || '';
    const mpnCleanVal = line.mpnClean || cleanMpn(mpnRaw);

    const lineSql = `
      INSERT INTO ai_writeback.chuboe_offer_line (
        chuboe_offer_line_id, ad_client_id, ad_org_id, isactive,
        created, createdby, updated, updatedby,
        chuboe_offer_id, line,
        chuboe_mpn, chuboe_mpn_clean,
        chuboe_mfr_id, chuboe_mfr_text,
        qty, priceentered,
        chuboe_date_code, chuboe_lead_time, chuboe_package_desc,
        c_country_id, c_currency_id,
        description,
        chuboe_moq, chuboe_spq,
        chuboe_cpc, chuboe_cpc_clean,
        apl_offer_recommendedresale
      ) VALUES (
        ${lineId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, '${IDEMPIERE_DEFAULTS.isactive}',
        CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
        ${offerId}, ${lineNum},
        ${sqlStr(mpnRaw)}, ${sqlStr(mpnCleanVal)},
        ${sqlNum(line.mfrId)}, ${sqlStr(line.mfrText)},
        ${sqlNum(line.qty)}, ${sqlNum(line.price)},
        ${sqlStr(line.dateCode)}, ${sqlStr(line.leadTime)}, ${sqlStr(line.packageDesc)},
        ${sqlNum(line.countryId)}, ${sqlNum(line.currencyId)},
        ${sqlStr(line.description)},
        ${sqlStr(line.moq)}, ${sqlStr(line.spq)},
        ${sqlStr(line.cpc)}, ${line.cpcClean ? sqlStr(line.cpcClean) : (line.cpc ? sqlStr(cleanMpn(line.cpc)) : 'NULL')},
        ${sqlNum(line.recommendedResale)}
      )
    `;

    if (!psqlExec(lineSql)) {
      errors.push(`Failed to insert line ${i + 1} (${mpnRaw})`);
      continue;
    }
    linesWritten++;

    // ── Optional: Insert chuboe_offer_line_mpn ──
    if (writeMpnRecords) {
      const mpnId = nextMpnId + i;
      const mpnSql = `
        INSERT INTO ai_writeback.chuboe_offer_line_mpn (
          chuboe_offer_line_mpn_id, ad_client_id, ad_org_id, isactive,
          created, createdby, updated, updatedby,
          chuboe_offer_line_id,
          chuboe_mpn, chuboe_mpn_clean,
          description
        ) VALUES (
          ${mpnId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, '${IDEMPIERE_DEFAULTS.isactive}',
          CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
          ${lineId},
          ${sqlStr(mpnRaw)}, ${sqlStr(mpnCleanVal)},
          ${sqlStr(line.description)}
        )
      `;

      if (!psqlExec(mpnSql)) {
        errors.push(`Failed to insert offer_line_mpn ${i + 1} (${mpnRaw})`);
      } else {
        mpnsWritten++;
      }
    }
  }

  logger.info(`Offer write complete: offerId=${offerId}, ${linesWritten} lines${writeMpnRecords ? `, ${mpnsWritten} MPNs` : ''}${errors.length ? `, ${errors.length} errors` : ''}`);

  return { offerId, linesWritten, mpnsWritten, errors };
}

// ─── BATCH WRITER ────────────────────────────────────────────────────────────

/**
 * Write multiple offers in a single call. Each entry in the array creates a
 * separate offer header with its own lines.
 *
 * @param {Array<object>} offers - Array of opts objects (same shape as writeOffer)
 * @returns {Array<object>} Array of results from writeOffer
 */
async function writeOffers(offers) {
  const results = [];
  for (const offerOpts of offers) {
    try {
      const result = await writeOffer(offerOpts);
      results.push(result);
    } catch (e) {
      results.push({ offerId: null, linesWritten: 0, mpnsWritten: 0, errors: [e.message] });
    }
  }
  const totalLines = results.reduce((sum, r) => sum + r.linesWritten, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  logger.info(`Batch write complete: ${results.length} offers, ${totalLines} total lines${totalErrors ? `, ${totalErrors} total errors` : ''}`);
  return results;
}

// ─── DEACTIVATION (for inventory refresh) ────────────────────────────────────

/**
 * Deactivate all existing offer lines for a given partner + offer type.
 * Used before writing a fresh inventory snapshot so stale lines don't persist.
 *
 * NOTE: This updates ai_writeback records only. Production records written
 * via CSV import live in adempiere and are NOT touched here.
 *
 * @param {number} bpartnerId - c_bpartner_id
 * @param {number} offerTypeId - chuboe_offer_type_id
 * @returns {object} { offersDeactivated, linesDeactivated }
 */
function deactivatePriorOffers(bpartnerId, offerTypeId) {
  // Deactivate lines belonging to matching offers
  const linesSql = `
    UPDATE ai_writeback.chuboe_offer_line ol
    SET isactive = 'N', updated = CURRENT_TIMESTAMP, updatedby = ${IDEMPIERE_DEFAULTS.updatedby}
    WHERE ol.chuboe_offer_id IN (
      SELECT chuboe_offer_id FROM ai_writeback.chuboe_offer
      WHERE c_bpartner_id = ${bpartnerId}
        AND chuboe_offer_type_id = ${offerTypeId}
        AND isactive = 'Y'
    ) AND ol.isactive = 'Y'
  `;

  // Deactivate the offer headers
  const headerSql = `
    UPDATE ai_writeback.chuboe_offer
    SET isactive = 'N', updated = CURRENT_TIMESTAMP, updatedby = ${IDEMPIERE_DEFAULTS.updatedby}
    WHERE c_bpartner_id = ${bpartnerId}
      AND chuboe_offer_type_id = ${offerTypeId}
      AND isactive = 'Y'
  `;

  // Count before deactivation
  const countResult = psqlQuery(`SELECT COUNT(*) FROM ai_writeback.chuboe_offer WHERE c_bpartner_id = ${bpartnerId} AND chuboe_offer_type_id = ${offerTypeId} AND isactive = 'Y'`);
  const priorCount = parseInt(countResult, 10) || 0;

  if (priorCount === 0) {
    logger.info(`No prior offers to deactivate for BP=${bpartnerId}, type=${offerTypeId}`);
    return { offersDeactivated: 0, linesDeactivated: 0 };
  }

  const lineCountResult = psqlQuery(`SELECT COUNT(*) FROM ai_writeback.chuboe_offer_line ol WHERE ol.chuboe_offer_id IN (SELECT chuboe_offer_id FROM ai_writeback.chuboe_offer WHERE c_bpartner_id = ${bpartnerId} AND chuboe_offer_type_id = ${offerTypeId} AND isactive = 'Y') AND ol.isactive = 'Y'`);
  const priorLineCount = parseInt(lineCountResult, 10) || 0;

  psqlExec(linesSql);
  psqlExec(headerSql);

  logger.info(`Deactivated ${priorCount} offers, ${priorLineCount} lines for BP=${bpartnerId}, type=${offerTypeId}`);
  return { offersDeactivated: priorCount, linesDeactivated: priorLineCount };
}

// ─── UTILITY: MFR ID LOOKUP ─────────────────────────────────────────────────

/**
 * Resolve a manufacturer name to its chuboe_mfr_id.
 * Reuses the same logic as rfq-writer for consistency.
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
  writeOffer,
  writeOffers,
  deactivatePriorOffers,
  lookupMfrId,
  cleanMpn,
  OFFER_TYPES,
};
