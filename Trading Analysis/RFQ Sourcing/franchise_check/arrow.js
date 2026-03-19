/**
 * Arrow API Integration for Franchise Screening
 *
 * Uses Arrow Pricing & Availability API v4
 * Auth: Query parameters (login + apikey)
 *
 * Note: Arrow API returns both arrow.com (franchise) and Verical (marketplace) sources.
 * For franchise screening, we filter to arrow.com sources only.
 */

const https = require('https');

// Arrow API Configuration
const ARROW_CONFIG = {
  login: process.env.ARROW_LOGIN || 'astutegroup1',
  apiKey: process.env.ARROW_API_KEY || 'fe8176be3335c19ce3d5f82cc8a06b21d04e62354e137b60994f4a95190a6d76',
  baseUrl: 'api.arrow.com',
  searchPath: '/itemservice/v4/en/search/token',

  // iDempiere Business Partner for VQ loading
  bpId: 1000386,
  bpValue: '1002390',
  bpName: 'Arrow Electronics',

  // Source types for categorization
  franchiseSources: ['AMERICAS', 'EUROPE', 'APAC', 'ASIA'],  // arrow.com franchise
  marketplaceSources: ['VERICAL'],  // Verical marketplace
};

/**
 * Search Arrow for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1) {
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({
      login: ARROW_CONFIG.login,
      apikey: ARROW_CONFIG.apiKey,
      search_token: mpn,
      rows: 5,  // Get top matches
    }).toString();

    const options = {
      hostname: ARROW_CONFIG.baseUrl,
      path: `${ARROW_CONFIG.searchPath}?${queryParams}`,
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
 * Parse Arrow search results into screening + VQ format
 */
function parseSearchResults(json, searchMpn, rfqQty) {
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
    vqDateCode: null,
    vqArrowSourcePartId: null,
    // Raw data
    allSources: [],
  };

  // Navigate to part list
  const data = json?.itemserviceresult?.data?.[0];
  if (!data || !data.PartList || data.PartList.length === 0) {
    return result;
  }

  // Find best match - prefer exact MPN match
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  for (const part of data.PartList) {
    const normalizedResult = normalizeMpn(part.partNum);
    if (normalizedResult === normalizedSearch) {
      bestMatch = part;
      break;
    }
  }

  // Fall back to first result if no exact match
  if (!bestMatch) {
    bestMatch = data.PartList[0];
  }

  result.vqMpn = bestMatch.partNum;
  result.vqDescription = bestMatch.desc || '';
  result.vqManufacturer = bestMatch.manufacturer?.mfrName || '';

  // Collect inventory from all sources (arrow.com + Verical)
  const invOrg = bestMatch.InvOrg;
  if (!invOrg || !invOrg.webSites) {
    return result;
  }

  let arrowQty = 0;      // arrow.com franchise stock
  let vericalQty = 0;    // Verical marketplace stock
  let bestPrice = null;
  let bestBulkPrice = null;
  let bestRfqPrice = null;
  let bestSource = null;
  let bestDateCode = null;
  let bestSourceType = null;  // 'Arrow' or 'Verical'

  for (const website of invOrg.webSites) {
    const isVerical = website.code === 'Verical.com';
    const isArrow = website.code === 'arrow.com';

    for (const source of website.sources || []) {
      for (const sourcePart of source.sourceParts || []) {
        // Get availability
        const availability = sourcePart.Availability?.[0];
        const qty = availability?.fohQty || 0;

        if (isArrow) {
          arrowQty += qty;
        } else if (isVerical) {
          vericalQty += qty;
        }

        // Get pricing
        const priceList = sourcePart.Prices?.resaleList || [];
        if (priceList.length > 0) {
          // First tier (unit price)
          const unitPrice = priceList[0]?.price;
          // Last tier (bulk price)
          const bulkPrice = priceList[priceList.length - 1]?.price;
          // Price at RFQ qty
          const rfqPrice = getPriceAtQty(priceList, rfqQty);

          // Track best pricing (lowest bulk price with stock)
          // Prefer Arrow franchise over Verical at same price
          if (qty > 0 && bulkPrice) {
            const isBetter = bestBulkPrice === null ||
              bulkPrice < bestBulkPrice ||
              (bulkPrice === bestBulkPrice && isArrow && bestSourceType === 'Verical');

            if (isBetter) {
              bestPrice = unitPrice;
              bestBulkPrice = bulkPrice;
              bestRfqPrice = rfqPrice;
              bestSource = sourcePart;
              bestDateCode = sourcePart.dateCode || null;
              bestSourceType = isVerical ? 'Verical' : 'Arrow';
            }
          }
        }

        // Collect all sources for reference
        result.allSources.push({
          website: website.code,
          source: source.displayName,
          qty,
          unitPrice: priceList[0]?.price,
          bulkPrice: priceList[priceList.length - 1]?.price,
          dateCode: sourcePart.dateCode,
          shipsFrom: sourcePart.shipsFrom,
        });
      }
    }
  }

  const totalQty = arrowQty + vericalQty;

  if (totalQty > 0) {
    result.found = true;
    result.franchiseQty = totalQty;
    result.arrowQty = arrowQty;
    result.vericalQty = vericalQty;
    result.franchisePrice = bestPrice;
    result.franchiseBulkPrice = bestBulkPrice;
    result.franchiseRfqPrice = bestRfqPrice;
    result.vqPrice = bestRfqPrice;
    result.vqDateCode = bestDateCode;
    result.vqSourceType = bestSourceType;
    result.opportunityValue = bestBulkPrice ? bestBulkPrice * rfqQty : null;

    // Build vendor notes - distinguish Arrow vs Verical
    const notes = [];
    if (arrowQty > 0) notes.push(`Arrow: ${arrowQty.toLocaleString()}`);
    if (vericalQty > 0) notes.push(`Verical: ${vericalQty.toLocaleString()}`);
    if (bestDateCode) notes.push(`DC: ${bestDateCode}`);
    if (bestSourceType) notes.push(`Best: ${bestSourceType}`);
    if (bestSource?.sourcePartId) {
      result.vqArrowSourcePartId = bestSource.sourcePartId;
    }
    result.vqVendorNotes = notes.join(' | ');
  }

  return result;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(priceList, qty) {
  if (!priceList || priceList.length === 0) return null;

  let price = priceList[0].price;  // Default to first tier

  for (const tier of priceList) {
    if (qty >= tier.minQty) {
      price = tier.price;
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
  ARROW_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node arrow.js <MPN> [qty]');
    console.log('Example: node arrow.js LM317T 100');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;

  searchPart(mpn, qty)
    .then(result => {
      console.log('\n=== Arrow Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
