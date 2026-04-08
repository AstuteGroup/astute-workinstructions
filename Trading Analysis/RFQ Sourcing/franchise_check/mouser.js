/**
 * Mouser API Integration for Franchise Screening
 *
 * Auth: apiKey query parameter
 * Portal: https://api.mouser.com/api/docs/ui/index
 *
 * API Endpoints:
 *   - Part Number Search: POST /api/v1/search/partnumber — pricing, stock, lead time, compliance
 *   - Keyword Search:     POST /api/v1/search/keyword — broader search
 *   - Mfr List:           GET  /api/v2/search/manufacturerlist — reference
 *
 * Response fields:
 *   ManufacturerPartNumber, Manufacturer, Description,
 *   AvailabilityInStock, PriceBreaks[], LeadTime,
 *   Min (MOQ), Mult (SPQ), MouserPartNumber,
 *   DataSheetUrl, ProductDetailUrl, ROHSStatus, LifecycleStatus,
 *   ProductCompliance[] (USHTS, ECCN, etc.)
 */

const https = require('https');

// Mouser API Configuration
const MOUSER_CONFIG = {
  apiKey: process.env.MOUSER_API_KEY || 'd73312c1-9675-4406-b0b5-d96241d46a5c',

  // Base URL
  baseUrl: 'api.mouser.com',

  // Endpoints
  partSearchPath: '/api/v1/search/partnumber',
  keywordSearchPath: '/api/v1/search/keyword',
  manufacturerListPath: '/api/v2/search/manufacturerlist',

  // iDempiere Business Partner for VQ loading
  bpId: 1000334,
  bpValue: '1002338',
  bpName: 'Mouser',
};

/**
 * Make an HTTPS request to Mouser API
 */
