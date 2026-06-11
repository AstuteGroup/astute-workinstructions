/**
 * Shared Offer Writer — writes market offers via iDempiere REST API
 *
 * Handles all offer types (Customer Excess, Broker Stock, Inventory Stock, etc.).
 * Creates records across three tables:
 *   - chuboe_offer (header)
 *   - chuboe_offer_line (line items)
 *   - chuboe_offer_line_mpn (MPN cross-references, optional)
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ ⚠️  CRITICAL — chuboe_offer_line CPC bean-callout collapse                ║
 * ║                                                                          ║
 * ║ iDempiere has a server-side bean callout that deduplicates                ║
 * ║ chuboe_offer_line records by (chuboe_offer_id, chuboe_cpc) — strict       ║
 * ║ equality, IGNORING chuboe_mpn. When two lines POST'd to the same offer    ║
 * ║ share a non-empty CPC, the callout fires AFTER the API returns 200 OK:    ║
 * ║                                                                          ║
 * ║   1. The earlier line's chuboe_mpn is COMMA-MERGED in place with the      ║
 * ║      new line's MPN ("MPN_A,MPN_B") — corrupts the survivor's join key.  ║
 * ║   2. The new line is set isactive=N with description overwritten to       ║
 * ║      "deactived - duplicate CPC - See Line #<survivor>".                  ║
 * ║   3. Loaders see no error — POST returns success and a new ID.            ║
 * ║                                                                          ║
 * ║ Verified empirically 2026-04-08 with totally distinct MPNs                ║
 * ║ ("5962-1620804QZC" vs "TESTAVL-COLLAPSE-CHECK") sharing one CPC.          ║
 * ║                                                                          ║
 * ║ MITIGATION — per-CPC anchor pattern:                                      ║
 * ║   - For each unique CPC value in your batch, ONE line carries the CPC.    ║
 * ║   - All other lines for that CPC must POST with chuboe_cpc = '' / NULL.   ║
 * ║   - Capture the CPC linkage via chuboe_offer_line_mpn sub-rows OR by      ║
 * ║     prepending "CPC=<value>" to the description (text-searchable).        ║
 * ║                                                                          ║
 * ║ For AVL/multi-MPN-per-CPC patterns: prefer writing alternates as          ║
 * ║ chuboe_offer_line_mpn sub-rows under one parent chuboe_offer_line. The    ║
 * ║ sub-table is NOT subject to the bean callout.                             ║
 * ║                                                                          ║
 * ║ See:  shared/data-model.md § chuboe_offer_line CPC dedup                  ║
 * ║       memory: feedback_avl_multi_mpn_loading.md                           ║
 * ║       memory: project_chuboe_offer_line_cpc_collapse.md                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ALSO: Chuboe_CPC is non-updateable on existing rows (PATCH returns 500
 * "Cannot update column Chuboe_CPC"). CPC must be set at POST time only.
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
 *   - Market Offer Loading (customer excess, broker stock)
 *   - Inventory File Cleanup (own stock by warehouse)
 *   - (Future) VQ Loading, automated offer capture
 *
 * ID MANAGEMENT:
 *   IDs are assigned server-side by iDempiere via the REST API.
 *   Parent IDs are extracted from POST responses and passed to child records.
 */

const logger = require('./logger').createLogger('OfferWriter');
const { apiPost, apiGet, apiPut } = require('./api-client');
const { isOtUnreachableError } = require('./ot-error');
const { psqlQuery, cleanMpn } = require('./db-helpers');
const { lookupMfr } = require('./mfr-lookup');
const { resolveMfrForRow } = require('./mfr-resolver');
const otBudget = require('./ot-api-budget');

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

