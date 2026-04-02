/**
 * OEMSecrets API Integration for Franchise Screening
 *
 * Aggregator API - returns stock/pricing from multiple distributors in one call.
 * Uses GET with API key query parameter.
 * Docs: https://oemsecretsapi.com/documentation
 *
 * NOTE: This is an aggregator, not a single franchise distributor.
 * Results include distributor names — we filter OUT distributors already
 * covered by direct APIs (DigiKey, Arrow, Mouser, etc.) and surface
 * incremental coverage from distributors we don't have direct access to.
 *
 * TRUST TIERS (aggregator data is not as reliable as direct APIs):
 *   Tier 1 = direct APIs (filtered out here, handled by franchise-api.js)
 *   Tier 2 = authorized franchise via aggregator — pricing is reference, not confirmed
 *   Tier 3 = broker/independent via aggregator — availability signal only, pricing suppressed
 *   Tier 4 = MFR direct (AD, Microchip) — list price reference, never VQ
 *
 * Every result carries a `tier` and `source` field so downstream consumers
 * (VQ loading, Quick Quote, screening) can decide how to use the data.
 */

const https = require('https');

// OEMSecrets API Configuration
const OEMSECRETS_CONFIG = {
  apiKey: process.env.OEMSECRETS_API_KEY || 'srz3ugdah9lm5fzj7bf2fkt7n2ycp2lqvc8rh4sc48upn41ctfp9ngu9pekf1haf',
  baseUrl: 'oemsecretsapi.com',
  searchPath: '/partsearch',
  countryCode: 'US',
  currency: 'USD',
};

// Distributors we already have direct API access to — filter these out of aggregated results
// Matched case-insensitively against distributor_name from API
const DIRECT_API_DISTRIBUTORS = [
  'digikey', 'digi-key',
  'arrow',                      // also covers Verical (Arrow subsidiary), Richardson RFPD
  'mouser',
  'newark', 'farnell', 'element14',
  'tti',                        // also covers Verical (TTI subsidiary marketplace)
  'future electronics',
  'master electronics',
  'onlinecomponents',           // Master Electronics subsidiary
  'electro sonic',              // Master Electronics subsidiary
  'waldom',
  'sager',
  'rutronik',
];

// Tier 2: Authorized franchise distributors we DON'T have direct APIs for.
// Pricing is reference-grade (aggregator-sourced, may be stale) but from real franchise sources.
// Matched case-insensitively against distributor_name from API.
const TIER2_FRANCHISE_DISTRIBUTORS = [
  'rs americas', 'rs uk', 'rs ',  // RS Components — has API (needs App ID from sales rep)
  'avnet',                         // Avnet America/Silica/Asia — has API (apiportal.avnet.com)
  'ebv elektronik', 'ebv',        // Avnet subsidiary
  'verical',                       // Arrow/TTI subsidiary marketplace
  'tme',                           // TME — has API (developers.tme.eu)
  'rochester',                     // Rochester Electronics — EOL specialist
  'chip one stop',                 // Japanese franchise
  'conrad',                        // European franchise
  'richardson rfpd',               // Arrow subsidiary (RF specialty)
  'schukat',                       // German franchise
  'buerklin', 'bürklin',          // German franchise
  'sos electronic',                // European franchise
  'weyland',                       // European franchise
  'ozdisan',                       // Turkish franchise
  'ineltek',                       // European franchise
  'corestaff',                     // Japanese franchise
];

// Tier 4: Manufacturer-direct listings. List price reference only — can't buy direct.
// Exception: Microchip may be purchasable but still treat as reference, not VQ.
const TIER4_MFR_DIRECT = [
  'analog devices',
  'microchip',
];

/**
 * Classify a distributor into a trust tier.
 * @returns {'direct'|'franchise'|'broker'|'mfr_direct'} tier name
 */
