/**
 * TTI API Integration for Franchise Screening
 *
 * Uses TTI Lead Time API (primary) + Search API (manufacturer reference)
 * Auth: apiKey header (custom Azure APIM header name)
 * Portal: https://developer.tti.com
 *
 * API Products:
 *   - Lead Time: POST /leadtime/v1/requestLeadtime — stock, lead time, lifecycle, CoO
 *   - Search:    GET /service/api/v1/search/manufacturers — manufacturer code list
 *   - Quote:     GET /quote/v2/{quoteId}/lineitems — requires separate key (not yet subscribed)
 *
 * Lead Time API returns: stock qty, lead time (weeks), lifecycle, CoO, mfr code
 * No pricing data available — TTI APIs don't expose price breaks
 * Rate limit: ~5 seconds between lead time calls
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
  leadTimePath: '/leadtime/v1/requestLeadtime',         // POST — primary endpoint
  manufacturersPath: '/service/api/v1/search/manufacturers', // GET — reference only

  // Rate limit (seconds between lead time calls)
  rateLimitMs: 6000,

  // iDempiere Business Partner for VQ loading
  bpId: 1000326,
  bpValue: '1002330',
  bpName: 'TTI Inc',
};

// Manufacturer code mapping (from Search API, cached)
// mfrAlias → full name (populated on first use or from search API)
const MFR_ALIASES = {
  'KEM': 'Kemet',
  'PAN': 'Panasonic',
  'VIS': 'Vishay',
  'TXN': 'Texas Instruments',
  'AVX': 'Kyocera AVX',
  'BOU': 'Bourns',
  'MUR': 'Murata',
  'TDK': 'TDK',
  'YAG': 'Yageo',
  'CDE': 'Cornell Dubilier',
  'AMO': 'ams OSRAM',
  'HON': 'Honeywell',
  'LIT': 'Littelfuse',
  'TEL': 'TE Connectivity',
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
          // Extract retry-after if available
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
 * Look up a single part via Lead Time API
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity
 * @param {Object} options - { verbose: boolean }
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, options = {}) {
  const body = {
    description: `Lookup ${mpn}`,
    partNumbers: [mpn],
  };

  const json = await ttiRequest(
    TTI_CONFIG.leadTimePath,
    TTI_CONFIG.leadTimeKey,
    'POST',
    body
  );

  return parseLeadTimeResult(json, mpn, rfqQty);
}

/**
 * Parse Lead Time API response into standard screening + VQ format
 *
 * Response shape:
 * {
 *   "description": "...",
 *   "leadTimes": [{
 *     "customerEntity": "NDC" | null,
 *     "requestedPartNumber": "C0805C104K5RACTU",
 *     "ttiPartNumber": "C0805C104K5RACTU" | "Not a TTI Part",
 *     "manufacturerPartNumber": "C0805C104K5RAC7800" | null,
 *     "leadTime": "14" | null,          // weeks
 *     "available": 2832000 | null,       // stock qty
 *     "mfrAlias": "KEM" | null,          // manufacturer code
 *     "approvalIndicator": " " | null,
 *     "lifeCycle": "Active" | null,
 *     "commentsToCustomer": "...",
 *     "countryOfOrigin": "CN" | null,
 *     "primaryCountryOfOrigin": "CN" | null,
 *     "availableOnOrder": [{ "quantity": 0, "date": "N/A" }, ...]
 *   }],
 *   "totalCount": 1
 * }
 */
