/**
 * TTI API Integration for Franchise Screening
 *
 * Auth: apiKey header (custom Azure APIM header — NOT Ocp-Apim-Subscription-Key)
 * Portal: https://developer.tti.com
 *
 * API Products:
 *   - Search (primary): GET /service/api/v1/search/keyword — pricing, stock, lead time, compliance
 *   - Lead Time:        POST /leadtime/v1/requestLeadtime — lifecycle, CoO, on-order pipeline
 *   - Manufacturers:    GET /service/api/v1/search/manufacturers — reference list
 *   - Quote:            GET /quote/v2/{quoteId}/lineitems — needs separate key
 *
 * Search API response fields:
 *   ttiPartNumber, manufacturerPartNumber, manufacturer, description,
 *   availableToSell, pricing.quantityPriceBreaks[], leadTime,
 *   salesMinimum (MOQ), salesMultiple (SPQ), packaging,
 *   datasheetURL, buyUrl, hts, eccn, rohsStatus, imageURL,
 *   regionalInventory[], availableOnOrder[]
 */

const https = require('https');

// TTI API Configuration
const TTI_CONFIG = {
  // API keys (separate products)
  searchKey: process.env.TTI_SEARCH_KEY || '9cafe5893ee04935a82d2c5ab663cf26',
  leadTimeKey: process.env.TTI_LEADTIME_KEY || 'ee0620712e46441296dd77341d6179e8',

  // Base URL
  baseUrl: 'api.tti.com',

  // Endpoints
  searchPath: '/service/api/v1/search/keyword',            // GET — primary (pricing + stock)
  leadTimePath: '/leadtime/v1/requestLeadtime',             // POST — supplemental (lifecycle, CoO)
  manufacturersPath: '/service/api/v1/search/manufacturers', // GET — reference

  // iDempiere Business Partner for VQ loading
  bpId: 1000326,
  bpValue: '1002330',
  bpName: 'TTI Inc',
};

/**
 * Make an HTTPS request to TTI API
 */
function ttiRequest(path, apiKey, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: TTI_CONFIG.baseUrl,
      path: path,
      method: method,
      headers: {
        'Accept': 'application/json',
        'apiKey': apiKey,
        'Cache-Control': 'no-cache',
      },
      timeout: 20000,
    };

    if (bodyStr) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('Unauthorized - check API key'));
          return;
        }
        if (res.statusCode === 429) {
          let retryMsg = 'Rate limited';
          try {
            const errBody = JSON.parse(data);
            retryMsg = errBody.message || retryMsg;
          } catch (e) {}
          reject(new Error(retryMsg));
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
 * Search TTI for a part number via Search API (keyword endpoint)
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {Object} options - { exact: boolean, enrichLeadTime: boolean, verbose: boolean }
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, options = {}) {
  const exact = options.exact !== false; // default true
  const params = new URLSearchParams({ searchTerms: mpn });
  if (exact) params.append('exactMatchPartNumber', 'true');

  const path = `${TTI_CONFIG.searchPath}?${params.toString()}`;
  const json = await ttiRequest(path, TTI_CONFIG.searchKey);
  const result = parseSearchResults(json, mpn, rfqQty);

  // Optionally enrich with Lead Time API data (lifecycle, CoO, on-order)
  if (options.enrichLeadTime && result.found) {
    try {
      const ltJson = await ttiRequest(
        TTI_CONFIG.leadTimePath,
        TTI_CONFIG.leadTimeKey,
        'POST',
        { description: `Enrich ${mpn}`, partNumbers: [mpn] }
      );
      enrichWithLeadTime(result, ltJson);
    } catch (e) {
      if (options.verbose) {
        console.error(`  Lead time enrichment failed: ${e.message}`);
      }
    }
  }

  return result;
}

