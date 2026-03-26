/**
 * API Result Writer — captures franchise API pricing data for market intelligence
 *
 * Stores full API responses (all price breaks, stock, lead time, MOQ) from
 * franchise distributor searches. Data flows into two stores:
 *
 *   1. Local cache: shared/data/api-pricing-cache/{MPN}_{date}.json (always)
 *   2. DB: ai_writeback.chuboe_pricing_api_result (when table exists)
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
 *
 * CONSUMERS:
 *   - Writers: Franchise Screening, Suggested Resale, LAM Kitting (fire-and-forget)
 *   - Readers: Vortex Matches (90d), Quick Quote (30d), on-demand (7d)
 *   - Hurricane Search reads from DB natively (iDempiere, we don't control)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { psqlQuery, psqlExec, getNextId, sqlStr, tableExists, IDEMPIERE_DEFAULTS } = require('./db-helpers');
const logger = require('./logger').createLogger('APIPricing');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(__dirname, 'data/api-pricing-cache');
const AD_TABLE_ID_RFQ = 1000002; // Chuboe_RFQ table
const DB_TABLE = 'chuboe_pricing_api_result';

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

  const pricingsArray = searchResult.distributors
    .filter(d => d.found)
    .map(d => ({
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
      ProductUrl: null,
      Packaging: d.raw?.vqPackaging || null,
      Pricings: (d.priceBreaks || d.raw?.priceBreaks || []).map(pb => ({
        QtyBreak: pb.qty,
        UnitPrice: pb.unitPrice,
      })),
    }));

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

// ─── DB OPERATIONS ──────────────────────────────────────────────────────────

/**
 * Check if the ai_writeback pricing table exists.
 * Result is memoized for the process lifetime.
 */
let _dbAvailable = null;
function isDbAvailable() {
  if (_dbAvailable !== null) return _dbAvailable;
  _dbAvailable = tableExists(DB_TABLE);
  if (!_dbAvailable) {
    logger.info('ai_writeback.chuboe_pricing_api_result not available — using cache only');
  }
  return _dbAvailable;
}

/**
 * Write envelope to ai_writeback.chuboe_pricing_api_result.
 * Returns the inserted ID, or null if table doesn't exist or write fails.
 */
function writeDb(mpn, envelope, rfqId) {
  if (!isDbAvailable()) return null;

  try {
    const nextId = getNextId(DB_TABLE, 'chuboe_pricing_api_result_id');
    const uu = crypto.randomUUID();
    const jsonStr = JSON.stringify(envelope).replace(/'/g, "''");

    const sql = `INSERT INTO ai_writeback.${DB_TABLE} (
      chuboe_pricing_api_result_id, ad_client_id, ad_org_id, isactive,
      created, createdby, updated, updatedby,
      chuboe_pricing_api_result_uu,
      ad_table_id, record_id, mpns, json_info
    ) VALUES (
      ${nextId}, ${IDEMPIERE_DEFAULTS.ad_client_id}, ${IDEMPIERE_DEFAULTS.ad_org_id}, 'Y',
      CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.createdby}, CURRENT_TIMESTAMP, ${IDEMPIERE_DEFAULTS.updatedby},
      '${uu}',
      ${rfqId ? AD_TABLE_ID_RFQ : 'NULL'},
      ${rfqId || 'NULL'},
      ${sqlStr(mpn.substring(0, 255))},
      '${jsonStr}'::jsonb
    )`;

    const ok = psqlExec(sql);
    if (ok) {
      return nextId;
    }
    logger.error(`DB write failed for ${mpn}`);
    return null;
  } catch (err) {
    logger.error(`DB write error for ${mpn}: ${err.message}`);
    return null;
  }
}

/**
 * Read the most recent API result from DB for an MPN within the age window.
 * Checks both adempiere (old Flux data) and ai_writeback (our data).
 */
function readDb(mpn, maxAgeDays = 30) {
  const escaped = mpn.replace(/'/g, "''");
  // Try ai_writeback first (our data, most recent)
  const sources = isDbAvailable()
    ? ['ai_writeback', 'adempiere']
    : ['adempiere'];

  for (const schema of sources) {
    const sql = `SELECT json_info::text FROM ${schema}.${DB_TABLE}
      WHERE mpns ILIKE '%${escaped}%'
        AND isactive = 'Y'
        AND created >= CURRENT_DATE - INTERVAL '${maxAgeDays} days'
      ORDER BY created DESC LIMIT 1`;

    const result = psqlQuery(sql);
    if (result) {
      try {
        return JSON.parse(result);
      } catch (e) {
        // JSON parse failed, try next source
      }
    }
  }
  return null;
}

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
  const { searchResult, mpn, qty, rfqId, source } = opts;

  if (!searchResult || !mpn) {
    return { cacheFile: null, dbId: null, success: false, error: 'Missing searchResult or mpn' };
  }

  // Build the Flux-compatible envelope
  const envelope = buildEnvelope(searchResult, mpn, qty, source);

  // Always write to cache
  const cacheFile = writeCache(mpn, envelope);

  // Write to DB if available (non-blocking — failure doesn't affect cache)
  const dbId = writeDb(mpn, envelope, rfqId);

  const success = cacheFile !== null;
  if (success) {
    logger.debug(`Captured ${mpn}: ${envelope.data.Pricings.length} distributors → ${cacheFile}${dbId ? ` + DB#${dbId}` : ''}`);
  }

  return { cacheFile, dbId, success };
}

// ─── PUBLIC API: READ ───────────────────────────────────────────────────────

/**
 * Extract the qty-relevant price break for an MPN across distributors.
 *
 * Reads from DB first (if available), falls back to cache. Applies freshness
 * filter via maxAgeDays. For each distributor, selects the highest QtyBreak
 * that is <= the requested qty (standard price break logic).
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

  // Try DB first, then cache
  const envelope = readDb(mpn, maxAgeDays) || readCache(mpn, maxAgeDays);
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
function flushCacheToDB() {
  if (!isDbAvailable()) {
    logger.error('Cannot flush: ai_writeback.chuboe_pricing_api_result not available');
    return { imported: 0, errors: 0 };
  }

  if (!fs.existsSync(CACHE_DIR)) return { imported: 0, errors: 0 };

  const importedDir = path.join(CACHE_DIR, 'imported');
  if (!fs.existsSync(importedDir)) {
    fs.mkdirSync(importedDir, { recursive: true });
  }

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  let imported = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const filepath = path.join(CACHE_DIR, file);
      const content = fs.readFileSync(filepath, 'utf-8');
      const envelope = JSON.parse(content);
      const mpn = envelope.data?._meta?.searchedMPN || file.split('_')[0];
      const rfqId = null; // Cache files don't track RFQ IDs

      const dbId = writeDb(mpn, envelope, rfqId);
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

  logger.info(`Cache flush: ${imported} imported, ${errors} errors`);
  return { imported, errors };
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
  flushCacheToDB,
  pruneCache,
  buildEnvelope,  // exported for testing
  CACHE_DIR,
};