function parseLeadTimeResult(apiResponse, searchMpn, rfqQty) {
  const result = {
    searchMpn,
    rfqQty,
    found: false,
    // Screening fields
    franchiseQty: 0,
    franchisePrice: null,      // Not available from TTI API
    franchiseBulkPrice: null,  // Not available from TTI API
    franchiseRfqPrice: null,   // Not available from TTI API
    opportunityValue: null,
    // VQ fields
    vqPrice: null,
    vqVendorNotes: null,
    vqMpn: null,
    vqDescription: null,
    vqManufacturer: null,
    vqLeadTime: null,
    vqCoo: null,
    vqSku: null,               // TTI part number
    vqLifeCycle: null,
    // Raw data
    allMatches: [],
    matchCount: 0,
  };

  const leadTimes = apiResponse.leadTimes || [];
  if (leadTimes.length === 0) return result;

  result.matchCount = leadTimes.length;

  // Find the matching part (usually just one since we search one at a time)
  const normalizedSearch = normalizeMpn(searchMpn);
  let bestMatch = null;

  for (const item of leadTimes) {
    // Skip "Not a TTI Part" entries if we have better ones
    if (item.ttiPartNumber && item.ttiPartNumber.trim() !== 'Not a TTI Part') {
      if (!bestMatch || (item.available || 0) > (bestMatch.available || 0)) {
        bestMatch = item;
      }
    }
  }

  // Fall back to first result (may be "Not a TTI Part")
  if (!bestMatch) {
    bestMatch = leadTimes[0];
  }

  // Check if TTI carries this part
  const isTtiPart = bestMatch.ttiPartNumber &&
    bestMatch.ttiPartNumber.trim() !== 'Not a TTI Part';

  if (!isTtiPart) {
    // TTI doesn't carry it — still return result with found=false
    result.vqMpn = searchMpn;
    result.vqVendorNotes = 'Not a TTI Part';
    return result;
  }

  result.found = true;

  // Part info
  result.vqMpn = (bestMatch.manufacturerPartNumber || '').trim() || searchMpn;
  result.vqSku = (bestMatch.ttiPartNumber || '').trim();

  // Manufacturer (resolve alias if possible)
  const mfrCode = bestMatch.mfrAlias || '';
  result.vqManufacturer = MFR_ALIASES[mfrCode] || mfrCode;

  // Stock
  result.franchiseQty = bestMatch.available || 0;

  // Lead time (weeks)
  if (bestMatch.leadTime) {
    const weeks = parseInt(bestMatch.leadTime);
    result.vqLeadTime = isNaN(weeks) ? bestMatch.leadTime : `${weeks} Week(s)`;
  }

  // Country of origin
  result.vqCoo = bestMatch.countryOfOrigin || bestMatch.primaryCountryOfOrigin || null;

  // Lifecycle
  result.vqLifeCycle = bestMatch.lifeCycle || null;

  // Available on order (future stock pipeline)
  const onOrder = (bestMatch.availableOnOrder || []).filter(
    o => o.quantity > 0 && o.date !== 'N/A'
  );

  // Build vendor notes
  const notes = [];
  if (result.franchiseQty > 0) {
    notes.push(`TTI stock: ${result.franchiseQty.toLocaleString()}`);
  }
  if (result.vqLeadTime) {
    notes.push(`LT: ${result.vqLeadTime}`);
  }
  if (result.vqLifeCycle && result.vqLifeCycle !== 'Active') {
    notes.push(`Lifecycle: ${result.vqLifeCycle}`);
  }
  if (result.vqCoo) {
    notes.push(`CoO: ${result.vqCoo}`);
  }
  if (result.vqManufacturer) {
    notes.push(`Mfr: ${result.vqManufacturer}`);
  }
  if (onOrder.length > 0) {
    const pipeline = onOrder.map(o => `${o.quantity.toLocaleString()} by ${o.date}`).join(', ');
    notes.push(`On order: ${pipeline}`);
  }
  result.vqVendorNotes = notes.join(' | ') || 'TTI part (no stock)';

  // Collect all matches for reference
  result.allMatches = leadTimes.map(item => ({
    requestedMpn: item.requestedPartNumber,
    ttiPn: (item.ttiPartNumber || '').trim(),
    mfrPn: (item.manufacturerPartNumber || '').trim(),
    stock: item.available || 0,
    leadTime: item.leadTime,
    mfr: item.mfrAlias,
    lifecycle: item.lifeCycle,
    coo: item.countryOfOrigin,
  }));

  return result;
}

/**
 * Search multiple parts via Lead Time API
 * Batches parts into the partNumbers array (API supports multiple)
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {number} delayMs - Delay between batch requests (rate limiting)
 * @param {Object} options - { batchSize: number, verbose: boolean }
 */
