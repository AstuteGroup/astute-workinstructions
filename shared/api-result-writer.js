/**
 * API Result Writer — captures franchise API pricing data for market intelligence
 *
 * Stores full API responses (all price breaks, stock, lead time, MOQ) from
 * franchise distributor searches. Two storage layers:
 *
 *   1. Local cache (CANONICAL): shared/data/api-pricing-cache/{MPN}_{date}.json
 *      The full envelope lives here. All read paths fall back to cache.
 *
 *   2. DB thin pointer: adempiere.chuboe_pricing_api_result via REST API
 *      A header row per pull with linkage (AD_Table_ID + Record_ID → source RFQ),
 *      MPN list, and timestamp. **No JSON body** — see writeDb() docstring for
 *      the iDempiere virtual-column constraint that forces this design today.
 *      Long-term plan: api-integration-roadmap.md § Pricing Envelope OT-Native
 *      Storage tracks the iDempiere config change to make the JSON column
 *      writable.
 *
 * WRITE PATH (called by franchise screening, suggested-resale, lam-kitting):
 *   const { writePricingResult } = require('../shared/api-result-writer');
 *   await writePricingResult({ searchResult, mpn, qty, rfqId, source: 'consumer-name' });
 *
 * READ PATH (called by Vortex, Quick Quote, future workflows):
 *   const { extractPriceAtQty } = require('../shared/api-result-writer');
 *   const rows = extractPriceAtQty('ADS1115IDGST', 700, { maxAgeDays: 90 });
 *   // Returns one row per distributor with price at the requested qty
 *
 * JSON SCHEMA (Option C — Flux envelope, our fields):
 *   Uses data.Status[] + data.Pricings[] matching the existing Flux BI tool format
 *   in adempiere.chuboe_pricing_api_result. Adds data._meta for our query context.
 *   No RawResponse field (keeps payloads lean).
 *   Astute extensions on Pricings[]: Description, VendorNotes, DateCode, HTSCode, ECCN
 *   (additive — Flux readers ignore unknown fields).
 *
 * CONSUMERS:
 *   - Writers: Franchise Screening, Suggested Resale, LAM Kitting (fire-and-forget)
 *   - Readers: Vortex Matches (90d), Quick Quote (30d), on-demand (7d)
 *   - Hurricane Search reads from DB natively (iDempiere, we don't control)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { apiPost, isApiAvailable } = require('./api-client');
const logger = require('./logger').createLogger('APIPricing');
const otBudget = require('./ot-api-budget');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(__dirname, 'data/api-pricing-cache');
const AD_TABLE_ID_RFQ = 1000002; // Chuboe_RFQ table
const DB_TABLE = 'Chuboe_Pricing_API_Result'; // REST API requires PascalCase from ad_table.tablename

// ─── JSON ENVELOPE BUILDER ──────────────────────────────────────────────────

/**
 * Build Flux-compatible JSON envelope from searchAllDistributors() result.
 *
 * @param {object} searchResult - Return value of searchAllDistributors()
 * @param {string} mpn - Searched MPN
 * @param {number} qty - Searched quantity
 * @param {string} source - Consumer name
 * @returns {object} Flux-compatible JSON object for json_info column
 */
