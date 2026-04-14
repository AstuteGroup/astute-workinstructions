/**
 * Newark / Farnell / element14 API Integration for Franchise Screening
 *
 * Uses element14 Product Search API (single API, multiple regional stores)
 * Auth: Query parameter (callInfo.apiKey)
 *
 * Active stores:
 *   - Newark (US): www.newark.com - USD pricing
 *   - Farnell (UK): uk.farnell.com - GBP pricing
 *
 * To investigate:
 *   - element14 (APAC): au.element14.com, sg.element14.com, etc.
 *
 * Rate limit: 2 calls/sec, 1,000 calls/day (free tier)
 * Note: Querying both Newark + Farnell uses 2 calls per part
 */

const https = require('https');

// API Configuration
const NEWARK_CONFIG = {
  apiKey: process.env.NEWARK_API_KEY || '72pqcg952mk4kkw3g8veb9xz',
  baseUrl: 'api.element14.com',
  searchPath: '/catalog/products',

  // Active stores (queried by default)
  activeStores: [
    { id: 'www.newark.com', name: 'Newark', region: 'US', currency: 'USD',
      bpId: 1000390, bpValue: '1002394', bpName: 'Newark in One (Element 14)' },
    { id: 'uk.farnell.com', name: 'Farnell', region: 'UK', currency: 'GBP',
      bpId: 1000306, bpValue: '1002310', bpName: 'Farnell Element 14' },
  ],

  // Stores to investigate (not queried by default)
  futureStores: [
    { id: 'au.element14.com', name: 'element14', region: 'AU', currency: 'AUD' },
    { id: 'sg.element14.com', name: 'element14', region: 'SG', currency: 'SGD' },
    { id: 'cn.element14.com', name: 'element14', region: 'CN', currency: 'CNY' },
    { id: 'hk.element14.com', name: 'element14', region: 'HK', currency: 'HKD' },
  ],

  // iDempiere Business Partner for VQ loading
  bpId: 1000390,
  bpValue: '1002394',
  bpName: 'Newark in One (Element 14)',

  // Rate limiting: 2 calls/sec = 500ms between calls
  rateLimitMs: 500,
};

/**
 * Search a single store for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {string} storeId - Store ID (e.g., www.newark.com)
 * @returns {Object} Screening and VQ data
 */
