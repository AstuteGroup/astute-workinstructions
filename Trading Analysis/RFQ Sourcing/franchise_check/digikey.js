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
const path = require('path');

// Bucket A: deferred retry queue for rate-limited / transient API failures.
// Loaded lazily so this module can still be required without astute-workinstructions
// being on the same path (defensive — fall through if helper not present).
let _enqueueRetry = null;
function enqueueRetrySafe(opts) {
  try {
    if (!_enqueueRetry) {
      _enqueueRetry = require(path.resolve(__dirname, '../../../shared/api-queue')).enqueueRetry;
    }
    return _enqueueRetry(opts);
  } catch (e) {
    // Helper not available — that's fine, just don't enqueue
    return false;
  }
}

// DigiKey quota state — capture X-RateLimit-Remaining on every response so the
// enrichment poller can make informed tier-4 backlog drain decisions.
let _writeQuotaState = null;
function updateQuotaStateSafe(patch) {
  try {
    if (!_writeQuotaState) {
      _writeQuotaState = require(path.resolve(__dirname, '../../RFQ API Enrichment/rfq-quota-state')).writeQuotaState;
    }
    _writeQuotaState(patch);
  } catch {
    // Not available — that's fine, quota tracking is best-effort
  }
}

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

// ─── Silent-Throttle Detection (Bucket A combo B+C) ─────────────────────────
//
// DigiKey has a failure mode where it silently returns HTTP 200 with empty
// Products[] when rate-limited or having OAuth issues — instead of returning
// 429. This is indistinguishable from a legitimate "no products found"
// response on a single call. Detection requires session-wide context.
//
// Strategy:
//   1. Track total calls + empty results in module-level state
//   2. When suspicious threshold hit (≥5 calls AND >50% empty), run ONE
//      sentinel call with a known-good MPN (LM358N) to verify
//   3. If sentinel returns results → false alarm, mark session healthy,
//      treat current empty as legit (don't enqueue)
//   4. If sentinel ALSO returns empty → confirmed throttling, enqueue the
//      current MPN AND mark session throttled so subsequent empties auto-
//      enqueue without re-running sentinel
//   5. Sentinel cooldown (5 min) prevents re-running the verification too
//      often if the session re-enters unknown state
//
// Status lifecycle:
//   unknown   → verifying → healthy   (sentinel passed, treat empties as legit)
//                       → throttled  (sentinel failed, all empties auto-enqueue)
//   healthy   stays healthy until reset
//   throttled stays throttled until reset
//
// To reset (e.g., after fixing the underlying issue or for testing):
//   require('./digikey').resetThrottleState()

const SENTINEL_MPN = 'LM358N';
const SENTINEL_QTY = 100;
const SUSPICIOUS_EMPTY_RATE = 0.5;
const MIN_CALLS_BEFORE_FLAG = 5;
const SENTINEL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

let _digikeyState = {
  calls: 0,
  empties: 0,
  status: 'unknown',           // 'unknown' | 'verifying' | 'healthy' | 'throttled'
  lastSentinelAt: 0,
  sentinelInProgress: false,
};

function resetThrottleState() {
  _digikeyState = {
    calls: 0,
    empties: 0,
    status: 'unknown',
    lastSentinelAt: 0,
    sentinelInProgress: false,
  };
}

function getThrottleState() {
  return { ..._digikeyState };
}

/**
 * Run a sentinel call against a known-good MPN. Returns true if DigiKey
 * appears healthy (sentinel returned results), false if not (empty or
 * error). Bypasses throttle tracking via { _internal: true } flag.
 */
async function runSentinel() {
  try {
    const result = await _searchPartImpl(SENTINEL_MPN, SENTINEL_QTY, { trackStats: false });
    return !!(result.found && result.priceBreaks && result.priceBreaks.length > 0);
  } catch (e) {
    return false; // sentinel itself failed → assume throttled
  }
}

/**
 * Called after every searchPart result. Tracks stats, runs sentinel when
 * threshold hit, and enqueues retries for empties when throttling is
 * confirmed.
 */
