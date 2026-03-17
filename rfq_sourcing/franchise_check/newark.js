/**
 * Newark / element14 / Farnell API Integration for Franchise Screening
 *
 * Uses element14 Product Search API
 * Auth: Query parameter (callInfo.apiKey)
 *
 * Covers multiple regions via storeInfo.id:
 *   - Newark (US): www.newark.com
 *   - Farnell (UK): uk.farnell.com
 *   - element14 (APAC): au.element14.com, sg.element14.com, etc.
 *
 * Rate limit: 2 calls/sec, 1,000 calls/day (free tier)
 */

const https = require('https');

// Newark API Configuration
const NEWARK_CONFIG = {
  apiKey: process.env.NEWARK_API_KEY || '72pqcg952mk4kkw3g8veb9xz',
  baseUrl: 'api.element14.com',
  searchPath: '/catalog/products',

  // Store IDs for different regions
  stores: {
    us: 'www.newark.com',
    uk: 'uk.farnell.com',
    au: 'au.element14.com',
    sg: 'sg.element14.com',
  },
  defaultStore: 'www.newark.com',  // Newark USA

  // iDempiere Business Partner for VQ loading
  bpId: 1000390,
  bpValue: '1002394',
  bpName: 'Newark in One (Element 14)',

  // Rate limiting: 2 calls/sec = 500ms between calls
  rateLimitMs: 500,
};

/**
 * Search Newark for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {string} store - Store ID (default: www.newark.com)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, store = NEWARK_CONFIG.defaultStore) {
  return new Promise((resolve, reject) => {
    // Build query parameters
    const queryParams = new URLSearchParams({
      'term': `manuPartNum:${mpn}`,
      'storeInfo.id': store,
      'resultsSettings.offset': '0',
      'resultsSettings.numberOfResults': '10',
      'resultsSettings.responseGroup': 'large',  // Get pricing + stock + details
      'callInfo.responseDataFormat': 'JSON',
      'callInfo.apiKey': NEWARK_CONFIG.apiKey,
    }).toString();

    const options = {
      hostname: NEWARK_CONFIG.baseUrl,
      path: `${NEWARK_CONFIG.searchPath}?${queryParams}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Check for HTTP errors
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }

          const json = JSON.parse(data);

          // Check for API errors
          if (json.Fault) {
            reject(new Error(`API Error: ${json.Fault.faultstring || JSON.stringify(json.Fault)}`));
            return;
          }

          const result = parseSearchResults(json, mpn, rfqQty, store);
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
 * Parse Newark search results into screening + VQ format
 */
function parseSearchResults(json, searchMpn, rfqQty, store) {
  const result = {
    searchMpn,
    rfqQty,
    store,
    found: false,
    source: 'Newark',
    // Screening fields
    franchiseQty: 0,
    franchisePrice: null,      // Unit price at qty 1
    franchiseBulkPrice: null,  // Lowest price break
    franchiseRfqPrice: null,   // Price at RFQ qty
    opportunityValue: null,
    // VQ fields
    vqPrice: null,
    vqVendorNotes: null,
    vqMpn: null,
    vqDescription: null,
    vqManufacturer: null,
    vqNewarkSku: null,
    vqDatasheetUrl: null,
    // Raw data
    allProducts: [],
  };

  // Navigate response - element14 uses different wrapper depending on search type
  // keywordSearchReturn for 'any:' searches
  // manufacturerPartNumberSearchReturn for 'manuPartNum:' searches
  const searchReturn = json.manufacturerPartNumberSearchReturn || json.keywordSearchReturn;

  if (!searchReturn || !searchReturn.products || searchReturn.products.length === 0) {
    return result;
  }

  const products = searchReturn.products;

  // Find best match - prefer exact MPN match
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  for (const product of products) {
    const normalizedResult = normalizeMpn(product.translatedManufacturerPartNumber);
    if (normalizedResult === normalizedSearch) {
      bestMatch = product;
      break;
    }
  }

  // Fall back to first result if no exact match
  if (!bestMatch) {
    bestMatch = products[0];
  }

  // Extract product details
  result.vqMpn = bestMatch.translatedManufacturerPartNumber || bestMatch.sku;
  result.vqDescription = bestMatch.displayName || '';
  result.vqManufacturer = bestMatch.brandName || '';
  result.vqNewarkSku = bestMatch.sku;

  // Get datasheet URL if available
  if (bestMatch.datasheets && bestMatch.datasheets.length > 0) {
    result.vqDatasheetUrl = bestMatch.datasheets[0].url;
  }

  // Get stock level
  const stockLevel = bestMatch.stock?.level || 0;
  result.franchiseQty = stockLevel;

  // Get pricing
  const prices = bestMatch.prices || [];
  if (prices.length > 0) {
    // First tier (unit price at qty 1)
    result.franchisePrice = prices[0].cost;

    // Last tier (bulk price)
    result.franchiseBulkPrice = prices[prices.length - 1].cost;

    // Price at RFQ qty
    result.franchiseRfqPrice = getPriceAtQty(prices, rfqQty);
    result.vqPrice = result.franchiseRfqPrice;
  }

  if (stockLevel > 0 || prices.length > 0) {
    result.found = true;
    result.opportunityValue = result.franchiseBulkPrice ? result.franchiseBulkPrice * rfqQty : null;

    // Build vendor notes
    const notes = [];
    notes.push(`Newark stock: ${stockLevel.toLocaleString()}`);
    if (result.vqNewarkSku) notes.push(`SKU: ${result.vqNewarkSku}`);
    result.vqVendorNotes = notes.join(' | ');
  }

  // Collect all products for reference
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

  let price = priceList[0].cost;  // Default to first tier

  for (const tier of priceList) {
    // element14 uses 'from' and 'to' for qty ranges
    if (qty >= tier.from) {
      price = tier.cost;
    }
  }

  return price;
}

/**
 * Normalize MPN for comparison (remove dashes, spaces, case-insensitive)
 */
function normalizeMpn(mpn) {
  if (!mpn) return '';
  return mpn.replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Search multiple parts
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {number} delayMs - Delay between requests (rate limiting)
 */
async function searchParts(parts, delayMs = NEWARK_CONFIG.rateLimitMs) {
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { mpn, qty } = parts[i];

    try {
      const result = await searchPart(mpn, qty || 1);
      results.push(result);
      console.log(`[${i + 1}/${parts.length}] ${mpn}: ${result.found ? `${result.franchiseQty} @ $${result.vqPrice}` : 'Not found'}`);
    } catch (error) {
      console.error(`[${i + 1}/${parts.length}] ${mpn}: Error - ${error.message}`);
      results.push({
        searchMpn: mpn,
        rfqQty: qty,
        found: false,
        error: error.message,
      });
    }

    // Rate limiting - 500ms for 2 calls/sec limit
    if (i < parts.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// Export for use in other modules
module.exports = {
  NEWARK_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node newark.js <MPN> [qty] [store]');
    console.log('Example: node newark.js LM317T 100');
    console.log('');
    console.log('Stores:');
    console.log('  www.newark.com      (US - default)');
    console.log('  uk.farnell.com      (UK)');
    console.log('  au.element14.com    (Australia)');
    console.log('  sg.element14.com    (Singapore)');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;
  const store = args[2] || NEWARK_CONFIG.defaultStore;

  searchPart(mpn, qty, store)
    .then(result => {
      console.log('\n=== Newark Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
