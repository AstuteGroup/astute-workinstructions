/**
 * Shared Offer Analyzer
 *
 * Takes a chuboe_offer_id (or array of IDs for multi-offer lots) and runs the
 * full Market Offer Analysis pipeline: fetch from OT → bulk demand fetch →
 * franchise enrichment per UNIQUE MPN → score → return structured result.
 *
 * KEY PRINCIPLE: Franchise enrichment is deduplicated by MPN. If 1991 lines
 * reference 25 unique MPNs (e.g., a Sanmina lot with date code/lot detail),
 * the franchise APIs are called exactly 25 times — not 1991. The dedupe is
 * enforced INSIDE the cog so callers cannot accidentally bypass it. Same
 * applies to demand-side enrichment via getBulkMarketData.
 *
 * USAGE:
 *   const { analyzeOffer } = require('../shared/offer-analyzer');
 *
 *   const result = await analyzeOffer({
 *     offerId: 1026032,            // or [1026030, 1026032] for multi-offer lots
 *     intent: 'consignment',        // 'consignment' | 'spec_buy' | 'reactive' | null
 *     // optional knobs:
 *     franchiseConcurrency: 10,
 *     vqMonths: 12, salesMonths: 24, rfqDaysActive: 90, rfqMonthsHist: 12,
 *     onProgress: (done, total) => process.stderr.write(`\r${done}/${total}`),
 *   });
 *
 * RETURNS: structured object — no file I/O, no email, no rendering. Callers
 * (analyze-*.js wrappers, future Phase 3 inbox poller, etc.) handle output.
 */

const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const { searchAllDistributors } = require(path.join(REPO, 'shared/franchise-api'));
const { writePricingResult, extractPriceAtQty } = require(path.join(REPO, 'shared/api-result-writer'));
const { getBulkMarketData } = require(path.join(REPO, 'shared/market-data'));
const { classifyMpnNonFranchise } = require(path.join(REPO, 'shared/mpn-classifier'));

// ─── INTERNAL: SQL fetch ─────────────────────────────────────────────────────

function fetchOfferFromOT(offerIds) {
  // Fetch offer headers + lines + line MPNs + partner via psql.
  // Uses adempiere read-replica directly (no REST pagination caps).
  const idList = offerIds.map(id => parseInt(id, 10)).filter(n => !isNaN(n)).join(',');
  if (!idList) throw new Error('analyzeOffer: no valid offerId(s) provided');

  // Header(s) + partner
  const headerSql = `SELECT o.chuboe_offer_id, o.value, o.description, o.created::text, ` +
                    `bp.c_bpartner_id, bp.value, bp.name, ot.name ` +
                    `FROM adempiere.chuboe_offer o ` +
                    `JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id ` +
                    `LEFT JOIN adempiere.chuboe_offer_type ot ON ot.chuboe_offer_type_id = o.chuboe_offer_type_id ` +
                    `WHERE o.chuboe_offer_id IN (${idList}) AND o.isactive = 'Y'`;
  // Use ASCII Unit Separator (\x1f, never appears in real text) so descriptions
  // containing | / , / tab don't break field splitting. Bash needed for $'...' quoting.
  const headerRaw = execSync(`psql -t -A -F $'\\x1f' -c "${headerSql}"`, { encoding: 'utf-8', shell: '/bin/bash' });
  const offers = headerRaw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('rbash') && !l.includes('/dev/null') && !l.includes('/tmp/claude'))
    .map(line => {
      const [offerId, searchKey, description, created, bpId, bpKey, bpName, offerType] = line.split('\x1f');
      return {
        offerId: parseInt(offerId, 10),
        searchKey: searchKey || '',
        description: description || '',
        created: created || '',
        offerType: offerType || '',
        partner: { id: parseInt(bpId, 10), search_key: bpKey || '', name: bpName || '' },
      };
    });

  if (offers.length === 0) {
    throw new Error(`analyzeOffer: no active offers found for IDs ${idList}`);
  }

  // Lines (joined to line_mpn for canonical mpn_clean)
  const lineSql = `SELECT ol.chuboe_offer_id, ol.chuboe_offer_line_id, ol.line, ` +
                  `ol.chuboe_mpn, ol.chuboe_mpn_clean, ol.qty, ol.priceentered, ` +
                  `ol.description, ol.chuboe_cpc, ol.chuboe_date_code, ol.chuboe_mfr_text ` +
                  `FROM adempiere.chuboe_offer_line ol ` +
                  `WHERE ol.chuboe_offer_id IN (${idList}) AND ol.isactive = 'Y' ` +
                  `ORDER BY ol.chuboe_offer_id, ol.line`;
  const linesRaw = execSync(`psql -t -A -F $'\\x1f' -c "${lineSql}"`, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, shell: '/bin/bash' });
  const lines = linesRaw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('rbash') && !l.includes('/dev/null') && !l.includes('/tmp/claude'))
    .map(line => {
      const [offerId, lineId, lineNum, mpn, mpnClean, qty, price, description, cpc, dateCode, mfrText] = line.split('\x1f');
      return {
        offerId: parseInt(offerId, 10),
        lineId: parseInt(lineId, 10),
        lineNum: parseInt(lineNum, 10),
        mpn: mpn || '',
        mpnClean: mpnClean || '',
        qty: qty ? parseFloat(qty) : null,
        price: price ? parseFloat(price) : null,
        description: description || '',
        cpc: cpc || '',
        dateCode: dateCode || '',
        mfrText: mfrText || '',
      };
    })
    .filter(l => !isNaN(l.lineId));

  return { offers, lines };
}

