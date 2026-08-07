/**
 * Unified API Enrichment Module
 *
 * Consolidates API enrichment logic from multiple workflows into a single
 * reusable module. All workflows that need franchise API data should use
 * this module instead of calling franchise-api.js directly.
 *
 * MIGRATION STATUS (2026-08-07):
 *   ✅ MIGRATED:
 *     - RFQ API Enrichment (enrich-rfq.js) — imports TTL rules (complex post-processing keeps raw API)
 *     - LAM Kitting (lam-kitting-source.js) — imports profileMpn, findBestInStock/LT
 *     - Franchise Screening (main.js) — imports profileMpn
 *     - Stock Suggested Resale (suggested-resale.js) — imports profileMpn
 *     - Offer Analyzer (offer-analyzer.js) — imports profileMpn
 *     - Customer Excess (render-reactive.js) — imports profileMpn
 *     - Inventory Recommended Resale (run-upside-down.js) — imports profileMpn
 *     - HTS/ECCN Backfill (hts-eccn-backfill.js) — imports profileMpn
 *
 *   📋 LOW PRIORITY (one-off scripts, infrastructure):
 *     - LAM EPG Award scripts (program-specific one-offs)
 *     - amat-rfq-enrichment.js, recall-tainted-mpns.js, etc.
 *     - vq-writer.js, api-retry-runner.js (infrastructure)
 *
 *   📖 CACHE CONSUMERS (read-only, different pattern):
 *     - Vortex Matches (vortex-matches.js)
 *     - Quick Quote (qq-cache-context.js)
 *
 * ENTRY POINTS:
 *   profileMpnList(items, opts)     — Profile a batch of MPNs (main entry point)
 *   profileMpn(mpn, qty, opts)      — Profile a single MPN
 *   readCachedEnrichment(mpn, opts) — Read from cache only (no API calls)
 *
 * EXTRACTORS:
 *   findBestInStock(result, qty)    — Find best in-stock option
 *   findBestLeadTime(result)        — Find best lead-time option
 *   extractAllOptions(result, qty)  — Extract all options (stock + LT)
 *
 * TTL RULES:
 *   getTTLForRfqType(rfqType)       — Get cache TTL for RFQ type
 *   TTL_BY_RFQ_TYPE                 — TTL map (exported for reference)
 *
 * CHECKPOINT/RESUME:
 *   saveCheckpoint(path, results, summary, metadata)
 *   loadCheckpoint(path) → { skipMpns, summary, metadata }
 *   createCheckpointCallback(path, metadata) → callback for profileMpnList
 *
 * CACHE:
 *   getCacheStatus(mpn)             — Check if MPN has fresh cache
 *
 * DISTRIBUTOR HEALTH (rate limiting / circuit breaker):
 *   getDistributorHealth(name)      — Check single distributor health
 *   getApiHealthSummary()           — Get all distributors' health status
 *   checkApiHealth(opts)            — Pre-flight check before batch operations
 *   recordApiSuccess(name)          — Record successful call (resets circuit breaker)
 *   recordApi429(name)              — Record 429 error (increments circuit breaker)
 *
 * @module shared/api-enrichment
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Core dependencies
const { searchAllDistributors } = require('./franchise-api');
const { writePricingResult, extractPriceAtQty } = require('./api-result-writer');
const apiThrottle = require('./api-throttle');

// ─── TTL BY RFQ TYPE ────────────────────────────────────────────────────────
// Source of truth: api-integration-roadmap.md § API Response Caching.
// Moved from enrich-rfq.js to be shared across all consumers.
const TTL_BY_RFQ_TYPE = {
  'PPV': 30,
  'Astute Franchised': 30,
  'Shortage': 7,
  'Stock': 14,
  'EOL/LTB': 7,
  '3PL/VMI': 7,
  'Hot Parts': 7,
  'Proactive Offer': 7,
  'Active Sourcing': 7,    // delisted parts pipeline
  'Stock Profiling': 14,   // market profiling
  'Quick Quote': 14,       // baseline quote generation
  'Customer Excess': 14,   // excess/offer analysis
};
const DEFAULT_TTL = 7;

/**
 * Get cache TTL in days for a given RFQ type.
 * @param {string} rfqType - The RFQ type name
 * @returns {number} TTL in days
 */
function getTTLForRfqType(rfqType) {
  return TTL_BY_RFQ_TYPE[rfqType] ?? DEFAULT_TTL;
}

