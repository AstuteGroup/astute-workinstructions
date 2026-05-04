/**
 * Centralized Market Data Queries
 *
 * Database queries for pricing intelligence across all workflows.
 * Queries VQ history, sales history, market offers, and RFQ demand.
 *
 * USAGE:
 *   const { getVQHistory, getSalesHistory, getMarketOffers, getRFQDemand, getAllMarketData } = require('../shared/market-data');
 *
 *   // Get everything for a part
 *   const data = getAllMarketData('ADS1115IDGST', { vqMonths: 12, salesMonths: 24 });
 *
 *   // Or individual queries
 *   const vqs = getVQHistory('ADS1115IDGST');
 *   const sales = getSalesHistory('ADS1115IDGST');
 *
 * CONSUMERS:
 *   - Suggested Resale: full market picture for pricing
 *   - Quick Quote: VQ costs + sales history for quote generation
 *   - Vortex Matches: demand signals + offer matching
 *   - Market Offer Analysis: RFQ demand + offer cross-reference
 *
 * NOTE: MPN inputs should be "cleaned" (no dashes/spaces/colons/commas, uppercase).
 *       Use cleanMpn() from this module or pass pre-cleaned values.
 */

const { execSync } = require('child_process');
const { isInfrastructureError } = require('./db-helpers');

// --- Config ---
const DEFAULTS = {
  vqMonths: 12,
  salesMonths: 24,
  offerDays: 180,
  rfqMonths: 12,
};

// --- Helpers ---