function classifyDistributor(distributorName) {
  if (!distributorName) return 'broker';
  const lower = distributorName.toLowerCase();

  if (DIRECT_API_DISTRIBUTORS.some(d => lower.includes(d))) return 'direct';
  if (TIER4_MFR_DIRECT.some(d => lower.includes(d))) return 'mfr_direct';
  if (TIER2_FRANCHISE_DISTRIBUTORS.some(d => lower.includes(d))) return 'franchise';

  // Check the API's own auth status as a secondary signal (handled in parseSearchResults)
  // Default: treat unknown distributors as brokers
  return 'broker';
}

/**
 * Check if a distributor name matches one we already have direct API access to
 */
function isDirectApiDistributor(distributorName) {
  if (!distributorName) return false;
  return classifyDistributor(distributorName) === 'direct';
}

/**
 * Search OEMSecrets for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {Object} options - Search options
 * @param {boolean} options.includeDirectApi - Include distributors we have direct APIs for (default: false)
 * @param {string} options.countryCode - ISO country code (default: US)
 * @param {string} options.currency - Currency code (default: USD)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, options = {}) {
  const includeDirectApi = options.includeDirectApi || false;
  const countryCode = options.countryCode || OEMSECRETS_CONFIG.countryCode;
  const currency = options.currency || OEMSECRETS_CONFIG.currency;

  const params = new URLSearchParams({
    searchTerm: mpn,
    apiKey: OEMSECRETS_CONFIG.apiKey,
    countryCode: countryCode,
    currency: currency,
  });

  const fullPath = `${OEMSECRETS_CONFIG.searchPath}?${params.toString()}`;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: OEMSECRETS_CONFIG.baseUrl,
      path: fullPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      timeout: 20000,
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 400) {
            reject(new Error('Bad request - missing searchTerm or apiKey'));
            return;
          }
          if (res.statusCode === 401) {
            reject(new Error('Unauthorized - invalid API key or call limit exceeded'));
            return;
          }
          if (res.statusCode === 404) {
            // No parts found — valid response
            resolve(makeEmptyResult(mpn, rfqQty));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`API error ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }

          const json = JSON.parse(data);
          const result = parseSearchResults(json, mpn, rfqQty, includeDirectApi);
          resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

function makeEmptyResult(searchMpn, rfqQty) {
  return {
    searchMpn,
    rfqQty,
    found: false,
    // Aggregated across all (non-direct) distributors
    franchiseQty: 0,
    franchisePrice: null,
    franchiseBulkPrice: null,
    franchiseRfqPrice: null,
    opportunityValue: null,
    // Best match VQ fields
    vqPrice: null,
    vqVendorNotes: null,
    vqMpn: null,
    vqDescription: null,
    vqManufacturer: null,
    vqLeadTime: null,
    vqDateCode: null,
    vqRohs: null,
    // Per-distributor breakdown
    distributors: [],
    distributorCount: 0,
    // Filtered out (already have direct API)
    filteredOutCount: 0,
    filteredOutDistributors: [],
    // Raw
    totalPartsReturned: 0,
    priceBreaks: [],
  };
}

/**
 * Parse OEMSecrets search results
 */
