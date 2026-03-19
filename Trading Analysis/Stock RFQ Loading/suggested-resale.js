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
const DIGIKEY_SCRIPT = path.resolve(__dirname, '../../rfq_sourcing/franchise_check/digikey.js');
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

function runDigiKey(mpn, qty) {
  try {
    const result = execSync(`node "${DIGIKEY_SCRIPT}" "${mpn}" ${qty}`, {
      encoding: 'utf-8',
      timeout: 30000
    });
    // Extract JSON from output
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    // Try stderr too (rbash puts stdout there)
    return null;
  } catch (e) {
    const out = (e.stderr || '') + (e.stdout || '');
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch (_) {}
    }
    return null;
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
  const { digikey, vqs, offers, sales, rfqDemand, rfqCount, line } = data;

  const result = {
    franchiseStock: 0,
    franchisePrice: null,
    franchiseBulkPrice: null,
    franchiseCoverage: 'NONE',       // FULL, PARTIAL, NONE
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

  // --- 1. Franchise (highest priority factor) ---
  if (digikey && digikey.found) {
    result.franchiseStock = digikey.franchiseQty;
    result.franchisePrice = digikey.franchisePrice;
    result.franchiseBulkPrice = digikey.franchiseBulkPrice;

    if (digikey.franchiseQty >= line.qty) {
      result.franchiseCoverage = 'FULL';
      result.notes.push(`DigiKey FULL coverage: ${digikey.franchiseQty.toLocaleString()} avail vs ${line.qty.toLocaleString()} needed @ $${digikey.franchiseBulkPrice?.toFixed(4)}/ea`);
    } else if (digikey.franchiseQty > 0) {
      result.franchiseCoverage = 'PARTIAL';
      const pct = Math.round(digikey.franchiseQty / line.qty * 100);
      result.notes.push(`DigiKey PARTIAL: ${digikey.franchiseQty.toLocaleString()} avail (${pct}% of ${line.qty.toLocaleString()}) @ $${digikey.franchiseBulkPrice?.toFixed(4)}/ea`);
    } else {
      result.notes.push('DigiKey: found but 0 stock');
    }
  } else {
    result.franchiseCoverage = 'NONE';
    result.notes.push('DigiKey: NOT AVAILABLE in franchise distribution');
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
  // Priority: broker sale > franchise markup > VQ cost markup > market offer
  // Franchise availability modifies everything

  let suggestedResale = null;
  let basis = '';

  // Determine cost basis (what we'd pay to source)
  let costBasis = null;
  let costSource = '';

  if (result.vqPurchasedCost) {
    costBasis = result.vqPurchasedCost;
    costSource = 'purchased VQ';
  } else if (result.vqCostMedian) {
    costBasis = result.vqCostMedian;
    costSource = 'median VQ';
  } else if (result.franchiseBulkPrice) {
    costBasis = result.franchiseBulkPrice;
    costSource = 'DigiKey bulk';
  }

  // TIER 1: Broker sale history (strongest market signal)
  if (result.brokerSalePrice && costBasis) {
    suggestedResale = result.brokerSalePrice;
    basis = `Broker sale price ($${result.brokerSalePrice.toFixed(2)})`;

    // Adjust if franchise changes the picture
    if (result.franchiseCoverage === 'FULL' && result.franchiseBulkPrice) {
      // Franchise available = price pressure DOWN
      const franchiseCeiling = result.franchiseBulkPrice * 1.15; // can't go much above franchise
      if (suggestedResale > franchiseCeiling) {
        suggestedResale = franchiseCeiling;
        basis += ` → capped by franchise availability ($${result.franchiseBulkPrice.toFixed(4)} + 15%)`;
      }
    } else if (result.franchiseCoverage === 'NONE') {
      // No franchise = scarcity premium possible
      if (result.demandStrength === 'HIGH') {
        suggestedResale *= 1.10; // 10% premium on scarcity + demand
        basis += ' + 10% scarcity premium (no franchise, high demand)';
      }
    }
    result.confidence = 'HIGH';
  }
  // TIER 2: Customer sale history (weaker signal, but real transaction)
  else if (result.customerSalePrice && costBasis) {
    suggestedResale = result.customerSalePrice;
    basis = `Customer sale price ($${result.customerSalePrice.toFixed(2)}) — weaker signal than broker`;

    if (result.franchiseCoverage === 'FULL' && result.franchiseBulkPrice) {
      const franchiseCeiling = result.franchiseBulkPrice * 1.15;
      if (suggestedResale > franchiseCeiling) {
        suggestedResale = franchiseCeiling;
        basis += ` → capped by franchise ($${result.franchiseBulkPrice.toFixed(4)} + 15%)`;
      }
    }
    result.confidence = 'MEDIUM';
  }
  // TIER 3: Cost-based with franchise-adjusted margin
  else if (costBasis) {
    if (result.franchiseCoverage === 'FULL') {
      // Franchise fully covers — customer can buy direct. Broker margin is thin.
      suggestedResale = costBasis * 1.12; // 12% margin max
      basis = `${costSource} $${costBasis.toFixed(2)} + 12% (franchise covers full qty — thin broker margin)`;
      result.confidence = 'MEDIUM';
    } else if (result.franchiseCoverage === 'PARTIAL') {
      // Some franchise — moderate margin
      suggestedResale = costBasis * 1.20; // 20% margin
      basis = `${costSource} $${costBasis.toFixed(2)} + 20% (partial franchise — moderate broker margin)`;
      result.confidence = 'MEDIUM';
    } else {
      // No franchise — scarcity pricing
      if (result.demandStrength === 'HIGH') {
        suggestedResale = costBasis * 1.35; // 35% margin
        basis = `${costSource} $${costBasis.toFixed(2)} + 35% (no franchise, high demand — scarcity premium)`;
      } else if (result.demandStrength === 'MEDIUM') {
        suggestedResale = costBasis * 1.30; // 30% margin
        basis = `${costSource} $${costBasis.toFixed(2)} + 30% (no franchise, medium demand)`;
      } else {
        suggestedResale = costBasis * 1.25; // 25% margin
        basis = `${costSource} $${costBasis.toFixed(2)} + 25% (no franchise, standard margin)`;
      }
      result.confidence = costSource === 'purchased VQ' ? 'HIGH' : 'MEDIUM';
    }
  }
  // TIER 4: Market offer based
  else if (result.marketOfferPriceLow) {
    // Use market offer as proxy for cost, add margin
    costBasis = result.marketOfferPriceLow;
    if (result.franchiseCoverage === 'NONE') {
      suggestedResale = costBasis * 1.25;
      basis = `Market offer low $${costBasis.toFixed(2)} + 25% (no other cost data)`;
    } else {
      suggestedResale = costBasis * 1.15;
      basis = `Market offer low $${costBasis.toFixed(2)} + 15% (franchise available)`;
    }
    result.confidence = 'LOW';
  }
  // TIER 5: No data — flag for research
  else {
    suggestedResale = null;
    basis = 'INSUFFICIENT DATA — no VQ, franchise, sales, or offer history';
    result.confidence = 'NONE';
  }

  result.suggestedResale = suggestedResale;
  result.resaleBasis = basis;

  return result;
}

// --- VQ Capture (DigiKey data for ERP import) ---

function generateVQCapture(digikeyResults) {
  const vqLines = [];
  for (const { mpn, qty, dk } of digikeyResults) {
    if (dk && dk.found && dk.vqPrice) {
      vqLines.push({
        vendor: 'Digi-Key Electronics',
        vendorBP: '1002331',
        mpn: dk.vqMpn || mpn,
        manufacturer: dk.vqManufacturer || '',
        cost: dk.vqPrice,
        qty: dk.franchiseQty,
        description: dk.vqDescription || '',
        vendorNotes: dk.vqVendorNotes || '',
        digiKeyPN: dk.vqDigiKeyPn || ''
      });
    }
  }
  return vqLines;
}

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
  const digikeyCapture = [];

  for (const line of lines) {
    const mpn = line.mpn;
    const mpnClean = cleanMpn(mpn);

    if (mpnData[mpn]) {
      console.log(`[${mpn}] Using cached data`);
      continue;
    }

    console.log(`[${mpn}] Collecting data...`);

    // 1. DigiKey API
    console.log(`  → DigiKey API...`);
    const dk = runDigiKey(mpn, line.qty);
    if (dk && dk.found) {
      console.log(`    ✓ Found: ${dk.franchiseQty} pcs @ $${dk.franchiseBulkPrice}/ea`);
      digikeyCapture.push({ mpn, qty: line.qty, dk });
    } else {
      console.log(`    ✗ Not available`);
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

    mpnData[mpn] = { digikey: dk, vqs, offers, sales, rfqDemand, rfqCount };
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
    'Franchise Stock', 'Franchise Bulk Price', 'Franchise Coverage',
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
      fmt(pricing.franchiseBulkPrice, 4),
      pricing.franchiseCoverage,
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

  // --- VQ Capture File (DigiKey data for ERP import) ---
  const vqLines = generateVQCapture(digikeyCapture);
  if (vqLines.length > 0) {
    const vqFile = path.join(outputDir, `${baseName}_DigiKey_VQ.csv`);
    const vqHeader = 'Vendor BP,MPN,Manufacturer,Cost,Qty Available,Description,Vendor Notes,DigiKey PN';
    const vqRows = vqLines.map(v => [
      v.vendorBP, `"${v.mpn}"`, `"${v.manufacturer}"`, v.cost,
      v.qty, `"${v.description}"`, `"${v.vendorNotes}"`, `"${v.digiKeyPN}"`
    ].join(','));
    fs.writeFileSync(vqFile, [vqHeader, ...vqRows].join('\n') + '\n');
    console.log(`DigiKey VQ capture saved to: ${vqFile} (${vqLines.length} lines)`);
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
      ? `${pricing.franchiseCoverage} (${pricing.franchiseStock})`
      : 'NONE';

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