function buildEnvelope(searchResult, mpn, qty, source) {
  const statusArray = searchResult.distributors.map(d => ({
    MPN: mpn,
    APIName: d.name || d.distributor,
    SourceOfPrice: `${d.name || d.distributor} API`,
    PricingResponseStatus: d.error ? 'Failed' : (d.found ? 'Success' : 'Empty'),
    FailedReason: d.error || null,
  }));

  // Build Pricings[] from distributor results.
  // Most distributors emit one row per result. Arrow splits into multiple
  // (Arrow franchise + Verical broker) via d.vqLines — when present, we emit
  // one Pricings entry per sub-line, each with the right SupplierName so the
  // cache reconstitution path resolves the row back to the correct BP.
  const pricingsArray = [];
  for (const d of searchResult.distributors) {
    if (!d.found) continue;

    if (Array.isArray(d.vqLines) && d.vqLines.length > 0) {
      for (const sub of d.vqLines) {
        // Map currencyId → ISO code so cache replay can restore currency.
        // 100=USD, 114=GBP (extend here as new currencies appear).
        const currencyCode = sub.currencyId === 114 ? 'GBP' : 'USD';
        // Fall back to single-tier break when the per-store sub didn't carry
        // priceBreaks but has a usable cost — otherwise cache replay sees
        // empty Pricings[] and emits no vqLine even though stock exists.
        const breaks = (sub.priceBreaks && sub.priceBreaks.length > 0)
          ? sub.priceBreaks
          : (sub.cost > 0 ? [{ qty: sub.qty || 1, unitPrice: sub.cost }] : []);
        pricingsArray.push({
          SupplierName: sub.vendorName || (sub.channel === 'Verical' ? 'Verical' : (d.name || d.distributor)),
          ManufacturerName: sub.manufacturer || d.vqManufacturer || '',
          ManufacturerPartNumber: sub.mpn || d.vqMpn || mpn,
          RequestedPartNumber: mpn,
          // Use sub.stock (actual distributor stock) when available; fall back to
          // sub.qty for backward compat. Fixes lead-time row bug where sub.qty is
          // the factory-order qty, not stock — see 2026-06-24 DigiKey LT diagnosis.
          CurrentStockQty: sub.stock ?? sub.qty ?? 0,
          MinimumBuy: sub.moq ? parseInt(sub.moq) || 1 : 1,
          Multiplier: sub.spq ? parseInt(sub.spq) || 1 : 1,
          LeadTime: sub.leadTime || null,
          Currency: currencyCode,
          RoHS: null,
          LifeCycleStatus: null,
          CountryOfOrigin: sub.shipsFrom || null,
          DataSheetUrl: null,
          ProductUrl: null,
          Packaging: null,
          Description: sub.description || d.vqDescription || null,
          VendorNotes: sub.vendorNotes || null,
          DateCode: sub.dateCode || null,
          HTSCode: null,
          ECCN: null,
          // Channel-aware extensions (new) — preserved across cache hits so
          // downstream consumers can distinguish Arrow franchise from Verical
          // broker even after reconstitution.
          SourceChannel: sub.channel || null,
          SourcePartId: sub.sourcePartId || null,
          Pricings: breaks.map(pb => ({
            QtyBreak: pb.qty,
            UnitPrice: pb.unitPrice,
          })),
        });
      }
    } else if (Array.isArray(d.allSkus) && d.allSkus.length > 0) {
      // ─── MULTI-SKU PATH (DigiKey, others) ───────────────────────────────────
      // When allSkus[] is present, emit one Pricings entry per SKU with full
      // price breaks. This captures all packaging variations (Cut Tape, T&R, etc.)
      // with their respective stock levels, SKU IDs, and pricing ladders.
      for (const sku of d.allSkus) {
        const breaks = (sku.priceBreaks && sku.priceBreaks.length > 0)
          ? sku.priceBreaks
          : (sku.unitPrice > 0 ? [{ qty: 1, unitPrice: sku.unitPrice }] : []);
        pricingsArray.push({
          SupplierName: d.name || d.distributor,
          ManufacturerName: sku.manufacturer || d.vqManufacturer || '',
          ManufacturerPartNumber: sku.mpn || d.vqMpn || mpn,
          RequestedPartNumber: mpn,
          CurrentStockQty: sku.stock || 0,
          MinimumBuy: sku.moq ? parseInt(sku.moq) || 1 : 1,
          Multiplier: sku.spq ? parseInt(sku.spq) || 1 : 1,
          LeadTime: sku.leadTime || null,
          Currency: 'USD',
          RoHS: sku.rohs || null,
          LifeCycleStatus: null,
          CountryOfOrigin: null,
          DataSheetUrl: null,
          ProductUrl: null,
          Packaging: sku.packageType || null,
          Description: sku.description || d.vqDescription || null,
          VendorNotes: `DigiKey stock: ${(sku.stock || 0).toLocaleString()} | DigiKey PN: ${sku.digiKeyPn || 'N/A'} | Pkg: ${sku.packageType || 'N/A'}`,
          DateCode: null,
          HTSCode: sku.hts || null,
          ECCN: sku.eccn || null,
          SourceChannel: d.name || d.distributor,
          SourcePartId: sku.digiKeyPn || null,  // DigiKey PN as SKU identifier
          Pricings: breaks.map(pb => ({
            QtyBreak: pb.qty,
            UnitPrice: pb.unitPrice,
          })),
        });
      }
    } else {
      pricingsArray.push({
        SupplierName: d.name || d.distributor,
        ManufacturerName: d.vqManufacturer || d.raw?.vqManufacturer || '',
        ManufacturerPartNumber: d.vqMpn || d.raw?.vqMpn || mpn,
        RequestedPartNumber: mpn,
        CurrentStockQty: d.franchiseQty || 0,
        MinimumBuy: d.raw?.vqMoq ? parseInt(d.raw.vqMoq) || 1 : d.raw?.moq || 1,
        Multiplier: d.raw?.vqSpq ? parseInt(d.raw.vqSpq) || 1 : 1,
        LeadTime: d.vqLeadTime || d.raw?.vqLeadTime || null,
        Currency: d.raw?.currency || 'USD',
        RoHS: d.raw?.vqRohs || null,
        LifeCycleStatus: d.raw?.vqLifeCycle || null,
        CountryOfOrigin: d.raw?.vqCoo || null,
        DataSheetUrl: d.raw?.vqDatasheetUrl || null,
        ProductUrl: d.raw?.vqProductUrl || d.raw?.productUrl || null,
        Packaging: d.raw?.vqPackaging || null,
        Description: d.vqDescription || d.raw?.vqDescription || null,
        VendorNotes: d.vqVendorNotes || d.raw?.vqVendorNotes || null,
        DateCode: d.vqDateCode || d.raw?.vqDateCode || null,
        HTSCode: d.raw?.vqHts || d.raw?.htsCode || null,
        ECCN: d.raw?.vqEccn || d.raw?.eccn || null,
        Pricings: (d.priceBreaks || d.raw?.priceBreaks || []).map(pb => ({
          QtyBreak: pb.qty,
          UnitPrice: pb.unitPrice,
        })),
      });
    }
  }

  return {
    data: {
      Status: statusArray,
      Pricings: pricingsArray,
      _meta: {
        version: '2.0',
        source: 'astute-franchise-api',
        consumer: source || 'unknown',
        searchedMPN: mpn,
        searchedQty: qty,
        timestamp: new Date().toISOString(),
        distributorsChecked: searchResult.summary?.distributorsChecked || searchResult.distributors.length,
        distributorsWithResults: searchResult.summary?.distributorsWithStock || pricingsArray.length,
      },
    },
  };
}