// ─── BEST OPTION EXTRACTORS ─────────────────────────────────────────────────
// Consolidated from lam-kitting-source.js — the cleanest implementation.
// These extract the "best" option from franchise API results.

/**
 * Find best in-stock option from franchise results.
 * Returns supplier with lowest price among those with sufficient stock.
 *
 * @param {Object} franchiseResults - Distributor results (keyed by name)
 *   Each entry: { qty, price, leadTime, supplier, ... }
 * @param {number} neededQty - Quantity needed (for full coverage check)
 * @returns {Object|null} Best option: { supplier, price, qty, partialStock?, ... }
 */
function findBestInStock(franchiseResults, neededQty = 1) {
  let best = null;
  let bestPartial = null;

  // Handle both object format (LAM Kitting) and array format (franchise-api)
  const entries = Array.isArray(franchiseResults)
    ? franchiseResults.map(d => [d.name || d.distributor, d])
    : Object.entries(franchiseResults || {});

  for (const [name, data] of entries) {
    if (!data) continue;

    // Normalize qty field (different callers use different shapes)
    const qty = data.qty ?? data.franchiseQty ?? 0;
    const price = data.price ?? data.franchiseRfqPrice ?? data.franchiseBulkPrice ?? null;

    if (qty <= 0) continue;

    const option = {
      supplier: name,
      price,
      qty,
      leadTime: data.leadTime ?? data.vqLeadTime ?? '',
      moq: data.moq,
      spq: data.spq,
      dateCode: data.dateCode ?? data.vqDateCode ?? '',
      bpId: data.bpId ?? data.vendorBP,
      bpSearchKey: data.bpSearchKey,
      locationId: data.locationId ?? data.vendorLocation,
    };

    if (qty >= neededQty) {
      // Full coverage — pick lowest price
      if (!best || (price != null && price < best.price)) {
        best = option;
      }
    } else {
      // Partial stock — track as fallback
      if (!bestPartial || (price != null && price < bestPartial.price)) {
        bestPartial = { ...option, partialStock: true };
      }
    }
  }

  // Return full coverage winner; if none, return partial with note
  return best || bestPartial || null;
}

/**
 * Find best lead-time option from franchise results.
 * Returns supplier with pricing but no/insufficient stock (lowest price).
 *
 * @param {Object} franchiseResults - Distributor results (keyed by name)
 * @returns {Object|null} Best lead-time option: { supplier, price, leadTime, ... }
 */
function findBestLeadTime(franchiseResults) {
  let best = null;

  const entries = Array.isArray(franchiseResults)
    ? franchiseResults.map(d => [d.name || d.distributor, d])
    : Object.entries(franchiseResults || {});

  for (const [name, data] of entries) {
    if (!data) continue;

    const qty = data.qty ?? data.franchiseQty ?? 0;
    const price = data.price ?? data.franchiseRfqPrice ?? data.franchiseBulkPrice ?? null;

    if (!price) continue;

    // Only consider items without stock (lead time orders)
    if (qty > 0) continue;

    const option = {
      supplier: name,
      price,
      qty: 0,
      leadTime: data.leadTime ?? data.vqLeadTime ?? '',
      moq: data.moq,
      spq: data.spq,
      bpId: data.bpId ?? data.vendorBP,
      bpSearchKey: data.bpSearchKey,
      locationId: data.locationId ?? data.vendorLocation,
    };

    if (!best || price < best.price) {
      best = option;
    }
  }

  return best;
}

/**
 * Extract all options from franchise results (both stock and lead-time).
 * Returns structured data for downstream processing.
 *
 * @param {Object} result - Full searchAllDistributors() result
 * @param {number} qty - Quantity for coverage evaluation
 * @returns {Object} { bestInStock, bestLeadTime, allDistributors, summary }
 */
function extractAllOptions(result, qty = 1) {
  const distributors = result?.distributors || [];

  // Build normalized results map
  const normalized = {};
  for (const d of distributors) {
    if (!d.found) continue;
    const name = d.name || d.distributor;
    normalized[name] = {
      qty: d.franchiseQty || 0,
      price: d.franchiseRfqPrice || d.franchiseBulkPrice || null,
      leadTime: d.vqLeadTime || '',
      moq: d.moq,
      spq: d.spq,
      dateCode: d.vqDateCode || '',
      bpId: d.vendorBP,
      bpSearchKey: d.bpSearchKey,
      locationId: d.vendorLocation,
      found: d.found,
      error: d.error || d.errorState,
    };
  }

  return {
    bestInStock: findBestInStock(normalized, qty),
    bestLeadTime: findBestLeadTime(normalized),
    allDistributors: normalized,
    summary: result?.summary || {},
    vqLines: result?.vqLines || [],
  };
}