async function searchStore(mpn, rfqQty = 1, storeId) {
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({
      'term': `manuPartNum:${mpn}`,
      'storeInfo.id': storeId,
      'resultsSettings.offset': '0',
      'resultsSettings.numberOfResults': '10',
      'resultsSettings.responseGroup': 'large',
      'callInfo.responseDataFormat': 'JSON',
      'callInfo.apiKey': NEWARK_CONFIG.apiKey,
    }).toString();

    const options = {
      hostname: NEWARK_CONFIG.baseUrl,
      path: `${NEWARK_CONFIG.searchPath}?${queryParams}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }

          const json = JSON.parse(data);

          if (json.Fault) {
            reject(new Error(`API Error: ${json.Fault.faultstring || JSON.stringify(json.Fault)}`));
            return;
          }

          const storeInfo = NEWARK_CONFIG.activeStores.find(s => s.id === storeId) ||
                           NEWARK_CONFIG.futureStores.find(s => s.id === storeId) ||
                           { id: storeId, name: storeId, region: '??', currency: '??' };

          const result = parseSearchResults(json, mpn, rfqQty, storeInfo);
          resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Search all active stores (Newark + Farnell) for a part
 * Returns combined results with per-store breakdown
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity
 * @returns {Object} Combined screening data with store breakdown
 */
async function searchPart(mpn, rfqQty = 1) {
  const storeResults = [];
  const errors = [];

  // Query each active store with rate limiting
  for (let i = 0; i < NEWARK_CONFIG.activeStores.length; i++) {
    const store = NEWARK_CONFIG.activeStores[i];

    try {
      const result = await searchStore(mpn, rfqQty, store.id);
      storeResults.push(result);
    } catch (error) {
      errors.push({ store: store.name, error: error.message });
    }

    // Rate limiting between stores
    if (i < NEWARK_CONFIG.activeStores.length - 1) {
      await new Promise(resolve => setTimeout(resolve, NEWARK_CONFIG.rateLimitMs));
    }
  }

  // Combine results - use Newark (USD) as primary; only fall back to Farnell if Newark has no stock
  // IMPORTANT: Do NOT sum stock across stores — prices are in different currencies
  const newarkResult = storeResults.find(r => r.store === 'Newark');
  const farnellResult = storeResults.find(r => r.store === 'Farnell');

  // Pick primary store: Newark if it has stock, otherwise Farnell (with GBP→USD conversion)
  const GBP_TO_USD = 1.3052;
  const newarkHasStock = newarkResult && newarkResult.franchiseQty > 0;
  const farnellHasStock = farnellResult && farnellResult.franchiseQty > 0;

  let primaryQty, primaryPrice, primaryBulk, primaryRfqPrice, primaryVqPrice;

  if (newarkHasStock) {
    // Newark has stock — use Newark pricing (USD)
    primaryQty = newarkResult.franchiseQty;
    primaryPrice = newarkResult.franchisePrice;
    primaryBulk = newarkResult.franchiseBulkPrice;
    primaryRfqPrice = newarkResult.franchiseRfqPrice;
    primaryVqPrice = newarkResult.vqPrice;
  } else if (farnellHasStock) {
    // Only Farnell has stock — convert GBP to USD
    primaryQty = farnellResult.franchiseQty;
    primaryPrice = farnellResult.franchisePrice ? farnellResult.franchisePrice * GBP_TO_USD : null;
    primaryBulk = farnellResult.franchiseBulkPrice ? farnellResult.franchiseBulkPrice * GBP_TO_USD : null;
    primaryRfqPrice = farnellResult.franchiseRfqPrice ? farnellResult.franchiseRfqPrice * GBP_TO_USD : null;
    primaryVqPrice = farnellResult.vqPrice ? farnellResult.vqPrice * GBP_TO_USD : null;
  } else {
    // Neither has stock — use Newark pricing if available for lead time reference
    primaryQty = 0;
    primaryPrice = newarkResult?.franchisePrice || null;
    primaryBulk = newarkResult?.franchiseBulkPrice || null;
    primaryRfqPrice = newarkResult?.franchiseRfqPrice || null;
    primaryVqPrice = newarkResult?.vqPrice || null;
  }

  const combined = {
    searchMpn: mpn,
    rfqQty,
    found: storeResults.some(r => r.found),
    source: 'Newark/Farnell',

    franchiseQty: primaryQty,
    franchisePrice: primaryPrice,
    franchiseBulkPrice: primaryBulk,
    franchiseRfqPrice: primaryRfqPrice,
    opportunityValue: primaryRfqPrice ? primaryRfqPrice * rfqQty : null,

    // VQ fields
    vqPrice: primaryVqPrice,
    vqMpn: newarkResult?.vqMpn || farnellResult?.vqMpn || null,
    vqDescription: newarkResult?.vqDescription || farnellResult?.vqDescription || null,
    vqManufacturer: newarkResult?.vqManufacturer || farnellResult?.vqManufacturer || null,
    vqDatasheetUrl: newarkResult?.vqDatasheetUrl || farnellResult?.vqDatasheetUrl || null,
    vqMoq: newarkResult?.vqMoq || farnellResult?.vqMoq || null,
    vqSpq: newarkResult?.vqSpq || farnellResult?.vqSpq || null,
    vqLeadTime: newarkResult?.vqLeadTime || farnellResult?.vqLeadTime || null,
    vqHts: null,  // not exposed by element14 API
    vqEccn: newarkResult?.vqEccn || farnellResult?.vqEccn || null,

    // Per-store breakdown
    stores: {
      newark: newarkResult ? {
        found: newarkResult.found,
        stock: newarkResult.franchiseQty,
        priceAtQty: newarkResult.franchiseRfqPrice,
        bulkPrice: newarkResult.franchiseBulkPrice,
        sku: newarkResult.vqSku,
        currency: 'USD',
      } : null,
      farnell: farnellResult ? {
        found: farnellResult.found,
        stock: farnellResult.franchiseQty,
        priceAtQty: farnellResult.franchiseRfqPrice,
        bulkPrice: farnellResult.franchiseBulkPrice,
        sku: farnellResult.vqSku,
        currency: 'GBP',
      } : null,
    },

    // Build vendor notes
    vqVendorNotes: buildCombinedNotes(newarkResult, farnellResult),

    // Price breaks from primary store (Newark preferred)
    priceBreaks: newarkResult?.priceBreaks || farnellResult?.priceBreaks || [],

    // Per-store VQ lines — each store writes under its own BP (like Arrow/Verical).
    // franchise-api.js uses vqLines[] when present instead of the single-row fallback.
    vqLines: buildPerStoreVqLines(newarkResult, farnellResult, mpn, rfqQty, GBP_TO_USD),

    // Errors if any
    errors: errors.length > 0 ? errors : undefined,
  };

  return combined;
}

/**
 * Build combined vendor notes from both stores
 */
function buildCombinedNotes(newark, farnell) {
  const notes = [];

  if (newark?.found) {
    notes.push(`Newark: ${newark.franchiseQty.toLocaleString()} @ $${newark.franchiseRfqPrice}`);
  }
  if (farnell?.found) {
    notes.push(`Farnell: ${farnell.franchiseQty.toLocaleString()} @ £${farnell.franchiseRfqPrice}`);
  }
  const moq = newark?.vqMoq || farnell?.vqMoq;
  if (moq && moq > 1) {
    notes.push(`MOQ: ${moq.toLocaleString()}`);
  }

  return notes.length > 0 ? notes.join(' | ') : null;
}

/**
 * Build per-store vqLines so each store writes VQs under its own BP.
 * Follows the same pattern as Arrow/Verical (parser-native vqLines).
 * franchise-api.js uses vqLines[] when present instead of the single-row fallback.
 */
function buildPerStoreVqLines(newarkResult, farnellResult, mpn, rfqQty, gbpToUsd) {
  const lines = [];
  const newarkStore = NEWARK_CONFIG.activeStores.find(s => s.name === 'Newark');
  const farnellStore = NEWARK_CONFIG.activeStores.find(s => s.name === 'Farnell');

  // Newark VQ line (USD)
  if (newarkResult && newarkResult.found && newarkResult.vqPrice > 0) {
    lines.push({
      vendorBP: newarkStore.bpValue,
      vendorName: newarkStore.bpName,
      mpn: newarkResult.vqMpn || mpn,
      manufacturer: newarkResult.vqManufacturer || '',
      cost: newarkResult.vqPrice,
      qty: newarkResult.franchiseQty || 0,
      currencyId: 100, // USD
      leadTime: newarkResult.vqLeadTime || '',
      moq: newarkResult.vqMoq || null,
      spq: newarkResult.vqSpq || null,
      packaging: newarkResult.vqPackaging || '',
      vendorNotes: `Newark: ${(newarkResult.franchiseQty || 0).toLocaleString()} @ $${newarkResult.vqPrice}`,
      channel: 'STOCK',
    });
  }

  // Farnell VQ line — stored in GBP (quoted currency), converted at analytics layer
  if (farnellResult && farnellResult.found && farnellResult.vqPrice > 0) {
    lines.push({
      vendorBP: farnellStore.bpValue,
      vendorName: farnellStore.bpName,
      mpn: farnellResult.vqMpn || mpn,
      manufacturer: farnellResult.vqManufacturer || '',
      cost: farnellResult.vqPrice, // raw GBP — not converted
      qty: farnellResult.franchiseQty || 0,
      currencyId: 114, // GBP — c_currency_id in iDempiere
      leadTime: farnellResult.vqLeadTime || '',
      moq: farnellResult.vqMoq || null,
      spq: farnellResult.vqSpq || null,
      packaging: farnellResult.vqPackaging || '',
      vendorNotes: `Farnell UK: ${(farnellResult.franchiseQty || 0).toLocaleString()} @ £${farnellResult.vqPrice}`,
      channel: 'STOCK',
    });
  }

  return lines.length > 0 ? lines : null;
}

/**
 * Parse search results for a single store
 */
function parseSearchResults(json, searchMpn, rfqQty, storeInfo) {
  const result = {
    searchMpn,
    rfqQty,
    storeId: storeInfo.id,
    store: storeInfo.name,
    region: storeInfo.region,
    currency: storeInfo.currency,
    found: false,
    franchiseQty: 0,
    franchisePrice: null,
    franchiseBulkPrice: null,
    franchiseRfqPrice: null,
    opportunityValue: null,
    vqPrice: null,
    vqMpn: null,
    vqDescription: null,
    vqManufacturer: null,
    vqSku: null,
    vqDatasheetUrl: null,
    vqMoq: null,
    vqSpq: null,
    vqHts: null,    // element14 API does not return HTS — kept null for shape parity
    vqEccn: null,   // element14 returns ECCN inside the attributes array (label='usEccn')
    allProducts: [],
  };

  const searchReturn = json.manufacturerPartNumberSearchReturn || json.keywordSearchReturn;

  if (!searchReturn || !searchReturn.products || searchReturn.products.length === 0) {
    return result;
  }

  const products = searchReturn.products;

  // Reject "you might also like" recommendations — never fall back to products[0].
  // Accept only exact MPN matches or packaging-suffix variants. See shared/mpn-match.js.
  const { pickBestCandidate } = require('../../../shared/mpn-match');
  const picked = pickBestCandidate(products, {
    getMpn: p => p.translatedManufacturerPartNumber,
    getMfr: p => p.brandName,
    getStock: p => p.stock?.level,
    searched: searchMpn,
    opts: { mfr: storeInfo?.searchMfr },
  });
  if (!picked) return result;
  const bestMatch = picked.candidate;
  result.matchType = picked.matchType;

  // Extract product details
  result.vqMpn = bestMatch.translatedManufacturerPartNumber || bestMatch.sku;
  result.vqDescription = bestMatch.displayName || '';
  result.vqManufacturer = bestMatch.brandName || '';
  result.vqSku = bestMatch.sku;

  if (bestMatch.datasheets && bestMatch.datasheets.length > 0) {
    result.vqDatasheetUrl = bestMatch.datasheets[0].url;
  }

  // MOQ and SPQ
  const moqVal = bestMatch.translatedMinimumOrderQuality || bestMatch.minimumOrderQuantity;
  result.vqMoq = moqVal && moqVal > 1 ? moqVal : null;
  result.vqSpq = bestMatch.packSize || null;

  // Compliance — element14 stores ECCN inside the attributes array under label='usEccn'.
  // No HTS field exposed.
  const eccnAttr = (bestMatch.attributes || []).find(a => a.attributeLabel === 'usEccn');
  result.vqEccn = (eccnAttr && eccnAttr.attributeValue && eccnAttr.attributeValue.trim()) || null;

  // Stock and pricing
  const stockLevel = bestMatch.stock?.level || 0;
  result.franchiseQty = stockLevel;

  const prices = bestMatch.prices || [];
  if (prices.length > 0) {
    result.franchisePrice = prices[0].cost;
    result.franchiseBulkPrice = prices[prices.length - 1].cost;
    result.franchiseRfqPrice = getPriceAtQty(prices, rfqQty);
    result.vqPrice = result.franchiseRfqPrice;
    result.priceBreaks = prices.map(p => ({ qty: p.from, unitPrice: p.cost })).sort((a, b) => a.qty - b.qty);
  }

  if (stockLevel > 0 || prices.length > 0) {
    result.found = true;
    result.opportunityValue = result.franchiseBulkPrice ? result.franchiseBulkPrice * rfqQty : null;
  }

  // Lead time (stock.leastLeadTime is in hours)
  const ltHours = bestMatch.stock?.leastLeadTime;
  if (ltHours && ltHours > 0) {
    const ltWeeks = Math.ceil(ltHours / (24 * 7));
    result.vqLeadTime = `${ltWeeks} Weeks`;
  }

  // All products for reference
  result.allProducts = products.map(p => ({
    sku: p.sku,
    mpn: p.translatedManufacturerPartNumber,
    manufacturer: p.brandName,
    description: p.displayName,
    stock: p.stock?.level || 0,
    unitPrice: p.prices?.[0]?.cost,
    bulkPrice: p.prices?.[p.prices?.length - 1]?.cost,
  }));

  return result;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceList, qty) {
  if (!priceList || priceList.length === 0) return null;

  let price = priceList[0].cost;
  for (const tier of priceList) {
    if (qty >= tier.from) {
      price = tier.cost;
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
 * Search multiple parts across all active stores
 * @param {Array} parts - Array of {mpn, qty} objects
 */
async function searchParts(parts) {
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { mpn, qty } = parts[i];

    try {
      const result = await searchPart(mpn, qty || 1);
      results.push(result);

      const newarkStock = result.stores.newark?.stock || 0;
      const farnellStock = result.stores.farnell?.stock || 0;
      console.log(`[${i + 1}/${parts.length}] ${mpn}: Newark ${newarkStock}, Farnell ${farnellStock}`);
    } catch (error) {
      console.error(`[${i + 1}/${parts.length}] ${mpn}: Error - ${error.message}`);
      results.push({
        searchMpn: mpn,
        rfqQty: qty,
        found: false,
        error: error.message,
      });
    }

    // Rate limiting between parts (already rate-limited within searchPart)
    if (i < parts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, NEWARK_CONFIG.rateLimitMs));
    }
  }

  return results;
}

// Export for use in other modules
module.exports = {
  NEWARK_CONFIG,
  searchPart,      // Searches both Newark + Farnell
  searchStore,     // Searches a single store
  searchParts,     // Batch search across both stores
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node newark.js <MPN> [qty] [--store <storeId>]');
    console.log('');
    console.log('Examples:');
    console.log('  node newark.js LM317T 100           # Search Newark + Farnell');
    console.log('  node newark.js LM317T 100 --store www.newark.com   # Newark only');
    console.log('  node newark.js LM317T 100 --store uk.farnell.com   # Farnell only');
    console.log('');
    console.log('Active stores:');
    NEWARK_CONFIG.activeStores.forEach(s => {
      console.log(`  ${s.id.padEnd(20)} (${s.name} ${s.region}, ${s.currency})`);
    });
    console.log('');
    console.log('Future stores (to investigate):');
    NEWARK_CONFIG.futureStores.forEach(s => {
      console.log(`  ${s.id.padEnd(20)} (${s.name} ${s.region}, ${s.currency})`);
    });
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;
  const storeIdx = args.indexOf('--store');
  const singleStore = storeIdx !== -1 ? args[storeIdx + 1] : null;

  const searchFn = singleStore
    ? () => searchStore(mpn, qty, singleStore)
    : () => searchPart(mpn, qty);

  searchFn()
    .then(result => {
      console.log('\n=== Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
