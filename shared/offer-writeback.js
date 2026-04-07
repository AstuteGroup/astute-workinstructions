/**
 * Shared Offer Writer — writes market offers via iDempiere REST API
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
 *   IDs are assigned server-side by iDempiere via the REST API.
 *   Parent IDs are extracted from POST responses and passed to child records.
 */

const logger = require('./logger').createLogger('OfferWriter');
const { apiPost, apiGet, apiPut } = require('./api-client');
const { psqlQuery, cleanMpn } = require('./db-helpers');
const { lookupMfr } = require('./mfr-lookup');

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

// ─── MAIN WRITER ─────────────────────────────────────────────────────────────

/**
 * Write a complete offer (header + lines + optional line MPNs) via iDempiere REST API.
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
 * @returns {object} { offerId, searchKey, linesWritten, mpnsWritten, errors }
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

  const errors = [];
  let linesWritten = 0;
  let mpnsWritten = 0;

  // ── Insert Offer Header via API ──
  // Column names MUST be exact PascalCase from ad_column.columnname
  // Omit button fields — API rejects string 'N' on button columns
  const headerPayload = {
    C_BPartner_ID: bpartnerId,
    Chuboe_Offer_Type_ID: offerTypeId,
  };
  if (description) headerPayload.Description = description;
  if (userId) headerPayload.Chuboe_User_ID = userId;
  if (buyerId) headerPayload.Chuboe_Buyer_ID = buyerId;

  let offerId;
  let searchKey = null;
  try {
    const headerResponse = await apiPost('chuboe_offer', headerPayload);
    offerId = headerResponse.id;
    searchKey = headerResponse.Value || headerResponse.value || null;
    if (!offerId) throw new Error('No ID returned in response');
  } catch (e) {
    return { offerId: null, searchKey: null, linesWritten: 0, mpnsWritten: 0, errors: [`Failed to insert offer header: ${e.message}`] };
  }
  logger.info(`Offer header created: searchKey=${searchKey}, chuboe_offer_id=${offerId}, BP=${bpartnerId}, type=${offerTypeId}`);

  // ── Insert Lines ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = (i + 1) * 10; // Line 10, 20, 30...

    const mpnRaw = line.mpn || '';
    const mpnCleanVal = line.mpnClean || cleanMpn(mpnRaw);

    const linePayload = {
      Chuboe_Offer_ID: offerId,
      Line: lineNum,
      Chuboe_MPN: mpnRaw,
      Chuboe_MPN_Clean: mpnCleanVal,
    };
    // MFR resolution: resolve to canonical name, only set MFR ID if non-system.
    // System-level MFR records (AD_Client_ID=0) cause 500 errors via API:
    // "System ID XXXX cannot be used in Chuboe_MFR_ID"
    if (line.mfrText) {
      const mfrResult = lookupMfr(line.mfrText);
      linePayload.Chuboe_MFR_Text = mfrResult.canonical;
      if (mfrResult.id && !mfrResult.isSystem) {
        linePayload.Chuboe_MFR_ID = mfrResult.id;
      }
    }
    if (line.qty != null) linePayload.Qty = line.qty;
    if (line.price != null) linePayload.PriceEntered = line.price;
    if (line.dateCode) linePayload.Chuboe_Date_Code = line.dateCode;
    if (line.leadTime) linePayload.Chuboe_Lead_Time = line.leadTime;
    if (line.packageDesc) linePayload.Chuboe_Package_Desc = line.packageDesc;
    if (line.countryId) linePayload.C_Country_ID = line.countryId;
    if (line.currencyId) linePayload.C_Currency_ID = line.currencyId;
    if (line.description) linePayload.Description = line.description;
    if (line.moq) linePayload.Chuboe_MOQ = line.moq;
    if (line.spq) linePayload.Chuboe_SPQ = line.spq;
    if (line.cpc) linePayload.Chuboe_CPC = line.cpc;
    if (line.cpcClean) {
      linePayload.Chuboe_CPC_Clean = line.cpcClean;
    } else if (line.cpc) {
      linePayload.Chuboe_CPC_Clean = cleanMpn(line.cpc);
    }
    if (line.recommendedResale != null) linePayload.APL_Offer_RecommendedResale = line.recommendedResale;

    let lineId;
    try {
      const lineResponse = await apiPost('chuboe_offer_line', linePayload);
      lineId = lineResponse.id;
      if (!lineId) throw new Error('No ID returned in response');
    } catch (e) {
      errors.push(`Failed to insert line ${i + 1} (${mpnRaw}): ${e.message}`);
      continue;
    }
    linesWritten++;

    // ── Optional: Insert chuboe_offer_line_mpn via API ──
    if (writeMpnRecords) {
      try {
        const mpnPayload = {
          chuboe_offer_line_id: lineId,
          chuboe_mpn: mpnRaw,
          chuboe_mpn_clean: mpnCleanVal,
        };
        if (line.description) mpnPayload.Description = line.description;

        await apiPost('chuboe_offer_line_mpn', mpnPayload);
        mpnsWritten++;
      } catch (e) {
        errors.push(`Failed to insert offer_line_mpn ${i + 1} (${mpnRaw}): ${e.message}`);
      }
    }
  }

  logger.info(`Offer write complete: searchKey=${searchKey}, offerId=${offerId}, ${linesWritten} lines${writeMpnRecords ? `, ${mpnsWritten} MPNs` : ''}${errors.length ? `, ${errors.length} errors` : ''}`);

  return { offerId, searchKey, linesWritten, mpnsWritten, errors };
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
 * Uses the REST API to query and deactivate records via GET + PUT.
 *
 * @param {number} bpartnerId - c_bpartner_id
 * @param {number} offerTypeId - chuboe_offer_type_id
 * @returns {Promise<object>} { offersDeactivated, linesDeactivated }
 */
