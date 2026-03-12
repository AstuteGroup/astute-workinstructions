/**
 * Rutronik API Integration for Franchise Screening
 *
 * Uses Rutronik24 REST API
 * Auth: Query parameter (apikey)
 * Docs: https://www.rutronik24.com/api.html
 */

const https = require('https');

// Rutronik API Configuration
const RUTRONIK_CONFIG = {
  apiKey: process.env.RUTRONIK_API_KEY || 'nppg7idj64gy',
  baseUrl: 'www.rutronik24.com',
  searchPath: '/api/search',

  // iDempiere Business Partner for VQ loading
  // Using Rutronik Inc. (US entity)
  bpId: 1002668,
  bpValue: '1004668',
  bpName: 'Rutronik Inc.',
};

/**
 * Search Rutronik for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1) {
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({
      searchterm: mpn,
      apikey: RUTRONIK_CONFIG.apiKey,
    }).toString();

    const options = {
      hostname: RUTRONIK_CONFIG.baseUrl,
      path: `${RUTRONIK_CONFIG.searchPath}?${queryParams}`,
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
          const json = JSON.parse(data);

          // Check for API errors
          if (json.error) {
            resolve({
              searchMpn: mpn,
              rfqQty,
              found: false,
              error: json.error,
            });
            return;
          }

          const result = parseSearchResults(json, mpn, rfqQty);
          resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse Rutronik search results into screening + VQ format
 */
function parseSearchResults(parts, searchMpn, rfqQty) {
  const result = {
    searchMpn,
    rfqQty,
    found: false,
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
    vqLeadTime: null,
    vqSku: null,
    // Raw data
    allMatches: [],
  };

  if (!Array.isArray(parts) || parts.length === 0) {
    return result;
  }

  // Find best match - prefer exact MPN match
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  for (const part of parts) {
    const normalizedResult = normalizeMpn(part.mpn);
    if (normalizedResult === normalizedSearch) {
      bestMatch = part;
      break;
    }
  }

  // Fall back to first result if no exact match
  if (!bestMatch) {
    bestMatch = parts[0];
  }

  result.vqMpn = bestMatch.mpn;
  result.vqDescription = bestMatch.description || bestMatch.matchcode || '';
  result.vqManufacturer = bestMatch.manufacturer || '';
  result.vqLeadTime = bestMatch.leadtime;
  result.vqSku = bestMatch.sku;

  // Get stock and pricing
  const stock = bestMatch.stock || 0;
  const priceBreaks = bestMatch.pricebreaks || [];
  const basePrice = parseFloat(bestMatch.price) || null;

  result.franchiseQty = stock;

  if (priceBreaks.length > 0) {
    // First tier (unit price)
    result.franchisePrice = parseFloat(priceBreaks[0].price);
    // Last tier (bulk price)
    result.franchiseBulkPrice = parseFloat(priceBreaks[priceBreaks.length - 1].price);
    // Price at RFQ qty
    result.franchiseRfqPrice = getPriceAtQty(priceBreaks, rfqQty);
  } else if (basePrice) {
    result.franchisePrice = basePrice;
    result.franchiseBulkPrice = basePrice;
    result.franchiseRfqPrice = basePrice;
  }

  if (result.franchiseRfqPrice) {
    result.vqPrice = result.franchiseRfqPrice;
    result.found = true;
  }

  if (result.franchiseBulkPrice && rfqQty) {
    result.opportunityValue = result.franchiseBulkPrice * rfqQty;
  }

  // Build vendor notes
  const notes = [];
  if (stock > 0) {
    notes.push(`Rutronik stock: ${stock.toLocaleString()}`);
  } else if (bestMatch.leadtime) {
    notes.push(`Lead time: ${bestMatch.leadtime} days`);
  }
  if (bestMatch.sku) {
    notes.push(`SKU: ${bestMatch.sku}`);
  }
  result.vqVendorNotes = notes.join(' | ');

  // Collect all matches for reference
  result.allMatches = parts.map(p => ({
    mpn: p.mpn,
    manufacturer: p.manufacturer,
    stock: p.stock,
    price: p.price,
    leadtime: p.leadtime,
  }));

  return result;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceBreaks, qty) {
  if (!priceBreaks || priceBreaks.length === 0) return null;

  let price = parseFloat(priceBreaks[0].price);  // Default to first tier

  for (const tier of priceBreaks) {
    if (qty >= tier.quantity) {
      price = parseFloat(tier.price);
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
async function searchParts(parts, delayMs = 300) {
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

    // Rate limiting
    if (i < parts.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// Export for use in other modules
module.exports = {
  RUTRONIK_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node rutronik.js <MPN> [qty]');
    console.log('Example: node rutronik.js STM32F103 100');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;

  searchPart(mpn, qty)
    .then(result => {
      console.log('\n=== Rutronik Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