// ─── Consignment-BP guard ────────────────────────────────────────────────────
//
// Consignment offers represent customer-owned stock Astute holds physically.
// Two business rules apply *unconditionally* regardless of which pipeline is
// writing:
//
//   1. NO PRICING. Consignment lines must never carry priceentered — pricing
//      is negotiated per-PO at the time the customer wants to consume.
//   2. Type is "Stock - <warehouse>", not "Customer Excess". Wrong-pipeline
//      ingestion (e.g. someone forwards consignment data to excess@orange
//      tsunami.com so the offer-poller writes type=1000000) gets coerced back
//      to the BP's paired stock type.
//
// This guard runs inside `writeOffer` so every caller — Inventory File Cleanup
// (weekly + carryover refresh), the customer-excess offer-poller, any future
// pipeline — is protected. Without it, the weekly flow's group-name-based
// blanking only covers the weekly path, and other pipelines silently write
// priced/wrong-typed consignment offers (verified live as of 2026-05-12 on
// offers 1026111 carryover and 1026118 excessPoller for LAM Consignment).
const CONSIGNMENT_BP_STOCK_TYPE = {
  1003236: 1000008, // Astute - GE Aviation Excess    → Stock - Austin
  1003621: 1000008, // Astute - Taxan Excess          → Stock - Austin
  1005225: 1000008, // Astute - Spartronics Excess    → Stock - Austin
  1010966: 1000014, // Astute Inc - Eaton Consignment → Stock - Philippines
  1011267: 1000014, // Astute - LAM Consignment       → Stock - Philippines
};
const CONSIGNMENT_BPARTNER_IDS = new Set(Object.keys(CONSIGNMENT_BP_STOCK_TYPE).map(Number));
const CUSTOMER_EXCESS_TYPE_ID = 1000000;

/**
 * Apply the consignment-BP guard. Pure function — returns a new opts object
 * with corrected price=null + corrected offerTypeId when applicable. Logs a
 * warning when a coercion fires so the operator sees that a wrong-pipeline
 * submission was caught. No-op for non-consignment BPs.
 *
 * @param {object} opts - the writeOffer opts argument
 * @returns {object} possibly-modified opts (caller should use the return value)
 */