// ─── SINGLE MPN PROFILING ───────────────────────────────────────────────────

/**
 * Profile a single MPN against franchise APIs.
 *
 * @param {string} mpn - Part number to profile
 * @param {number} qty - Quantity for pricing
 * @param {Object} [opts] - Options
 * @param {number} [opts.cacheTTL] - Cache TTL in days (default: 7)
 * @param {string} [opts.rfqType] - RFQ type for TTL lookup (overrides cacheTTL)
 * @param {string} [opts.mfr] - Manufacturer hint
 * @param {boolean} [opts.force=false] - Bypass cache
 * @param {boolean} [opts.cacheOnly=false] - Only read from cache, no API calls
 * @param {boolean} [opts.writePricing=true] - Write to pricing cache
 * @param {string} [opts.source] - Source identifier for audit trail
 * @param {number} [opts.rfqId] - RFQ ID for audit trail linkage
 * @returns {Promise<Object>} Enrichment result with extracted options
 */
async function profileMpn(mpn, qty, opts = {}) {
  const {
    cacheTTL,
    rfqType,
    mfr = '',
    force = false,
    cacheOnly = false,
    writePricing = true,
    source = 'api-enrichment',
    rfqId = null,
  } = opts;

  // Determine TTL: explicit cacheTTL > rfqType lookup > default
  const ttlDays = force ? 0 : (cacheTTL ?? (rfqType ? getTTLForRfqType(rfqType) : DEFAULT_TTL));

  // Call franchise API
  const result = await searchAllDistributors(mpn, qty, {
    cacheTTL: ttlDays,
    mfr,
    cacheOnly,
    rfqType,
  });

  const fromCache = result?.summary?.fromCache === true;
  const cacheOnlyMiss = result?.summary?.cacheOnlyMiss === true;

  // Write to pricing cache (only on live calls, not cache hits)
  if (writePricing && !fromCache && !cacheOnlyMiss) {
    try {
      await writePricingResult({
        searchResult: result,
        mpn,
        qty,
        rfqId,
        source,
      });
    } catch (err) {
      // Don't fail the enrichment if cache write fails
      console.warn(`[api-enrichment] writePricingResult failed for ${mpn}: ${err.message}`);
    }
  }

  // Extract options
  const options = extractAllOptions(result, qty);

  return {
    mpn,
    qty,
    fromCache,
    cacheOnlyMiss,
    ...options,
    raw: result,
  };
}

// ─── BATCH MPN PROFILING ────────────────────────────────────────────────────

/**
 * Profile a batch of MPNs against franchise APIs.
 * Main entry point for batch enrichment workflows.
 *
 * PARTIAL FAILURE HANDLING:
 * - Results are built incrementally as each MPN is processed
 * - Unprocessed items are pre-initialized with status: 'PENDING'
 * - Use checkpoint callbacks to save progress incrementally
 * - If interrupted, already-written pricing cache data is preserved
 * - Resume from checkpoint by filtering out already-processed items
 *
 * WHAT'S PRESERVED ON PARTIAL FAILURE:
 * - Pricing cache files (shared/data/api-pricing-cache/{MPN}_{date}.json)
 * - chuboe_pricing_api_result DB rows (thin pointers)
 * - Individual VQs written by writeVQFromAPI (if caller uses that)
 *
 * WHAT NEEDS RE-RUNNING:
 * - Unprocessed items in the batch
 * - Workflow-specific outputs (reports, summaries, emails)
 *
 * @param {Array<Object>} items - Items to profile: [{ mpn, qty, mfr? }, ...]
 * @param {Object} [opts] - Options
 * @param {number} [opts.cacheTTL] - Cache TTL in days
 * @param {string} [opts.rfqType] - RFQ type for TTL lookup
 * @param {boolean} [opts.force=false] - Bypass cache for all items
 * @param {boolean} [opts.cacheOnly=false] - Only read from cache
 * @param {boolean} [opts.writePricing=true] - Write to pricing cache
 * @param {string} [opts.source] - Source identifier for audit trail
 * @param {number} [opts.rfqId] - RFQ ID for audit trail linkage
 * @param {number} [opts.delayMs=0] - Delay between items (rate limiting)
 * @param {Function} [opts.onProgress] - Progress callback: (item, index, total, result) => void
 * @param {Function} [opts.onError] - Error callback: (item, index, error) => void
 * @param {Function} [opts.onCheckpoint] - Checkpoint callback: (results, summary, index) => void
 *   Called after each item; use to save incremental progress
 * @param {number} [opts.checkpointInterval=10] - Call onCheckpoint every N items
 * @param {Set} [opts.skipMpns] - Set of MPNs to skip (for resume from checkpoint)
 * @returns {Promise<Object>} { results: [...], summary: { ... }, interrupted: boolean }
 */
