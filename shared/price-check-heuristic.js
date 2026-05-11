#!/usr/bin/env node
/**
 * shared/price-check-heuristic.js
 *
 * Region + market-context price-fishing detector for incoming Stock RFQs.
 *
 * The rule (per feedback_exact_stock_match_brokers memory, refined 2026-05-11):
 *   - APAC broker requesting our exact stock qty + non-Astute broker stock
 *     exists in the market → STRONG fishing signal. Flag.
 *   - APAC broker requesting exact stock + market is otherwise dry → could
 *     be legit shortage demand. Do NOT flag.
 *   - US/EMEA OEM/CM requesting exact stock → legitimate partial-demand
 *     purchase (they took everything available). Do NOT flag.
 *   - Any region requesting qty materially different from our stock → no
 *     fishing signal from this axis. Do NOT flag.
 *
 * Library usage:
 *   const { checkPriceFishing } = require('./price-check-heuristic');
 *   const result = await checkPriceFishing({
 *     mpn: 'W631GG6NB-12',
 *     brokerQty: 1514,
 *     senderEmail: 'sales@szpengyuan.cn',
 *   });
 *   // → { isPriceCheck: true, region: 'APAC', ourStockQty: 1514,
 *   //     otherBrokerStockQty: 15840, reason: 'APAC broker; exact match; 1 non-Astute broker stock row in market' }
 *
 * CLI usage (from agent prompts):
 *   node shared/price-check-heuristic.js --mpn <MPN> --qty <N> --sender <EMAIL>
 *   → prints JSON: { isPriceCheck, region, ourStockQty, otherBrokerStockQty, reason }
 */

'use strict';

const { psqlQuery } = require('./db-helpers');

// APAC top-level domain set. ".in" (India) intentionally excluded —
// historical Astute pattern treats India as its own bucket, not APAC.
const APAC_TLDS = new Set([
  'cn', 'hk', 'tw', 'jp', 'kr', 'sg', 'vn', 'th', 'id', 'my', 'ph',
]);

function classifyRegion(senderEmail) {
  if (!senderEmail) return 'UNKNOWN';
  const lower = senderEmail.toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return 'UNKNOWN';
  const tld = lower.slice(at + 1).split('.').pop();
  if (APAC_TLDS.has(tld)) return 'APAC';
  // US/EMEA grouping: .com .net .org .us .uk .de .fr .it .es .nl .se .ch .at .be .ie .pl .cz .dk .no .fi
  // Treat everything non-APAC as US_EMEA for the heuristic (a sender from
  // .com could be APAC-based, but we err on "real demand" — false negatives
  // on flag are safer than false positives that mistreat real customers).
  return 'US_EMEA';
}

/**
 * Returns true iff the broker's requested qty is within 5% of our exact stock
 * qty AND non-trivial (>0). Tolerance handles cases like "1500 vs 1514" where
 * a broker rounded but is still effectively requesting full stock.
 */
function isExactMatch(brokerQty, ourQty) {
  if (!brokerQty || !ourQty) return false;
  const delta = Math.abs(brokerQty - ourQty);
  return delta / ourQty < 0.05;
}

/**
 * Sum active stock qty grouped by owner-bucket for the given MPN.
 * Buckets:
 *   - astute_stock:        Astute-owned offers (bp.name ILIKE '%Astute%')
 *   - other_broker_stock:  non-Astute offers that look like broker stock
 *                          (not customer excess, not LAM Kitting Inventory)
 *
 * Filters: isactive='Y' and recent window (60d).
 *
 * Returns { astute_stock_qty, other_broker_stock_qty, other_broker_rows }.
 */