function applyConsignmentGuard(opts) {
  const bpId = Number(opts.bpartnerId);
  if (!CONSIGNMENT_BPARTNER_IDS.has(bpId)) return opts;

  const corrections = [];
  const nextOpts = { ...opts };

  // Resolve string offerTypeId via OFFER_TYPES so we can compare numerics.
  let currentTypeId;
  if (typeof opts.offerTypeId === 'string' && isNaN(Number(opts.offerTypeId))) {
    currentTypeId = OFFER_TYPES[opts.offerTypeId];
  } else {
    currentTypeId = Number(opts.offerTypeId);
  }
  if (currentTypeId === CUSTOMER_EXCESS_TYPE_ID) {
    const pairedType = CONSIGNMENT_BP_STOCK_TYPE[bpId];
    corrections.push(`offerTypeId ${CUSTOMER_EXCESS_TYPE_ID} (Customer Excess) → ${pairedType} (paired stock type for BP ${bpId})`);
    nextOpts.offerTypeId = pairedType;
  }

  // Always null prices on consignment BPs.
  let priceLinesBlanked = 0;
  if (Array.isArray(opts.lines)) {
    nextOpts.lines = opts.lines.map(l => {
      if (l == null) return l;
      if (l.price != null) {
        priceLinesBlanked++;
        return { ...l, price: null };
      }
      return l;
    });
  }
  if (priceLinesBlanked > 0) {
    corrections.push(`PriceEntered blanked on ${priceLinesBlanked}/${opts.lines.length} lines`);
  }

  if (corrections.length > 0) {
    logger.warn(`Consignment-BP guard fired for BP ${bpId}: ${corrections.join('; ')}`);
  }
  return nextOpts;
}

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
 * @param {boolean} [opts.isBackfill=false] - Backfill mode (coordinates with global budget)
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
  // Consignment-BP guard runs before destructuring so every downstream code
  // path (validation, type resolution, line POSTs) sees the corrected opts.
  opts = applyConsignmentGuard(opts);

  const {
    bpartnerId,
    offerTypeId: rawOfferType,
    description = null,
    datetrx = null,
    userId = null,
    buyerId = null,
    writeMpnRecords = false,
    isBackfill = false,
    lines = [],
  } = opts;

  // ── Validation ──
  if (!bpartnerId) throw new Error('offer-writeback: bpartnerId is required');
  if (!rawOfferType) throw new Error('offer-writeback: offerTypeId is required');
  if (!lines || lines.length === 0) throw new Error('offer-writeback: at least one line is required');

  // Note: Suspended (vtype 1000004) / Prohibited (vtype 1000005) BPs are NOT
  // gated here. Loading is data capture; the approval flow downstream is the
  // gate for buying from a restricted vendor. See shared/agent-philosophy.md
  // § "Loading is data capture" and shared/disqualified-vendor-types.js (the
  // module is still in place as a label provider for anyone who wants to
  // display vendor status downstream — it just doesn't decide skips).

  // Resolve type: accept either numeric ID or string name
  let offerTypeId;
  if (typeof rawOfferType === 'string' && isNaN(Number(rawOfferType))) {
    offerTypeId = OFFER_TYPES[rawOfferType];
    if (!offerTypeId) throw new Error(`offer-writeback: unknown offer type '${rawOfferType}'. Valid: ${Object.keys(OFFER_TYPES).join(', ')}`);
  } else {
    offerTypeId = Number(rawOfferType);
  }

  // ── TIER 1: Global budget check ──
  // Estimated writes: lines + optional MPN records
  const estimatedWrites = lines.length + (writeMpnRecords ? lines.length : 0);
  const caller = 'offer-writeback'; // Will be 'excess-agent' or 'inventory-cleanup' in practice

  // ── CHUNKED MODE for large offers ──
  // Offers with many lines would fail the budget check outright. Instead of
  // rejecting, we write in chunks with delays to stay under rate limits.
  // This allows legitimate large customer excess lists (1000+ lines) to load.
  const LARGE_OFFER_THRESHOLD = 500;  // lines
  const CHUNK_SIZE = 150;             // lines per chunk (300 writes with MPN)
  const CHUNK_DELAY_MS = 2000;        // 2s between chunks
  const useChunkedMode = lines.length > LARGE_OFFER_THRESHOLD;

  if (!useChunkedMode) {
    // Standard budget check for small/medium offers
    const globalCheck = otBudget.checkBudget({
      table: 'chuboe_offer_line',
      count: estimatedWrites,
      caller,
      isBackfill,
    });

    if (!globalCheck.allowed) {
      logger.warn(`Global budget exhausted: ${globalCheck.reason}`);
      return {
        offerId: null,
        searchKey: null,
        linesWritten: 0,
        mpnsWritten: 0,
        errors: [],
        rateLimited: true,
        rateLimitReason: globalCheck.reason,
        rateLimitTier: 'global',
        otUnreachable: false,
      };
    }
  } else {
    // Chunked mode: still check daily limit (skip burst checks - we self-pace)
    // Prevents perfect storm of normal loads + huge file exceeding daily cap
    const status = otBudget.getStatus();
    const dailyUsed = parseInt(status.globalBudget.lastDay.split('/')[0], 10) || 0;
    const dailyLimit = otBudget.LIMITS.maxWritesPerDay;
    if (dailyUsed + estimatedWrites > dailyLimit) {
      logger.warn(`Daily budget would be exceeded: ${dailyUsed}/${dailyLimit} + ${estimatedWrites} estimated`);
      return {
        offerId: null,
        searchKey: null,
        linesWritten: 0,
        mpnsWritten: 0,
        errors: [],
        rateLimited: true,
        rateLimitReason: `Daily limit: ${dailyUsed}/${dailyLimit} used, need ${estimatedWrites} more`,
        rateLimitTier: 'daily',
        otUnreachable: false,
      };
    }
    logger.info(`Large offer detected (${lines.length} lines) — using chunked mode with ${CHUNK_SIZE}-line chunks and ${CHUNK_DELAY_MS}ms delays`);
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
  let otUnreachable = false;   // set when any write hit a network/transport failure (OT down) — retryable
  try {
    const headerResponse = await apiPost('chuboe_offer', headerPayload);
    offerId = headerResponse.id;
    searchKey = headerResponse.Value || headerResponse.value || null;
    if (!offerId) throw new Error('No ID returned in response');
  } catch (e) {
    const net = isOtUnreachableError(e);
    return { offerId: null, searchKey: null, linesWritten: 0, mpnsWritten: 0, errors: [`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert offer header: ${e.message}`], otUnreachable: net };
  }
  logger.info(`Offer header created: searchKey=${searchKey}, chuboe_offer_id=${offerId}, BP=${bpartnerId}, type=${offerTypeId}`);

  // ── Reserve budget and claim backfill slot ──
  // Skip reservation for chunked mode — we self-pace with delays between chunks
  if (!useChunkedMode) {
    otBudget.reserve('chuboe_offer_line', estimatedWrites, caller);
  }

  if (isBackfill) {
    otBudget.claimBackfillSlot(caller);
  }

  const writeStartTime = Date.now();

  // Helper for chunked delay
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ── Insert Lines ──
  for (let i = 0; i < lines.length; i++) {
    // Chunked mode: pause between chunks to stay under rate limits
    if (useChunkedMode && i > 0 && i % CHUNK_SIZE === 0) {
      const chunkNum = Math.floor(i / CHUNK_SIZE);
      const totalChunks = Math.ceil(lines.length / CHUNK_SIZE);
      logger.info(`Chunk ${chunkNum}/${totalChunks} complete (${linesWritten} lines written). Pausing ${CHUNK_DELAY_MS}ms...`);
      await sleep(CHUNK_DELAY_MS);
    }

    const line = lines[i];
    const lineNum = (i + 1) * 10; // Line 10, 20, 30...

    // Coerce MPN to string — xlsx parsing often returns numbers for numeric-looking part numbers
    const mpnRaw = String(line.mpn || '');
    const mpnCleanVal = line.mpnClean || cleanMpn(mpnRaw);

    const linePayload = {
      Chuboe_Offer_ID: offerId,
      Line: lineNum,
      Chuboe_MPN: mpnRaw,
      Chuboe_MPN_Clean: mpnCleanVal,
    };
    // MFR resolution via the unified resolver: text path (Policy D #1) when
    // line.mfrText is provided; MPN-prefix inference + acquisition map
    // (Policy D #3) as fallback when text is empty. Only set Chuboe_MFR_ID
    // when the resolved record is non-system (system-level MFRs with
    // AD_Client_ID=0 cause 500 errors via API: "System ID XXXX cannot be
    // used in Chuboe_MFR_ID").
    if (line.mfrText || mpnRaw) {
      const mfrResult = resolveMfrForRow({ mfrText: line.mfrText, mpn: mpnRaw });
      if (mfrResult.canonical) {
        linePayload.Chuboe_MFR_Text = mfrResult.canonical;
      }
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
      // Natural key uses (Offer_ID, MPN) since every offer line has an MPN
      // and not all have CPC. Note: this does NOT protect against the
      // server-side CPC bean-callout collapse (separate concern documented
      // in shared/data-model.md and project_chuboe_offer_line_cpc_collapse.md).
      const lineResponse = await apiPost('chuboe_offer_line', linePayload, {
        naturalKeyFields: ['Chuboe_Offer_ID', 'Chuboe_MPN'],
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

    // ── Optional: Insert chuboe_offer_line_mpn via API ──
    if (writeMpnRecords) {
      try {
        const mpnPayload = {
          Chuboe_Offer_Line_ID: lineId,
          Chuboe_MPN: mpnRaw,
          Chuboe_MPN_Clean: mpnCleanVal,
        };
        if (line.description) mpnPayload.Description = line.description;

        await apiPost('chuboe_offer_line_mpn', mpnPayload, {
          naturalKeyFields: ['Chuboe_Offer_Line_ID', 'Chuboe_MPN_Clean'],
        });
        mpnsWritten++;
      } catch (e) {
        const net = isOtUnreachableError(e);
        if (net) otUnreachable = true;
        errors.push(`${net ? '[OT_UNREACHABLE] ' : ''}Failed to insert offer_line_mpn ${i + 1} (${mpnRaw}): ${e.message}`);
      }
    }
  }

  // ── Record writes and release backfill slot ──
  const writeDuration = Date.now() - writeStartTime;
  const totalWritten = linesWritten + mpnsWritten;
  if (totalWritten > 0) {
    otBudget.recordWrites('chuboe_offer_line', totalWritten, {
      caller,
      success: true,
      durationMs: writeDuration,
    });
  }

  if (errors.length > 0) {
    for (let i = 0; i < errors.length; i++) {
      otBudget.recordFailure();
    }
  }

  if (isBackfill) {
    otBudget.releaseBackfillSlot(caller);
  }

  const chunkedNote = useChunkedMode ? ` [chunked: ${Math.ceil(lines.length / CHUNK_SIZE)} chunks]` : '';
  logger.info(`Offer write complete: searchKey=${searchKey}, offerId=${offerId}, ${linesWritten} lines${writeMpnRecords ? `, ${mpnsWritten} MPNs` : ''}${errors.length ? `, ${errors.length} errors` : ''}${chunkedNote}`);

  return { offerId, searchKey, linesWritten, mpnsWritten, errors, otUnreachable, chunkedMode: useChunkedMode };
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
 * Deactivate prior offers for a given partner + offer type. Used before
 * writing a fresh inventory snapshot so the previous run's records don't
 * coexist with the new ones.
 *
 * SCOPING — read this before using:
 *   By default this deactivates EVERY active offer matching (BP, OfferType).
 *   That is almost never what you want when multiple loaders share a BP+type
 *   pair (e.g. Inventory File Cleanup writes both Free_Stock_Austin and
 *   LAM_Dead_Inventory under BP 1000332 + OfferType 1000008, distinguished
 *   only by description). To scope the deactivate to a specific
 *   description pattern, pass `descriptionEndsWith` — only offers whose
 *   Description ends with the given string will be deactivated. The
 *   sentinel pattern this loader uses is `'— GroupName'`.
 *
 * @param {number} bpartnerId - c_bpartner_id
 * @param {number} offerTypeId - chuboe_offer_type_id
 * @param {object} [opts]
 * @param {string} [opts.descriptionEndsWith] - if provided, only deactivate
 *   offers whose Description ends with this string. Recommended for any
 *   loader that shares (BP, OfferType) with another loader.
 * @returns {Promise<object>} { offersDeactivated, linesDeactivated, deactivatedOffers: [{id, value, description}] }
 */
async function deactivatePriorOffers(bpartnerId, offerTypeId, opts = {}) {
  const { descriptionEndsWith = null } = opts;
  // Query active offers for this BP + type via API
  let offers;
  try {
    let filter = `C_BPartner_ID eq ${bpartnerId} and chuboe_offer_type_id eq ${offerTypeId} and IsActive eq true`;
    if (descriptionEndsWith) {
      const escaped = descriptionEndsWith.replace(/'/g, "''");
      filter += ` and endswith(Description,'${escaped}')`;
    }
    const result = await apiGet('chuboe_offer', {
      filter,
      select: 'Value,Description',
    });
    offers = result.records || [];
  } catch (e) {
    logger.error(`Failed to query prior offers for BP=${bpartnerId}, type=${offerTypeId}: ${e.message}`);
    return { offersDeactivated: 0, linesDeactivated: 0, deactivatedOffers: [] };
  }

  if (offers.length === 0) {
    logger.info(`No prior offers to deactivate for BP=${bpartnerId}, type=${offerTypeId}${descriptionEndsWith ? ` (description endswith '${descriptionEndsWith}')` : ''}`);
    return { offersDeactivated: 0, linesDeactivated: 0, deactivatedOffers: [] };
  }

  let linesDeactivated = 0;
  const deactivatedOffers = [];

  // Deactivate lines for each offer, then deactivate the offer header.
  //
  // PAGINATION: iDempiere REST caps GET responses at 100 records server-side
  // regardless of the `top` parameter. We must loop, fetching the current
  // active-line batch and deactivating it, until the query returns empty.
  // Without this loop, large offers (e.g. inventory weekly runs with 1000+
  // lines per group) leave orphaned active lines under deactivated headers.
  // Verified empirically 2026-04-09 against the 07/21 historical strays —
  // a single naive query returned only the first 100 lines of a 1521-line
  // GE Consignment offer.
  for (const offer of offers) {
    const offerId = offer.id;
    const offerValue = offer.Value || offer.value || null;
    const offerDesc = offer.Description || offer.description || null;

    // Get active lines for this offer in paginated batches and deactivate
    // them as we go. Loop until the active-line query returns empty (which
    // it will after the previous batch's PUTs land).
    try {
      let pageNum = 0;
      while (true) {
        const lineResult = await apiGet('chuboe_offer_line', {
          filter: `chuboe_offer_id eq ${offerId} and IsActive eq true`,
          select: 'Line',
        });
        const lines = lineResult.records || [];
        if (lines.length === 0) break;
        pageNum++;
        for (const line of lines) {
          const lineId = line.id;
          try {
            await apiPut('chuboe_offer_line', lineId, { IsActive: false });
            linesDeactivated++;
          } catch (e) {
            logger.warn(`Failed to deactivate offer line ${lineId}: ${e.message}`);
          }
        }
        // Defensive cap — if iDempiere ever returns an unbounded set we
        // don't want to loop forever. 100 pages × 100/page = 10,000 lines
        // per offer is well above any realistic inventory snapshot.
        if (pageNum > 100) {
          logger.error(`deactivatePriorOffers: hit page cap (100) on offer ${offerId} — investigate`);
          break;
        }
      }
    } catch (e) {
      logger.warn(`Failed to query lines for offer ${offerId}: ${e.message}`);
    }

    // Deactivate the offer header
    try {
      await apiPut('chuboe_offer', offerId, { IsActive: false });
      deactivatedOffers.push({ id: offerId, value: offerValue, description: offerDesc });
    } catch (e) {
      logger.warn(`Failed to deactivate offer ${offerId}: ${e.message}`);
    }
  }

  logger.info(`Deactivated ${deactivatedOffers.length} offers, ${linesDeactivated} lines for BP=${bpartnerId}, type=${offerTypeId}${descriptionEndsWith ? ` (description endswith '${descriptionEndsWith}')` : ''}`);
  return { offersDeactivated: deactivatedOffers.length, linesDeactivated, deactivatedOffers };
}

// ─── DEACTIVATION BY ID ─────────────────────────────────────────────────────

/**
 * Deactivate a single offer by ID — header + all active lines, paginated.
 *
 * Use this when you already know the offer's PK (e.g. for static-carryover
 * refresh: read header + lines, deactivate by ID, write a new copy). This
 * is a sibling to `deactivatePriorOffers` which scopes by (BP, OfferType, …).
 *
 * Lines are deactivated in paginated batches because the iDempiere REST API
 * caps GETs at 100 records server-side regardless of `top`. See the comment
 * on `deactivatePriorOffers` for the empirical evidence.
 *
 * @param {number} offerId - chuboe_offer_id (PK)
 * @returns {Promise<{success: boolean, linesDeactivated: number, error?: string}>}
 */
async function deactivateOfferById(offerId) {
  let linesDeactivated = 0;
  let pageNum = 0;
  try {
    while (true) {
      const lineResult = await apiGet('chuboe_offer_line', {
        filter: `chuboe_offer_id eq ${offerId} and IsActive eq true`,
        select: 'Line',
      });
      const lines = lineResult.records || [];
      if (lines.length === 0) break;
      pageNum++;
      for (const line of lines) {
        try {
          await apiPut('chuboe_offer_line', line.id, { IsActive: false });
          linesDeactivated++;
        } catch (e) {
          logger.warn(`deactivateOfferById: failed to deactivate line ${line.id} on offer ${offerId}: ${e.message}`);
        }
      }
      if (pageNum > 100) {
        logger.error(`deactivateOfferById: hit page cap (100) on offer ${offerId} — investigate`);
        break;
      }
    }
  } catch (e) {
    logger.error(`deactivateOfferById: failed to query lines for offer ${offerId}: ${e.message}`);
    return { success: false, linesDeactivated, error: e.message };
  }

  try {
    await apiPut('chuboe_offer', offerId, { IsActive: false });
  } catch (e) {
    logger.error(`deactivateOfferById: failed to deactivate offer header ${offerId}: ${e.message}`);
    return { success: false, linesDeactivated, error: e.message };
  }

  logger.info(`deactivateOfferById: deactivated offer ${offerId} + ${linesDeactivated} lines`);
  return { success: true, linesDeactivated };
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
  applyConsignmentGuard,
  CONSIGNMENT_BP_STOCK_TYPE,
  CONSIGNMENT_BPARTNER_IDS,
  deactivatePriorOffers,
  deactivateOfferById,
  lookupMfrId,
  cleanMpn,
  OFFER_TYPES,
};