async function profileMpnList(items, opts = {}) {
  const {
    cacheTTL,
    rfqType,
    force = false,
    cacheOnly = false,
    writePricing = true,
    source = 'api-enrichment',
    rfqId = null,
    delayMs = 0,
    onProgress = null,
    onError = null,
    onCheckpoint = null,
    checkpointInterval = 10,
    skipMpns = null,
    checkHealth = true, // Pre-flight health check
  } = opts;

  // Pre-flight health check — warn if any distributors are rate-limited
  // This happens automatically so workflows don't need to remember to check
  const healthCheck = checkHealth ? getApiHealthSummary() : { healthy: [], unhealthy: [], allHealthy: true };
  if (healthCheck.unhealthy.length > 0 && !cacheOnly) {
    const warnings = healthCheck.unhealthy.map(s => {
      const minLeft = s.until ? Math.ceil((s.until - Date.now()) / 60000) : '?';
      return `${s.distributor}: circuit breaker OPEN (${minLeft}min cooldown)`;
    });
    console.warn(`[api-enrichment] Pre-flight health check: ${warnings.length} distributor(s) rate-limited`);
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  // Pre-initialize all results with PENDING status
  // This ensures partial runs still have complete result arrays
  const results = items.map(item => ({
    ...item,
    status: 'PENDING',
    enrichment: null,
    error: null,
  }));

  const summary = {
    total: items.length,
    processed: 0,
    skipped: 0,
    apiCalls: 0,
    cacheHits: 0,
    cacheOnlyMisses: 0,
    withStock: 0,
    withLeadTime: 0,
    noCoverage: 0,
    errors: 0,
    // Health status at start of batch
    healthyDistributors: healthCheck.healthy,
    unhealthyDistributors: healthCheck.unhealthy.map(s => s.distributor),
    healthWarnings: healthCheck.unhealthy.map(s => {
      const minLeft = s.until ? Math.ceil((s.until - Date.now()) / 60000) : '?';
      return `${s.distributor}: circuit breaker OPEN (${minLeft}min cooldown)`;
    }),
  };

  // Track interruption for graceful shutdown
  let interrupted = false;
  const handleInterrupt = () => {
    interrupted = true;
  };

  // Register signal handlers (caller can use onCheckpoint to save state)
  process.once('SIGTERM', handleInterrupt);
  process.once('SIGINT', handleInterrupt);

  try {
    for (let i = 0; i < items.length; i++) {
      // Check for interruption
      if (interrupted) {
        console.warn(`[api-enrichment] Interrupted at item ${i}/${items.length} — partial results available`);
        break;
      }

      const item = items[i];
      const { mpn, qty = 1, mfr = '' } = item;

      // Skip if in skipMpns set (resume support)
      if (skipMpns && skipMpns.has(mpn)) {
        results[i].status = 'SKIPPED_RESUME';
        summary.skipped++;
        continue;
      }

      try {
        const result = await profileMpn(mpn, qty, {
          cacheTTL,
          rfqType,
          mfr,
          force,
          cacheOnly,
          writePricing,
          source,
          rfqId,
        });

        // Update result entry
        results[i].status = 'PROCESSED';
        results[i].enrichment = result;

        // Update summary
        summary.processed++;
        if (result.cacheOnlyMiss) {
          summary.cacheOnlyMisses++;
          summary.noCoverage++;
        } else if (result.fromCache) {
          summary.cacheHits++;
        } else {
          summary.apiCalls++;
        }

        if (result.bestInStock) {
          summary.withStock++;
        } else if (result.bestLeadTime) {
          summary.withLeadTime++;
        } else if (!result.cacheOnlyMiss) {
          summary.noCoverage++;
        }

        if (onProgress) {
          onProgress(item, i, items.length, result);
        }
      } catch (err) {
        // Update result entry with error
        results[i].status = 'ERROR';
        results[i].error = err.message;
        summary.errors++;

        if (onError) {
          onError(item, i, err);
        }
      }

      // Checkpoint callback for incremental saves
      if (onCheckpoint && (i + 1) % checkpointInterval === 0) {
        try {
          onCheckpoint(results, summary, i);
        } catch (cpErr) {
          console.warn(`[api-enrichment] Checkpoint callback failed: ${cpErr.message}`);
        }
      }

      // Rate limiting delay
      if (delayMs > 0 && i < items.length - 1) {
        await sleep(delayMs);
      }
    }
  } finally {
    // Clean up signal handlers
    process.removeListener('SIGTERM', handleInterrupt);
    process.removeListener('SIGINT', handleInterrupt);
  }

  // Final checkpoint
  if (onCheckpoint) {
    try {
      onCheckpoint(results, summary, items.length - 1);
    } catch (cpErr) {
      console.warn(`[api-enrichment] Final checkpoint callback failed: ${cpErr.message}`);
    }
  }

  return { results, summary, interrupted };
}

// ─── CACHE READING ──────────────────────────────────────────────────────────

/**
 * Read cached enrichment data for an MPN (no API calls).
 * Used by consumers that only need cached data (Vortex, Quick Quote).
 *
 * @param {string} mpn - Part number
 * @param {Object} [opts] - Options
 * @param {number} [opts.maxAgeDays=90] - Maximum cache age to consider
 * @param {boolean} [opts.includeAllTiers=true] - Include all price tiers
 * @returns {Object|null} Cached data or null if not found/expired
 */
function readCachedEnrichment(mpn, opts = {}) {
  const { maxAgeDays = 90, includeAllTiers = true } = opts;

  // Use the existing extractPriceAtQty for single-price extraction
  // or implement full envelope reading here if needed
  try {
    const price = extractPriceAtQty(mpn, 1, { maxAgeDays });
    if (price) {
      return {
        mpn,
        fromCache: true,
        bestPrice: price,
        // TODO: Extend to return full envelope if includeAllTiers
      };
    }
  } catch (err) {
    // Cache read failed
  }

  return null;
}

/**
 * Check if an MPN has fresh cache data.
 *
 * @param {string} mpn - Part number
 * @param {number} [maxAgeDays=7] - Maximum age to consider "fresh"
 * @returns {boolean} True if fresh cache exists
 */
function getCacheStatus(mpn, maxAgeDays = 7) {
  const CACHE_DIR = path.resolve(__dirname, 'data/api-pricing-cache');
  if (!fs.existsSync(CACHE_DIR)) return false;

  const mpnClean = mpn.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (!file.startsWith(mpnClean + '_')) continue;
      // Extract date from filename: MPN_YYYY-MM-DD.json
      const match = file.match(/_(\d{4}-\d{2}-\d{2})\.json$/);
      if (match) {
        const fileDate = new Date(match[1]);
        if (fileDate >= cutoffDate) {
          return true;
        }
      }
    }
  } catch (err) {
    // Ignore read errors
  }

  return false;
}