/**
 * Parse Search API (keyword) response into standard screening + VQ format
 *
 * Response shape:
 * {
 *   "parts": [{
 *     "ttiPartNumber": "C0805C104K5RACTU",
 *     "manufacturerPartNumber": "C0805C104K5RAC7800",
 *     "manufacturerCode": "KEM",
 *     "manufacturer": "KEMET",
 *     "description": "Multilayer Ceramic Capacitors MLCC...",
 *     "availableToSell": 2832000,
 *     "salesMinimum": 4000,        // MOQ
 *     "salesMultiple": 4000,       // SPQ
 *     "pricing": {
 *       "quantityPriceBreaks": [{ "quantity": 4000, "price": 0.0114 }, ...]
 *     },
 *     "leadTime": "14 Weeks",
 *     "packaging": "Reel",
 *     "datasheetURL": "https://...",
 *     "buyUrl": "https://...",
 *     "hts": "8532240020",
 *     "category": "Multilayer Ceramic Capacitors...",
 *     "partNCNR": "N",
 *     "tariffMessage": "Tariff May Apply",
 *     "exportInformation": { "eccn": "EAR99", "hts": "...", "taric": "..." },
 *     "environmentalInformation": { "rohsStatus": "Compliant", ... },
 *     "regionalInventory": [{ "ttiRegion": "AS", "availableToSell": 20000, ... }],
 *     "availableOnOrder": [{ "quantity": 184000, "date": "2026-03-18" }],
 *     "roHsStatus": "Compliant"
 *   }],
 *   "currencyCode": "USD",
 *   "recordCount": 2
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
    vqCoo: null,
    vqLifeCycle: null,
    vqPackaging: null,
    // Raw data
    allMatches: [],
    matchCount: 0,
    currency: apiResponse.currencyCode || 'USD',
  };

  const parts = apiResponse.parts || [];
  if (parts.length === 0) return result;

  result.matchCount = parts.length;
  const normalizedSearch = normalizeMpn(searchMpn);

  // Find best match: exact MPN with highest stock
  let bestMatch = null;

  // First: exact match with stock
  const exactWithStock = parts.filter(p =>
    normalizeMpn(p.ttiPartNumber) === normalizedSearch &&
    (p.availableToSell || 0) > 0
  );
  if (exactWithStock.length > 0) {
    exactWithStock.sort((a, b) => (b.availableToSell || 0) - (a.availableToSell || 0));
    bestMatch = exactWithStock[0];
  }

  // Second: exact match (no stock requirement)
  if (!bestMatch) {
    bestMatch = parts.find(p => normalizeMpn(p.ttiPartNumber) === normalizedSearch);
  }

  // Third: any match with highest stock
  if (!bestMatch) {
    const withStock = parts.filter(p => (p.availableToSell || 0) > 0);
    if (withStock.length > 0) {
      withStock.sort((a, b) => (b.availableToSell || 0) - (a.availableToSell || 0));
      bestMatch = withStock[0];
    }
  }

  // Fallback: first result
  if (!bestMatch) {
    bestMatch = parts[0];
  }

  result.found = true;

  // Part info
  result.vqMpn = bestMatch.manufacturerPartNumber || bestMatch.ttiPartNumber || '';
  result.vqSku = bestMatch.ttiPartNumber || '';
  result.vqManufacturer = bestMatch.manufacturer || '';
  result.vqDescription = bestMatch.description || '';

  // Stock
  result.franchiseQty = bestMatch.availableToSell || 0;

  // Regional inventory (e.g., Asia stock)
  const regionalStock = (bestMatch.regionalInventory || []).reduce(
    (sum, r) => sum + (r.availableToSell || 0), 0
  );

  // MOQ / SPQ
  result.vqMoq = bestMatch.salesMinimum || null;
  result.vqSpq = bestMatch.salesMultiple || null;

  // Pricing
  const priceBreaks = bestMatch.pricing?.quantityPriceBreaks || [];
  if (priceBreaks.length > 0) {
    // Already sorted by quantity from API, but ensure it
    const sorted = [...priceBreaks].sort((a, b) => a.quantity - b.quantity);

    result.franchisePrice = sorted[0].price;
    result.franchiseBulkPrice = sorted[sorted.length - 1].price;
    result.franchiseRfqPrice = getPriceAtQty(sorted, rfqQty);
    result.vqPrice = result.franchiseRfqPrice;
  }

  if (result.franchiseBulkPrice && rfqQty) {
    result.opportunityValue = result.franchiseBulkPrice * rfqQty;
  }

  // Lead time
  if (bestMatch.leadTime) {
    result.vqLeadTime = bestMatch.leadTime; // Already formatted: "14 Weeks"
  }

  // Compliance & export
  result.vqRohs = bestMatch.roHsStatus || bestMatch.environmentalInformation?.rohsStatus || null;
  result.vqHts = bestMatch.hts || bestMatch.exportInformation?.hts || null;
  result.vqEccn = bestMatch.exportInformation?.eccn || null;
  result.vqPackaging = bestMatch.packaging || null;
  result.vqDatasheetUrl = bestMatch.datasheetURL || null;

  // On-order pipeline
  const onOrder = (bestMatch.availableOnOrder || []).filter(
    o => o.quantity > 0 && o.date !== 'N/A'
  );

  // Build vendor notes
  const notes = [];
  if (result.franchiseQty > 0) {
    notes.push(`TTI stock: ${result.franchiseQty.toLocaleString()}`);
  }
  if (regionalStock > 0) {
    notes.push(`Asia: ${regionalStock.toLocaleString()}`);
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
  if (bestMatch.tariffMessage) {
    notes.push(bestMatch.tariffMessage);
  }
  if (onOrder.length > 0) {
    const pipeline = onOrder.map(o => `${o.quantity.toLocaleString()} by ${o.date}`).join(', ');
    notes.push(`On order: ${pipeline}`);
  }
  result.vqVendorNotes = notes.join(' | ') || 'TTI part (no stock)';

  // Collect all matches
  result.allMatches = parts.map(p => ({
    ttiPn: p.ttiPartNumber || '',
    mfrPn: p.manufacturerPartNumber || '',
    manufacturer: p.manufacturer || '',
    stock: p.availableToSell || 0,
    moq: p.salesMinimum,
    leadTime: p.leadTime,
    price: p.pricing?.quantityPriceBreaks?.[0]?.price || null,
    bulkPrice: p.pricing?.quantityPriceBreaks?.slice(-1)[0]?.price || null,
    packaging: p.packaging,
    rohs: p.roHsStatus,
    regionalStock: (p.regionalInventory || []).map(r => ({
      region: r.ttiRegion,
      stock: r.availableToSell,
    })),
  }));

  return result;
}

/**
 * Enrich result with Lead Time API data (lifecycle, CoO)
 * Adds fields not available in the Search API response
 */