function psql(query) {
  try {
    // -U analytics_user is required under cron (cron doesn't pass $USER)
    const result = execSync(`psql -U analytics_user -t -A -F '|' -c "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30000
    });
    return parsePsqlOutput(result);
  } catch (e) {
    // Re-throw infrastructure errors so callers can't confuse "broken
    // lookup" with "no rows." See db-helpers.isInfrastructureError.
    if (isInfrastructureError(e)) throw e;
    const combined = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    return parsePsqlOutput(combined);
  }
}

function parsePsqlOutput(raw) {
  if (!raw) return [];
  const noise = ['rbash', 'bashrc', '/dev/null', 'restricted:', 'syntax error', '/tmp/claude'];
  return raw.split('\n')
    .filter(l => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('ERROR:') || trimmed.startsWith('HINT:') || trimmed.startsWith('LINE')) return false;
      return !noise.some(n => trimmed.includes(n));
    })
    .map(line => line.split('|'));
}

/**
 * Clean an MPN for database matching
 * Removes dashes, spaces, slashes, dots, colons, commas. Uppercases.
 */
function cleanMpn(mpn) {
  return mpn.replace(/[-\s\/.:,]/g, '').toUpperCase();
}

/**
 * Get base MPN by stripping packaging suffixes (REEL, TRAY, BULK, etc.)
 * Returns null if no suffix found.
 */
function getBaseMpn(mpnClean) {
  const suffixes = ['REEL', 'TRAY', 'BULK', 'TR', 'CT', 'DKR', 'TU'];
  for (const suffix of suffixes) {
    if (mpnClean.endsWith(suffix) && mpnClean.length > suffix.length + 3) {
      return mpnClean.slice(0, -suffix.length);
    }
  }
  return null;
}

/**
 * Build SQL WHERE clause that matches both exact and base MPN
 */
function mpnWhereClause(column, mpnClean) {
  const base = getBaseMpn(mpnClean);
  if (base && base !== mpnClean) {
    return `(${column} ILIKE '${mpnClean}%' OR ${column} ILIKE '${base}%')`;
  }
  return `${column} ILIKE '${mpnClean}%'`;
}

// --- Data Queries ---

/**
 * VQ History — secondary market pricing (what brokers are quoting)
 */
function getVQHistory(mpnClean, options = {}) {
  const months = options.months || DEFAULTS.vqMonths;
  const rows = psql(`
    SELECT vendor_quote_mpn_clean, vendor_quote_cost, vendor_quote_quantity,
           vendor_quote_bpartner_name, vendor_quote_created::date,
           vendor_quote_date_code, vendor_quote_purchased
    FROM adempiere.bi_vendor_quote_line_v
    WHERE ${mpnWhereClause('vendor_quote_mpn_clean', mpnClean)}
    AND vendor_quote_created >= CURRENT_DATE - INTERVAL '${months} months'
    AND vendor_quote_cost > 0
    ORDER BY vendor_quote_created DESC LIMIT 20
  `);
  return rows.map(r => ({
    mpn: r[0], cost: parseFloat(r[1]), qty: parseInt(r[2]),
    vendor: r[3], date: r[4], dc: r[5], purchased: r[6] === 'Y'
  }));
}

/**
 * Summarize VQ data into key metrics
 */
function summarizeVQs(vqs) {
  const costs = vqs.map(v => v.cost).filter(c => c > 0);
  const purchased = vqs.filter(v => v.purchased);
  if (costs.length === 0) return null;

  const sorted = [...costs].sort((a, b) => a - b);
  return {
    count: costs.length,
    low: Math.min(...costs),
    high: Math.max(...costs),
    median: sorted[Math.floor(sorted.length / 2)],
    purchasedCost: purchased.length > 0 ? purchased[0].cost : null,
    purchasedVendor: purchased.length > 0 ? purchased[0].vendor : null,
    purchasedDate: purchased.length > 0 ? purchased[0].date : null,
  };
}

/**
 * Market Offers — customer excess, broker stock, warehouse inventory
 */
function getMarketOffers(mpnClean, options = {}) {
  const days = options.days || DEFAULTS.offerDays;
  const rows = psql(`
    SELECT ol.chuboe_mpn_clean, ol.qty, ol.priceentered,
           bp.name as partner, ot.name as offer_type,
           o.created::date, ol.chuboe_date_code,
           bp.isvendor, bp.iscustomer
    FROM adempiere.chuboe_offer_line ol
    JOIN adempiere.chuboe_offer o ON ol.chuboe_offer_id = o.chuboe_offer_id
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    JOIN adempiere.chuboe_offer_type ot ON o.chuboe_offer_type_id = ot.chuboe_offer_type_id
    WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
    AND o.chuboe_offer_type_id <> 1000025  -- exclude LAM Kitting Inventory (LAM consigned, not ours)
    AND ${mpnWhereClause('ol.chuboe_mpn_clean', mpnClean)}
    AND o.created >= CURRENT_DATE - INTERVAL '${days} days'
    ORDER BY o.created DESC LIMIT 15
  `);
  return rows.map(r => ({
    mpn: r[0], qty: parseInt(r[1]), price: parseFloat(r[2]) || 0,
    partner: r[3], offerType: r[4], date: r[5], dc: r[6],
    isVendor: r[7] === 'Y', isCustomer: r[8] === 'Y'
  }));
}

/**
 * Sales History — actual transactions. Broker sales (isVendor=Y) are stronger signals.
 */
function getSalesHistory(mpnClean, options = {}) {
  const months = options.months || DEFAULTS.salesMonths;
  const rows = psql(`
    SELECT sol.chuboe_mpn as mpn, so.dateordered::date, bp.name as customer,
           sol.priceentered as unit_price, sol.qtyentered as qty,
           bp.isvendor, bp.iscustomer,
           g.name as bp_group
    FROM adempiere.c_order so
    JOIN adempiere.c_orderline sol ON so.c_order_id = sol.c_order_id
    JOIN adempiere.c_bpartner bp ON so.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.c_bp_group g ON bp.c_bp_group_id = g.c_bp_group_id
    WHERE so.isactive = 'Y' AND sol.isactive = 'Y'
    AND so.issotrx = 'Y' AND so.docstatus IN ('IP','CO','CL')
    AND so.ad_client_id = 1000000
    AND so.dateordered >= CURRENT_DATE - INTERVAL '${months} months'
    AND sol.chuboe_mpn IS NOT NULL
    AND ${mpnWhereClause("UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(sol.chuboe_mpn, '-', ''), ' ', ''), '/', ''), ':', ''), ',', ''))", mpnClean)}
    ORDER BY so.dateordered DESC LIMIT 15
  `);
  return rows.map(r => ({
    mpn: r[0], date: r[1], customer: r[2],
    price: parseFloat(r[3]) || 0, qty: parseInt(r[4]) || 0,
    isVendor: r[5] === 'Y', isCustomer: r[6] === 'Y',
    bpGroup: r[7] || '',
    isBrokerSale: r[5] === 'Y'
  }));
}

/**
 * RFQ Demand — recent demand signals with customer/type detail
 */
function getRFQDemand(mpnClean, options = {}) {
  const months = options.months || DEFAULTS.rfqMonths;
  const rows = psql(`
    SELECT m.chuboe_mpn_clean, rl.qty, rl.priceentered as target,
           bp.name as customer, rt.name as rfq_type, r.created::date,
           bp.isvendor
    FROM adempiere.chuboe_rfq_line_mpn m
    JOIN adempiere.chuboe_rfq_line rl ON m.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    WHERE m.isactive = 'Y' AND rl.isactive = 'Y' AND r.isactive = 'Y'
    AND ${mpnWhereClause('m.chuboe_mpn_clean', mpnClean)}
    AND r.created >= CURRENT_DATE - INTERVAL '${months} months'
    ORDER BY r.created DESC LIMIT 15
  `);
  return rows.map(r => ({
    mpn: r[0], qty: parseInt(r[1]) || 0, target: parseFloat(r[2]) || 0,
    customer: r[3], rfqType: r[4], date: r[5], isVendor: r[6] === 'Y'
  }));
}

/**
 * RFQ Count — all-time demand volume
 */
function getRFQCount(mpnClean) {
  const rows = psql(`
    SELECT COUNT(*), MIN(r.created::date), MAX(r.created::date)
    FROM adempiere.chuboe_rfq_line_mpn m
    JOIN adempiere.chuboe_rfq_line rl ON m.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    WHERE m.isactive = 'Y' AND rl.isactive = 'Y' AND r.isactive = 'Y'
    AND ${mpnWhereClause('m.chuboe_mpn_clean', mpnClean)}
  `);
  if (rows.length && rows[0].length >= 3) {
    return { count: parseInt(rows[0][0]) || 0, earliest: rows[0][1], latest: rows[0][2] };
  }
  return { count: 0, earliest: null, latest: null };
}

/**
 * Demand strength classification
 */
function getDemandStrength(count) {
  if (count >= 50) return 'HIGH';
  if (count >= 10) return 'MEDIUM';
  if (count >= 3) return 'LOW';
  return 'NONE';
}

/**
 * Get ALL market data for an MPN in one call
 */
function getAllMarketData(mpn, options = {}) {
  const mpnClean = typeof mpn === 'string' && mpn === mpn.toUpperCase() && !mpn.includes('-')
    ? mpn  // already cleaned
    : cleanMpn(mpn);

  const vqs = getVQHistory(mpnClean, options);
  const vqSummary = summarizeVQs(vqs);
  const offers = getMarketOffers(mpnClean, options);
  const sales = getSalesHistory(mpnClean, options);
  const rfqDemand = getRFQDemand(mpnClean, options);
  const rfqCount = getRFQCount(mpnClean);
  const demandStrength = getDemandStrength(rfqCount.count);

  const brokerSales = sales.filter(s => s.isBrokerSale && s.price > 0);
  const customerSales = sales.filter(s => !s.isBrokerSale && s.price > 0);
  const pricedOffers = offers.filter(o => o.price > 0);

  return {
    mpnClean,
    vqs,
    vqSummary,
    offers,
    pricedOffers,
    sales,
    brokerSales,
    customerSales,
    rfqDemand,
    rfqCount,
    demandStrength,
    // Quick-access fields
    bestBrokerSale: brokerSales.length > 0 ? brokerSales[0] : null,
    bestCustomerSale: customerSales.length > 0 ? customerSales[0] : null,
    offerPriceRange: pricedOffers.length > 0
      ? { low: Math.min(...pricedOffers.map(o => o.price)), high: Math.max(...pricedOffers.map(o => o.price)) }
      : null,
  };
}

// ─── BULK / BATCH QUERIES ────────────────────────────────────────────────────

/**
 * Bulk-fetch demand signals for many MPNs in a single set of psql round-trips.
 *
 * **Use this** when you need market data for a SET of MPNs (e.g., a 500-line
 * Market Offer Analysis run, a Vortex Matches batch, BOM Monitoring scoring).
 * It runs 4 bulk queries (VQ + Sales + Offers + RFQ counts) and joins back to
 * the MPN list, returning a Map keyed by mpn_clean.
 *
 * **Use `getAllMarketData()` instead** when you need rich per-MPN detail
 * (full VQ history, full sales rows, full offer rows) for a single MPN —
 * the bulk version trades raw rows for aggregates to keep payload small.
 *
 * Performance: 538 MPNs in ~12 seconds vs ~9 hours for the per-MPN loop.
 *
 * @param {string[]} mpnCleans  - Array of pre-cleaned MPN strings (use `cleanMpn()` if uncertain)
 * @param {object}   [options]
 * @param {number}   [options.vqMonths=12]   - VQ history window
 * @param {number}   [options.salesMonths=24]- SO history window
 * @param {number}   [options.offerDays=180] - Offer window
 * @param {number}   [options.rfqDaysActive=90] - "Active" RFQ window
 * @param {number}   [options.rfqMonthsHist=12] - Historical RFQ window
 * @param {number}   [options.topBuyers=5]   - How many historical buyer names to keep per MPN
 * @returns {Map<string, BulkMarketRecord>}
 *
 * BulkMarketRecord shape (one per MPN, all fields default to 0/null/empty):
 * {
 *   mpnClean,
 *   vqCount, vqSummary: { count, low, high, median },
 *   brokerSaleCount, customerSaleCount, lastBrokerSalePrice, lastCustomerSalePrice,
 *   offerCount, offerPriceLow, offerPriceHigh,
 *   activeRfqCount,        // last `rfqDaysActive` days
 *   historicalRfqCount,    // last `rfqMonthsHist` months
 *   demandStrength,        // HIGH / MEDIUM / LOW / NONE — derived from historicalRfqCount
 *   topBuyers: [{name, isBroker}],   // top N customers by SO frequency, broker-flagged
 *
 *   // Detail rows (top N most recent per MPN, for "show me actual matches" UI):
 *   historicalRfqs: [{ rfqSearchKey, customer, rfqType, qty, targetPrice, date, isVendor, ageDays }],
 *   historicalSales: [{ customer, qty, soldPrice, date, isBroker, ageDays }],
 * }
 *
 * Match semantics: EXACT equality on `chuboe_mpn_clean`. Partial / suffix-variant
 * matching (which the per-MPN ILIKE versions do) is NOT supported here — fall
 * back to per-MPN `getAllMarketData()` for that. The exact-match constraint is
 * what makes the bulk version fast (indexed lookup vs full table scan).
 */
function getBulkMarketData(mpnCleans, options = {}) {
  const vqMonths      = options.vqMonths      || DEFAULTS.vqMonths;
  const salesMonths   = options.salesMonths   || DEFAULTS.salesMonths;
  const offerDays     = options.offerDays     || DEFAULTS.offerDays;
  const rfqDaysActive = options.rfqDaysActive || 90;
  const rfqMonthsHist = options.rfqMonthsHist || DEFAULTS.rfqMonths;
  const topBuyers     = options.topBuyers     || 5;

  // Initialize result map with empty records for every requested MPN
  const result = new Map();
  for (const m of mpnCleans) {
    if (!m) continue;
    result.set(m, {
      mpnClean: m,
      vqCount: 0,
      vqSummary: null,
      brokerSaleCount: 0,
      customerSaleCount: 0,
      lastBrokerSalePrice: null,
      lastCustomerSalePrice: null,
      offerCount: 0,
      offerPriceLow: null,
      offerPriceHigh: null,
      activeRfqCount: 0,
      historicalRfqCount: 0,
      demandStrength: 'NONE',
      topBuyers: [],
      historicalRfqs: [],   // populated by Query 5 — actual RFQ row detail
      historicalSales: [],  // populated by Query 6 — actual SO row detail
    });
  }

  if (result.size === 0) return result;

  // Build the VALUES list shared across queries. Single quote escaping.
  const valuesList = Array.from(result.keys())
    .map(m => `('${m.replace(/'/g, "''")}')`)
    .join(',');

  // ── Query 1: VQ aggregates ──────────────────────────────────────────────
  // bi_vendor_quote_line_v has vendor_quote_mpn_clean already cleaned.
  const vqRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList})
    SELECT vendor_quote_mpn_clean,
           COUNT(*) AS cnt,
           MIN(vendor_quote_cost)::numeric(18,4) AS lo,
           MAX(vendor_quote_cost)::numeric(18,4) AS hi,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vendor_quote_cost)::numeric(18,4) AS med
    FROM adempiere.bi_vendor_quote_line_v
    WHERE vendor_quote_mpn_clean IN (SELECT mpn FROM mpns)
      AND vendor_quote_created >= CURRENT_DATE - INTERVAL '${vqMonths} months'
      AND vendor_quote_cost > 0
    GROUP BY vendor_quote_mpn_clean
  `);
  for (const row of vqRows) {
    if (!row || row.length < 5) continue;
    const [mpn, cnt, lo, hi, med] = row;
    const r = result.get(mpn);
    if (!r) continue;
    r.vqCount = parseInt(cnt, 10) || 0;
    r.vqSummary = {
      count: r.vqCount,
      low: parseFloat(lo) || null,
      high: parseFloat(hi) || null,
      median: parseFloat(med) || null,
    };
  }

  // ── Query 2: Sales aggregates with broker / customer split ──────────────
  // c_orderline.chuboe_mpn isn't pre-cleaned, so normalize it inline.
  // Broker = bp.isvendor='Y' (sold to a broker BP). Customer = the rest.
  const saleRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList}),
         normalized AS (
           SELECT
             UPPER(REGEXP_REPLACE(sol.chuboe_mpn, '[-\\s\\/.:,]', '', 'g')) AS mpn_clean,
             sol.priceentered AS price,
             so.dateordered,
             bp.isvendor,
             bp.name AS bp_name
           FROM adempiere.c_order so
           JOIN adempiere.c_orderline sol ON so.c_order_id = sol.c_order_id
           JOIN adempiere.c_bpartner bp ON so.c_bpartner_id = bp.c_bpartner_id
           WHERE so.isactive = 'Y' AND sol.isactive = 'Y'
             AND so.issotrx = 'Y' AND so.docstatus IN ('IP','CO','CL')
             AND so.ad_client_id = 1000000
             AND so.dateordered >= CURRENT_DATE - INTERVAL '${salesMonths} months'
             AND sol.chuboe_mpn IS NOT NULL
         )
    SELECT n.mpn_clean,
           SUM(CASE WHEN n.isvendor = 'Y' THEN 1 ELSE 0 END) AS broker_cnt,
           SUM(CASE WHEN n.isvendor = 'Y' THEN 0 ELSE 1 END) AS cust_cnt,
           MAX(CASE WHEN n.isvendor = 'Y' THEN n.price END)::numeric(18,4) AS last_broker_price,
           MAX(CASE WHEN n.isvendor != 'Y' THEN n.price END)::numeric(18,4) AS last_cust_price
    FROM normalized n
    WHERE n.mpn_clean IN (SELECT mpn FROM mpns)
    GROUP BY n.mpn_clean
  `);
  for (const row of saleRows) {
    if (!row || row.length < 5) continue;
    const [mpn, brk, cust, lbp, lcp] = row;
    const r = result.get(mpn);
    if (!r) continue;
    r.brokerSaleCount = parseInt(brk, 10) || 0;
    r.customerSaleCount = parseInt(cust, 10) || 0;
    r.lastBrokerSalePrice = parseFloat(lbp) || null;
    r.lastCustomerSalePrice = parseFloat(lcp) || null;
  }

  // ── Query 2b: Top buyers per MPN ───────────────────────────────────────
  // Separate query because the per-MPN ranked list doesn't aggregate well
  // alongside the count totals. Limited to topBuyers per MPN via window function.
  const buyerRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList}),
         normalized AS (
           SELECT
             UPPER(REGEXP_REPLACE(sol.chuboe_mpn, '[-\\s\\/.:,]', '', 'g')) AS mpn_clean,
             bp.name AS bp_name,
             bp.isvendor
           FROM adempiere.c_order so
           JOIN adempiere.c_orderline sol ON so.c_order_id = sol.c_order_id
           JOIN adempiere.c_bpartner bp ON so.c_bpartner_id = bp.c_bpartner_id
           WHERE so.isactive = 'Y' AND sol.isactive = 'Y'
             AND so.issotrx = 'Y' AND so.docstatus IN ('IP','CO','CL')
             AND so.ad_client_id = 1000000
             AND so.dateordered >= CURRENT_DATE - INTERVAL '${salesMonths} months'
             AND sol.chuboe_mpn IS NOT NULL
         ),
         counted AS (
           SELECT n.mpn_clean, n.bp_name, n.isvendor, COUNT(*) AS cnt
           FROM normalized n
           WHERE n.mpn_clean IN (SELECT mpn FROM mpns)
           GROUP BY n.mpn_clean, n.bp_name, n.isvendor
         ),
         ranked AS (
           SELECT mpn_clean, bp_name, isvendor, cnt,
                  ROW_NUMBER() OVER (PARTITION BY mpn_clean ORDER BY cnt DESC) AS rn
           FROM counted
         )
    SELECT mpn_clean, bp_name, isvendor
    FROM ranked
    WHERE rn <= ${topBuyers}
    ORDER BY mpn_clean, rn
  `);
  for (const row of buyerRows) {
    if (!row || row.length < 3) continue;
    const [mpn, name, isVendor] = row;
    const r = result.get(mpn);
    if (!r) continue;
    r.topBuyers.push({ name, isBroker: isVendor === 'Y' });
  }

  // ── Query 3: Offer aggregates ───────────────────────────────────────────
  const offerRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList})
    SELECT ol.chuboe_mpn_clean,
           COUNT(*) AS cnt,
           MIN(NULLIF(ol.priceentered, 0))::numeric(18,4) AS lo,
           MAX(NULLIF(ol.priceentered, 0))::numeric(18,4) AS hi
    FROM adempiere.chuboe_offer_line ol
    JOIN adempiere.chuboe_offer o ON ol.chuboe_offer_id = o.chuboe_offer_id
    WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
      AND o.chuboe_offer_type_id <> 1000025  -- exclude LAM Kitting Inventory (LAM consigned, not ours)
      AND ol.chuboe_mpn_clean IN (SELECT mpn FROM mpns)
      AND o.created >= CURRENT_DATE - INTERVAL '${offerDays} days'
    GROUP BY ol.chuboe_mpn_clean
  `);
  for (const row of offerRows) {
    if (!row || row.length < 4) continue;
    const [mpn, cnt, lo, hi] = row;
    const r = result.get(mpn);
    if (!r) continue;
    r.offerCount = parseInt(cnt, 10) || 0;
    r.offerPriceLow = parseFloat(lo) || null;
    r.offerPriceHigh = parseFloat(hi) || null;
  }

  // ── Query 4: RFQ counts (active + historical) ───────────────────────────
  const rfqRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList})
    SELECT m.chuboe_mpn_clean,
           SUM(CASE WHEN r.created >= CURRENT_DATE - INTERVAL '${rfqDaysActive} days' THEN 1 ELSE 0 END) AS active_cnt,
           SUM(CASE WHEN r.created >= CURRENT_DATE - INTERVAL '${rfqMonthsHist} months' THEN 1 ELSE 0 END) AS hist_cnt
    FROM adempiere.chuboe_rfq_line_mpn m
    JOIN adempiere.chuboe_rfq_line rl ON m.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    WHERE m.isactive = 'Y' AND rl.isactive = 'Y' AND r.isactive = 'Y'
      AND m.chuboe_mpn_clean IN (SELECT mpn FROM mpns)
      AND r.created >= CURRENT_DATE - INTERVAL '${rfqMonthsHist} months'
    GROUP BY m.chuboe_mpn_clean
  `);
  for (const row of rfqRows) {
    if (!row || row.length < 3) continue;
    const [mpn, active, hist] = row;
    const r = result.get(mpn);
    if (!r) continue;
    r.activeRfqCount = parseInt(active, 10) || 0;
    r.historicalRfqCount = parseInt(hist, 10) || 0;
    r.demandStrength = getDemandStrength(r.historicalRfqCount);
  }

  // ── Query 5: Historical RFQ ROW DETAIL (top N most recent per MPN) ──────
  // Window function ranks rows by created DESC within each MPN; we keep the
  // top 10 to show actual customer/qty/target/date in downstream output.
  const detailLimit = options.detailLimit || 10;
  const rfqDetailRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList}),
         ranked AS (
           SELECT m.chuboe_mpn_clean AS mpn,
                  r.value AS rfq_search_key,
                  bp.name AS customer,
                  COALESCE(rt.name, '') AS rfq_type,
                  rl.qty AS qty,
                  rl.priceentered AS target,
                  r.created::date AS rfq_date,
                  bp.isvendor,
                  ROW_NUMBER() OVER (PARTITION BY m.chuboe_mpn_clean ORDER BY r.created DESC) AS rn
           FROM adempiere.chuboe_rfq_line_mpn m
           JOIN adempiere.chuboe_rfq_line rl ON m.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
           JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
           JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
           LEFT JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
           WHERE m.isactive = 'Y' AND rl.isactive = 'Y' AND r.isactive = 'Y'
             AND m.chuboe_mpn_clean IN (SELECT mpn FROM mpns)
             AND r.created >= CURRENT_DATE - INTERVAL '${rfqMonthsHist} months'
         )
    SELECT mpn, rfq_search_key, customer, rfq_type, qty, target, rfq_date, isvendor
    FROM ranked
    WHERE rn <= ${detailLimit}
    ORDER BY mpn, rn
  `);
  for (const row of rfqDetailRows) {
    if (!row || row.length < 8) continue;
    const [mpn, searchKey, customer, rfqType, qty, target, rfqDate, isVendor] = row;
    const r = result.get(mpn);
    if (!r) continue;
    const date = rfqDate || '';
    const ageDays = date ? Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000)) : null;
    r.historicalRfqs.push({
      rfqSearchKey: searchKey || '',
      customer: customer || '',
      rfqType: rfqType || '',
      qty: parseInt(qty, 10) || 0,
      targetPrice: parseFloat(target) || null,
      date,
      isVendor: isVendor === 'Y',
      ageDays,
    });
  }

  // ── Query 6: Historical SALE ROW DETAIL (top N most recent per MPN) ─────
  // Same window-function pattern as Query 5. Surfaces actual buyer / price /
  // date so the report can show "we sold X to Customer Y at $Z, N days ago"
  // instead of just "5 historical sales."
  const saleDetailRows = psql(`
    WITH mpns(mpn) AS (VALUES ${valuesList}),
         normalized AS (
           SELECT
             UPPER(REGEXP_REPLACE(sol.chuboe_mpn, '[-\\s\\/.:,]', '', 'g')) AS mpn,
             bp.name AS customer,
             sol.qtyentered AS qty,
             sol.priceentered AS price,
             so.dateordered::date AS sale_date,
             bp.isvendor
           FROM adempiere.c_order so
           JOIN adempiere.c_orderline sol ON so.c_order_id = sol.c_order_id
           JOIN adempiere.c_bpartner bp ON so.c_bpartner_id = bp.c_bpartner_id
           WHERE so.isactive = 'Y' AND sol.isactive = 'Y'
             AND so.issotrx = 'Y' AND so.docstatus IN ('IP','CO','CL')
             AND so.ad_client_id = 1000000
             AND so.dateordered >= CURRENT_DATE - INTERVAL '${salesMonths} months'
             AND sol.chuboe_mpn IS NOT NULL
             AND sol.priceentered > 0
         ),
         ranked AS (
           SELECT n.*, ROW_NUMBER() OVER (PARTITION BY n.mpn ORDER BY n.sale_date DESC) AS rn
           FROM normalized n
           WHERE n.mpn IN (SELECT mpn FROM mpns)
         )
    SELECT mpn, customer, qty, price, sale_date, isvendor
    FROM ranked
    WHERE rn <= ${detailLimit}
    ORDER BY mpn, rn
  `);
  for (const row of saleDetailRows) {
    if (!row || row.length < 6) continue;
    const [mpn, customer, qty, price, saleDate, isVendor] = row;
    const r = result.get(mpn);
    if (!r) continue;
    const date = saleDate || '';
    const ageDays = date ? Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000)) : null;
    r.historicalSales.push({
      customer: customer || '',
      qty: parseInt(qty, 10) || 0,
      soldPrice: parseFloat(price) || null,
      date,
      isBroker: isVendor === 'Y',
      ageDays,
    });
  }

  return result;
}

module.exports = {
  cleanMpn,
  getBaseMpn,
  mpnWhereClause,
  getVQHistory,
  summarizeVQs,
  getMarketOffers,
  getSalesHistory,
  getRFQDemand,
  getRFQCount,
  getDemandStrength,
  getAllMarketData,
  getBulkMarketData,
  // Expose for testing/reuse
  psql,
  parsePsqlOutput,
};