// ─── INTERNAL: Per-MPN franchise enrichment with parallel batches ────────────

// Reconstruct a franchise summary object from cached extractPriceAtQty results.
// Used when we have recent cache data and don't need to re-call the live APIs.
function summaryFromCache(mpn, qty, cachedRows) {
  const carrying = cachedRows.length;
  const inStock = cachedRows.filter(c => (c.stock || 0) > 0);
  const totalStock = inStock.reduce((s, c) => s + (c.stock || 0), 0);
  // Use bulkPrice (or priceAtQty fallback) across ALL carrying distributors
  // — same semantic as the new franchise-api.js lowestPrice field.
  const allPrices = cachedRows
    .map(c => c.bulkPrice != null ? c.bulkPrice : c.priceAtQty)
    .filter(p => p != null && p > 0);
  return {
    mpn, qty, totalStock,
    distributorsWithStock: inStock.length,
    distributorsCarrying: carrying,
    distributorsChecked: carrying, // can't distinguish "not asked" from "asked and not found" in cache
    lowestPrice: allPrices.length > 0 ? Math.min(...allPrices) : null,
    highestPrice: allPrices.length > 0 ? Math.max(...allPrices) : null,
    coverage: totalStock >= qty ? 'FULL' : totalStock > 0 ? 'PARTIAL' : 'NONE',
    coveragePct: qty > 0 ? Math.round(totalStock / qty * 100) : 0,
  };
}

async function enrichMpnsParallel(uniqueMpns, qtyByMpn, options) {
  const concurrency = options.franchiseConcurrency || 10;
  const cacheMaxAgeDays = options.cacheMaxAgeDays || 14;
  const onProgress = options.onProgress || (() => {});
  const results = new Map(); // mpn → { summary, source }
  let processed = 0;

  for (let bs = 0; bs < uniqueMpns.length; bs += concurrency) {
    const batch = uniqueMpns.slice(bs, bs + concurrency);
    const batchResults = await Promise.all(batch.map(async (mpn) => {
      const qty = qtyByMpn.get(mpn) || 1;

      // Cache-first: try extractPriceAtQty before calling live APIs.
      // Cache freshness window is configurable (default 14 days). This makes
      // back-to-back runs against the same offer return identical results,
      // and avoids hammering franchise APIs unnecessarily.
      try {
        const cached = extractPriceAtQty(mpn, qty, { maxAgeDays: cacheMaxAgeDays });
        if (cached && cached.length > 0) {
          return { mpn, summary: summaryFromCache(mpn, qty, cached), source: 'cache' };
        }
      } catch (_) { /* fall through to live API */ }

      try {
        const result = await searchAllDistributors(mpn, qty);
        // Fire-and-forget cache write so the next run benefits
        writePricingResult({
          searchResult: result,
          mpn,
          qty,
          source: 'shared-offer-analyzer',
        }).catch(() => { /* cache writes are non-blocking */ });
        return { mpn, summary: result.summary, source: 'api' };
      } catch (err) {
        return {
          mpn,
          summary: {
            mpn, qty, totalStock: 0,
            distributorsCarrying: 0, distributorsWithStock: 0,
            lowestPrice: null, coverage: 'NONE', coveragePct: 0,
          },
          source: 'error',
          error: err.message,
        };
      }
    }));
    for (const r of batchResults) {
      results.set(r.mpn, r);
      processed++;
    }
    onProgress(processed, uniqueMpns.length);
  }
  return results;
}

