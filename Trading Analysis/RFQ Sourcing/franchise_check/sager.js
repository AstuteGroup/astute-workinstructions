/**
 * Sager Electronics API Integration for Franchise Screening
 *
 * Auth: api_key header (Mashery)
 * Portal: https://developer.sager.com
 * Base URL: sagerelectronics.api.mashery.com
 *
 * API: Customer Price and Availability
 *   - POST /customer-price-availability/v1
 *   - Body: { "PartNumber": "MPN" }
 *
 * Response fields:
 *   manufacturerPartNumber, manufacturerName, description,
 *   currentStockQty, onOrderQuantity, leadTimeDays,
 *   pricings[].unitPrice/qtyBreak, minimumBuy, multiplier,
 *   ncnr, roHS, lifeCycleStatus, category, currency,
 *   dataSheetUrl, productUrl, sku, packaging
 *
 * Rate limit: 4 calls/sec, 100K calls/day
 *
 * iDempiere Business Partner: Sager - v3004 (1000335)
 */

const https = require('https');

const SAGER_CONFIG = {
  apiKey: process.env.SAGER_API_KEY || 'y7deugn3bmsk8czcc5aaxk9q',
  baseUrl: 'sagerelectronics.api.mashery.com',
  path: '/customer-price-availability/v1',

  // iDempiere Business Partner
  bpId: 1000335,
  bpValue: '1002339',
  bpName: 'Sager - v3004',
};

/**
 * POST to Sager API
 */
function sagerRequest(partNumber) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ PartNumber: partNumber });

    const options = {
      hostname: SAGER_CONFIG.baseUrl,
      path: SAGER_CONFIG.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'api_key': SAGER_CONFIG.apiKey,
        'Accept': 'application/json',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 403) {
          const msg = data.includes('Over Qps') ? 'Rate limited (4/sec)' :
                      data.includes('Inactive') ? 'Developer inactive — check Sager portal' :
                      `Forbidden: ${data.substring(0, 100)}`;
          reject(new Error(msg));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`API error ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout (15s)'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Find the price at or nearest above the requested qty from pricing tiers
 */
function getPriceAtQty(pricings, qty) {
  if (!pricings || pricings.length === 0) return null;

  // Sort by qtyBreak ascending
  const sorted = [...pricings].sort((a, b) => a.qtyBreak - b.qtyBreak);

  // Find the highest tier where qty >= qtyBreak
  let matched = sorted[0]; // default to first tier
  for (const tier of sorted) {
    if (qty >= tier.qtyBreak) {
      matched = tier;
    }
  }

  return parseFloat(matched.unitPrice);
}

/**
 * Search Sager for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @returns {Object} Screening and VQ data (matches franchise-api.js standard interface)
 */
async function searchPart(mpn, rfqQty = 1) {
  const result = {
    searchMpn: mpn,
    rfqQty,
    found: false,
    // Screening fields
    franchiseQty: 0,
    franchisePrice: null,
    franchiseBulkPrice: null,
    franchiseRfqPrice: null,
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
    vqLifeCycle: null,
    vqPackaging: null,
    vqNcnr: null,
    vqProductUrl: null,
    // Raw
    allMatches: [],
    matchCount: 0,
    currency: 'USD',
  };

  const apiResponse = await sagerRequest(mpn);

  if (!apiResponse || apiResponse.status !== 'Success') return result;

  const products = (apiResponse.data && apiResponse.data.products) || [];
  // Filter out empty product objects
  const validProducts = products.filter(p => p.manufacturerPartNumber);

  if (validProducts.length === 0) return result;

  result.matchCount = validProducts.length;
  result.allMatches = validProducts;

  // Pick best match: highest stock
  const bestMatch = validProducts.reduce((best, p) =>
    (p.currentStockQty || 0) > (best.currentStockQty || 0) ? p : best
  , validProducts[0]);

  result.found = true;

  // Screening fields
  const stock = bestMatch.currentStockQty || 0;
  result.franchiseQty = stock;

  const pricings = bestMatch.pricings || [];
  if (pricings.length > 0) {
    const sorted = [...pricings].sort((a, b) => a.qtyBreak - b.qtyBreak);
    result.franchisePrice = parseFloat(sorted[0].unitPrice);
    result.franchiseBulkPrice = parseFloat(sorted[sorted.length - 1].unitPrice);
    result.franchiseRfqPrice = getPriceAtQty(pricings, rfqQty);
  }

  if (result.franchiseRfqPrice && rfqQty) {
    result.opportunityValue = result.franchiseRfqPrice * rfqQty;
  }

  // VQ fields
  result.vqPrice = result.franchiseRfqPrice;
  result.vqMpn = bestMatch.manufacturerPartNumber || mpn;
  result.vqManufacturer = bestMatch.manufacturerName || '';
  result.vqDescription = bestMatch.description || '';
  result.vqLeadTime = bestMatch.leadTimeDays ? `${bestMatch.leadTimeDays} days` : '';
  result.vqMoq = bestMatch.minimumBuy || null;
  result.vqSpq = bestMatch.multiplier || null;
  result.vqSku = bestMatch.sku || null;
  result.vqDatasheetUrl = bestMatch.dataSheetUrl || null;
  result.vqRohs = bestMatch.roHS || null;
  result.vqLifeCycle = bestMatch.lifeCycleStatus || null;
  result.vqPackaging = bestMatch.packaging || null;
  result.vqNcnr = bestMatch.ncnr || null;
  result.vqProductUrl = bestMatch.productUrl || null;
  result.currency = bestMatch.currency || 'USD';

  // Vendor notes: stock + on-order + lead time + NCNR
  const notes = [];
  if (stock > 0) notes.push(`Stock: ${stock.toLocaleString()}`);
  if (bestMatch.onOrderQuantity > 0) notes.push(`On order: ${bestMatch.onOrderQuantity.toLocaleString()}`);
  if (bestMatch.leadTimeDays) notes.push(`LT: ${bestMatch.leadTimeDays}d`);
  if (bestMatch.ncnr === 'Yes') notes.push('NCNR');
  if (bestMatch.category) notes.push(bestMatch.category);
  result.vqVendorNotes = notes.join(' | ');

  return result;
}

module.exports = { searchPart, sagerRequest, SAGER_CONFIG };
