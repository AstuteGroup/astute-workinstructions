/**
 * Waldom Electronics API Integration for Franchise Screening
 *
 * Uses Waldom Electronics REST API
 * Auth: API key in URL path (/api/v1/{ApiKey}/...)
 * Docs: https://api.waldom.com/swagger/index.html
 *
 * Endpoints used:
 *   GET /api/v1/{ApiKey}/InventoryAndPricing/{Term}/{InStockOnly}/{ExactMatch}/{ResultsCount}
 */

const https = require('https');

// Waldom Electronics API Configuration
const WALDOM_CONFIG = {
  apiKey: process.env.WALDOM_API_KEY || 'e8b022a9-896f-4a04-a3df-4f99d3851331',
  baseUrl: 'api.waldom.com',
  version: 'v1',

  // iDempiere Business Partner for VQ loading
  bpId: 1000644,
  bpValue: '1002648',
  bpName: 'Waldom Electronics',
};

/**
 * Search Waldom Electronics for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {Object} options - Search options
 * @param {boolean} options.inStockOnly - Only return in-stock items (default: false)
 * @param {boolean} options.exactMatch - Exact MPN match (default: true)
 * @param {number} options.maxResults - Max results to return (default: 10)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, options = {}) {
  const inStockOnly = options.inStockOnly !== false;
  const exactMatch = options.exactMatch !== false;
  const maxResults = options.maxResults || 10;

  const path = `/api/${WALDOM_CONFIG.version}/${WALDOM_CONFIG.apiKey}/InventoryAndPricing/${encodeURIComponent(mpn)}/${inStockOnly}/${exactMatch}/${maxResults}`;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: WALDOM_CONFIG.baseUrl,
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
          if (res.statusCode === 401 || res.statusCode === 403) {
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
 * Parse Waldom Electronics search results into screening + VQ format
 *
 * API response shape:
 * {
 *   products: [{
 *     Id, PartNumber, ManufacturerName, Description, Status,
 *     TotalStockQuantity, TotalInventoryQuantity, MinOrderQuantity, StandardPackQuantity,
 *     LeadTime, Rohs, HTSCode, UOM,
 *     AvailableInventory: [{ ShipsFromRegion, Quantity, DateCodes: [{ DateCode, CountryOfOrigin }] }],
 *     Pricing: { Currency, PriceBreaks: [{ PriceBreakQuantity, Price }] }
 *   }],
 *   errors: [],
 *   totalCount: N
 * }
 */
