/**
 * Future Electronics API Integration for Franchise Screening
 *
 * Uses Future Electronics REST API (via Orbweaver)
 * Auth: Header x-orbweaver-licensekey
 * Docs: https://documenter.getpostman.com/view/18706946/UzBvFhcj
 */

const https = require('https');

// Future Electronics API Configuration
const FUTURE_CONFIG = {
  apiKey: process.env.FUTURE_API_KEY || 'IW7OI-DOC91-OKUD3-37YK2-X3RSY',
  baseUrl: 'api.futureelectronics.com',
  searchPath: '/api/v1/pim-future/lookup',

  // iDempiere Business Partner for VQ loading
  bpId: 1000328,
  bpValue: '1002332',
  bpName: 'Future Electronics Corporation',
};

/**
 * Search Future Electronics for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @param {string} lookupType - 'exact', 'contains', or 'default' (starts with)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, lookupTypeOrOpts = 'exact') {
  // Backwards-compat: third arg used to be `lookupType` string. Accept either
  // a string or an options object { lookupType, mfr } so callers can pass the
  // searched MFR for the MPN-match veto without breaking existing call sites.
  const searchOptions = (typeof lookupTypeOrOpts === 'object' && lookupTypeOrOpts !== null)
    ? lookupTypeOrOpts
    : { lookupType: lookupTypeOrOpts };
  const lookupType = searchOptions.lookupType || 'exact';
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({
      part_number: mpn,
      lookup_type: lookupType,
    }).toString();

    const options = {
      hostname: FUTURE_CONFIG.baseUrl,
      path: `${FUTURE_CONFIG.searchPath}?${queryParams}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-orbweaver-licensekey': FUTURE_CONFIG.apiKey,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          // Check for API errors
          if (json.status === 'bad_request' || json.message) {
            resolve({
              searchMpn: mpn,
              rfqQty,
              found: false,
              error: json.message || 'Bad request',
            });
            return;
          }

          const result = parseSearchResults(json, mpn, rfqQty, searchOptions);
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
 * Parse Future Electronics search results into screening + VQ format
 */
function parseSearchResults(response, searchMpn, rfqQty, searchOptions = {}) {
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
    vqDateCode: null,
    vqSku: null,
    vqMoq: null,
    vqSpq: null,
    vqHts: null,    // Future API does not return HTS — kept null for shape parity
    vqEccn: null,   // Future returns ECCN as a name/value entry in part_attributes
    // Raw data
    allMatches: [],
    offerCount: 0,
  };

  const offers = response.offers || [];
  if (offers.length === 0) {
    return result;
  }

  result.offerCount = offers.length;

  // Restrict to MPN-matching candidates (exact or packaging-suffix variant).
  // Never fall back to offers[0] — see shared/mpn-match.js.
  const { pickBestCandidate } = require('../../../shared/mpn-match');
  const attrLookup = (attrs, name) => (attrs || []).find(a => a.name === name)?.value;
  const picked = pickBestCandidate(offers, {
    getMpn: o => o.part_id?.mpn,
    getMfr: o => attrLookup(o.part_attributes, 'manufacturerName'),
    getStock: o => o.quantities?.quantity_available,
    searched: searchMpn,
    opts: { mfr: searchOptions?.mfr },
  });
  if (!picked) return result;
  const bestMatch = picked.candidate;
  result.matchType = picked.matchType;

  // Extract part info
  result.vqMpn = bestMatch.part_id?.mpn || '';
  result.vqSku = bestMatch.part_id?.seller_part_number || '';

  // Extract from part_attributes array
  const attrs = bestMatch.part_attributes || [];
  const attrMap = {};
  for (const attr of attrs) {
    attrMap[attr.name] = attr.value;
  }

  result.vqManufacturer = attrMap['manufacturerName'] || '';
  result.vqDescription = attrMap['description (en)'] || '';
  result.vqDateCode = attrMap['dateCode'] || '';

  // Compliance — Future stores ECCN under part_attributes (name='eccn').
  // Often null in their data; treat empty string as null too.
  const eccnRaw = attrMap['eccn'];
  result.vqEccn = (eccnRaw && String(eccnRaw).trim()) || null;

  // Get quantities
  const quantities = bestMatch.quantities || {};
  const stock = quantities.quantity_available || 0;
  result.franchiseQty = stock;

  // MOQ and SPQ from quantities or attributes.
  // Future's actual field names are quantity_minimum + order_mult_qty (verified
  // against live API 2026-04-14). Other names kept as defensive fallbacks in
  // case Future's schema varies by API version / part class.
  const moqVal = quantities.quantity_minimum
    || quantities.minimum_order_quantity
    || quantities.moq
    || parseInt(attrMap['quantity_minimum'])
    || parseInt(attrMap['purchaseOrderQty'])
    || parseInt(attrMap['minimumOrderQuantity'])
    || null;
  result.vqMoq = moqVal && moqVal > 1 ? moqVal : null;
  result.vqSpq = quantities.order_mult_qty
    || quantities.order_multiple
    || quantities.spq
    || parseInt(attrMap['orderMultiple'])
    || null;

  // Lead time
  if (quantities.factory_leadtime) {
    const ltValue = quantities.factory_leadtime;
    const ltUnits = quantities.factory_leadtime_units || 'Weeks';
    result.vqLeadTime = `${ltValue} ${ltUnits}`;
  }

  // Get pricing
  const pricing = bestMatch.pricing || [];
  if (pricing.length > 0) {
    // Sort by quantity_from ascending
    pricing.sort((a, b) => (a.quantity_from || 0) - (b.quantity_from || 0));

    // First tier (unit price)
    result.franchisePrice = pricing[0].unit_price;
    // Last tier (bulk price)
    result.franchiseBulkPrice = pricing[pricing.length - 1].unit_price;
    // Price at RFQ qty
    result.franchiseRfqPrice = getPriceAtQty(pricing, rfqQty);
    // All price breaks sorted ascending by qty
    result.priceBreaks = pricing.map(p => ({ qty: p.quantity_from, unitPrice: p.unit_price })).sort((a, b) => a.qty - b.qty);
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
    notes.push(`Future stock: ${stock.toLocaleString()}`);
  } else if (result.vqLeadTime) {
    notes.push(`Lead time: ${result.vqLeadTime}`);
  }
  if (result.vqDateCode) {
    notes.push(`DC: ${result.vqDateCode}`);
  }
  if (result.vqSku) {
    notes.push(`Future PN: ${result.vqSku}`);
  }
  if (result.vqMoq && result.vqMoq > 1) {
    notes.push(`MOQ: ${result.vqMoq.toLocaleString()}`);
  }
  result.vqVendorNotes = notes.join(' | ');

  // Collect all matches for reference
  result.allMatches = offers.slice(0, 10).map(o => {
    const oAttrs = {};
    for (const attr of (o.part_attributes || [])) {
      oAttrs[attr.name] = attr.value;
    }
    return {
      mpn: o.part_id?.mpn,
      manufacturer: oAttrs['manufacturerName'],
      stock: o.quantities?.quantity_available || 0,
      price: o.pricing?.[0]?.unit_price,
      dateCode: oAttrs['dateCode'],
    };
  });

  return result;
}