async function checkForSilentThrottle(mpn, rfqQty, result) {
  _digikeyState.calls++;
  if (!result.found) _digikeyState.empties++;

  // Already in known throttled state → enqueue any empty without re-checking
  if (_digikeyState.status === 'throttled' && !result.found) {
    enqueueRetrySafe({
      id: 'digikey-silent-' + mpn + '-' + Date.now(),
      kind: 'api-retry-digikey',
      command: `node -e "require('${__dirname}/digikey').searchPart('${mpn.replace(/'/g, "\\'")}', ${rfqQty}).then(r => console.log('OK', r.found)).catch(e => { console.error(e.message); process.exit(1); })"`,
      blocked_until_hours: 1,
      reason: `DigiKey silent throttle (sentinel-confirmed) on ${mpn}`,
    });
    return;
  }

  // Already known healthy → trust empties as legit
  if (_digikeyState.status === 'healthy') return;

  // Status unknown — should we run the sentinel?
  if (result.found) return; // not a suspicious data point
  if (_digikeyState.calls < MIN_CALLS_BEFORE_FLAG) return;
  if (_digikeyState.empties / _digikeyState.calls < SUSPICIOUS_EMPTY_RATE) return;

  // Sentinel cooldown — don't re-run too soon
  const now = Date.now();
  if (now - _digikeyState.lastSentinelAt < SENTINEL_COOLDOWN_MS) return;

  // Concurrency guard — if another call is running the sentinel, this one
  // falls through (will be caught on the next call after sentinel finishes)
  if (_digikeyState.sentinelInProgress) return;

  _digikeyState.sentinelInProgress = true;
  _digikeyState.status = 'verifying';
  _digikeyState.lastSentinelAt = now;

  try {
    const sentinelOk = await runSentinel();
    if (sentinelOk) {
      _digikeyState.status = 'healthy';
      // Sentinel passed → empties were legit, no enqueue needed
    } else {
      _digikeyState.status = 'throttled';
      // Sentinel failed → enqueue this MPN as the first confirmed-throttled item
      enqueueRetrySafe({
        id: 'digikey-silent-' + mpn + '-' + Date.now(),
        kind: 'api-retry-digikey',
        command: `node -e "require('${__dirname}/digikey').searchPart('${mpn.replace(/'/g, "\\'")}', ${rfqQty}).then(r => console.log('OK', r.found)).catch(e => { console.error(e.message); process.exit(1); })"`,
        blocked_until_hours: 1,
        reason: `DigiKey silent throttle confirmed: ${_digikeyState.empties}/${_digikeyState.calls} empties + sentinel ${SENTINEL_MPN} also empty`,
      });
    }
  } finally {
    _digikeyState.sentinelInProgress = false;
  }
}

/**
 * Search DigiKey for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, searchOptions = {}) {
  const result = await _searchPartImpl(mpn, rfqQty, { trackStats: true, searchOptions });
  // Throttle check runs after the result is in hand. Async but we don't
  // need to block the caller — fire and continue. (await is ok here too;
  // sentinel runs at most once per cooldown window so the cost is bounded.)
  await checkForSilentThrottle(mpn, rfqQty, result);
  return result;
}

/**
 * Internal API call implementation. searchPart wraps this with throttle
 * tracking; runSentinel calls it directly to avoid recursion / counter pollution.
 */
async function _searchPartImpl(mpn, rfqQty = 1, _opts = {}) {
  const token = await getAccessToken();
  const searchOptions = _opts.searchOptions || {};

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
        // Capture DigiKey rate-limit headers on every response for quota tracking.
        const rlRemaining = parseInt(res.headers['x-ratelimit-remaining'] || '', 10);
        const blRemaining = parseInt(res.headers['x-burstlimit-remaining'] || '', 10);
        const retryAfterSec = parseInt(res.headers['retry-after'] || '', 10);
        if (!isNaN(rlRemaining)) {
          const patch = { remainingCalls: rlRemaining };
          if (!isNaN(blRemaining)) patch.burstRemaining = blRemaining;
          updateQuotaStateSafe(patch);
        }

        // Bucket A — auto-enqueue on rate limit / transient errors so the
        // worker retries when DigiKey's quota window resets.
        if (res.statusCode === 429) {
          // Honor Retry-After header if present; fall back to 1 hour.
          const blockHours = !isNaN(retryAfterSec) ? Math.max(retryAfterSec / 3600, 0.25) : 1;
          updateQuotaStateSafe({
            remainingCalls: 0,
            retryAfter: new Date(Date.now() + (blockHours * 3600 * 1000)).toISOString(),
          });
          enqueueRetrySafe({
            id: 'digikey-' + mpn + '-' + Date.now(),
            kind: 'api-retry-digikey',
            command: `node -e "require('${__dirname}/digikey').searchPart('${mpn.replace(/'/g, "\\'")}', ${rfqQty}).then(r => console.log('OK', r.found)).catch(e => { console.error(e.message); process.exit(1); })"`,
            blocked_until_hours: blockHours,
            reason: `DigiKey 429 rate limit on ${mpn}`,
          });
          reject(new Error(`DigiKey rate limit (429) — enqueued for retry`));
          return;
        }
        if (res.statusCode >= 500 && res.statusCode < 600) {
          enqueueRetrySafe({
            id: 'digikey-' + mpn + '-' + Date.now(),
            kind: 'api-retry-digikey',
            command: `node -e "require('${__dirname}/digikey').searchPart('${mpn.replace(/'/g, "\\'")}', ${rfqQty}).then(r => console.log('OK', r.found)).catch(e => { console.error(e.message); process.exit(1); })"`,
            blocked_until_hours: 1,
            reason: `DigiKey ${res.statusCode} server error on ${mpn}`,
          });
          reject(new Error(`DigiKey server error (${res.statusCode}) — enqueued for retry`));
          return;
        }

        try {
          const json = JSON.parse(data);

          if (json.status === 401) {
            // Token expired, clear cache and retry
            cachedToken = null;
            tokenExpiry = null;
            reject(new Error('Token expired'));
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
    req.write(postData);
    req.end();
  });
}