async function deactivatePriorOffers(bpartnerId, offerTypeId) {
  // Query active offers for this BP + type via API
  let offers;
  try {
    const result = await apiGet('chuboe_offer', {
      filter: `C_BPartner_ID eq ${bpartnerId} and chuboe_offer_type_id eq ${offerTypeId} and IsActive eq true`,
      select: 'chuboe_offer_id',
    });
    offers = result.records || [];
  } catch (e) {
    logger.error(`Failed to query prior offers for BP=${bpartnerId}, type=${offerTypeId}: ${e.message}`);
    return { offersDeactivated: 0, linesDeactivated: 0 };
  }

  if (offers.length === 0) {
    logger.info(`No prior offers to deactivate for BP=${bpartnerId}, type=${offerTypeId}`);
    return { offersDeactivated: 0, linesDeactivated: 0 };
  }

  let linesDeactivated = 0;

  // Deactivate lines for each offer, then deactivate the offer header
  for (const offer of offers) {
    const offerId = offer.chuboe_offer_id || offer.id;

    // Get active lines for this offer
    try {
      const lineResult = await apiGet('chuboe_offer_line', {
        filter: `chuboe_offer_id eq ${offerId} and IsActive eq true`,
        select: 'chuboe_offer_line_id',
      });
      const lines = lineResult.records || [];

      for (const line of lines) {
        const lineId = line.chuboe_offer_line_id || line.id;
        try {
          await apiPut('chuboe_offer_line', lineId, { IsActive: false });
          linesDeactivated++;
        } catch (e) {
          logger.warn(`Failed to deactivate offer line ${lineId}: ${e.message}`);
        }
      }
    } catch (e) {
      logger.warn(`Failed to query lines for offer ${offerId}: ${e.message}`);
    }

    // Deactivate the offer header
    try {
      await apiPut('chuboe_offer', offerId, { IsActive: false });
    } catch (e) {
      logger.warn(`Failed to deactivate offer ${offerId}: ${e.message}`);
    }
  }

  logger.info(`Deactivated ${offers.length} offers, ${linesDeactivated} lines for BP=${bpartnerId}, type=${offerTypeId}`);
  return { offersDeactivated: offers.length, linesDeactivated };
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