/**
 * Get price at a specific quantity from price breaks
 */
function getPriceAtQty(pricing, qty) {
  if (!pricing || pricing.length === 0) return null;

  let price = pricing[0].unit_price;  // Default to first tier

  for (const tier of pricing) {
    const qtyFrom = tier.quantity_from || 0;
    const qtyTo = tier.quantity_to || Infinity;
    if (qty >= qtyFrom && qty <= qtyTo) {
      price = tier.unit_price;
      break;
    }
    if (qty >= qtyFrom) {
      price = tier.unit_price;
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
 * Batch search multiple parts using POST (more efficient for >1 part)
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {string} lookupType - 'exact', 'contains', or 'default'
 * @returns {Array} Results in same order as input
 */
async function searchPartsBatch(parts, lookupType = 'exact') {
  const mpnList = parts.map(p => p.mpn || p);
  const qtyMap = {};
  parts.forEach(p => {
    const mpn = p.mpn || p;
    qtyMap[mpn] = p.qty || 1;
  });

  const body = { parts: mpnList, lookup_type: lookupType };
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: FUTURE_CONFIG.baseUrl,
      path: '/api/v1/pim-future/batch/lookup',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-orbweaver-licensekey': FUTURE_CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (res.statusCode !== 200) {
            reject(new Error(`API error ${res.statusCode}: ${json.error || data}`));
            return;
          }

          // Parse each result
          const results = [];
          for (const item of (json.lookup_parts || [])) {
            const searchMpn = item.part_number;
            const rfqQty = qtyMap[searchMpn] || 1;

            // Build fake single-response format for parseSearchResults
            const singleResponse = { offers: item.offers || [] };
            const result = parseSearchResults(singleResponse, searchMpn, rfqQty);
            results.push(result);

            console.log(`[Future Batch] ${searchMpn}: ${result.found ? `${result.franchiseQty} @ $${result.vqPrice}` : 'Not found'}`);
          }

          resolve(results);
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

    req.write(postData);
    req.end();
  });
}

/**
 * Search multiple parts (auto-selects batch POST for >1 part, GET for single)
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {number} delayMs - Delay between requests (only used for serial fallback)
 */
async function searchParts(parts, delayMs = 300) {
  // Use batch POST for multiple parts
  if (parts.length > 1) {
    try {
      return await searchPartsBatch(parts);
    } catch (err) {
      console.warn(`Batch failed, falling back to serial: ${err.message}`);
      // Fall through to serial
    }
  }

  // Serial GET for single part or fallback
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
  FUTURE_CONFIG,
  searchPart,
  searchParts,
  searchPartsBatch,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node future.js <MPN> [qty] [lookup_type]');
    console.log('Example: node future.js LM317 100');
    console.log('Example: node future.js LM317 100 contains');
    console.log('');
    console.log('Lookup types:');
    console.log('  exact    - Exact MPN match (default)');
    console.log('  default  - Starts with MPN');
    console.log('  contains - MPN contains search term');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;
  const lookupType = args[2] || 'exact';

  searchPart(mpn, qty, lookupType)
    .then(result => {
      console.log('\n=== Future Electronics Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