// ─── CACHE OPERATIONS ───────────────────────────────────────────────────────

/**
 * Clean MPN for use in filenames (alphanumeric + hyphens only).
 */
function cacheKey(mpn) {
  return mpn.replace(/[^A-Za-z0-9-]/g, '_').toUpperCase();
}

/**
 * Write envelope to local cache file.
 * File: {MPN}_{YYYY-MM-DD}.json — overwritten if same MPN searched again same day.
 */
function writeCache(mpn, envelope) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${cacheKey(mpn)}_${date}.json`;
    const filepath = path.join(CACHE_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(envelope, null, 2), 'utf-8');
    return filepath;
  } catch (err) {
    logger.error(`Cache write failed for ${mpn}: ${err.message}`);
    return null;
  }
}

/**
 * Read cached results for an MPN within the given age window.
 * Returns the most recent envelope, or null if nothing fresh enough.
 *
 * @param {string} mpn - MPN to look up
 * @param {number} maxAgeDays - Maximum age in days
 * @returns {object|null} Envelope object or null
 */
function readCache(mpn, maxAgeDays = 30) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return null;

    const prefix = cacheKey(mpn) + '_';
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .filter(f => {
        const dateStr = f.replace(prefix, '').replace('.json', '');
        return dateStr >= cutoffStr;
      })
      .sort()
      .reverse(); // most recent first

    if (files.length === 0) return null;

    const content = fs.readFileSync(path.join(CACHE_DIR, files[0]), 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    logger.error(`Cache read failed for ${mpn}: ${err.message}`);
    return null;
  }
}

// ─── FRESHNESS CHECK ────────────────────────────────────────────────────────

/**
 * Check whether we have fresh API data for an MPN within the TTL window.
 *
 * This is the "should I call the APIs or reuse what I have?" gate used by the
 * RFQ API Enrichment workflow and (via franchise-api.js cacheTTL option) any
 * other consumer. TTL rules are locked in api-integration-roadmap.md § API
 * Response Caching. Caller passes the resolved TTL for its RFQ type.
 *
 * Today's source of truth is the local cache file (`readCache()`) because
 * chuboe_pricing_api_result holds only thin-pointer rows (no envelope body) —
 * see writeDb() docstring. When the JSON column becomes writable and envelopes
 * live in OT, extend this to prefer the DB and fall back to cache.
 *
 * @param {string} mpn - MPN to check
 * @param {number} ttlDays - Max age in days to consider "fresh"
 * Envelopes containing any PricingResponseStatus='Failed' entry are always
 * treated as stale and refreshed — the per-distributor retry runner doesn't
 * heal the cache, so a partial-failure envelope would block recovered API
 * results from reaching downstream consumers for the full TTL window.
 *
 * @param {object} [options]
 * @param {function} [options.bypassIf] - Optional predicate (envelope) => bool.
 *   If returns true, force a refresh even when the cached envelope is fresh.
 *   Used by the "PPV + cached price < customer target" force-refresh rule.
 * @returns {{fresh: boolean, ageDays: number|null, envelope: object|null, reason?: string, failedDistys?: string[]}}
 */
function getFreshness(mpn, ttlDays, options = {}) {
  if (!mpn || !ttlDays) {
    return { fresh: false, ageDays: null, envelope: null };
  }

  const envelope = readCache(mpn, ttlDays);
  if (!envelope) {
    return { fresh: false, ageDays: null, envelope: null };
  }

  // Compute age from envelope timestamp
  const ts = envelope.data?._meta?.timestamp;
  let ageDays = null;
  if (ts) {
    const ageMs = Date.now() - new Date(ts).getTime();
    ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  }

  // Failed-entry gate: refuse to serve envelopes that captured upstream API
  // failures. The retry runner (scripts/api-retry-runner.js) confirms recovery
  // but never re-pulls the envelope, so a Failed-tainted envelope sticks for
  // the full TTL even after the underlying API is healthy again. Forcing a
  // live re-call overwrites the bad envelope same-day and unblocks downstream
  // VQ writes. Cost: one extra full pull per tainted MPN per TTL window.
  const statusEntries = envelope.data?.Status || [];
  const failedDistys = statusEntries
    .filter(s => s.PricingResponseStatus === 'Failed')
    .map(s => s.APIName);
  if (failedDistys.length > 0) {
    return { fresh: false, ageDays, envelope, reason: 'failed_entries', failedDistys };
  }

  // Apply optional bypass predicate (e.g., PPV-under-target force refresh)
  if (options.bypassIf && typeof options.bypassIf === 'function') {
    try {
      if (options.bypassIf(envelope)) {
        return { fresh: false, ageDays, envelope, reason: 'bypassIf' };
      }
    } catch (err) {
      logger.error(`bypassIf predicate failed for ${mpn}: ${err.message}`);
    }
  }

  return { fresh: true, ageDays, envelope };
}

// ─── DB OPERATIONS ──────────────────────────────────────────────────────────

/**
 * Check if the iDempiere REST API is reachable for writes.
 * Result is memoized for the process lifetime.
 */
let _dbAvailable = null;
async function isDbAvailable() {
  if (_dbAvailable !== null) return _dbAvailable;
  _dbAvailable = await isApiAvailable();
  if (!_dbAvailable) {
    logger.info('iDempiere API not available — using cache only');
  }
  return _dbAvailable;
}

/**
 * Write a thin-pointer row to Chuboe_Pricing_API_Result via iDempiere REST API.
 *
 * IMPORTANT — REST API limitation discovered 2026-04-08:
 *   The `Chuboe_JSON_Info_Text` column registered in iDempiere ad_column metadata
 *   is a **virtual column** — POSTing to it returns 500 "Cannot update virtual
 *   column". The underlying postgres `json_info jsonb` column exists physically
 *   (legacy Flux/CalcuQuote pipeline writes to it directly via SQL), but the
 *   REST model does not expose it as a writable field.
 *
 *   Until iDempiere config un-virtualizes the column (or we add a new physical
 *   text column), we write a **thin pointer** row containing only the linkage
 *   fields (AD_Table_ID + Record_ID), the MPN list, and the timestamp. The full
 *   pricing envelope stays in the local cache file (always written) and serves
 *   as the canonical store. See api-integration-roadmap.md § Pricing Envelope
 *   OT-Native Storage for the longer-term resolution.
 *
 * What the thin pointer gives us today:
 *   - "We pulled API data for this RFQ on this date for these MPNs" — visible
 *     in OT, joinable to the source RFQ via AD_Table_ID + Record_ID
 *   - Time-series of API call activity per RFQ / per MPN list
 *
 * What it does NOT give us today:
 *   - Per-distributor price ladders, stock levels, lead times — those live in
 *     the local cache only. Vortex/QQ/etc. should fall back to cache reads
 *     until the JSON column becomes writable.
 *
 * @returns Server-assigned ID on success, or null if API unreachable or write fails.
 */
async function writeDb(mpn, envelope, rfqId) {
  const available = await isDbAvailable();
  if (!available) return null;

  try {
    const uu = crypto.randomUUID();

    // Thin-pointer payload — no JSON body. Field names use exact PascalCase
    // from ad_column.columnname (REST API requirement).
    const payload = {
      Chuboe_Pricing_API_Result_UU: uu,
      MPNs: mpn.substring(0, 255),
    };
    if (rfqId) {
      payload.AD_Table_ID = AD_TABLE_ID_RFQ;
      payload.Record_ID = rfqId;
    }

    // Natural key is the client-generated UU — guaranteed unique and known
    // pre-POST, so check-before-retry has a perfect identity match.
    const result = await apiPost(DB_TABLE, payload, {
      naturalKeyFields: ['Chuboe_Pricing_API_Result_UU'],
    });
    const assignedId = result.id;
    if (assignedId) {
      return assignedId;
    }
    logger.error(`DB write failed for ${mpn}: no ID returned`);
    return null;
  } catch (err) {
    logger.error(`DB write error for ${mpn}: ${err.message}`);
    return null;
  }
}

// readDb() removed 2026-04-08:
//
// We previously tried to read pricing envelopes from
// adempiere.chuboe_pricing_api_result.json_info (legacy Flux data) and
// ai_writeback.chuboe_pricing_api_result (our data). Neither path is useful
// today:
//
//   - Our writes never reach json_info (the column is virtual via REST — see
//     writeDb() docstring), so there is no "our data" in either schema.
//   - The legacy Flux data in adempiere.json_info hasn't been written since
//     2024-12-30 and is older than any reasonable maxAgeDays window.
//   - The ai_writeback schema is deprecated.
//
// extractPriceAtQty now reads from the local cache only. When iDempiere
// un-virtualizes the JSON column (api-integration-roadmap.md § Pricing
// Envelope OT-Native Storage), reintroduce a DB read here that uses the
// REST GET endpoint, not direct SQL.

// ─── PUBLIC API: WRITE ──────────────────────────────────────────────────────

/**
 * Write franchise API results to cache + DB.
 *
 * Call this after searchAllDistributors() returns. Fire-and-forget pattern:
 *   writePricingResult({ searchResult, mpn, qty, source: 'consumer-name' })
 *     .catch(err => console.error(err.message));
 *
 * @param {object} opts
 * @param {object} opts.searchResult - Return value of searchAllDistributors()
 * @param {string} opts.mpn - Searched MPN
 * @param {number} opts.qty - Searched quantity
 * @param {number} [opts.rfqId] - chuboe_rfq_id (links result to triggering RFQ)
 * @param {string} [opts.source] - Consumer name for _meta tracking
 * @returns {Promise<object>} { cacheFile, dbId, success }
 */
async function writePricingResult(opts) {
  const { searchResult, mpn, qty, rfqId, source, caller = 'enrich-poller' } = opts;

  if (!searchResult || !mpn) {
    return { cacheFile: null, dbId: null, success: false, error: 'Missing searchResult or mpn' };
  }

  // Build the Flux-compatible envelope
  const envelope = buildEnvelope(searchResult, mpn, qty, source);

  // Always write to cache
  const cacheFile = writeCache(mpn, envelope);

  // ── Global budget check for DB write ──
  const globalCheck = otBudget.checkBudget({
    table: 'chuboe_pricing_api_result',
    count: 1,
    caller,
    isBackfill: false,
  });

  let dbId = null;
  let rateLimited = false;
  if (!globalCheck.allowed) {
    logger.warn(`Global budget exhausted for ${mpn}: ${globalCheck.reason} — cache written, DB skipped`);
    rateLimited = true;
  } else {
    // Reserve budget before write
    otBudget.reserve('chuboe_pricing_api_result', 1, caller);
    const writeStartTime = Date.now();

    // Write to DB via API if available (non-blocking — failure doesn't affect cache)
    dbId = await writeDb(mpn, envelope, rfqId);

    // Record the write
    const writeDuration = Date.now() - writeStartTime;
    if (dbId) {
      otBudget.recordWrites('chuboe_pricing_api_result', 1, {
        caller,
        success: true,
        durationMs: writeDuration,
      });
    } else {
      otBudget.recordFailure();
    }
  }

  const success = cacheFile !== null;
  if (success) {
    logger.debug(`Captured ${mpn}: ${envelope.data.Pricings.length} distributors → ${cacheFile}${dbId ? ` + DB#${dbId}` : ''}${rateLimited ? ' (DB rate limited)' : ''}`);
  }

  return { cacheFile, dbId, success, rateLimited };
}

// ─── PUBLIC API: READ ───────────────────────────────────────────────────────

/**
 * Extract the qty-relevant price break for an MPN across distributors.
 *
 * Reads from the local cache (canonical store today — see writeDb() docstring
 * for why DB envelope reads don't work). Applies freshness filter via
 * maxAgeDays. For each distributor, selects the highest QtyBreak that is
 * <= the requested qty (standard price break logic).
 *
 * @param {string} mpn - MPN to look up
 * @param {number} qty - Quantity for price break selection
 * @param {object} [options]
 * @param {number} [options.maxAgeDays=30] - Only results from last N days
 * @returns {Array<object>} One entry per distributor:
 *   { supplier, mpn, manufacturer, stock, leadTime, moq, priceAtQty, bulkPrice, allBreaks, currency, asOf }
 */
function extractPriceAtQty(mpn, qty, options = {}) {
  const maxAgeDays = options.maxAgeDays || 30;

  const envelope = readCache(mpn, maxAgeDays);
  if (!envelope || !envelope.data || !envelope.data.Pricings) {
    return [];
  }

  return envelope.data.Pricings.map(p => {
    const breaks = (p.Pricings || []).sort((a, b) => a.QtyBreak - b.QtyBreak);

    // Find highest QtyBreak <= requested qty
    let priceAtQty = null;
    for (let i = breaks.length - 1; i >= 0; i--) {
      if (breaks[i].QtyBreak <= qty) {
        priceAtQty = breaks[i].UnitPrice;
        break;
      }
    }
    // If qty is below the minimum break, use the first break
    if (priceAtQty === null && breaks.length > 0) {
      priceAtQty = breaks[0].UnitPrice;
    }

    const bulkPrice = breaks.length > 0 ? breaks[breaks.length - 1].UnitPrice : null;

    return {
      supplier: p.SupplierName,
      mpn: p.ManufacturerPartNumber,
      manufacturer: p.ManufacturerName,
      stock: p.CurrentStockQty || 0,
      leadTime: p.LeadTime,
      moq: p.MinimumBuy || 1,
      priceAtQty,
      bulkPrice,
      allBreaks: breaks.map(b => ({ qty: b.QtyBreak, unitPrice: b.UnitPrice })),
      currency: p.Currency || 'USD',
      asOf: envelope.data._meta?.timestamp || null,
    };
  });
}

// ─── FLUSH CACHE TO DB ──────────────────────────────────────────────────────

/**
 * Bulk import cached files to ai_writeback.chuboe_pricing_api_result.
 * Call once when the DB table is confirmed ready.
 * Moves processed files to imported/ subdirectory.
 *
 * @returns {{ imported: number, errors: number }}
 */
async function flushCacheToDB() {
  const available = await isDbAvailable();
  if (!available) {
    logger.error('Cannot flush: iDempiere API not available');
    return { imported: 0, errors: 0, rateLimited: false };
  }

  if (!fs.existsSync(CACHE_DIR)) return { imported: 0, errors: 0, rateLimited: false };

  const importedDir = path.join(CACHE_DIR, 'imported');
  if (!fs.existsSync(importedDir)) {
    fs.mkdirSync(importedDir, { recursive: true });
  }

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));

  // ── Global budget check for bulk flush ──
  const globalCheck = otBudget.checkBudget({
    table: 'chuboe_pricing_api_result',
    count: files.length,
    caller: 'enrich-poller',
    isBackfill: true,  // Bulk flush is treated as backfill
  });

  if (!globalCheck.allowed) {
    logger.warn(`Global budget exhausted for cache flush: ${globalCheck.reason} — ${files.length} files deferred`);
    return { imported: 0, errors: 0, rateLimited: true, rateLimitReason: globalCheck.reason };
  }

  // Reserve budget and claim backfill slot
  otBudget.reserve('chuboe_pricing_api_result', files.length, 'enrich-poller');
  otBudget.claimBackfillSlot('enrich-poller');

  const flushStartTime = Date.now();
  let imported = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const filepath = path.join(CACHE_DIR, file);
      const content = fs.readFileSync(filepath, 'utf-8');
      const envelope = JSON.parse(content);
      const mpn = envelope.data?._meta?.searchedMPN || file.split('_')[0];
      const rfqId = null; // Cache files don't track RFQ IDs

      const dbId = await writeDb(mpn, envelope, rfqId);
      if (dbId) {
        fs.renameSync(filepath, path.join(importedDir, file));
        imported++;
      } else {
        errors++;
      }
    } catch (err) {
      logger.error(`Flush failed for ${file}: ${err.message}`);
      errors++;
    }
  }

  // ── Record writes and release backfill slot ──
  const flushDuration = Date.now() - flushStartTime;
  if (imported > 0) {
    otBudget.recordWrites('chuboe_pricing_api_result', imported, {
      caller: 'enrich-poller',
      success: true,
      durationMs: flushDuration,
    });
  }

  if (errors > 0) {
    for (let i = 0; i < errors; i++) {
      otBudget.recordFailure();
    }
  }

  otBudget.releaseBackfillSlot('enrich-poller');

  logger.info(`Cache flush: ${imported} imported, ${errors} errors`);
  return { imported, errors, rateLimited: false };
}

// ─── CACHE CLEANUP ──────────────────────────────────────────────────────────

/**
 * Remove cache files older than maxAgeDays.
 * @param {number} maxAgeDays - Delete files older than this (default 90)
 * @returns {number} Files deleted
 */
function pruneCache(maxAgeDays = 90) {
  if (!fs.existsSync(CACHE_DIR)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  let deleted = 0;

  for (const file of files) {
    // Extract date from filename: {MPN}_{YYYY-MM-DD}.json
    const match = file.match(/_(\d{4}-\d{2}-\d{2})\.json$/);
    if (match && match[1] < cutoffStr) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
      deleted++;
    }
  }

  if (deleted > 0) logger.info(`Pruned ${deleted} cache files older than ${maxAgeDays} days`);
  return deleted;
}

module.exports = {
  writePricingResult,
  extractPriceAtQty,
  getFreshness,
  flushCacheToDB,
  pruneCache,
  buildEnvelope,  // exported for testing
  cacheKey,       // exported for cache-aware consumers (large-rfq-gate scan)
  CACHE_DIR,
};