function parseSearchResults(json, searchMpn, rfqQty, includeDirectApi) {
  const result = makeEmptyResult(searchMpn, rfqQty);
  result.totalPartsReturned = json.parts_returned || 0;

  const stock = json.stock || [];
  if (stock.length === 0) return result;

  // Normalize search MPN for matching
  const normalizedSearch = normalizeMpn(searchMpn);

  // Group results by distributor, filtering as needed
  const byDistributor = {};
  const filteredOut = new Set();

  for (const part of stock) {
    const distName = part.distributor?.distributor_name || part.distributor?.distributor_common_name || 'Unknown';

    // Filter check
    if (!includeDirectApi && isDirectApiDistributor(distName)) {
      filteredOut.add(distName);
      continue;
    }

    if (!byDistributor[distName]) {
      byDistributor[distName] = [];
    }
    byDistributor[distName].push(part);
  }

  result.filteredOutCount = filteredOut.size;
  result.filteredOutDistributors = [...filteredOut];

  // Process each distributor's results
  const distributorResults = [];

  for (const [distName, parts] of Object.entries(byDistributor)) {
    // Find best match for this distributor (exact MPN with most stock)
    let bestPart = null;

    // Prefer exact MPN match with stock
    const exactWithStock = parts.filter(p =>
      normalizeMpn(p.source_part_number || p.part_number) === normalizedSearch &&
      parseInt(p.quantity_in_stock || '0') > 0
    );

    if (exactWithStock.length > 0) {
      exactWithStock.sort((a, b) =>
        parseInt(b.quantity_in_stock || '0') - parseInt(a.quantity_in_stock || '0')
      );
      bestPart = exactWithStock[0];
    }

    // Fallback: exact match without stock
    if (!bestPart) {
      bestPart = parts.find(p =>
        normalizeMpn(p.source_part_number || p.part_number) === normalizedSearch
      );
    }

    // Fallback: any part with stock
    if (!bestPart) {
      const withStock = parts.filter(p => parseInt(p.quantity_in_stock || '0') > 0);
      if (withStock.length > 0) {
        withStock.sort((a, b) =>
          parseInt(b.quantity_in_stock || '0') - parseInt(a.quantity_in_stock || '0')
        );
        bestPart = withStock[0];
      }
    }

    // Fallback: first part
    if (!bestPart) bestPart = parts[0];

    const qty = parseInt(bestPart.quantity_in_stock || '0');
    const priceBreaks = extractPriceBreaks(bestPart.prices, OEMSECRETS_CONFIG.currency);
    const priceAtQty = getPriceAtQty(priceBreaks, rfqQty);
    const moqPrice = priceBreaks.length > 0 ? priceBreaks[0].unitPrice : null;
    const bulkPrice = priceBreaks.length > 0 ? priceBreaks[priceBreaks.length - 1].unitPrice : null;

    // Classify this distributor into a trust tier
    let tier = classifyDistributor(distName);
    // Upgrade unknown distributors to franchise if OEMsecrets flags them as authorized
    if (tier === 'broker' && bestPart.distributor_authorisation_status === 'authorised') {
      tier = 'franchise';
    }

    distributorResults.push({
      distributor: distName,
      distributorRegion: bestPart.distributor?.distributor_region || '',
      distributorCountry: bestPart.distributor?.distributor_country || '',
      authStatus: bestPart.distributor_authorisation_status || '',
      // Source & trust tier — downstream consumers use these to decide how to treat the data
      source: 'oemsecrets',
      tier,  // 'franchise' | 'broker' | 'mfr_direct'
      // Pricing: suppressed for broker/mfr_direct tiers (availability signal only)
      mpn: bestPart.source_part_number || bestPart.part_number || '',
      manufacturer: bestPart.manufacturer || bestPart.source_manufacturer || '',
      stock: qty,
      moqPrice: tier === 'broker' ? null : moqPrice,
      bulkPrice: tier === 'broker' ? null : bulkPrice,
      rfqPrice: tier === 'broker' ? null : priceAtQty,
      priceBreaks: tier === 'broker' ? [] : priceBreaks,
      // Keep raw prices available for reference if someone explicitly needs them
      _rawMoqPrice: moqPrice,
      _rawBulkPrice: bulkPrice,
      _rawRfqPrice: priceAtQty,
      _rawPriceBreaks: priceBreaks,
      moq: parseInt(bestPart.moq || '1'),
      packaging: bestPart.packaging || bestPart.source_packaging || '',
      leadTime: bestPart.lead_time || '',
      leadTimeWeeks: bestPart.lead_time_weeks || '',
      dateCode: bestPart.date_code || '',
      lifecycle: bestPart.life_cycle || '',
      rohs: bestPart.compliance?.rohs === true ? 'Y' : (bestPart.compliance?.rohs === false ? 'N' : ''),
      pbFree: bestPart.compliance?.pb_status || '',
      buyUrl: bestPart.buy_now_url || '',
      datasheetUrl: bestPart.datasheet_url || '',
    });
  }

  // Sort by: has stock desc, then price asc
  distributorResults.sort((a, b) => {
    if (a.stock > 0 && b.stock <= 0) return -1;
    if (a.stock <= 0 && b.stock > 0) return 1;
    if (a.rfqPrice !== null && b.rfqPrice !== null) return a.rfqPrice - b.rfqPrice;
    return b.stock - a.stock;
  });

  result.distributors = distributorResults;
  result.distributorCount = distributorResults.length;

  // Aggregate: total stock across ALL tiers (availability signal)
  const withStock = distributorResults.filter(d => d.stock > 0);
  result.franchiseQty = distributorResults.reduce((sum, d) => sum + d.stock, 0);

  // Tier breakdown for consumers
  result.tierBreakdown = {
    franchise: distributorResults.filter(d => d.tier === 'franchise'),
    broker: distributorResults.filter(d => d.tier === 'broker'),
    mfrDirect: distributorResults.filter(d => d.tier === 'mfr_direct'),
  };
  result.franchiseStockQty = result.tierBreakdown.franchise.reduce((sum, d) => sum + d.stock, 0);
  result.brokerStockQty = result.tierBreakdown.broker.reduce((sum, d) => sum + d.stock, 0);

  if (withStock.length > 0) {
    // Pricing: only from Tier 2 franchise sources (not broker, not MFR direct)
    const franchiseWithPrice = result.tierBreakdown.franchise
      .filter(d => d.stock > 0 && d.rfqPrice !== null);

    if (franchiseWithPrice.length > 0) {
      const cheapest = franchiseWithPrice.reduce((best, d) =>
        d.rfqPrice < best.rfqPrice ? d : best
      );
      result.franchisePrice = cheapest.moqPrice;
      result.franchiseBulkPrice = cheapest.bulkPrice;
      result.franchiseRfqPrice = cheapest.rfqPrice;
      result.priceBreaks = cheapest.priceBreaks;

      // VQ fields from cheapest franchise source — flagged as aggregator, NOT confirmed
      result.vqPrice = cheapest.rfqPrice;
      result.vqMpn = cheapest.mpn;
      result.vqManufacturer = cheapest.manufacturer || '';
      result.vqLeadTime = cheapest.leadTime;
      result.vqDateCode = cheapest.dateCode;
      result.vqRohs = cheapest.rohs;

      const notes = [];
      notes.push(`via OEMSecrets (${cheapest.distributor}) [AGGREGATOR - ref only]`);
      if (cheapest.stock > 0) notes.push(`Stock: ${cheapest.stock.toLocaleString()}`);
      if (cheapest.leadTime) notes.push(`LT: ${cheapest.leadTime}`);
      if (cheapest.lifecycle) notes.push(`Lifecycle: ${cheapest.lifecycle}`);
      result.vqVendorNotes = notes.join(' | ');
    }

    // MFR direct pricing as separate reference (not used for VQ/quoting)
    const mfrWithPrice = result.tierBreakdown.mfrDirect
      .filter(d => d.stock > 0 && d.rfqPrice !== null);
    if (mfrWithPrice.length > 0) {
      result.mfrListPrice = mfrWithPrice[0].rfqPrice;
      result.mfrListSource = mfrWithPrice[0].distributor;
    }

    result.found = true;
  }

  if (result.franchiseBulkPrice && rfqQty) {
    result.opportunityValue = result.franchiseBulkPrice * rfqQty;
  }

  return result;
}

