/**
 * Master Electronics API Integration for Franchise Screening
 *
 * Uses Master Electronics REST API v2
 * Auth: API key in path parameter
 * Docs: https://www.masterelectronics.com/en/gettingstarted/?div=gettingstarted2
 */

const https = require('https');

// Master Electronics API Configuration
const MASTER_CONFIG = {
  apiKey: process.env.MASTER_API_KEY || '1640d818-0b10-4162-a2ad-34750e79e346',
  baseUrl: 'api.masterelectronics.com',
  // Path: /wapi/v2/cgpriceavailability/{query}/{inStockOnly}/{exactMatch}/{resultsCount}/{apiKey}
  searchPath: '/wapi/v2/cgpriceavailability',

  // iDempiere Business Partner for VQ loading
  bpId: 1000405,
  bpValue: '1002409',
  bpName: 'Master Electronics',
};

/**
 * Search Master Electronics for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {Object} options - Search options
 * @param {boolean} options.inStockOnly - Only return in-stock items (default: false)
 * @param {boolean} options.exactMatch - Exact MPN match (default: true)
 * @param {number} options.maxResults - Max results to return (default: 10)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, options = {}) {
  const inStockOnly = options.inStockOnly ? 1 : 0;
  const exactMatch = options.exactMatch !== false ? 1 : 0;
  const maxResults = options.maxResults || 10;

  const path = `${MASTER_CONFIG.searchPath}/${encodeURIComponent(mpn)}/${inStockOnly}/${exactMatch}/${maxResults}/${MASTER_CONFIG.apiKey}`;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: MASTER_CONFIG.baseUrl,
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      timeout: 15000,
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 401) {
            reject(new Error('Unauthorized - check API key'));
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`API error ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }

          const json = JSON.parse(data);
          const result = parseSearchResults(json, mpn, rfqQty);
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

/**
 * Parse Master Electronics search results into screening + VQ format
 */