function parseSearchResults(response, searchMpn, rfqQty) {
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
    vqDateCode: null,
    vqMoq: null,
    vqRohs: null,
    vqCoo: null,
    // Raw data
    allMatches: [],
    matchCount: 0,
  };

  const products = response.products || [];
  if (products.length === 0) {
    return result;
  }

  result.matchCount = response.totalCount || products.length;

  // Find best match - prefer exact MPN match with highest stock
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  // First pass: exact MPN matches with stock
  const exactWithStock = products.filter(p =>
    normalizeMpn(p.PartNumber) === normalizedSearch &&
    (p.TotalStockQuantity || 0) > 0
  );

  if (exactWithStock.length > 0) {
    exactWithStock.sort((a, b) => (b.TotalStockQuantity || 0) - (a.TotalStockQuantity || 0));
    bestMatch = exactWithStock[0];
  }

  // Second pass: exact MPN match (no stock requirement)
  if (!bestMatch) {
    for (const item of products) {
      if (normalizeMpn(item.PartNumber) === normalizedSearch) {
        bestMatch = item;
        break;
      }
    }
  }

  // Third pass: any item with highest stock
  if (!bestMatch) {
    const withStock = products.filter(p => (p.TotalStockQuantity || 0) > 0);
    if (withStock.length > 0) {
      withStock.sort((a, b) => (b.TotalStockQuantity || 0) - (a.TotalStockQuantity || 0));
      bestMatch = withStock[0];
    }
  }

  // Fall back to first result
  if (!bestMatch) {
    bestMatch = products[0];
  }

  // Extract part info
  result.vqMpn = bestMatch.PartNumber || '';
  result.vqManufacturer = bestMatch.ManufacturerName || '';
  result.vqDescription = bestMatch.Description || '';
  result.vqRohs = bestMatch.Rohs || '';
  result.vqMoq = parseInt(bestMatch.MinOrderQuantity || '1');
  result.vqSpq = parseInt(bestMatch.StandardPackQuantity || '1') || null;

  // Stock quantity
  const stock = bestMatch.TotalStockQuantity || 0;
  result.franchiseQty = stock;

  // Lead time (weeks)
  if (bestMatch.LeadTime) {
    result.vqLeadTime = `${bestMatch.LeadTime} Week(s)`;
  }

  // Date code - from first available inventory entry
  const inventory = bestMatch.AvailableInventory || [];
  if (inventory.length > 0) {
    const dateCodes = inventory[0].DateCodes || [];
    if (dateCodes.length > 0) {
      // Format date code from ISO date to YYWW or readable format
      const dc = dateCodes[0];
      if (dc.DateCode) {
        const d = new Date(dc.DateCode);
        result.vqDateCode = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      if (dc.CountryOfOrigin) {
        result.vqCoo = dc.CountryOfOrigin;
      }
    }
  }

  // Pricing
  const priceBreaks = bestMatch.Pricing?.PriceBreaks || [];
  if (priceBreaks.length > 0) {
    // Sort by quantity ascending
    priceBreaks.sort((a, b) => a.PriceBreakQuantity - b.PriceBreakQuantity);

    // First tier (price at MOQ)
    result.franchisePrice = priceBreaks[0].Price;
    // Last tier (bulk price)
    result.franchiseBulkPrice = priceBreaks[priceBreaks.length - 1].Price;
    // Price at RFQ qty
    result.franchiseRfqPrice = getPriceAtQty(priceBreaks, rfqQty);
    // All price breaks sorted ascending by qty
    result.priceBreaks = priceBreaks.map(pb => ({ qty: pb.PriceBreakQuantity, unitPrice: pb.Price })).sort((a, b) => a.qty - b.qty);
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
    notes.push(`Waldom stock: ${stock.toLocaleString()}`);
    // Include ship-from region
    if (inventory.length > 0 && inventory[0].ShipsFromRegion) {
      notes.push(`Ships: ${inventory[0].ShipsFromRegion}`);
    }
  } else if (result.vqLeadTime) {
    notes.push(`Lead time: ${result.vqLeadTime}`);
  }
  if (result.vqMoq > 1) {
    notes.push(`MOQ: ${result.vqMoq}`);
  }
  if (result.vqManufacturer) {
    notes.push(`Mfr: ${result.vqManufacturer}`);
  }
  if (bestMatch.Status && bestMatch.Status !== 'Active') {
    notes.push(`Status: ${bestMatch.Status}`);
  }
  result.vqVendorNotes = notes.join(' | ');

  // Collect all matches for reference
  result.allMatches = products.slice(0, 10).map(p => ({
    mpn: p.PartNumber,
    manufacturer: p.ManufacturerName,
    stock: p.TotalStockQuantity || 0,
    price: p.Pricing?.PriceBreaks?.[0]?.Price || null,
    moq: parseInt(p.MinOrderQuantity || '1'),
    leadTime: p.LeadTime ? `${p.LeadTime} wks` : null,
    rohs: p.Rohs,
    status: p.Status,
    coo: p.AvailableInventory?.[0]?.DateCodes?.[0]?.CountryOfOrigin || null,
  }));

  return result;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceBreaks, qty) {
  if (!priceBreaks || priceBreaks.length === 0) return null;

  let price = priceBreaks[0].Price;

  for (const tier of priceBreaks) {
    if (qty >= tier.PriceBreakQuantity) {
      price = tier.Price;
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
  WALDOM_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node waldom.js <MPN> [qty] [options]');
    console.log('Example: node waldom.js 1720420802 100');
    console.log('Example: node waldom.js 172042 100 --partial    # partial match');
    console.log('Example: node waldom.js 1720420802 100 --all     # include out-of-stock');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;

  const options = {
    exactMatch: !args.includes('--partial'),
    inStockOnly: !args.includes('--all'),
  };

  searchPart(mpn, qty, options)
    .then(result => {
      console.log('\n=== Waldom Electronics Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