// ─── INTERNAL: Three-state classification + scoring ──────────────────────────

function franchiseStateOf(line, summary) {
  if (!summary) return 'NO_LISTING_UNKNOWN';
  if (summary.distributorsWithStock > 0) return 'IN_STOCK';
  if ((summary.distributorsCarrying || 0) > 0) return 'FRANCHISE_OUT_OF_STOCK';
  // Franchise truly has no listing — sub-classify by MPN pattern.
  // Note: this only fires when franchise APIs returned successfully but with
  // zero results. If franchise call ERRORED (summary still has the empty
  // shape with totalStock=0 etc.), we also land here. The classifier uses
  // the MPN string + (optional) CPC to bucket into INTERNAL / MILSPEC / UNKNOWN.
  return classifyMpnNonFranchise(line.mpn, line.mfrText, line.cpc);
}

function scoreSupply(state, summary, offeredQty) {
  if (state === 'NO_LISTING_INTERNAL' ||
      state === 'NO_LISTING_MILSPEC'  ||
      state === 'NO_LISTING_UNKNOWN') {
    return null;
  }
  let score = 0;
  if (state === 'FRANCHISE_OUT_OF_STOCK') score += 12;
  if (offeredQty > 0 && summary.totalStock < offeredQty) score += 8;
  if (offeredQty > 0 && summary.totalStock < 2 * offeredQty &&
      summary.totalStock >= offeredQty)                      score += 4;
  if (summary.distributorsWithStock >= 3 && offeredQty > 0 &&
      summary.totalStock > 10 * offeredQty)                  score -= 10;
  return Math.max(0, Math.min(40, score));
}

function scoreDemand(demand) {
  let score = 0;
  if (demand.activeRfqCount > 0) score += 10;
  if (demand.activeRfqCount >= 3) score += 5;
  if (demand.brokerSaleCount > 0 || demand.customerSaleCount > 0) score += 7;
  return Math.max(0, Math.min(25, score));
}

/**
 * Resolve a "best comparable" price for a part from any available signal.
 * Used to score price advantage when the customer gives us a price even
 * though franchise has no stock — we can still compare against catalog
 * pricing, broker sales, customer sales, or RFQ targets.
 *
 * Priority order (most reliable first):
 *   1. Franchise catalog lowest price (works even when stock = 0 because
 *      franchise-api now exposes lowestPrice across ALL carrying distributors)
 *   2. Most recent broker sale price (broker sales are strong market signal)
 *   3. Most recent customer sale price
 *   4. Most recent RFQ target price (weakest — what buyers asked for, not what they paid)
 *
 * Returns { price, source, ageDays } or null if nothing available.
 */
function resolveBestComparable(franchise, demand) {
  // 1. Franchise catalog price (stocked OR catalog-only, exposed on summary.lowestPrice)
  if (franchise && franchise.lowestPrice != null && franchise.lowestPrice > 0) {
    return { price: franchise.lowestPrice, source: 'franchise', ageDays: 0 };
  }
  // 2. Most recent broker sale (from historicalSales array, filtered to broker)
  const brokerSale = (demand.historicalSales || []).find(s => s.isBroker && s.soldPrice > 0);
  if (brokerSale) {
    return { price: brokerSale.soldPrice, source: 'broker_sale', ageDays: brokerSale.ageDays };
  }
  // 3. Most recent customer sale
  const custSale = (demand.historicalSales || []).find(s => !s.isBroker && s.soldPrice > 0);
  if (custSale) {
    return { price: custSale.soldPrice, source: 'customer_sale', ageDays: custSale.ageDays };
  }
  // 4. Most recent RFQ with a target price
  const rfqTarget = (demand.historicalRfqs || []).find(r => r.targetPrice && r.targetPrice > 0);
  if (rfqTarget) {
    return { price: rfqTarget.targetPrice, source: 'rfq_target', ageDays: rfqTarget.ageDays };
  }
  return null;
}