function parseSearchResults(results, searchMpn, rfqQty) {
  const result = {
    searchMpn,
    rfqQty,
    found: false,
    // Screening fields
    franchiseQty: 0,
    franchisePrice: null,      // Unit price at qty 1 (or MOQ)
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
    vqMoq: null,
    vqRohs: null,
    vqCoo: null,
    vqSku: null,
    // Raw data
    allMatches: [],
    matchCount: 0,
  };

  // API returns array directly
  if (!Array.isArray(results) || results.length === 0) {
    return result;
  }

  result.matchCount = results.length;

  // Find best match - prefer exact MPN match with highest stock
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  // First pass: exact MPN matches with stock
  const exactWithStock = results.filter(r =>
    normalizeMpn(r.partNumber) === normalizedSearch &&
    parseInt(r.quantityAvailable || '0') > 0
  );

  if (exactWithStock.length > 0) {
    // Sort by stock descending
    exactWithStock.sort((a, b) =>
      parseInt(b.quantityAvailable || '0') - parseInt(a.quantityAvailable || '0')
    );
    bestMatch = exactWithStock[0];
  }

  // Second pass: exact MPN match (no stock requirement)
  if (!bestMatch) {
    for (const item of results) {
      if (normalizeMpn(item.partNumber) === normalizedSearch) {
        bestMatch = item;
        break;
      }
    }
  }

  // Third pass: any item with highest stock
  if (!bestMatch) {
    const withStock = results.filter(r => parseInt(r.quantityAvailable || '0') > 0);
    if (withStock.length > 0) {
      withStock.sort((a, b) =>
        parseInt(b.quantityAvailable || '0') - parseInt(a.quantityAvailable || '0')
      );
      bestMatch = withStock[0];
    }
  }

  // Fall back to first result
  if (!bestMatch) {
    bestMatch = results[0];
  }

  // Extract part info
  result.vqMpn = bestMatch.partNumber || '';
  result.vqManufacturer = bestMatch.manufacturer || '';
  result.vqDescription = bestMatch.description || '';
  result.vqRohs = bestMatch.roHS || '';
  result.vqCoo = bestMatch.coo || '';
  result.vqMoq = parseInt(bestMatch.moq || '1');

  // Get quantities (API returns strings)
  const stock = parseInt(bestMatch.quantityAvailable || '0');
  result.franchiseQty = stock;

  // Lead time
  if (bestMatch.factoryLeadTimeTxt) {
    result.vqLeadTime = bestMatch.factoryLeadTimeTxt;
  } else if (bestMatch.factoryLeadTime) {
    result.vqLeadTime = `${bestMatch.factoryLeadTime} Week(s)`;
  }

  // Get pricing (price_breaks array)
  const priceBreaks = bestMatch.price_breaks || [];
  if (priceBreaks.length > 0) {
    // Sort by quantity ascending
    priceBreaks.sort((a, b) => parseInt(a.pricebreak) - parseInt(b.pricebreak));

    // First tier (price at MOQ)
    result.franchisePrice = parseFloat(priceBreaks[0].pricelist);
    // Last tier (bulk price)
    result.franchiseBulkPrice = parseFloat(priceBreaks[priceBreaks.length - 1].pricelist);
    // Price at RFQ qty
    result.franchiseRfqPrice = getPriceAtQty(priceBreaks, rfqQty);
  }

  if (result.franchiseRfqPrice !== null) {
    result.vqPrice = result.franchiseRfqPrice;
    result.found = true;
  }

  if (result.franchiseBulkPrice && rfqQty) {
    result.opportunityValue = result.franchiseBulkPrice * rfqQty;
  }

  // Build vendor notes
  const notes = [];
  if (stock > 0) {
    notes.push(`Master stock: ${stock.toLocaleString()}`);
  } else if (result.vqLeadTime) {
    notes.push(`Lead time: ${result.vqLeadTime}`);
  }
  if (result.vqMoq > 1) {
    notes.push(`MOQ: ${result.vqMoq}`);
  }
  if (result.vqManufacturer) {
    notes.push(`Mfr: ${result.vqManufacturer}`);
  }
  result.vqVendorNotes = notes.join(' | ');

  // Collect all matches for reference
  result.allMatches = results.slice(0, 10).map(r => ({
    mpn: r.partNumber,
    manufacturer: r.manufacturer,
    stock: parseInt(r.quantityAvailable || '0'),
    price: r.price_breaks?.[0]?.pricelist ? parseFloat(r.price_breaks[0].pricelist) : null,
    moq: parseInt(r.moq || '1'),
    leadTime: r.factoryLeadTimeTxt,
    rohs: r.roHS,
    lifecycle: r.productLifeCycle,
  }));

  return result;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceBreaks, qty) {
  if (!priceBreaks || priceBreaks.length === 0) return null;

  // Price breaks are strings, need to parse
  let price = parseFloat(priceBreaks[0].pricelist);

  for (const tier of priceBreaks) {
    const breakQty = parseInt(tier.pricebreak);
    if (qty >= breakQty) {
      price = parseFloat(tier.pricelist);
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
 * @param {Object} options - Search options passed to searchPart
 */
async function searchParts(parts, delayMs = 300, options = {}) {
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { mpn, qty } = parts[i];

    try {
      const result = await searchPart(mpn, qty || 1, options);
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
  MASTER_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node master.js <MPN> [qty] [options]');
    console.log('Example: node master.js LM317T 100');
    console.log('Example: node master.js LM317 100 --partial    # partial match');
    console.log('Example: node master.js LM317 100 --in-stock   # in-stock only');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;

  const options = {
    exactMatch: !args.includes('--partial'),
    inStockOnly: args.includes('--in-stock'),
  };

  searchPart(mpn, qty, options)
    .then(result => {
      console.log('\n=== Master Electronics Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