// ─── CHECKPOINT HELPERS ─────────────────────────────────────────────────────

/**
 * Save enrichment checkpoint to file.
 * Use with onCheckpoint callback for incremental saves.
 *
 * @param {string} checkpointPath - Path to checkpoint file
 * @param {Array} results - Current results array
 * @param {Object} summary - Current summary object
 * @param {Object} [metadata] - Additional metadata (source, rfqId, etc.)
 */
function saveCheckpoint(checkpointPath, results, summary, metadata = {}) {
  const checkpoint = {
    timestamp: new Date().toISOString(),
    summary,
    metadata,
    // Only save processed MPNs to reduce file size
    processedMpns: results
      .filter(r => r.status === 'PROCESSED' || r.status === 'ERROR')
      .map(r => ({
        mpn: r.mpn,
        status: r.status,
        error: r.error,
        // Include key results for resume verification
        hasStock: !!r.enrichment?.bestInStock,
        hasLeadTime: !!r.enrichment?.bestLeadTime,
      })),
  };
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Load enrichment checkpoint from file.
 * Returns set of MPNs to skip for resume.
 *
 * @param {string} checkpointPath - Path to checkpoint file
 * @returns {Object} { skipMpns: Set, summary: Object, metadata: Object } or null
 */
function loadCheckpoint(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) return null;

  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const skipMpns = new Set(
      checkpoint.processedMpns
        .filter(r => r.status === 'PROCESSED')
        .map(r => r.mpn)
    );
    return {
      skipMpns,
      summary: checkpoint.summary,
      metadata: checkpoint.metadata,
      timestamp: checkpoint.timestamp,
    };
  } catch (err) {
    console.warn(`[api-enrichment] Failed to load checkpoint: ${err.message}`);
    return null;
  }
}

