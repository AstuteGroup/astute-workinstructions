#!/usr/bin/env node
/**
 * Suggested Resale Analysis for Stock RFQ Lines
 *
 * Takes an RFQ upload CSV and generates comprehensive resale suggestions
 * using all available data sources:
 *   1. DigiKey API — franchise stock + pricing (captured as VQ data)
 *   2. Secondary market VQ costs from DB
 *   3. Market offers (customer excess, broker stock) from DB
 *   4. Sales history (broker sales weighted > customer sales)
 *   5. RFQ demand signals (loose guidance)
 *
 * Usage: node suggested-resale.js <rfq-upload.csv> [--output <path>]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Config ---
const { searchAllDistributors, writeVQCapture } = require('../../shared/franchise-api');
const FINDCHIPS_SCRIPT = path.resolve(__dirname, '../../rfq_sourcing/franchise_check/main.js');

// Franchise pricing rule: our price ≈ 20% of franchise best price
// (older DC, untraceable stock — buyer needs room to resell vs franchise)
const FRANCHISE_RATIO = 0.20;
const FRANCHISE_RATIO_NEWER_DC = 0.30; // slightly more for 3-5yr date codes
const VQ_LOOKBACK_MONTHS = 12;
const OFFER_LOOKBACK_DAYS = 180;
const SALES_LOOKBACK_MONTHS = 24;
const RFQ_LOOKBACK_MONTHS = 12;

// --- Helpers ---

function psql(query) {
  try {
    const result = execSync(`psql -t -A -F '|' -c "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30000
    });
    return parsePsqlOutput(result);
  } catch (e) {
    // psql returns exit code 1 due to rbash errors but still works
    // Output may be in stdout OR stderr depending on rbash behavior
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

function cleanMpn(mpn) {
  return mpn.replace(/[-\s\/.:,]/g, '').toUpperCase();
}

function getBaseMpn(mpnClean) {
  // Strip packaging suffixes to search base part number
  const suffixes = ['REEL', 'TRAY', 'BULK', 'TR', 'CT', 'DKR', 'TU'];
  let base = mpnClean;
  for (const suffix of suffixes) {
    if (base.endsWith(suffix) && base.length > suffix.length + 3) {
      return base.slice(0, -suffix.length);
    }
  }
  return null; // no suffix found
}

function buildMpnPattern(mpnClean) {
  // Returns SQL OR pattern matching both exact and base MPN
  const base = getBaseMpn(mpnClean);
  if (base && base !== mpnClean) {
    return `(ILIKE '${mpnClean}%' OR ILIKE '${base}%')`;
  }
  return `ILIKE '${mpnClean}%'`;
}

function mpnWhereClause(column, mpnClean) {
  const base = getBaseMpn(mpnClean);
  if (base && base !== mpnClean) {
    return `(${column} ILIKE '${mpnClean}%' OR ${column} ILIKE '${base}%')`;
  }
  return `${column} ILIKE '${mpnClean}%'`;
}

// runDigiKey removed — use shared/franchise-api.js searchAllDistributors() instead

function runFindChips(mpn, qty) {
  // FindChips = AVAILABILITY signal only, not confirmed pricing
  // Returns franchise distributor stock levels (scraped, not API)
  try {
    const result = execSync(`node "${FINDCHIPS_SCRIPT}" -p "${mpn}" -q ${qty} 2>&1`, {
      encoding: 'utf-8',
      timeout: 60000
    });
    // Parse the screening output for franchise qty
    const combined = result;
    // Look for "Not found" or franchise data in the xlsx output
    if (combined.includes('Not found in franchise distribution')) {
      return { found: false, franchiseQty: 0, note: 'Not in any franchise distributor (FindChips)' };
    }
    if (combined.includes('Skip broker (franchise OK)')) {
      return { found: true, franchiseQty: qty, note: 'Available in franchise distribution (FindChips)' };
    }
    // Default: sent to broker = not readily available in franchise
    return { found: false, franchiseQty: 0, note: 'Not readily available in franchise (FindChips)' };
  } catch (e) {
    const out = (e.stderr || '') + (e.stdout || '');
    if (out.includes('Not found in franchise distribution')) {
      return { found: false, franchiseQty: 0, note: 'Not in any franchise distributor (FindChips)' };
    }
    if (out.includes('Skip broker')) {
      return { found: true, franchiseQty: qty, note: 'Available in franchise distribution (FindChips)' };
    }
    return { found: false, franchiseQty: 0, note: 'FindChips check failed' };
  }
}

function parseUploadCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parse handling quoted fields
    const fields = [];
    let field = '', inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { fields.push(field); field = ''; continue; }
      field += ch;
    }
    fields.push(field);
    if (fields.length >= 4) {
      rows.push({
        rfqId: fields[0],
        cpc: fields[1],
        mfr: fields[2],
        mpn: fields[3],
        qty: parseInt(fields[4]) || 0,
        targetPrice: parseFloat(fields[5]) || null,
        description: fields[6] || ''
      });
    }
  }
  return rows;
}

// --- Data Collection Functions ---

function getVQHistory(mpnClean) {
  const rows = psql(`
    SELECT vendor_quote_mpn_clean, vendor_quote_cost, vendor_quote_quantity,
           vendor_quote_bpartner_name, vendor_quote_created::date,
           vendor_quote_date_code, vendor_quote_purchased
    FROM adempiere.bi_vendor_quote_line_v
    WHERE ${mpnWhereClause('vendor_quote_mpn_clean', mpnClean)}
    AND vendor_quote_created >= CURRENT_DATE - INTERVAL '${VQ_LOOKBACK_MONTHS} months'
    AND vendor_quote_cost > 0
    ORDER BY vendor_quote_created DESC LIMIT 20
  `);
  return rows.map(r => ({
    mpn: r[0], cost: parseFloat(r[1]), qty: parseInt(r[2]),
    vendor: r[3], date: r[4], dc: r[5], purchased: r[6] === 'Y'
  }));
}

function getMarketOffers(mpnClean) {
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
    AND o.created >= CURRENT_DATE - INTERVAL '${OFFER_LOOKBACK_DAYS} days'
    ORDER BY o.created DESC LIMIT 15
  `);
  return rows.map(r => ({
    mpn: r[0], qty: parseInt(r[1]), price: parseFloat(r[2]) || 0,
    partner: r[3], offerType: r[4], date: r[5], dc: r[6],
    isVendor: r[7] === 'Y', isCustomer: r[8] === 'Y'
  }));
}

function getSalesHistory(mpnClean) {
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
    AND so.dateordered >= CURRENT_DATE - INTERVAL '${SALES_LOOKBACK_MONTHS} months'
    AND sol.chuboe_mpn IS NOT NULL
    AND ${mpnWhereClause("UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(sol.chuboe_mpn, '-', ''), ' ', ''), '/', ''), ':', ''), ',', ''))", mpnClean)}
    ORDER BY so.dateordered DESC LIMIT 15
  `);
  return rows.map(r => ({
    mpn: r[0], date: r[1], customer: r[2],
    price: parseFloat(r[3]) || 0, qty: parseInt(r[4]) || 0,
    isVendor: r[5] === 'Y', isCustomer: r[6] === 'Y',
    bpGroup: r[7] || '',
    isBrokerSale: r[5] === 'Y'  // sold to a vendor = broker sale
  }));
}

function getRFQDemand(mpnClean) {
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
    AND r.created >= CURRENT_DATE - INTERVAL '${RFQ_LOOKBACK_MONTHS} months'
    ORDER BY r.created DESC LIMIT 15
  `);
  return rows.map(r => ({
    mpn: r[0], qty: parseInt(r[1]) || 0, target: parseFloat(r[2]) || 0,
    customer: r[3], rfqType: r[4], date: r[5], isVendor: r[6] === 'Y'
  }));
}

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

// --- Pricing Logic ---

function calculateSuggestedResale(data) {
  const { franchise, vqs, offers, sales, rfqDemand, rfqCount, line } = data;

  const result = {
    franchiseStock: 0,
    franchiseLowestPrice: null,
    franchiseCoverage: 'NONE',       // FULL, PARTIAL, NONE
    franchiseDistributors: 0,        // how many distributors have it
    vqCostLow: null,
    vqCostHigh: null,
    vqCostMedian: null,
    vqPurchasedCost: null,           // actual purchased price (strongest signal)
    marketOfferCount: 0,
    marketOfferPriceLow: null,
    marketOfferPriceHigh: null,
    brokerSalePrice: null,           // most relevant
    customerSalePrice: null,         // less relevant
    rfqCount: rfqCount.count,
    demandStrength: 'NONE',          // HIGH, MEDIUM, LOW, NONE
    suggestedResale: null,
    resaleBasis: '',
    confidence: 'LOW',               // HIGH, MEDIUM, LOW
    notes: []
  };

  // --- 1. Franchise (ALL 7 distributors via shared/franchise-api.js) ---
  if (franchise && franchise.summary) {
    const s = franchise.summary;
    result.franchiseStock = s.totalStock;
    result.franchiseLowestPrice = s.lowestPrice;
    result.franchiseDistributors = s.distributorsWithStock;
    result.franchiseCoverage = s.coverage;

    if (s.distributorsWithStock > 0) {
      // List each distributor with stock
      for (const d of franchise.found) {
        result.notes.push(`${d.name}: ${d.franchiseQty.toLocaleString()} pcs @ $${d.franchiseBulkPrice?.toFixed(4)}/ea`);
      }
      result.notes.push(`FRANCHISE TOTAL: ${s.totalStock.toLocaleString()} pcs across ${s.distributorsWithStock} distributors. Best price: $${s.lowestPrice?.toFixed(4)}. Coverage: ${s.coverage} (${s.coveragePct}%)`);
    } else {
      result.notes.push(`Franchise: checked ${s.distributorsChecked} distributors — NOT AVAILABLE in distribution`);
    }
  } else {
    result.franchiseCoverage = 'NONE';
    result.notes.push('Franchise: data not available');
  }

  // --- 2. Secondary market VQ costs ---
  if (vqs.length > 0) {
    const costs = vqs.map(v => v.cost).filter(c => c > 0);
    const purchased = vqs.filter(v => v.purchased);

    if (costs.length > 0) {
      result.vqCostLow = Math.min(...costs);
      result.vqCostHigh = Math.max(...costs);
      const sorted = [...costs].sort((a, b) => a - b);
      result.vqCostMedian = sorted[Math.floor(sorted.length / 2)];
      result.notes.push(`Secondary market: $${result.vqCostLow.toFixed(2)}-$${result.vqCostHigh.toFixed(2)} (${costs.length} quotes, median $${result.vqCostMedian.toFixed(2)})`);
    }

    if (purchased.length > 0) {
      result.vqPurchasedCost = purchased[0].cost; // most recent purchased
      result.notes.push(`PURCHASED at $${result.vqPurchasedCost.toFixed(2)} from ${purchased[0].vendor} (${purchased[0].date})`);
    }
  }

  // --- 3. Market offers ---
  if (offers.length > 0) {
    const priced = offers.filter(o => o.price > 0);
    result.marketOfferCount = offers.length;

    if (priced.length > 0) {
      const prices = priced.map(o => o.price);
      result.marketOfferPriceLow = Math.min(...prices);
      result.marketOfferPriceHigh = Math.max(...prices);
      result.notes.push(`Market offers: ${offers.length} total, ${priced.length} priced ($${result.marketOfferPriceLow.toFixed(2)}-$${result.marketOfferPriceHigh.toFixed(2)})`);
    } else {
      result.notes.push(`Market offers: ${offers.length} (no prices)`);
    }

    // List offer types
    const types = [...new Set(offers.map(o => o.offerType))];
    result.notes.push(`Offer types: ${types.join(', ')}`);
  }

  // --- 4. Sales history (broker > customer) ---
  const brokerSales = sales.filter(s => s.isBrokerSale && s.price > 0);
  const customerSales = sales.filter(s => !s.isBrokerSale && s.price > 0);

  if (brokerSales.length > 0) {
    result.brokerSalePrice = brokerSales[0].price; // most recent
    result.notes.push(`BROKER SALE: $${result.brokerSalePrice.toFixed(2)} to ${brokerSales[0].customer} (${brokerSales[0].date}, qty ${brokerSales[0].qty})`);
  }
  if (customerSales.length > 0) {
    result.customerSalePrice = customerSales[0].price;
    result.notes.push(`Customer sale: $${result.customerSalePrice.toFixed(2)} to ${customerSales[0].customer} (${customerSales[0].date})`);
  }

  // --- 5. RFQ demand ---
  if (rfqCount.count >= 50) result.demandStrength = 'HIGH';
  else if (rfqCount.count >= 10) result.demandStrength = 'MEDIUM';
  else if (rfqCount.count >= 3) result.demandStrength = 'LOW';

  if (rfqCount.count > 0) {
    result.notes.push(`RFQ demand: ${rfqCount.count} total (${rfqCount.earliest} to ${rfqCount.latest}) — ${result.demandStrength}`);
  }

  // --- PRICING SYNTHESIS ---
  // MARKET-BASED, not cost-plus. Inventory often has no cost (consignment, aged).
  // Anchor to market signals, adjust by scarcity (franchise availability).
  //
  // Signal hierarchy:
  //   1. Broker sale price (strongest — real market clearing price)
  //   2. DigiKey API price (confirmed franchise — price ceiling when available)
  //   3. VQ market level (secondary market benchmark)
  //   4. Market offer prices (supply-side reference)
  //   5. Customer sale price (weaker — relationship/contract factors)
  //
  // Scarcity modifier:
  //   Franchise FULL → price near franchise (customer has alternatives)
  //   Franchise PARTIAL → price above franchise (broker fills the gap)
  //   Franchise NONE → scarcity premium (secondary market only)

  let suggestedResale = null;
  let basis = '';

  const hasAnyFranchise = result.franchiseCoverage !== 'NONE';

  // SCENARIO A: Franchise HAS stock → start at ~20-30% of their best price
  // Our stock is older DC, untraceable. Buyer (another broker) needs room
  // to resell vs franchise. Baseline 20% for cheap parts, up to 30% for pricier parts.
  // BUT: broker sales/VQ market can override this if the real market is different.
  if (result.franchiseCoverage !== 'NONE' && result.franchiseLowestPrice) {
    // Scale ratio: higher-value parts → closer to 30%
    const franchiseVal = result.franchiseLowestPrice;
    let ratio = FRANCHISE_RATIO; // 20% baseline
    if (franchiseVal >= 10) ratio = 0.30;       // $10+ parts → 30%
    else if (franchiseVal >= 1) ratio = 0.25;   // $1-10 → 25%
    // else < $1 → 20%

    suggestedResale = franchiseVal * ratio;
    basis = `~${Math.round(ratio*100)}% of franchise best ($${franchiseVal.toFixed(4)})`;
    basis += ` | ${result.franchiseDistributors} distributor(s), ${result.franchiseStock.toLocaleString()} pcs`;

    // Broker sales or VQ market can override franchise-based pricing
    if (result.brokerSalePrice) {
      // If brokers are selling at a different level, that's the real market
      const brokerRatio = result.brokerSalePrice / franchiseVal;
      if (Math.abs(brokerRatio - ratio) > 0.05) {
        suggestedResale = result.brokerSalePrice;
        basis = `Broker sale $${result.brokerSalePrice.toFixed(2)} (${Math.round(brokerRatio*100)}% of franchise) overrides baseline`;
      } else {
        basis += ` | Broker sale confirms: $${result.brokerSalePrice.toFixed(2)}`;
      }
    } else if (result.vqCostMedian && result.vqCostMedian < suggestedResale) {
      // If secondary market is trading below our franchise-based price, adjust down
      suggestedResale = result.vqCostMedian * 0.80; // below VQ market (we're selling, not buying)
      basis += ` | Adjusted down: VQ market median $${result.vqCostMedian.toFixed(2)} is below franchise ratio`;
    }

    result.confidence = 'HIGH';
  }
  // SCENARIO B: NO franchise stock → different game. Secondary market/scarcity pricing.
  // TIER B1: Broker sale price (strongest market signal for no-franchise parts)
  else if (result.brokerSalePrice) {
    suggestedResale = result.brokerSalePrice;
    basis = `Broker sale: $${result.brokerSalePrice.toFixed(2)} (no franchise — secondary market)`;
    if (result.demandStrength === 'HIGH') {
      basis += ' | High demand supports this level';
    }
    result.confidence = 'HIGH';
  }
  // TIER B2: VQ market level (what secondary market is trading at)
  else if (result.vqCostMedian) {
    suggestedResale = result.vqCostMedian;
    basis = `VQ market median: $${result.vqCostMedian.toFixed(2)} (no franchise — secondary market level)`;

    if (result.vqPurchasedCost) {
      basis += ` | Purchased at $${result.vqPurchasedCost.toFixed(2)}`;
    }
    // Demand strength as context, not a multiplier
    if (result.demandStrength === 'HIGH') {
      basis += ' | HIGH demand — room to price above median';
    }
    result.confidence = result.vqPurchasedCost ? 'HIGH' : 'MEDIUM';
  }
  // TIER B3: Market offers as reference
  else if (result.marketOfferPriceLow) {
    suggestedResale = (result.marketOfferPriceLow + result.marketOfferPriceHigh) / 2;
    basis = `Market offer mid-point: $${suggestedResale.toFixed(2)} (no franchise, no VQ — offer-based)`;
    result.confidence = 'LOW';
  }
  // TIER B4: Customer sale (weakest signal)
  else if (result.customerSalePrice) {
    suggestedResale = result.customerSalePrice;
    basis = `Customer sale: $${result.customerSalePrice.toFixed(2)} (weak signal — no other data)`;
    result.confidence = 'LOW';
  }
  // TIER B5: No data — flag for research
  else {
    suggestedResale = null;
    basis = 'INSUFFICIENT DATA — no franchise, VQ, sales, or offer history';
    result.confidence = 'NONE';
  }

  result.suggestedResale = suggestedResale;
  result.resaleBasis = basis;

  return result;
}

// VQ capture now handled by shared/franchise-api.js writeVQCapture()

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node suggested-resale.js <rfq-upload.csv> [--output <path>]');
    process.exit(1);
  }

  const inputFile = args[0];
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : path.dirname(inputFile);

  console.log(`\n=== Suggested Resale Analysis ===`);
  console.log(`Input: ${inputFile}`);
  console.log(`Output: ${outputDir}\n`);

  // Parse input
  const lines = parseUploadCSV(inputFile);
  console.log(`Loaded ${lines.length} RFQ lines\n`);

  // Dedupe MPNs (same MPN from different requestors shares the same market data)
  const uniqueMpns = [...new Set(lines.map(l => l.mpn))];
  console.log(`Unique MPNs: ${uniqueMpns.length}\n`);

  // Collect data for each MPN
  const mpnData = {};
  const allVqLines = []; // VQ capture from ALL API results

  for (const line of lines) {
    const mpn = line.mpn;
    const mpnClean = cleanMpn(mpn);

    if (mpnData[mpn]) {
      console.log(`[${mpn}] Using cached data`);
      continue;
    }

    console.log(`[${mpn}] Collecting data...`);

    // 1. Franchise APIs (ALL 7 distributors via shared/franchise-api.js)
    console.log(`  → Franchise APIs (7 distributors)...`);
    const franchise = await searchAllDistributors(mpn, line.qty, {
      onResult: (r) => {
        if (r.found) {
          console.log(`    ✓ ${r.name}: ${r.franchiseQty} pcs @ $${r.franchiseBulkPrice?.toFixed(4)}/ea`);
        } else if (r.error) {
          console.log(`    ✗ ${r.name}: ${r.error}`);
        } else {
          console.log(`    - ${r.name}: not available`);
        }
      }
    });
    console.log(`    TOTAL: ${franchise.summary.totalStock} pcs from ${franchise.summary.distributorsWithStock} distributors`);

    // Collect VQ lines from API results (confirmed pricing → log as VQ)
    if (franchise.vqLines.length > 0) {
      allVqLines.push(...franchise.vqLines);
      console.log(`    VQ capture: ${franchise.vqLines.length} lines from API data`);
    }

    // 2. VQ History
    console.log(`  → VQ History...`);
    const vqs = getVQHistory(mpnClean);
    console.log(`    ${vqs.length} quotes found`);

    // 3. Market Offers
    console.log(`  → Market Offers...`);
    const offers = getMarketOffers(mpnClean);
    console.log(`    ${offers.length} offers found`);

    // 4. Sales History
    console.log(`  → Sales History...`);
    const sales = getSalesHistory(mpnClean);
    const brokerSales = sales.filter(s => s.isBrokerSale);
    console.log(`    ${sales.length} sales (${brokerSales.length} broker)`);

    // 5. RFQ Demand
    console.log(`  → RFQ Demand...`);
    const rfqDemand = getRFQDemand(mpnClean);
    const rfqCount = getRFQCount(mpnClean);
    console.log(`    ${rfqCount.count} total RFQs`);

    mpnData[mpn] = { franchise, vqs, offers, sales, rfqDemand, rfqCount };
    console.log('');
  }

  // Calculate suggested resale for each line
  const results = [];
  for (const line of lines) {
    const data = { ...mpnData[line.mpn], line };
    const pricing = calculateSuggestedResale(data);
    results.push({ line, pricing });
  }

  // --- Output CSV ---
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const baseName = path.basename(inputFile, '.csv');
  const outFile = path.join(outputDir, `${baseName}_RESALE.csv`);

  const csvHeader = [
    'MPN', 'RFQ Qty', 'Requestor', 'Customer Target',
    'Franchise Stock', 'Franchise Lowest Price', 'Franchise Coverage', 'Franchise Distributors',
    'VQ Cost Low', 'VQ Cost High', 'VQ Purchased Cost',
    'Market Offers', 'Offer Price Range',
    'Broker Sale Price', 'Customer Sale Price',
    'RFQ Demand Count', 'Demand Strength',
    'Suggested Resale', 'Resale Basis', 'Confidence',
    'Notes'
  ].join(',');

  const csvRows = results.map(({ line, pricing }) => {
    const fmt = (v, decimals = 2) => v != null ? v.toFixed(decimals) : '';
    const offerRange = (pricing.marketOfferPriceLow != null)
      ? `$${pricing.marketOfferPriceLow.toFixed(2)}-$${pricing.marketOfferPriceHigh.toFixed(2)}`
      : '';

    return [
      `"${line.mpn}"`,
      line.qty,
      `"${line.description || line.rfqId}"`,
      fmt(line.targetPrice),
      pricing.franchiseStock,
      fmt(pricing.franchiseLowestPrice, 4),
      pricing.franchiseCoverage,
      pricing.franchiseDistributors,
      fmt(pricing.vqCostLow),
      fmt(pricing.vqCostHigh),
      fmt(pricing.vqPurchasedCost),
      pricing.marketOfferCount,
      `"${offerRange}"`,
      fmt(pricing.brokerSalePrice),
      fmt(pricing.customerSalePrice),
      pricing.rfqCount,
      pricing.demandStrength,
      fmt(pricing.suggestedResale),
      `"${pricing.resaleBasis}"`,
      pricing.confidence,
      `"${pricing.notes.join(' | ')}"`,
    ].join(',');
  });

  const csvContent = [csvHeader, ...csvRows].join('\n') + '\n';
  fs.writeFileSync(outFile, csvContent);
  console.log(`\nResale analysis saved to: ${outFile}`);

  // --- VQ Capture File (ALL API data for ERP import) ---
  if (allVqLines.length > 0) {
    const vqFile = path.join(outputDir, `${baseName}_Franchise_VQ.csv`);
    writeVQCapture(vqFile, allVqLines);
    console.log(`Franchise VQ capture saved to: ${vqFile} (${allVqLines.length} lines from ${new Set(allVqLines.map(v => v.vendorName)).size} distributors)`);
  }

  // --- Console Summary ---
  console.log('\n' + '='.repeat(80));
  console.log('SUGGESTED RESALE SUMMARY');
  console.log('='.repeat(80));

  for (const { line, pricing } of results) {
    const resaleStr = pricing.suggestedResale != null
      ? `$${pricing.suggestedResale.toFixed(2)}`
      : 'N/A';
    const franchiseStr = pricing.franchiseCoverage !== 'NONE'
      ? `${pricing.franchiseCoverage} (${pricing.franchiseStock.toLocaleString()} pcs, ${pricing.franchiseDistributors} distributors, best $${pricing.franchiseLowestPrice?.toFixed(4)})`
      : `NONE (checked 7 distributors)`;

    console.log(`\n${line.mpn} (qty ${line.qty.toLocaleString()})`);
    console.log(`  Franchise: ${franchiseStr}`);
    console.log(`  Suggested: ${resaleStr} [${pricing.confidence}]`);
    console.log(`  Basis: ${pricing.resaleBasis}`);
    if (pricing.notes.length > 0) {
      for (const note of pricing.notes) {
        console.log(`  • ${note}`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
