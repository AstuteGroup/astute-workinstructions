/**
 * Foreign Exchange Rate Cache
 *
 * Fetches USD-based exchange rates from the free exchangerate-api.com endpoint.
 * Caches to ~/workspace/.fx-rates.json with a 7-day TTL (configurable).
 * No API key required.
 *
 * Usage:
 *   const { getRate, convertToUSD, refreshRates } = require('../shared/fx-rates');
 *
 *   const gbpToUsd = await getRate('GBP');  // e.g. 1.3052
 *   const usdAmount = await convertToUSD(0.17, 'GBP');  // 0.17 * 1.3052
 *   await refreshRates();  // force refresh
 *
 * The cache file stores rates as "1 USD = X foreign" (same as the API).
 * Conversion: foreignAmount / rate = USD amount.
 *             OR: foreignAmount * (1/rate) = USD amount.
 *
 * iDempiere currency IDs → ISO mapping included for convenience.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.fx-rates.json');
const API_URL = 'https://open.er-api.com/v6/latest/USD';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// iDempiere c_currency_id → ISO code mapping (common currencies)
const CURRENCY_ID_TO_ISO = {
  100: 'USD',
  102: 'EUR',
  114: 'GBP',
  116: 'JPY',
  120: 'CAD',
  121: 'AUD',
  148: 'CNY',
  154: 'HKD',
  238: 'SGD',
  258: 'KRW',
  287: 'INR',
  293: 'MYR',
  304: 'THB',
  307: 'TWD',
  311: 'PHP',
  318: 'ILS',
  322: 'MXN',
  332: 'BRL',
  343: 'SEK',
  347: 'CHF',
};

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { return null; }
}

function writeCache(data) {
  try {
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.error('WARN: failed to write FX cache:', err.message);
  }
}

function isCacheValid(cache) {
  if (!cache || !cache.fetchedAt || !cache.rates) return false;
  return (Date.now() - new Date(cache.fetchedAt).getTime()) < TTL_MS;
}

function fetchFromAPI() {
  return new Promise((resolve, reject) => {
    https.get(API_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.result !== 'success') {
            reject(new Error(`FX API error: ${json.result}`));
            return;
          }
          resolve(json.rates);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * Ensure we have fresh rates. Returns the rates object.
 * Auto-fetches if cache is stale or missing.
 */
async function ensureRates() {
  const cache = readCache();
  if (isCacheValid(cache)) return cache.rates;

  try {
    const rates = await fetchFromAPI();
    writeCache({ fetchedAt: new Date().toISOString(), base: 'USD', rates });
    return rates;
  } catch (err) {
    // If fetch fails but we have stale cache, use it
    if (cache && cache.rates) {
      console.error(`WARN: FX refresh failed (${err.message}), using stale cache from ${cache.fetchedAt}`);
      return cache.rates;
    }
    throw new Error(`FX rates unavailable: ${err.message}`);
  }
}

/**
 * Get the rate for converting FROM a foreign currency TO USD.
 * Returns the multiplier: foreignAmount * result = USD amount.
 *
 * Example: getRate('GBP') returns ~1.34 (1 GBP = 1.34 USD)
 */
async function getRate(isoCode) {
  if (isoCode === 'USD') return 1;
  const rates = await ensureRates();
  const rate = rates[isoCode];
  if (!rate) throw new Error(`Unknown currency: ${isoCode}`);
  // API gives "1 USD = X foreign", so to go foreign→USD we invert
  return 1 / rate;
}

/**
 * Convert an amount from a foreign currency to USD.
 */
async function convertToUSD(amount, isoCode) {
  const rate = await getRate(isoCode);
  return amount * rate;
}

/**
 * Convert using iDempiere currency ID instead of ISO code.
 */
async function convertToUSDById(amount, currencyId) {
  if (currencyId === 100 || !currencyId) return amount; // already USD
  const iso = CURRENCY_ID_TO_ISO[currencyId];
  if (!iso) throw new Error(`Unknown iDempiere currency ID: ${currencyId}`);
  return convertToUSD(amount, iso);
}

/**
 * Get the ISO code for an iDempiere currency ID.
 */
function currencyIdToISO(currencyId) {
  return CURRENCY_ID_TO_ISO[currencyId] || null;
}

/**
 * Force refresh rates from the API.
 */
async function refreshRates() {
  const rates = await fetchFromAPI();
  writeCache({ fetchedAt: new Date().toISOString(), base: 'USD', rates });
  return rates;
}

module.exports = {
  getRate, convertToUSD, convertToUSDById, refreshRates, ensureRates,
  currencyIdToISO, CURRENCY_ID_TO_ISO, CACHE_FILE,
};