/**
 * Extract price breaks from OEMSecrets prices object
 * Format: { "USD": [{"unit_break": "1", "unit_price": "1.23"}, ...] }
 */
function extractPriceBreaks(prices, currency) {
  if (!prices) return [];

  const breaks = prices[currency] || prices['USD'] || [];
  if (!Array.isArray(breaks)) return [];

  return breaks
    .map(pb => ({
      qty: parseInt(pb.unit_break || '0'),
      unitPrice: parseFloat(pb.unit_price || '0'),
    }))
    .filter(pb => pb.qty > 0 && pb.unitPrice > 0)
    .sort((a, b) => a.qty - b.qty);
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceBreaks, qty) {
  if (!priceBreaks || priceBreaks.length === 0) return null;

  let price = priceBreaks[0].unitPrice;
  for (const tier of priceBreaks) {
    if (qty >= tier.qty) {
      price = tier.unitPrice;
    }
  }
  return price;
}

/**
 * Normalize MPN for comparison
 */
function normalizeMpn(mpn) {
  if (!mpn) return '';
  return mpn.replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Search multiple parts
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {number} delayMs - Delay between requests (rate limiting)
 * @param {Object} options - Search options passed to searchPart
 */
async function searchParts(parts, delayMs = 500, options = {}) {
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { mpn, qty } = parts[i];

    try {
      const result = await searchPart(mpn, qty || 1, options);
      results.push(result);
      const distCount = result.distributorCount;
      const filteredCount = result.filteredOutCount;
      console.log(`[${i + 1}/${parts.length}] ${mpn}: ${result.found ? `${result.franchiseQty} stock across ${distCount} distributors` : 'Not found'} (${filteredCount} direct-API filtered)`);
    } catch (error) {
      console.error(`[${i + 1}/${parts.length}] ${mpn}: Error - ${error.message}`);
      results.push({
        searchMpn: mpn,
        rfqQty: qty,
        found: false,
        error: error.message,
      });
    }

    // Rate limiting
    if (i < parts.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// Export for use in other modules
module.exports = {
  OEMSECRETS_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
  isDirectApiDistributor,
  classifyDistributor,
  DIRECT_API_DISTRIBUTORS,
  TIER2_FRANCHISE_DISTRIBUTORS,
  TIER4_MFR_DIRECT,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node oemsecrets.js <MPN> [qty] [options]');
    console.log('Example: node oemsecrets.js LM317T 100');
    console.log('Example: node oemsecrets.js LM317T 100 --all    # include direct-API distributors too');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;
  const includeDirectApi = args.includes('--all');

  searchPart(mpn, qty, { includeDirectApi })
    .then(result => {
      console.log('\n=== OEMSecrets Search Result ===');
      console.log(`Part: ${result.searchMpn} | Qty: ${result.rfqQty}`);
      console.log(`Found: ${result.found} | Total stock: ${result.franchiseQty.toLocaleString()}`);
      console.log(`Distributors (new coverage): ${result.distributorCount}`);
      console.log(`Filtered out (direct API): ${result.filteredOutCount} — ${result.filteredOutDistributors.join(', ')}`);

      if (result.franchiseRfqPrice) {
        console.log(`Best price at qty ${result.rfqQty}: $${result.franchiseRfqPrice.toFixed(4)}`);
      }

      if (result.tierBreakdown) {
        console.log(`\nTier breakdown: ${result.tierBreakdown.franchise.length} franchise, ${result.tierBreakdown.broker.length} broker, ${result.tierBreakdown.mfrDirect.length} MFR direct`);
        console.log(`Franchise stock: ${result.franchiseStockQty.toLocaleString()} | Broker stock: ${result.brokerStockQty.toLocaleString()}`);
        if (result.mfrListPrice) {
          console.log(`MFR list price ref: $${result.mfrListPrice.toFixed(4)} (${result.mfrListSource})`);
        }
      }

      console.log('\n--- Per-Distributor Breakdown ---');
      for (const d of result.distributors) {
        const price = d.rfqPrice !== null ? `$${d.rfqPrice.toFixed(4)}` : 'N/A';
        const tierTag = `[${d.tier}]`.padEnd(13);
        console.log(`  ${tierTag} ${d.distributor}: ${d.stock.toLocaleString()} stock, ${price}, LT: ${d.leadTime || 'N/A'}, LC: ${d.lifecycle || 'N/A'}`);
      }

      if (includeDirectApi) {
        console.log('\n(--all flag: showing all distributors including those with direct APIs)');
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