function mouserRequest(path, method = 'POST', body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    // API key goes in query string
    const separator = path.includes('?') ? '&' : '?';
    const fullPath = `${path}${separator}apiKey=${MOUSER_CONFIG.apiKey}`;

    const options = {
      hostname: MOUSER_CONFIG.baseUrl,
      path: fullPath,
      method: method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error('Unauthorized - check API key'));
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('Rate limited'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`API error ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}\nRaw: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout (20s)'));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Search Mouser for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {Object} options - { exact: boolean, verbose: boolean }
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, options = {}) {
  const exact = options.exact !== false; // default true

  const body = {
    SearchByPartRequest: {
      mouserPartNumber: mpn,
      partSearchOptions: exact ? 'Exact' : 'None',
    },
  };

  const json = await mouserRequest(MOUSER_CONFIG.partSearchPath, 'POST', body);
  return parseSearchResults(json, mpn, rfqQty);
}

/**
 * Parse Mouser search response into standard screening + VQ format
 *
 * Response shape:
 * {
 *   "Errors": [],
 *   "SearchResults": {
 *     "NumberOfResult": 3,
 *     "Parts": [{
 *       "MouserPartNumber": "512-LM358N",
 *       "ManufacturerPartNumber": "LM358N",
 *       "Manufacturer": "onsemi",
 *       "Description": "...",
 *       "AvailabilityInStock": "2422522 In Stock",
 *       "FactoryStock": null,
 *       "Min": "1",
 *       "Mult": "1",
 *       "PriceBreaks": [{ "Quantity": 1, "Price": "$0.10", "Currency": "USD" }, ...],
 *       "LeadTime": "140 Days",
 *       "LifecycleStatus": null | "Obsolete" | ...,
 *       "ROHSStatus": "RoHS Compliant",
 *       "DataSheetUrl": "https://...",
 *       "ProductDetailUrl": "https://...",
 *       "ProductCompliance": [{ "ComplianceName": "USHTS", "ComplianceValue": "..." }, ...],
 *       "SuggestedReplacement": "...",
 *       "InfoMessages": [...],
 *       "RestrictionMessage": "..."
 *     }]
 *   }
 * }
 */
function parseSearchResults(apiResponse, searchMpn, rfqQty) {
  const result = {
    searchMpn,
    rfqQty,
    found: false,
    // Screening fields
    franchiseQty: 0,
    franchisePrice: null,      // Price at MOQ
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
    vqSpq: null,
    vqSku: null,
    vqDatasheetUrl: null,
    vqRohs: null,
    vqHts: null,
    vqEccn: null,
    vqLifeCycle: null,
    vqPackaging: null,
    // Raw data
    allMatches: [],
    matchCount: 0,
    currency: 'USD',
  };

  const parts = apiResponse.SearchResults?.Parts || [];
  if (parts.length === 0) return result;

  result.matchCount = parts.length;
  const normalizedSearch = normalizeMpn(searchMpn);

  // Find best match: prioritize exact MPN with stock and pricing
  let bestMatch = null;

  // First: exact MPN match with stock AND pricing
  const exactWithStockAndPrice = parts.filter(p =>
    normalizeMpn(p.ManufacturerPartNumber) === normalizedSearch &&
    parseAvailability(p.AvailabilityInStock) > 0 &&
    p.PriceBreaks && p.PriceBreaks.length > 0
  );
  if (exactWithStockAndPrice.length > 0) {
    exactWithStockAndPrice.sort((a, b) =>
      parseAvailability(b.AvailabilityInStock) - parseAvailability(a.AvailabilityInStock)
    );
    bestMatch = exactWithStockAndPrice[0];
  }

  // Second: exact MPN match with stock (no pricing requirement)
  if (!bestMatch) {
    const exactWithStock = parts.filter(p =>
      normalizeMpn(p.ManufacturerPartNumber) === normalizedSearch &&
      parseAvailability(p.AvailabilityInStock) > 0
    );
    if (exactWithStock.length > 0) {
      exactWithStock.sort((a, b) =>
        parseAvailability(b.AvailabilityInStock) - parseAvailability(a.AvailabilityInStock)
      );
      bestMatch = exactWithStock[0];
    }
  }

  // Third: exact MPN match (no stock)
  if (!bestMatch) {
    bestMatch = parts.find(p =>
      normalizeMpn(p.ManufacturerPartNumber) === normalizedSearch
    );
  }

  // Fourth: any match with stock + pricing
  if (!bestMatch) {
    const withStock = parts.filter(p =>
      parseAvailability(p.AvailabilityInStock) > 0 &&
      p.PriceBreaks && p.PriceBreaks.length > 0
    );
    if (withStock.length > 0) {
      withStock.sort((a, b) =>
        parseAvailability(b.AvailabilityInStock) - parseAvailability(a.AvailabilityInStock)
      );
      bestMatch = withStock[0];
    }
  }

  // Fallback: first result
  if (!bestMatch) {
    bestMatch = parts[0];
  }

  // Extract HTS/ECCN from ProductCompliance early so restricted parts still
  // surface compliance data (HTS/ECCN are properties of the part, not the
  // distributor's ability to sell it).
  const earlyCompliance = bestMatch.ProductCompliance || [];
  const earlyUshts = earlyCompliance.find(c => c.ComplianceName === 'USHTS');
  const earlyEccn = earlyCompliance.find(c => c.ComplianceName === 'ECCN');
  result.vqHts = earlyUshts ? earlyUshts.ComplianceValue : null;
  result.vqEccn = earlyEccn ? earlyEccn.ComplianceValue : null;

  // Check for restriction (distributor block)
  if (bestMatch.RestrictionMessage && !bestMatch.AvailabilityInStock && (!bestMatch.PriceBreaks || bestMatch.PriceBreaks.length === 0)) {
    result.found = true;
    result.vqMpn = bestMatch.ManufacturerPartNumber || '';
    result.vqSku = bestMatch.MouserPartNumber || '';
    result.vqManufacturer = bestMatch.Manufacturer || '';
    result.vqDescription = bestMatch.Description || '';
    result.vqVendorNotes = `Mouser: ${bestMatch.RestrictionMessage}`;
    result.vqLifeCycle = bestMatch.LifecycleStatus || null;
    return result;
  }

  result.found = true;

  // Part info
  result.vqMpn = bestMatch.ManufacturerPartNumber || '';
  result.vqSku = bestMatch.MouserPartNumber || '';
  result.vqManufacturer = bestMatch.Manufacturer || '';
  result.vqDescription = bestMatch.Description || '';

  // Stock — Mouser returns "2422522 In Stock" as a string
  result.franchiseQty = parseAvailability(bestMatch.AvailabilityInStock);

  // MOQ / SPQ
  result.vqMoq = bestMatch.Min ? parseInt(bestMatch.Min) || null : null;
  result.vqSpq = bestMatch.Mult ? parseInt(bestMatch.Mult) || null : null;

  // Pricing — Mouser returns [{ Quantity: 1, Price: "$0.10", Currency: "USD" }]
  const priceBreaks = (bestMatch.PriceBreaks || []).map(pb => ({
    quantity: pb.Quantity,
    price: parsePrice(pb.Price),
    currency: pb.Currency,
  })).filter(pb => pb.price != null && pb.price > 0);

  if (priceBreaks.length > 0) {
    const sorted = [...priceBreaks].sort((a, b) => a.quantity - b.quantity);

    result.franchisePrice = sorted[0].price;
    result.franchiseBulkPrice = sorted[sorted.length - 1].price;
    result.franchiseRfqPrice = getPriceAtQty(sorted, rfqQty);
    result.vqPrice = result.franchiseRfqPrice;
    result.currency = sorted[0].currency || 'USD';
    result.priceBreaks = sorted.map(pb => ({ qty: pb.quantity, unitPrice: pb.price }));
  }

  if (result.franchiseBulkPrice && rfqQty) {
    result.opportunityValue = result.franchiseBulkPrice * rfqQty;
  }

  // Lead time
  if (bestMatch.LeadTime && bestMatch.LeadTime !== '0 Days') {
    result.vqLeadTime = bestMatch.LeadTime;
  }

  // Lifecycle
  result.vqLifeCycle = bestMatch.LifecycleStatus || null;

  // Compliance
  result.vqRohs = bestMatch.ROHSStatus || null;
  result.vqDatasheetUrl = bestMatch.DataSheetUrl || null;

  // HTS/ECCN already extracted above (before restriction check).

  // Packaging from ProductAttributes
  const attrs = bestMatch.ProductAttributes || [];
  const packagingAttr = attrs.find(a => a.AttributeName === 'Packaging');
  result.vqPackaging = packagingAttr ? packagingAttr.AttributeValue : null;

  // Build vendor notes
  const notes = [];
  if (result.franchiseQty > 0) {
    notes.push(`Mouser stock: ${result.franchiseQty.toLocaleString()}`);
  }
  if (result.vqLeadTime) {
    notes.push(`LT: ${result.vqLeadTime}`);
  }
  if (result.vqMoq && result.vqMoq > 1) {
    notes.push(`MOQ: ${result.vqMoq.toLocaleString()}`);
  }
  if (result.vqManufacturer) {
    notes.push(`Mfr: ${result.vqManufacturer}`);
  }
  if (result.vqLifeCycle) {
    notes.push(`Lifecycle: ${result.vqLifeCycle}`);
  }
  if (bestMatch.SuggestedReplacement) {
    notes.push(`Alt: ${bestMatch.SuggestedReplacement}`);
  }
  result.vqVendorNotes = notes.join(' | ') || 'Mouser part (no stock)';

  // Collect all matches
  result.allMatches = parts.map(p => ({
    mouserPn: p.MouserPartNumber || '',
    mfrPn: p.ManufacturerPartNumber || '',
    manufacturer: p.Manufacturer || '',
    stock: parseAvailability(p.AvailabilityInStock),
    moq: parseInt(p.Min) || null,
    leadTime: p.LeadTime,
    lifecycle: p.LifecycleStatus,
    price: p.PriceBreaks?.[0] ? parsePrice(p.PriceBreaks[0].Price) : null,
    bulkPrice: p.PriceBreaks?.length > 0 ? parsePrice(p.PriceBreaks[p.PriceBreaks.length - 1].Price) : null,
    packaging: (p.ProductAttributes || []).find(a => a.AttributeName === 'Packaging')?.AttributeValue || null,
    rohs: p.ROHSStatus,
    restriction: p.RestrictionMessage || null,
  }));

  return result;
}

/**
 * Parse Mouser availability string → number
 * "2422522 In Stock" → 2422522
 * "None" → 0
 * null → 0
 */
function parseAvailability(str) {
  if (!str) return 0;
  const match = str.match(/^([\d,]+)/);
  if (!match) return 0;
  return parseInt(match[1].replace(/,/g, '')) || 0;
}

/**
 * Parse Mouser price string → number
 * "$0.10" → 0.10
 * "0.10" → 0.10
 */
function parsePrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceBreaks, qty) {
  if (!priceBreaks || priceBreaks.length === 0) return null;

  let price = priceBreaks[0].price;
  for (const tier of priceBreaks) {
    if (qty >= tier.quantity) {
      price = tier.price;
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
 * Search multiple parts (sequential with rate limiting)
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {number} delayMs - Delay between requests
 * @param {Object} options - Passed to searchPart
 */
async function searchParts(parts, delayMs = 500, options = {}) {
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { mpn, qty } = parts[i];

    try {
      const result = await searchPart(mpn, qty || 1, options);
      results.push(result);

      const status = result.found
        ? `${result.franchiseQty.toLocaleString()} @ $${result.vqPrice || 'N/A'}`
        : 'Not found';
      console.log(`[${i + 1}/${parts.length}] ${mpn}: ${status}`);
    } catch (error) {
      console.error(`[${i + 1}/${parts.length}] ${mpn}: Error - ${error.message}`);
      results.push({
        searchMpn: mpn,
        rfqQty: qty,
        found: false,
        error: error.message,
      });
    }

    if (i < parts.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// Export for use in other modules
module.exports = {
  MOUSER_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node mouser.js <MPN> [qty]');
    console.log('       node mouser.js <MPN> [qty] --partial   # non-exact search');
    console.log('\nExamples:');
    console.log('  node mouser.js C0805C104K5RACTU 100');
    console.log('  node mouser.js LM358 100 --partial');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;
  const opts = {
    exact: !args.includes('--partial'),
    verbose: true,
  };

  searchPart(mpn, qty, opts)
    .then(result => {
      console.log('\n=== Mouser Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