function enrichWithLeadTime(result, ltResponse) {
  const leadTimes = ltResponse.leadTimes || [];
  if (leadTimes.length === 0) return;

  // Find matching entry
  const match = leadTimes.find(lt =>
    lt.ttiPartNumber && lt.ttiPartNumber.trim() !== 'Not a TTI Part'
  );
  if (!match) return;

  if (match.lifeCycle) {
    result.vqLifeCycle = match.lifeCycle;
    if (match.lifeCycle !== 'Active' && !result.vqVendorNotes.includes('Lifecycle')) {
      result.vqVendorNotes += ` | Lifecycle: ${match.lifeCycle}`;
    }
  }

  if (match.countryOfOrigin || match.primaryCountryOfOrigin) {
    result.vqCoo = match.countryOfOrigin || match.primaryCountryOfOrigin;
  }
}

/**
 * Get price at a specific quantity from price breaks
 * TTI price breaks: [{ quantity: 4000, price: 0.0114 }, ...]
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
async function searchParts(parts, delayMs = 300, options = {}) {
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

/**
 * Fetch manufacturer code list from Search API
 */
async function getManufacturers() {
  return ttiRequest(TTI_CONFIG.manufacturersPath, TTI_CONFIG.searchKey);
}

// Export for use in other modules
module.exports = {
  TTI_CONFIG,
  searchPart,
  searchParts,
  getManufacturers,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node tti.js <MPN> [qty]');
    console.log('       node tti.js <MPN> [qty] --enrich    # add lifecycle/CoO from Lead Time API');
    console.log('       node tti.js <MPN> [qty] --partial   # non-exact search');
    console.log('       node tti.js --manufacturers          # list manufacturer codes');
    console.log('\nExamples:');
    console.log('  node tti.js C0805C104K5RACTU 100');
    console.log('  node tti.js ERJ-6ENF1001V 5000 --enrich');
    console.log('  node tti.js C0805 100 --partial');
    process.exit(1);
  }

  if (args[0] === '--manufacturers') {
    getManufacturers()
      .then(data => {
        const mfrs = data.manufacturers || [];
        console.log(`\n${mfrs.length} manufacturers:\n`);
        for (const m of mfrs) {
          console.log(`  ${m.manufacturerCode.padEnd(5)} ${m.manufacturer}`);
        }
      })
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    const mpn = args[0];
    const qty = parseInt(args[1]) || 1;
    const opts = {
      exact: !args.includes('--partial'),
      enrichLeadTime: args.includes('--enrich'),
      verbose: true,
    };

    searchPart(mpn, qty, opts)
      .then(result => {
        console.log('\n=== TTI Search Result ===');
        console.log(JSON.stringify(result, null, 2));
      })
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