/**
 * Price advantage score (0-35). Compares the offered price against the best
 * available comparable, regardless of whether franchise has stock. Per the
 * workflow doc:
 *   < 5% of comparable    → +30 + VERIFY flag (suspiciously cheap)
 *   5-10%                 → +30 (strong buy)
 *   10-15%                → +25 (good buy)
 *   15-20%                → +18 (decent)
 *   20-25%                → +8 (marginal)
 *   25-30%                → +3 (break-even)
 *   > 30%                 → 0 (no value)
 *
 * Returns { score, ratio, flag } or null if either side is missing.
 */
function scorePriceAdvantage(offeredPrice, comparable) {
  if (offeredPrice == null || offeredPrice <= 0) return null;
  if (!comparable || comparable.price == null || comparable.price <= 0) return null;
  const ratio = offeredPrice / comparable.price;
  let score = 0;
  let flag = null;
  if (ratio < 0.05)        { score = 30; flag = 'VERIFY'; }
  else if (ratio < 0.10)   { score = 30; }
  else if (ratio < 0.15)   { score = 25; }
  else if (ratio < 0.20)   { score = 18; }
  else if (ratio < 0.25)   { score = 8; }
  else if (ratio < 0.30)   { score = 3; }
  else                     { score = 0; }
  return { score, ratio, flag };
}

function tierForScore(rawScore, maxScore) {
  if (rawScore == null) return 'UNSCORED';
  const normalized = (rawScore / maxScore) * 100;
  if (normalized >= 70) return 'HOT';
  if (normalized >= 40) return 'WARM';
  if (normalized >= 20) return 'COOL';
  return 'SKIP';
}

// ─── INTERNAL: Stub intent inference (replace with classifier later) ─────────

