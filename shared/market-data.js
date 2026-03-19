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
    const result = execSync(`psql -t -A -F '|' -c "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30000
    });
    return parsePsqlOutput(result);
  } catch (e) {
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
           sol.priceentered as unit_price, sol.qtyordered as qty,
           bp.isvendor, bp.iscustomer,
           g.name as bp_group
    FROM adempiere.c_order so
    JOIN adempiere.c_orderline sol ON so.c_order_id = sol.c_order_id
    JOIN adempiere.c_bpartner bp ON so.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.c_bp_group g ON bp.c_bp_group_id = g.c_bp_group_id
    WHERE so.isactive = 'Y' AND sol.isactive = 'Y'
    AND so.issotrx = 'Y' AND so.docstatus IN ('CO','CL')
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
  // Expose for testing/reuse
  psql,
  parsePsqlOutput,
};
