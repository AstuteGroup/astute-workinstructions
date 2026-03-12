/**
 * DigiKey API Integration for Franchise Screening
 *
 * Uses DigiKey Product Information v4 API (2-Legged OAuth)
 *
 * Outputs:
 * 1. Screening data (qty available, pricing) for broker decision
 * 2. VQ-ready data for ERP import
 */

const https = require('https');

// DigiKey API Configuration
const DIGIKEY_CONFIG = {
  clientId: process.env.DIGIKEY_CLIENT_ID || 'ivtDsDLOQ6l4TgHiKzRJeI42BUrw5ZRq',
  clientSecret: process.env.DIGIKEY_CLIENT_SECRET || '2gx8NL6aSwH9GkpH',
  accountId: process.env.DIGIKEY_ACCOUNT_ID || '14763716',
  tokenUrl: 'https://api.digikey.com/v1/oauth2/token',
  searchUrl: 'https://api.digikey.com/products/v4/search/keyword',

  // iDempiere Business Partner for VQ loading
  bpId: 1000327,
  bpValue: '1002331',
  bpName: 'Digi-Key Electronics',
};

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get OAuth2 access token (cached with refresh)
 */
async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: DIGIKEY_CONFIG.clientId,
      client_secret: DIGIKEY_CONFIG.clientSecret,
      grant_type: 'client_credentials',
    }).toString();

    const options = {
      hostname: 'api.digikey.com',
      path: '/v1/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            cachedToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in * 1000);
            resolve(cachedToken);
          } else {
            reject(new Error(`Token error: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Token parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Search DigiKey for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1) {
  const token = await getAccessToken();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      Keywords: mpn,
      Limit: 10,  // Get top matches
      FilterOptionsRequest: {
        // Only in-stock items
        MinimumQuantityAvailable: 1,
      },
    });

    const options = {
      hostname: 'api.digikey.com',
      path: '/products/v4/search/keyword',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': DIGIKEY_CONFIG.clientId,
        'X-DIGIKEY-Account-Id': DIGIKEY_CONFIG.accountId,
        'X-DIGIKEY-Locale-Site': 'US',
        'X-DIGIKEY-Locale-Language': 'EN',
        'X-DIGIKEY-Locale-Currency': 'USD',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (json.status === 401) {
            // Token expired, clear cache and retry
            cachedToken = null;
            tokenExpiry = null;
            reject(new Error('Token expired'));
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
    req.write(postData);
    req.end();
  });
}

/**
 * Parse DigiKey search results into screening + VQ format
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
    vqDigiKeyPn: null,
    vqManufacturer: null,
    // Raw data
    allMatches: [],
  };

  if (!json.Products || json.Products.length === 0) {
    return result;
  }

  // Find best match - prefer exact MPN match
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  for (const product of json.Products) {
    const normalizedResult = normalizeMpn(product.ManufacturerProductNumber);
    if (normalizedResult === normalizedSearch) {
      bestMatch = product;
      break;
    }
  }

  // Fall back to first result if no exact match
  if (!bestMatch) {
    bestMatch = json.Products[0];
  }

  result.found = true;
  result.vqMpn = bestMatch.ManufacturerProductNumber;
  result.vqDescription = bestMatch.Description?.ProductDescription || '';
  result.vqManufacturer = bestMatch.Manufacturer?.Name || '';

  // Use product-level quantity (don't sum package types to avoid double counting)
  result.franchiseQty = bestMatch.QuantityAvailable || 0;

  // Find best pricing based on RFQ quantity
  const pricingInfo = selectBestPricing(bestMatch.ProductVariations, rfqQty);

  if (pricingInfo) {
    result.vqDigiKeyPn = pricingInfo.digiKeyPn;
    result.franchisePrice = pricingInfo.unitPrice;
    result.franchiseBulkPrice = pricingInfo.bulkPrice;
    result.franchiseRfqPrice = pricingInfo.rfqPrice;
    result.vqPrice = pricingInfo.rfqPrice;
    result.opportunityValue = result.franchiseRfqPrice * rfqQty;
  }

  // Build vendor notes
  result.vqVendorNotes = `DigiKey stock: ${result.franchiseQty.toLocaleString()}`;
  if (result.vqDigiKeyPn) {
    result.vqVendorNotes += ` | DigiKey PN: ${result.vqDigiKeyPn}`;
  }

  // Collect all matches for reference
  result.allMatches = json.Products.map(p => ({
    mpn: p.ManufacturerProductNumber,
    manufacturer: p.Manufacturer?.Name,
    qty: p.QuantityAvailable,
    unitPrice: p.UnitPrice,
  }));

  return result;
}

/**
 * Select best pricing from product variations based on RFQ quantity
 * Returns pricing from Cut Tape for small qty, Tape & Reel for large qty
 */
function selectBestPricing(variations, rfqQty) {
  if (!variations || variations.length === 0) return null;

  // Separate by package type
  const cutTape = variations.find(v => v.PackageType?.Name?.includes('Cut Tape'));
  const tapeReel = variations.find(v => v.PackageType?.Name?.includes('Tape & Reel'));
  const digiReel = variations.find(v => v.PackageType?.Name?.includes('Digi-Reel'));

  // Prefer Cut Tape for flexibility, fall back to others
  let selected = cutTape || digiReel || tapeReel || variations[0];

  // If qty is large enough for Tape & Reel MOQ, consider it
  if (tapeReel && rfqQty >= (tapeReel.MinimumOrderQuantity || 1)) {
    // Compare pricing at rfqQty
    const trPrice = getPriceAtQty(tapeReel.StandardPricing, rfqQty);
    const ctPrice = cutTape ? getPriceAtQty(cutTape.StandardPricing, rfqQty) : Infinity;

    if (trPrice && trPrice < ctPrice) {
      selected = tapeReel;
    }
  }

  const pricing = selected.StandardPricing || [];

  return {
    digiKeyPn: selected.DigiKeyProductNumber,
    packageType: selected.PackageType?.Name,
    unitPrice: pricing[0]?.UnitPrice || null,
    bulkPrice: pricing[pricing.length - 1]?.UnitPrice || null,
    rfqPrice: getPriceAtQty(pricing, rfqQty),
    moq: selected.MinimumOrderQuantity || 1,
  };
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(pricing, qty) {
  if (!pricing || pricing.length === 0) return null;

  let price = pricing[0].UnitPrice;  // Default to first tier

  for (const tier of pricing) {
    if (qty >= tier.BreakQuantity) {
      price = tier.UnitPrice;
    } else {
      break;
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
async function searchParts(parts, delayMs = 500) {
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
  DIGIKEY_CONFIG,
  getAccessToken,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node digikey.js <MPN> [qty]');
    console.log('Example: node digikey.js LM317 100');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;

  searchPart(mpn, qty)
    .then(result => {
      console.log('\n=== DigiKey Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