/**
 * Parse DigiKey search results into screening + VQ format
 */
function parseSearchResults(json, searchMpn, rfqQty, searchOptions = {}) {
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
    vqMoq: null,
    vqSpq: null,
    vqHts: null,
    vqEccn: null,
    vqRohs: null,
    vqPackaging: null,  // populated from PackageType.Name on selected variation
    // Raw data
    allMatches: [],
  };

  if (!json.Products || json.Products.length === 0) {
    return result;
  }

  // Restrict to MPN-matching candidates (exact or packaging-suffix variant).
  // Never fall back to Products[0] — see shared/mpn-match.js.
  const { pickBestCandidate } = require('../../../shared/mpn-match');
  const picked = pickBestCandidate(json.Products, {
    getMpn: p => p.ManufacturerProductNumber,
    getMfr: p => p.Manufacturer?.Name,
    getStock: p => p.QuantityAvailable,
    searched: searchMpn,
    opts: { mfr: searchOptions?.mfr },
  });
  if (!picked) return result;
  const bestMatch = picked.candidate;
  result.matchType = picked.matchType;

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
    result.priceBreaks = pricingInfo.priceBreaks;
    result.vqMoq = pricingInfo.moq > 1 ? pricingInfo.moq : null;
    result.vqSpq = pricingInfo.spq || null;
    // Packaging — selectBestPricing returns the PackageType.Name on the chosen
    // variation ("Cut Tape", "Tape & Reel", "Digi-Reel"). normalizePackaging in
    // shared/packaging-lookup.js handles all these strings via STRING_TO_FAMILY.
    result.vqPackaging = pricingInfo.packageType || null;
    result.opportunityValue = result.franchiseRfqPrice * rfqQty;
  }

  // Lead time (from product-level ManufacturerLeadWeeks)
  if (bestMatch.ManufacturerLeadWeeks) {
    result.vqLeadTime = `${bestMatch.ManufacturerLeadWeeks} Weeks`;
  }

  // Compliance (HTS / ECCN / RoHS) from product-level Classifications
  // DigiKey v4 returns these on every product, even those without stock.
  const cls = bestMatch.Classifications || {};
  result.vqHts = cls.HtsusCode || null;
  result.vqEccn = cls.ExportControlClassNumber || null;
  result.vqRohs = cls.RohsStatus || null;

  // Build vendor notes
  result.vqVendorNotes = `DigiKey stock: ${result.franchiseQty.toLocaleString()}`;
  if (result.vqDigiKeyPn) {
    result.vqVendorNotes += ` | DigiKey PN: ${result.vqDigiKeyPn}`;
  }
  if (result.vqMoq && result.vqMoq > 1) {
    result.vqVendorNotes += ` | MOQ: ${result.vqMoq.toLocaleString()}`;
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
    spq: selected.StandardPackage || null,
    priceBreaks: pricing.map(p => ({ qty: p.BreakQuantity, unitPrice: p.UnitPrice })).sort((a, b) => a.qty - b.qty),
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
  // Silent-throttle detection (Bucket A combo B+C)
  resetThrottleState,
  getThrottleState,
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