function getMarketContext(mpn) {
  // Escape single quotes in MPN (db-helpers' psqlQuery passes via cmdline)
  const safeMpn = mpn.replace(/'/g, "''");
  const sql = `
    SELECT
      COALESCE(SUM(ol.qty) FILTER (WHERE bp.name ILIKE '%Astute%'), 0)::int            AS astute_qty,
      COALESCE(SUM(ol.qty) FILTER (WHERE bp.name NOT ILIKE '%Astute%'
                                     AND o.chuboe_offer_type_id != 1000025), 0)::int   AS other_qty,
      COUNT(*) FILTER (WHERE bp.name NOT ILIKE '%Astute%'
                         AND o.chuboe_offer_type_id != 1000025)::int                   AS other_rows
    FROM adempiere.chuboe_offer_line ol
    JOIN adempiere.chuboe_offer o      ON o.chuboe_offer_id = ol.chuboe_offer_id
    JOIN adempiere.c_bpartner bp       ON bp.c_bpartner_id  = o.c_bpartner_id
    WHERE ol.isactive='Y'
      AND o.isactive='Y'
      AND ol.chuboe_mpn = '${safeMpn}'
      AND o.created >= now() - interval '180 days'
  `;
  const out = psqlQuery(sql).trim();
  // psqlQuery returns single row pipe-separated: "1514|15840|1"
  const parts = out.split('|').map(s => parseInt(s.trim(), 10) || 0);
  return {
    astute_stock_qty: parts[0] || 0,
    other_broker_stock_qty: parts[1] || 0,
    other_broker_rows: parts[2] || 0,
  };
}

/**
 * Main entry. See module header for the rule.
 */
function checkPriceFishing({ mpn, brokerQty, senderEmail }) {
  if (!mpn || !brokerQty) {
    return { isPriceCheck: false, region: 'UNKNOWN', ourStockQty: 0, otherBrokerStockQty: 0, reason: 'missing mpn or qty' };
  }

  const region = classifyRegion(senderEmail);
  const market = getMarketContext(mpn);
  const ourStockQty = market.astute_stock_qty;
  const otherBrokerStockQty = market.other_broker_stock_qty;
  const otherRows = market.other_broker_rows;

  // No stock to fish for → can't be a fishing pattern based on stock match.
  if (ourStockQty === 0) {
    return { isPriceCheck: false, region, ourStockQty, otherBrokerStockQty,
             reason: 'no Astute stock visible for this MPN' };
  }

  const exact = isExactMatch(brokerQty, ourStockQty);
  if (!exact) {
    return { isPriceCheck: false, region, ourStockQty, otherBrokerStockQty,
             reason: `qty ${brokerQty} differs materially from our stock ${ourStockQty}` };
  }

  // Exact match. Apply region + market-context rules.
  if (region === 'APAC' && otherRows > 0) {
    return { isPriceCheck: true, region, ourStockQty, otherBrokerStockQty,
             reason: `APAC broker; exact match (${brokerQty} vs our ${ourStockQty}); ${otherRows} non-Astute broker stock row(s) in market — market not dry, classic fishing pattern` };
  }
  if (region === 'APAC' && otherRows === 0) {
    return { isPriceCheck: false, region, ourStockQty, otherBrokerStockQty,
             reason: `APAC broker; exact match (${brokerQty} vs our ${ourStockQty}); but market is dry — could be legit shortage demand` };
  }
  if (region === 'US_EMEA') {
    return { isPriceCheck: false, region, ourStockQty, otherBrokerStockQty,
             reason: `US/EMEA sender; exact match (${brokerQty} vs our ${ourStockQty}) — legitimate partial-demand buy, not fishing` };
  }
  // UNKNOWN region — be conservative, do not flag.
  return { isPriceCheck: false, region, ourStockQty, otherBrokerStockQty,
           reason: `region unknown; exact match but cannot classify confidently` };
}

module.exports = { checkPriceFishing, classifyRegion, getMarketContext };

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const getFlag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const mpn = getFlag('mpn');
  const brokerQty = parseInt(getFlag('qty') || '0', 10);
  const senderEmail = getFlag('sender') || '';
  if (!mpn) {
    console.error('Usage: node price-check-heuristic.js --mpn <MPN> --qty <N> --sender <email>');
    process.exit(2);
  }
  try {
    const r = checkPriceFishing({ mpn, brokerQty, senderEmail });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
