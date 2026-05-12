/**
 * render-reactive.js — Customer Excess Analysis Reactive renderer (Step 5).
 *
 * Per the spec at `customer-excess-analysis.md` § Step 5 Reactive Output, this
 * runs the full Step 3 → 4 → 5 pipeline for a single offer classified
 * `reactive`:
 *
 *   Step 3a (supply):  shared/franchise-api.js searchAllDistributors
 *                      with cacheTTL: 14d — cache-first naturally
 *   Step 3b (demand):  shared/market-data.js getBulkMarketData
 *                      (bulk SQL — ~1000× faster than per-MPN)
 *   Step 4 (scoring):  Supply Scarcity (0-40) + Price Advantage (0-35)
 *                      + Demand Signal (0-25) per the .md weights.
 *                      Tier: HOT 70+ / WARM 40-69 / COOL 20-39 / SKIP <20
 *   Step 5 (render):   Tabular per-line output. Viability filter suppresses
 *                      SKIP-tier lines from operator-facing summary.
 *
 * USAGE:
 *   node render-reactive.js <offer-search-key>
 *   node render-reactive.js 1026134
 *
 * V1 OUTPUT: console table + JSON summary. Email rendering comes after the
 * pipeline shape is validated on the 9 small Reactive offers.
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const { Pool } = require('pg');
const { searchAllDistributors } = require('../../shared/franchise-api');
const { getBulkMarketData, cleanMpn } = require('../../shared/market-data');
const { classifyMpnNonFranchise } = require('../../shared/mpn-classifier');

const FRANCHISE_CACHE_TTL_DAYS = 14;

// ─── DATA LOAD ───────────────────────────────────────────────────────────────

async function loadOffer(pool, searchKey) {
  const r = await pool.query(`
    SELECT
      o.chuboe_offer_id, o.value AS search_key, o.description,
      o.c_bpartner_id, bp.name AS partner_name,
      ol.chuboe_offer_line_id AS line_id, ol.line AS line_num,
      ol.chuboe_mpn, ol.chuboe_mpn_clean, ol.chuboe_mfr_text,
      ol.qty, ol.priceentered, ol.chuboe_date_code, ol.chuboe_package_desc,
      ol.chuboe_cpc, ol.description AS line_description
    FROM adempiere.chuboe_offer o
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id
    JOIN adempiere.chuboe_offer_line ol ON ol.chuboe_offer_id = o.chuboe_offer_id AND ol.isactive='Y'
    WHERE o.value = $1 AND o.isactive='Y'
    ORDER BY ol.line
  `, [searchKey]);
  if (r.rows.length === 0) throw new Error(`offer searchKey=${searchKey} not found`);
  const first = r.rows[0];
  return {
    offerId: first.chuboe_offer_id,
    searchKey: first.search_key,
    description: first.description,
    partner: { id: first.c_bpartner_id, name: first.partner_name },
    lines: r.rows.map(row => ({
      lineId: row.line_id, lineNum: row.line_num,
      mpn: row.chuboe_mpn, mpnClean: row.chuboe_mpn_clean,
      mfr: row.chuboe_mfr_text || '',
      qty: Number(row.qty || 0), offeredPrice: row.priceentered ? Number(row.priceentered) : null,
      dateCode: row.chuboe_date_code || '', packageDesc: row.chuboe_package_desc || '',
      cpc: row.chuboe_cpc || '', description: row.line_description || '',
      enrichment: {},
    })),
  };
}

// ─── STEP 3a: SUPPLY (franchise APIs, cache-first) ───────────────────────────

async function enrichSupply(offer) {
  let fresh = 0, cached = 0, errors = 0;
  for (const line of offer.lines) {
    try {
      const result = await searchAllDistributors(line.mpn, line.qty || 1, {
        cacheTTL: FRANCHISE_CACHE_TTL_DAYS,
      });
      const s = result.summary || {};
      if (s.fromCache) cached++; else fresh++;
      line.enrichment.supply = {
        distributorsCarrying:  Number(s.distributorsCarrying || 0),
        distributorsWithStock: Number(s.distributorsWithStock || 0),
        totalStock:            Number(s.totalStock || 0),
        lowestPrice:           s.lowestPrice != null ? Number(s.lowestPrice) : null,
        coverage:              s.coverage || 'NONE',
        fromCache:             !!s.fromCache,
      };
      // Three-state coverage model (.md Step 3a)
      if (line.enrichment.supply.distributorsWithStock > 0) {
        line.franchiseState = 'IN_STOCK';
      } else if (line.enrichment.supply.distributorsCarrying > 0) {
        line.franchiseState = 'FRANCHISE_OUT_OF_STOCK';
      } else {
        line.franchiseState = classifyMpnNonFranchise(line.mpn, line.mfr, line.cpc);
      }
    } catch (e) {
      errors++;
      line.enrichment.supply = { error: e.message };
      line.franchiseState = 'API_ERROR';
    }
  }
  return { fresh, cached, errors };
}

// ─── STEP 3b: DEMAND + MARKET CONTEXT (OT history, bulk pattern) ─────────────
//
// Operator's framework (reframed 2026-05-12) puts the pricing-ladder and
// sourcing-viability at the center, not the academic demand-score axis:
//
//   For priced lines:    offered vs franchise vs broker-market vs sold-CQ vs RFQ-target
//   For unpriced lines:  VQ availability + scarcity assessment
//   Demand (RFQs/CQs):   minor presence indicator, not heavy scoring input
//
// Same-customer-asks-and-offers detection deliberately dropped — usually
// internal supply-chain inefficiency, not a real resale signal.

function enrichDemand(offer) {
  const mpnCleans = offer.lines.map(l => cleanMpn(l.mpn));
  // VQ window deliberately tight (90d = 3mo). Per operator 2026-05-12: VQs
  // older than 90d are usually noise; volatile commodities (DRAM, SSDs)
  // may justify even tighter (30d). Future enhancement: commodity-aware
  // window via MFR/MPN classifier. For now: uniform 90d.
  // Sales history kept wider (24mo) — a customer sale 6mo ago is still
  // meaningful demand signal; not the same volatility profile as supply.
  const demandMap = getBulkMarketData(mpnCleans, {
    vqMonths: 3, salesMonths: 24, rfqDaysActive: 90, rfqMonthsHist: 12,
  });
  for (const line of offer.lines) {
    const d = demandMap.get(cleanMpn(line.mpn)) || {};
    // Split RFQs by source: customer demand vs broker (stock-RFQ) demand.
    // Both are resale channels — customer is direct; broker is open-market.
    const rfqsLast90d = (d.historicalRfqs || []).filter(r => r.ageDays != null && r.ageDays <= 90);
    const custRfqs90d   = rfqsLast90d.filter(r => !r.isVendor);
    const brokerRfqs90d = rfqsLast90d.filter(r =>  r.isVendor);
    // Max RFQ target among customer (non-broker) RFQs in 90d — the aspirational
    // price customers say they want. Useful market anchor even when same-customer.
    const maxCustomerRfqTarget = custRfqs90d
      .map(r => r.targetPrice).filter(p => p != null && p > 0)
      .reduce((m, p) => p > m ? p : m, 0) || null;
    // Last customer sale — what we actually realized. Per operator: BOTH this
    // and the RFQ target are useful (PPV vs shortage context still TBD).
    const lastCustomerSale = (d.historicalSales || []).find(s => !s.isBroker && s.soldPrice);
    const lastBrokerSale   = (d.historicalSales || []).find(s =>  s.isBroker && s.soldPrice);

    line.enrichment.demand = {
      vqCount:            Number(d.vqCount || 0),
      vqLow:              d.vqSummary?.low || null,
      vqHigh:             d.vqSummary?.high || null,
      vqMedian:           d.vqSummary?.median || null,
      lastCustomerSale,   // { customer, soldPrice, date, qty, ageDays } | undefined
      lastBrokerSale,
      maxCustomerRfqTarget,
      customerRfqs90d:    custRfqs90d.length,
      brokerRfqs90d:      brokerRfqs90d.length,
      historicalRfqCount: Number(d.historicalRfqCount || 0),
    };
  }
}

// Pull the cheapest VQ in the last 90d per MPN (vendor + cost + date).
// Bulk function gives summary stats but not the per-VQ vendor name; do a
// targeted query for the offer's MPN set.
async function enrichVqDetail(pool, offer) {
  const cleans = Array.from(new Set(offer.lines.map(l => cleanMpn(l.mpn))));
  if (cleans.length === 0) return;
  const r = await pool.query(`
    WITH ranked AS (
      SELECT vq.chuboe_mpn_clean,
             bp.name AS vendor,
             vq.cost,
             vq.qty,
             (vq.created AT TIME ZONE 'America/Chicago')::date AS vq_date,
             ROW_NUMBER() OVER (PARTITION BY vq.chuboe_mpn_clean ORDER BY vq.cost ASC NULLS LAST) AS rn_cost,
             ROW_NUMBER() OVER (PARTITION BY vq.chuboe_mpn_clean ORDER BY vq.created DESC) AS rn_recent
      FROM adempiere.chuboe_vq_line vq
      LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vq.c_bpartner_id
      WHERE vq.isactive='Y'
        AND vq.cost > 0
        AND vq.chuboe_mpn_clean = ANY($1::text[])
        AND vq.created AT TIME ZONE 'America/Chicago' >= NOW() - INTERVAL '90 days'
    )
    SELECT chuboe_mpn_clean, vendor, cost, qty, vq_date, rn_cost, rn_recent
    FROM ranked
    WHERE rn_cost = 1 OR rn_recent = 1
  `, [cleans]);
  const map = new Map();
  for (const row of r.rows) {
    const m = map.get(row.chuboe_mpn_clean) || {};
    if (Number(row.rn_cost) === 1)   m.cheapest = { vendor: row.vendor, cost: Number(row.cost), qty: Number(row.qty), date: row.vq_date };
    if (Number(row.rn_recent) === 1) m.mostRecent = { vendor: row.vendor, cost: Number(row.cost), qty: Number(row.qty), date: row.vq_date };
    map.set(row.chuboe_mpn_clean, m);
  }
  for (const line of offer.lines) {
    const m = map.get(cleanMpn(line.mpn));
    line.enrichment.vqDetail = m || null;
  }
}

// ─── STEP 4: ASSESS (operator-reframed, not .md scoring) ─────────────────────
//
// Per the 2026-05-12 operator reframing, this layer surfaces ACTIONABILITY
// flags, not the academic 0-100 score. Per-line outputs three signals:
//
//   pricing  — "PRICED_GOOD" / "PRICED_PARITY" / "PRICED_HIGH" / "UNPRICED"
//              based on offered vs franchise + vs broker-market (VQs) +
//              vs last sold-CQ
//   sourcing — "FRANCHISE_OK" / "BROKER_AVAILABLE" / "SCARCE" based on
//              franchise state × VQ presence
//   channels — "CUST_DEMAND" / "BROKER_DEMAND" / "BOTH" / "NONE" based on
//              who's been buying (resale channel availability)
//
// "Worth pursuing" = at least one of:
//   - pricing PRICED_GOOD AND any channel
//   - pricing UNPRICED AND sourcing SCARCE AND any channel  (real opportunity)
//   - pricing UNPRICED AND VQs exist below customer-sold-price
//
// Old HOT/WARM/COOL/SKIP tiers retained for at-a-glance compatibility.

function assessPricing(line) {
  const supply = line.enrichment.supply || {};
  const demand = line.enrichment.demand || {};
  if (line.offeredPrice == null) return { state: 'UNPRICED', reasons: ['no offer price'] };

  const fr = supply.lowestPrice;
  const vqLow = demand.vqLow;
  const soldCust = demand.lastCustomerSale?.soldPrice;
  const refs = [];

  // Ladder: prefer broker-market (VQ low) as benchmark when available;
  // fall back to franchise. Customer sold is informational (depends on context).
  const benchmark = vqLow || fr;
  if (!benchmark) return { state: 'NO_BENCHMARK', reasons: ['no franchise + no VQ'] };

  const ratio = line.offeredPrice / benchmark;
  refs.push(`offer/${vqLow ? 'vq_low' : 'frnch'}=${(ratio * 100).toFixed(0)}%`);
  if (fr) refs.push(`frnch=$${fr.toFixed(2)}`);
  if (vqLow) refs.push(`vq_low=$${vqLow.toFixed(2)}`);
  if (soldCust) refs.push(`sold_cust=$${soldCust.toFixed(2)}`);

  let state;
  if (ratio < 0.5)       state = 'PRICED_GOOD';      // beats benchmark by 2x
  else if (ratio < 0.85) state = 'PRICED_WORKABLE';
  else if (ratio < 1.10) state = 'PRICED_PARITY';
  else                   state = 'PRICED_HIGH';
  return { state, reasons: refs, ratio };
}

function assessSourcing(line) {
  const supply = line.enrichment.supply || {};
  const demand = line.enrichment.demand || {};
  const hasFrStock = supply.distributorsWithStock > 0;
  const hasVqs = (demand.vqCount || 0) > 0;
  if (hasFrStock) return { state: 'FRANCHISE_OK', reasons: [`fr_stock=${supply.totalStock}`] };
  if (hasVqs)     return { state: 'BROKER_AVAILABLE', reasons: [`vqs=${demand.vqCount}`, `vq_low=${demand.vqLow ?? '?'}`] };
  if (line.franchiseState === 'FRANCHISE_OUT_OF_STOCK') return { state: 'SCARCE', reasons: ['franch OOS + no recent VQs'] };
  if (line.franchiseState?.startsWith('NO_LISTING')) return { state: 'OFF_FRANCHISE', reasons: [line.franchiseState] };
  return { state: 'UNKNOWN', reasons: [] };
}

function assessChannels(line) {
  const d = line.enrichment.demand || {};
  const cust = (d.customerRfqs90d || 0) > 0 || d.lastCustomerSale;
  const brkr = (d.brokerRfqs90d || 0) > 0 || d.lastBrokerSale;
  if (cust && brkr) return { state: 'BOTH', reasons: [`cust_rfq=${d.customerRfqs90d}`, `brkr_rfq=${d.brokerRfqs90d}`] };
  if (cust)         return { state: 'CUST_DEMAND', reasons: [`cust_rfq=${d.customerRfqs90d}`, `last_sold=${d.lastCustomerSale?.soldPrice ?? '—'}`] };
  if (brkr)         return { state: 'BROKER_DEMAND', reasons: [`brkr_rfq=${d.brokerRfqs90d}`] };
  return { state: 'NONE', reasons: [] };
}

function assessLine(line) {
  const pricing  = assessPricing(line);
  const sourcing = assessSourcing(line);
  const channels = assessChannels(line);

  // Worth-pursuing logic per operator reframing
  let worth = 'PASS';
  let worthReason = '';
  if (pricing.state === 'PRICED_GOOD' && channels.state !== 'NONE') {
    worth = 'PURSUE'; worthReason = 'Good price + resale channel';
  } else if (pricing.state === 'PRICED_WORKABLE' && channels.state !== 'NONE') {
    worth = 'CONSIDER'; worthReason = 'Workable price + resale channel';
  } else if (pricing.state === 'UNPRICED' && sourcing.state === 'SCARCE' && channels.state !== 'NONE') {
    worth = 'PURSUE'; worthReason = 'Scarce + demand exists — get price from seller';
  } else if (pricing.state === 'UNPRICED' && sourcing.state === 'BROKER_AVAILABLE' && channels.state !== 'NONE') {
    worth = 'CONSIDER'; worthReason = 'Unpriced but sourceable + demand';
  } else if (channels.state === 'NONE') {
    worth = 'PASS'; worthReason = 'No resale channel — no point';
  } else if (pricing.state === 'PRICED_HIGH') {
    worth = 'PASS'; worthReason = 'Offer above market benchmark';
  } else if (sourcing.state === 'FRANCHISE_OK' && pricing.state !== 'PRICED_GOOD') {
    worth = 'PASS'; worthReason = 'Commodity — franchise has it';
  }

  // Legacy tier for at-a-glance
  let tier;
  if (worth === 'PURSUE')        tier = 'HOT';
  else if (worth === 'CONSIDER') tier = 'WARM';
  else if (pricing.state === 'UNPRICED' && sourcing.state === 'OFF_FRANCHISE') tier = 'INSUFFICIENT';
  else                           tier = 'SKIP';

  const flags = [];
  if (pricing.state === 'UNPRICED') flags.push('NO_OFFER_PRICE');
  if (sourcing.state === 'SCARCE') flags.push('SCARCE');
  if (line.franchiseState === 'NO_LISTING_INTERNAL')  flags.push('INTERNAL_CODE');
  if (line.franchiseState === 'NO_LISTING_MILSPEC')   flags.push('MIL_SPEC');
  if (line.franchiseState === 'NO_LISTING_UNKNOWN')   flags.push('UNKNOWN_MPN');
  if (channels.state === 'BOTH')                       flags.push('DUAL_CHANNEL');

  return { pricing, sourcing, channels, worth, worthReason, tier, flags };
}

// ─── STEP 5: REACTIVE OUTPUT (console table) ─────────────────────────────────

function rpad(s, n) { return String(s ?? '').padEnd(n).slice(0, n); }
function lpad(s, n) { return String(s ?? '').padStart(n).slice(-n); }
function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function fmtInt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function renderReactive(offer, opts = {}) {
  const lines = offer.lines;

  console.log(`\n=== ${offer.partner.name} (BP ${offer.partner.id}) — search key ${offer.searchKey} ===`);
  console.log(`${lines.length} line(s) — printing all (no cherry-picking)\n`);

  // Two-line-per-row layout — too many columns to fit one wide row readably.
  // Row 1: identity + pricing ladder
  // Row 2: sourcing + channels + worth-assessment + flags
  for (const l of lines) {
    const s = l.enrichment.supply || {};
    const d = l.enrichment.demand || {};
    const a = l.assess;

    // Row 1: identity + pricing
    const id = `${rpad(l.mpn, 22)} ${rpad(l.mfr, 14)} ${lpad(fmtInt(l.qty), 8)}`;
    const pricing =
      `Offer:${lpad(l.offeredPrice != null ? fmtMoney(l.offeredPrice) : '—', 12)} ` +
      `Frnch:${lpad(s.lowestPrice ? fmtMoney(s.lowestPrice) : '—', 11)} ` +
      `FrStk:${lpad(fmtInt(s.totalStock || 0), 9)} ` +
      `VQ_low(90d):${lpad(d.vqLow ? fmtMoney(d.vqLow) : '—', 10)} ` +
      `VQ#:${lpad(d.vqCount || 0, 3)}`;
    console.log(`${id}  ${pricing}`);

    // Row 2: sourcing + channels + worth
    const soldStr = d.lastCustomerSale
      ? `SoldCust:${fmtMoney(d.lastCustomerSale.soldPrice)} (${d.lastCustomerSale.customer?.slice(0, 18) || '?'}, ${d.lastCustomerSale.ageDays}d)`
      : 'SoldCust:—';
    const tgtStr  = d.maxCustomerRfqTarget ? `RFQTgt:${fmtMoney(d.maxCustomerRfqTarget)}` : 'RFQTgt:—';
    const rfqStr  = `CustRFQ:${d.customerRfqs90d || 0} BrkrRFQ:${d.brokerRfqs90d || 0}`;
    const cheapVq = l.enrichment.vqDetail?.cheapest
      ? `CheapVQ:${fmtMoney(l.enrichment.vqDetail.cheapest.cost)}@${l.enrichment.vqDetail.cheapest.vendor?.slice(0, 15) || '?'}`
      : '';
    const verdict = `${a.worth.padEnd(8)} ${rpad(a.pricing.state, 14)} ${rpad(a.sourcing.state, 17)} ${rpad(a.channels.state, 13)}`;
    const flags = (a.flags || []).join(',');
    console.log(`${' '.repeat(46)}${soldStr}  ${tgtStr}  ${rfqStr}  ${cheapVq}`);
    console.log(`${' '.repeat(46)}${verdict}  ${a.worthReason}${flags ? ' [' + flags + ']' : ''}`);
    console.log('');
  }

  // Summary
  const verdictCounts = lines.reduce((acc, l) => { acc[l.assess.worth] = (acc[l.assess.worth] || 0) + 1; return acc; }, {});
  const verdictStr = ['PURSUE', 'CONSIDER', 'PASS'].filter(t => verdictCounts[t]).map(t => `${t}:${verdictCounts[t]}`).join(' ');
  console.log(`Verdict: ${verdictStr}`);
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const searchKey = args.find(a => !a.startsWith('--'));
  if (!searchKey) {
    console.error('Usage: node render-reactive.js <offer-search-key> [--verbose]');
    process.exit(2);
  }

  const pool = new Pool({
    host: '/var/run/postgresql',
    database: process.env.PGDATABASE || 'idempiere_replica',
    user: process.env.PGUSER || process.env.USER || 'analytics_user',
  });

  try {
    const offer = await loadOffer(pool, searchKey);
    console.log(`Loaded offer ${searchKey} — ${offer.lines.length} lines`);

    const supplyStats = await enrichSupply(offer);
    console.log(`Supply enrichment: ${supplyStats.cached} cache hit(s), ${supplyStats.fresh} fresh call(s), ${supplyStats.errors} error(s)`);

    enrichDemand(offer);
    await enrichVqDetail(pool, offer);
    for (const line of offer.lines) line.assess = assessLine(line);

    renderReactive(offer, { verbose });
  } catch (e) {
    console.error('FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