async function searchParts(parts, delayMs = TTI_CONFIG.rateLimitMs, options = {}) {
  const batchSize = options.batchSize || 20; // TTI may support batch lookups
  const results = [];

  // Try batch first — send all MPNs in one request
  for (let i = 0; i < parts.length; i += batchSize) {
    const batch = parts.slice(i, i + batchSize);
    const partNumbers = batch.map(p => p.mpn);

    try {
      const body = {
        description: `Batch lookup ${i + 1}-${i + batch.length}`,
        partNumbers: partNumbers,
      };

      const json = await ttiRequest(
        TTI_CONFIG.leadTimePath,
        TTI_CONFIG.leadTimeKey,
        'POST',
        body
      );

      // Parse each result from the batch response
      const leadTimes = json.leadTimes || [];
      for (let j = 0; j < batch.length; j++) {
        const { mpn, qty } = batch[j];
        // Find this part's lead time entry
        const partLt = leadTimes.find(
          lt => normalizeMpn(lt.requestedPartNumber) === normalizeMpn(mpn)
        );

        if (partLt) {
          const singleResponse = { leadTimes: [partLt], totalCount: 1 };
          const result = parseLeadTimeResult(singleResponse, mpn, qty || 1);
          results.push(result);
          const status = result.found
            ? `${result.franchiseQty.toLocaleString()} avail | LT: ${result.vqLeadTime || 'N/A'}`
            : 'Not a TTI part';
          console.log(`[${results.length}/${parts.length}] ${mpn}: ${status}`);
        } else {
          results.push({
            searchMpn: mpn,
            rfqQty: qty,
            found: false,
            vqVendorNotes: 'No response from TTI',
          });
          console.log(`[${results.length}/${parts.length}] ${mpn}: No match in response`);
        }
      }
    } catch (error) {
      console.error(`Batch ${i + 1}-${i + batch.length} error: ${error.message}`);
      // Add error entries for all parts in failed batch
      for (const { mpn, qty } of batch) {
        results.push({
          searchMpn: mpn,
          rfqQty: qty,
          found: false,
          error: error.message,
        });
      }
    }

    // Rate limiting between batches
    if (i + batchSize < parts.length && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Fetch manufacturer code list from Search API
 * Returns array of { manufacturerCode, manufacturer }
 */
async function getManufacturers() {
  return ttiRequest(
    TTI_CONFIG.manufacturersPath,
    TTI_CONFIG.searchKey
  );
}

/**
 * Normalize MPN for comparison
 */
function normalizeMpn(mpn) {
  if (!mpn) return '';
  return mpn.replace(/[-\s]/g, '').toUpperCase();
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
    console.log('       node tti.js <MPN1> <MPN2> <MPN3>    # batch lookup');
    console.log('       node tti.js --manufacturers          # list manufacturer codes');
    console.log('\nExamples:');
    console.log('  node tti.js C0805C104K5RACTU 100');
    console.log('  node tti.js ERJ-6ENF1001V GRM188R71H104KA93D');
    console.log('\nNote: TTI API provides stock, lead time, lifecycle, and CoO.');
    console.log('      Pricing is NOT available via the Lead Time API.');
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
  } else if (args.length === 1 || (args.length === 2 && !isNaN(args[1]))) {
    // Single part lookup
    const mpn = args[0];
    const qty = parseInt(args[1]) || 1;

    searchPart(mpn, qty)
      .then(result => {
        console.log('\n=== TTI Search Result ===');
        console.log(JSON.stringify(result, null, 2));
      })
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    // Batch lookup — all args are MPNs
    const parts = args.map(mpn => ({ mpn, qty: 1 }));

    searchParts(parts)
      .then(results => {
        console.log('\n=== TTI Batch Results ===');
        const found = results.filter(r => r.found).length;
        const notTti = results.filter(r => !r.found).length;
        console.log(`Found: ${found} | Not TTI: ${notTti} | Total: ${results.length}`);
        console.log(JSON.stringify(results, null, 2));
      })
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