function inferIntent(offers, lines) {
  // Stub: any explicit type that screams consignment, otherwise default reactive.
  // Real classifier (rules-based + override) goes here in a follow-up.
  for (const o of offers) {
    if (o.offerType === 'LAM Kitting Inventory') return 'consignment';
    const desc = (o.description || '').toLowerCase();
    if (/rev[-\s]?share|revshare|e&o|buyback|buy.back/.test(desc)) return 'consignment';
  }
  // If lots of lines and no offered prices, lean consignment
  const withPrice = lines.filter(l => l.price != null).length;
  if (lines.length > 50 && withPrice / lines.length < 0.5) return 'consignment';
  return 'reactive';
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Analyze one or more offers in OT.
 *
 * @param {object} opts
 * @param {number|number[]} opts.offerId - chuboe_offer_id (single or array)
 * @param {string} [opts.intent] - 'consignment' | 'spec_buy' | 'reactive' | null=infer
 * @param {number} [opts.franchiseConcurrency=10] - parallel franchise API calls
 * @param {number} [opts.vqMonths=12]
 * @param {number} [opts.salesMonths=24]
 * @param {number} [opts.rfqDaysActive=90]
 * @param {number} [opts.rfqMonthsHist=12]
 * @param {function} [opts.onProgress] - (done, totalUniqueMpns) progress callback
 * @returns {Promise<object>} structured analysis result (see header doc)
 */
async function analyzeOffer(opts) {
  const t0 = Date.now();
  const offerIds = Array.isArray(opts.offerId) ? opts.offerId : [opts.offerId];
  if (offerIds.length === 0) throw new Error('analyzeOffer: offerId is required');

  // ── Step 1: Fetch from OT ──
  const tFetch = Date.now();
  const { offers, lines } = fetchOfferFromOT(offerIds);
  const fetchMs = Date.now() - tFetch;
  if (lines.length === 0) {
    throw new Error(`analyzeOffer: no lines found for offer(s) ${offerIds.join(',')}`);
  }

  // ── Step 2: Resolve intent ──
  const intent = opts.intent || inferIntent(offers, lines);

  // ── Step 3a: Build unique MPN set + canonical qty per MPN ──
  // For franchise enrichment we use the MAX qty across all lines sharing the
  // same MPN — this gives the best signal for "is there enough franchise
  // stock to cover this offer." Could also use sum; max is more conservative.
  const uniqueMpnSet = new Set();
  const qtyByMpn = new Map();
  for (const l of lines) {
    if (!l.mpn) continue;
    uniqueMpnSet.add(l.mpn);
    const existing = qtyByMpn.get(l.mpn) || 0;
    if ((l.qty || 0) > existing) qtyByMpn.set(l.mpn, l.qty || 0);
  }
  const uniqueMpns = Array.from(uniqueMpnSet);

  // ── Step 3b: Bulk demand fetch (one psql round-trip for all unique MPNs) ──
  const tDemand = Date.now();
  const uniqueMpnCleans = Array.from(new Set(lines.map(l => l.mpnClean).filter(Boolean)));
  const demandMap = getBulkMarketData(uniqueMpnCleans, {
    vqMonths: opts.vqMonths || 12,
    salesMonths: opts.salesMonths || 24,
    rfqDaysActive: opts.rfqDaysActive || 90,
    rfqMonthsHist: opts.rfqMonthsHist || 12,
  });
  const demandMs = Date.now() - tDemand;

  // ── Step 3c: Franchise enrichment per UNIQUE MPN ──
  // This is the dedupe enforcement. uniqueMpns.length API calls,
  // not lines.length. Sanmina case: 25 calls instead of 1991.
  const tFranchise = Date.now();
  const franchiseMap = await enrichMpnsParallel(uniqueMpns, qtyByMpn, opts);
  const franchiseMs = Date.now() - tFranchise;

  // ── Step 3d: Build the per-MPN enrichment view ──
  // One entry per unique MPN combining franchise + demand + canonical state.
  // Wrappers can render this directly for "25 unique parts" headline views.
  const perMpnEnrichment = new Map();
  for (const mpn of uniqueMpns) {
    const franchise = franchiseMap.get(mpn) || { summary: null, source: 'missing' };
    // Find a representative line for state classification. Prefer a line with
    // CPC populated so the classifier can see the CPC↔MPN relationship even
    // when the loader used a per-CPC anchor pattern that leaves most rows
    // with empty CPC. Falls back to the first matching line if none has CPC.
    const repLine = lines.find(l => l.mpn === mpn && l.cpc)
                 || lines.find(l => l.mpn === mpn)
                 || { mpn, mfrText: '', cpc: '' };
    const state = franchiseStateOf(repLine, franchise.summary);
    // Demand is keyed by mpn_clean — find the clean version for this MPN
    const repClean = repLine.mpnClean || '';
    const demandRaw = demandMap.get(repClean) || {};
    const demand = {
      vqCount: demandRaw.vqCount || 0,
      brokerSaleCount: demandRaw.brokerSaleCount || 0,
      customerSaleCount: demandRaw.customerSaleCount || 0,
      activeRfqCount: demandRaw.activeRfqCount || 0,
      historicalRfqCount: demandRaw.historicalRfqCount || 0,
      demandStrength: demandRaw.demandStrength || 'NONE',
      topBuyers: demandRaw.topBuyers || [],
      // Detail rows from Queries 5 & 6 — surfaced so wrappers can show
      // actual customer/qty/price/date instead of just counts
      historicalRfqs: demandRaw.historicalRfqs || [],
      historicalSales: demandRaw.historicalSales || [],
    };
    // Resolve best comparable price from any signal in priority order:
    // franchise catalog → broker sale → customer sale → RFQ target.
    // Used for price advantage scoring even when franchise has no stock.
    const bestComparable = resolveBestComparable(franchise.summary, demand);
    perMpnEnrichment.set(mpn, {
      mpn,
      mpnClean: repClean,
      mfrText: repLine.mfrText,
      cpc: repLine.cpc,
      franchise: franchise.summary,
      franchiseSource: franchise.source,
      state,
      demand,
      bestComparable,
    });
  }

  // ── Step 4: Walk every line, attach the per-MPN enrichment, score ──
  // Three categories: Supply (0-40), Price Advantage (0-35), Demand (0-25).
  // Max 100. supplyScore is null on NO_LISTING_* lines (insufficient franchise
  // data). priceScore is null when there's no offered price OR no comparable.
  // The total rawScore sums whichever components are non-null. Tier thresholds
  // scale to the max possible for the available components.
  const tScore = Date.now();
  const enrichedLines = lines.map(line => {
    const mpnEnrichment = perMpnEnrichment.get(line.mpn) || {
      franchise: null, state: 'NO_LISTING_UNKNOWN', bestComparable: null,
      demand: { vqCount: 0, brokerSaleCount: 0, customerSaleCount: 0, activeRfqCount: 0,
                historicalRfqCount: 0, demandStrength: 'NONE', topBuyers: [],
                historicalRfqs: [], historicalSales: [] },
    };
    const supplyScore = scoreSupply(mpnEnrichment.state, mpnEnrichment.franchise, line.qty || 0);
    const priceAdv = scorePriceAdvantage(line.price, mpnEnrichment.bestComparable);
    const priceScore = priceAdv ? priceAdv.score : null;
    const demandScore = scoreDemand(mpnEnrichment.demand);
    // rawScore = sum of non-null components. supplyScore null → exclude that
    // axis. priceScore null → exclude that axis. demandScore is always 0+.
    const components = [supplyScore, priceScore, demandScore].filter(s => s != null);
    const rawScore = components.length > 0 ? components.reduce((a, b) => a + b, 0) : null;
    // maxScore is the sum of MAX possible for each non-null axis (40 supply +
    // 35 price + 25 demand = 100; or 25 if only demand applies, etc.)
    const maxScore =
      (supplyScore != null ? 40 : 0) +
      (priceScore != null ? 35 : 0) +
      25; // demand always counts
    const tier = tierForScore(rawScore, maxScore);

    return {
      ...line,
      franchise: mpnEnrichment.franchise,
      franchiseSource: mpnEnrichment.franchiseSource,
      state: mpnEnrichment.state,
      demand: mpnEnrichment.demand,
      bestComparable: mpnEnrichment.bestComparable,
      supplyScore,
      priceScore,
      priceAdvantage: priceAdv, // { score, ratio, flag } or null
      demandScore,
      rawScore,
      maxScore,
      tier,
      flags: [
        ...(line.price == null ? ['NO_OFFER_PRICE'] : []),
        mpnEnrichment.state,
        ...(priceAdv && priceAdv.flag ? [priceAdv.flag] : []),
        ...(mpnEnrichment.demand.activeRfqCount > 0 ? ['ACTIVE_RFQ'] : []),
        ...(mpnEnrichment.demand.brokerSaleCount + mpnEnrichment.demand.customerSaleCount > 0 ? ['HAS_SO_HISTORY'] : []),
      ],
    };
  });
  const scoreMs = Date.now() - tScore;

  // ── Step 5: Aggregate stats ──
  const stats = {
    IN_STOCK: 0, FRANCHISE_OUT_OF_STOCK: 0,
    NO_LISTING_INTERNAL: 0, NO_LISTING_MILSPEC: 0, NO_LISTING_UNKNOWN: 0,
    tier: { HOT: 0, WARM: 0, COOL: 0, SKIP: 0, UNSCORED: 0 },
    activeRfq: 0, priorSo: 0, zeroDemand: 0,
    // Per-unique-MPN tier breakdown — what most analyses care about
    uniqueMpnTier: { HOT: 0, WARM: 0, COOL: 0, SKIP: 0, UNSCORED: 0 },
  };
  // Per-line stats
  for (const e of enrichedLines) {
    stats[e.state] = (stats[e.state] || 0) + 1;
    stats.tier[e.tier] = (stats.tier[e.tier] || 0) + 1;
    if (e.demand.activeRfqCount > 0) stats.activeRfq++;
    if (e.demand.brokerSaleCount + e.demand.customerSaleCount > 0) stats.priorSo++;
    if (e.demand.activeRfqCount === 0 && e.demand.brokerSaleCount + e.demand.customerSaleCount === 0) stats.zeroDemand++;
  }
  // Per-unique-MPN tier (so wrappers can headline "25 parts: 4 HOT, 8 WARM..." regardless of line count)
  for (const m of perMpnEnrichment.values()) {
    // Use the first matching enriched line's tier (they should all match for the same MPN's
    // state and demand; supply scoring varies only by per-line qty)
    const sample = enrichedLines.find(l => l.mpn === m.mpn);
    if (sample) stats.uniqueMpnTier[sample.tier] = (stats.uniqueMpnTier[sample.tier] || 0) + 1;
  }

  return {
    offers,
    intent,
    lineCount: lines.length,
    uniqueMpnCount: uniqueMpns.length,
    perMpnEnrichment,
    enrichedLines,
    stats,
    timing: {
      fetchMs,
      demandMs,
      franchiseMs,
      scoreMs,
      totalMs: Date.now() - t0,
    },
  };
}

module.exports = {
  analyzeOffer,
  // Exported for testing / potential reuse
  franchiseStateOf,
  scoreSupply,
  scoreDemand,
  tierForScore,
  inferIntent,
};