/**
 * Create a checkpoint callback for profileMpnList.
 * Saves progress to a file every N items.
 *
 * @param {string} checkpointPath - Path to checkpoint file
 * @param {Object} [metadata] - Additional metadata
 * @returns {Function} Checkpoint callback for profileMpnList
 */
function createCheckpointCallback(checkpointPath, metadata = {}) {
  return (results, summary, index) => {
    saveCheckpoint(checkpointPath, results, summary, metadata);
  };
}

// ─── DISTRIBUTOR HEALTH ─────────────────────────────────────────────────────
// Expose api-throttle health checks so all consumers can check before starting.

/**
 * Get health status for a specific distributor.
 * Returns circuit breaker state, consecutive 429s, etc.
 *
 * @param {string} distributor - Distributor name (e.g., 'digikey', 'mouser')
 * @returns {Object} { healthy: boolean, circuitOpen: boolean, until?: Date, consecutive429s?: number }
 */
function getDistributorHealth(distributor) {
  const status = apiThrottle.checkCircuitBreaker(distributor);
  return {
    distributor,
    healthy: !status.open,
    circuitOpen: status.open,
    until: status.until || null,
    consecutive429s: status.consecutive429s || 0,
    expired: status.expired || false,
  };
}

/**
 * Get health summary for all throttled distributors.
 * Use before starting a batch to see which distributors are available.
 *
 * @returns {Object} { healthy: [...], unhealthy: [...], summary: { ... } }
 */
function getApiHealthSummary() {
  const distributors = Object.keys(apiThrottle._LIMITS);
  const healthy = [];
  const unhealthy = [];

  for (const d of distributors) {
    const status = getDistributorHealth(d);
    if (status.healthy) {
      healthy.push(d);
    } else {
      unhealthy.push(status);
    }
  }

  return {
    healthy,
    unhealthy,
    allHealthy: unhealthy.length === 0,
    summary: {
      totalDistributors: distributors.length,
      healthyCount: healthy.length,
      unhealthyCount: unhealthy.length,
    },
  };
}

/**
 * Pre-flight check before batch operations.
 * Returns warnings if any distributors are rate-limited.
 *
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.requireAll=false] - Fail if ANY distributor is unhealthy
 * @param {string[]} [opts.required=[]] - Specific distributors that must be healthy
 * @returns {Object} { ok: boolean, warnings: [...], unhealthy: [...] }
 */
function checkApiHealth(opts = {}) {
  const { requireAll = false, required = [] } = opts;
  const health = getApiHealthSummary();
  const warnings = [];

  for (const status of health.unhealthy) {
    const minLeft = status.until ? Math.ceil((status.until - Date.now()) / 60000) : '?';
    warnings.push(`${status.distributor}: circuit breaker OPEN (${status.consecutive429s} consecutive 429s, ${minLeft}min cooldown)`);
  }

  // Check if required distributors are healthy
  const missingRequired = required.filter(d => !health.healthy.includes(d));
  const ok = requireAll
    ? health.allHealthy
    : missingRequired.length === 0;

  return {
    ok,
    warnings,
    unhealthy: health.unhealthy,
    healthy: health.healthy,
    missingRequired,
  };
}

/**
 * Record a successful API call for a distributor.
 * Resets the circuit breaker counter.
 *
 * @param {string} distributor - Distributor name
 */
function recordApiSuccess(distributor) {
  apiThrottle.recordSuccess(distributor);
}

/**
 * Record a 429 rate limit error for a distributor.
 * Increments circuit breaker counter.
 *
 * @param {string} distributor - Distributor name
 */
function recordApi429(distributor) {
  apiThrottle.record429(distributor);
}

// ─── UTILITIES ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  // Main entry points
  profileMpnList,
  profileMpn,
  readCachedEnrichment,

  // Extractors
  findBestInStock,
  findBestLeadTime,
  extractAllOptions,

  // TTL rules
  getTTLForRfqType,
  TTL_BY_RFQ_TYPE,
  DEFAULT_TTL,

  // Cache utilities
  getCacheStatus,

  // Checkpoint/resume support
  saveCheckpoint,
  loadCheckpoint,
  createCheckpointCallback,

  // Distributor health (rate limiting / circuit breaker)
  getDistributorHealth,
  getApiHealthSummary,
  checkApiHealth,
  recordApiSuccess,
  recordApi429,
};
