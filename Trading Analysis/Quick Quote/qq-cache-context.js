#!/usr/bin/env node
/**
 * Quick Quote — Cache Context Supplement
 *
 * Takes an RFQ number, walks the franchise API file cache for every MPN
 * on that RFQ, and outputs a supplementary CSV (`qq_{RFQ}_cache_context.csv`)
 * containing the alternate price tiers + distributors that aren't in
 * chuboe_vq_line.
 *
 * Why: per the rfq-api-enrichment.md design (line 140), the file cache at
 * shared/data/api-pricing-cache/ is the canonical store for full distributor
 * pricing envelopes — Quick Quote was always supposed to read it for context.
 * Implementation never delivered until A4 Finding 3 surfaced the gap on
 * 2026-04-09.
 *
 * Usage:
 *   node "Trading Analysis/Quick Quote/qq-cache-context.js" 1130263
 *
 * Output: ./qq_1130263_cache_context.csv (in the current working directory)
 *
 * Pairs with the existing SQL workflow:
 *   psql -f qq_1130263.sql > "Quick Quote 1130263 YYYY-MM-DD Customer.csv"
 *   node qq-cache-context.js 1130263   # supplementary cache view
 *
 * The two outputs are intended to be reviewed side-by-side. The QQ CSV is
 * the actionable pricing logic (margin/GP/floor against VQs in the 30d
 * window); the cache context CSV is the broader market intel (alternate
 * price tiers + distributors that didn't land in VQs but exist in the
 * cached envelopes).
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CACHE_DIR = path.resolve(__dirname, '../../shared/data/api-pricing-cache');
const CACHE_LOOKBACK_DAYS = 90;
// Same cutoff as vortex-matches.js — Arrow/Verical entries from envelopes
// captured before today's parser fix (commit fa740e9, 2026-04-09T14:30:36Z)
// have the broken single-row Arrow shape and would resurrect data we just
// corrected. Skip them.
const ARROW_PARSER_FIX_CUTOFF = new Date('2026-04-09T13:00:00Z');

// Canonical BP name lookup so output matches the names sellers see in
// chuboe_vq_line / Vortex / OT.
const SUPPLIER_NAME_CANONICAL = (() => {
  try {
    const dists = require('../../shared/franchise-api').DISTRIBUTORS || {};
    const map = {};
    for (const key of Object.keys(dists)) {
      const cfg = dists[key];
      if (cfg.name && cfg.bpName) map[cfg.name] = cfg.bpName;
    }
    return map;
  } catch (e) {
    return {};
  }
})();

function canonicalSupplierName(rawName) {
  return SUPPLIER_NAME_CANONICAL[rawName] || rawName;
}

function cacheKeyForMpn(mpn) {
  return mpn.replace(/[^A-Za-z0-9-]/g, '_').toUpperCase();
}

async function main() {
  const rfqValue = process.argv[2];
  if (!rfqValue) {
    console.error('Usage: node qq-cache-context.js <rfq_number>');
    console.error('Example: node qq-cache-context.js 1130263');
    process.exit(1);
  }

  const pool = new Pool({
    host: '/var/run/postgresql',
    database: process.env.PGDATABASE || 'idempiere_replica',
    user: process.env.PGUSER || process.env.USER || 'analytics_user',
  });

  // Pull every distinct MPN on the RFQ
  const { rows: mpnRows } = await pool.query(`
    SELECT DISTINCT
      rlm.chuboe_mpn_clean AS mpn,
      rl.qty AS rfq_qty,
      rl.chuboe_cpc AS cpc
    FROM adempiere.chuboe_rfq rfq
    JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rfq.value = $1
      AND rl.isactive = 'Y'
      AND rlm.isactive = 'Y'
      AND rlm.chuboe_mpn_clean IS NOT NULL
    ORDER BY rlm.chuboe_mpn_clean
  `, [rfqValue]);
  await pool.end();

  if (mpnRows.length === 0) {
    console.error(`No MPNs found on RFQ ${rfqValue}`);
    process.exit(1);
  }

  console.log(`RFQ ${rfqValue}: ${mpnRows.length} unique MPNs`);

  // Build a map of MPN → list of (cpc, rfq_qty) so the output rows can
  // include the customer-side context.
  const mpnContext = new Map();
  for (const r of mpnRows) {
    if (!mpnContext.has(r.mpn)) mpnContext.set(r.mpn, []);
    mpnContext.get(r.mpn).push({ cpc: r.cpc || '', rfqQty: Number(r.rfq_qty) || 0 });
  }

  // Walk the cache directory for each MPN
  if (!fs.existsSync(CACHE_DIR)) {
    console.error(`Cache directory not found: ${CACHE_DIR}`);
    process.exit(1);
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CACHE_LOOKBACK_DAYS);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const allFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));

  const outRows = [];
  let mpnsHit = 0;

  for (const [mpn, contexts] of mpnContext.entries()) {
    const prefix = cacheKeyForMpn(mpn) + '_';
    const matchingFiles = allFiles
      .filter(f => f.startsWith(prefix))
      .filter(f => f.replace(prefix, '').replace('.json', '') >= cutoffStr)
      .sort()
      .reverse();
    if (matchingFiles.length === 0) continue;
    mpnsHit++;

    let env;
    try {
      env = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, matchingFiles[0]), 'utf-8'));
    } catch (e) {
      continue;
    }

    const meta = env.data?._meta || {};
    const pricings = env.data?.Pricings || [];
    const envelopeTime = meta.timestamp ? new Date(meta.timestamp) : null;
    const sourceConsumer = meta.consumer || 'unknown';
    const searchedQty = meta.searchedQty || null;

    for (const p of pricings) {
      const rawSupplier = p.SupplierName || '';
      const isArrowChannel = /^(arrow|verical)/i.test(rawSupplier) || rawSupplier === 'Arrow Electronics';
      if (isArrowChannel && envelopeTime && envelopeTime < ARROW_PARSER_FIX_CUTOFF) continue;

      const supplier = canonicalSupplierName(rawSupplier);
      const stockQty = p.CurrentStockQty || 0;
      const leadTime = p.LeadTime || '';
      const dateCode = p.DateCode || '';
      const apiMpn = p.ManufacturerPartNumber || mpn;
      const apiMfr = p.ManufacturerName || '';

      // Collapse the price ladder by distinct unit price — same as
      // vortex-matches.js fetchCachedEnvelopes. One row per (supplier, price)
      // with the lowest qty break that unlocks that price.
      const ladder = p.Pricings || [];
      if (ladder.length === 0) continue;
      const byPrice = new Map();
      for (const tier of ladder) {
        const price = tier.UnitPrice;
        if (price == null) continue;
        const qtyBreak = tier.QtyBreak ?? 1;
        if (!byPrice.has(price) || qtyBreak < byPrice.get(price)) {
          byPrice.set(price, qtyBreak);
        }
      }

      // Emit one output row per (price tier × RFQ context)
      for (const [price, tierMinQty] of byPrice.entries()) {
        for (const ctx of contexts) {
          outRows.push({
            rfq: rfqValue,
            mpn,
            cpc: ctx.cpc,
            rfq_qty: ctx.rfqQty,
            api_mpn: apiMpn,
            api_mfr: apiMfr,
            supplier,
            stock_qty: stockQty,
            tier_min_qty: tierMinQty,
            unit_price: price,
            lead_time: leadTime,
            date_code: dateCode,
            pulled: envelopeTime ? envelopeTime.toISOString().slice(0, 19).replace('T', ' ') : '',
            envelope_searched_qty: searchedQty,
            source_consumer: sourceConsumer,
          });
        }
      }
    }
  }

  // Sort: MPN > supplier > unit_price ascending
  outRows.sort((a, b) => {
    if (a.mpn !== b.mpn) return a.mpn.localeCompare(b.mpn);
    if (a.supplier !== b.supplier) return a.supplier.localeCompare(b.supplier);
    return (a.unit_price || 0) - (b.unit_price || 0);
  });

  // Emit CSV
  const headers = [
    'RFQ', 'MPN', 'CPC', 'RFQ Qty', 'API MPN', 'API MFR', 'Supplier',
    'Stock Qty', 'Tier Min Qty', 'Unit Price', 'Lead Time', 'Date Code',
    'Pulled', 'Envelope Searched Qty', 'Source Consumer'
  ];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(','),
    ...outRows.map(r => [
      r.rfq, r.mpn, r.cpc, r.rfq_qty, r.api_mpn, r.api_mfr, r.supplier,
      r.stock_qty, r.tier_min_qty, r.unit_price, r.lead_time, r.date_code,
      r.pulled, r.envelope_searched_qty, r.source_consumer
    ].map(esc).join(','))
  ].join('\n');

  const outFile = `qq_${rfqValue}_cache_context.csv`;
  fs.writeFileSync(outFile, csv, 'utf-8');

  console.log(`MPNs with cache hits: ${mpnsHit} / ${mpnContext.size}`);
  console.log(`Output rows: ${outRows.length}`);
  console.log(`Wrote: ${path.resolve(outFile)}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
