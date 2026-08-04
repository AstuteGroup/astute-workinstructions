/**
 * currency-rate-writer.js
 *
 * Writes currency conversion rates to iDempiere C_Conversion_Rate table.
 *
 * Usage:
 *   const { writeCurrencyRates } = require('./currency-rate-writer');
 *   const result = await writeCurrencyRates({
 *     rates: [
 *       { from: 'EUR', to: 'USD', rate: 1.1403 },
 *       { from: 'SGD', to: 'USD', rate: 0.7715 },
 *       // ... 21 total pairs
 *     ],
 *     validFrom: '2026-08-04',
 *     validTo: '2026-09-03',
 *   });
 */

'use strict';

const { apiPost } = require('./api-client');

// Currency ISO code to iDempiere c_currency_id mapping
const CURRENCY_IDS = {
  CAD: 116,
  EUR: 102,
  GBP: 114,
  INR: 304,
  JPY: 113,
  SGD: 307,
  USD: 100,
};

// Conversion type: Spot
const CONVERSION_TYPE_ID = 114;

// Client and Org (0 = all orgs)
const AD_CLIENT_ID = 1000000;
const AD_ORG_ID = 0;

/**
 * Write a batch of currency conversion rates to OT.
 *
 * @param {Object} opts
 * @param {Array<{from: string, to: string, rate: number}>} opts.rates - Currency pairs with rates
 * @param {string} opts.validFrom - Start date (YYYY-MM-DD)
 * @param {string} opts.validTo - End date (YYYY-MM-DD)
 * @param {boolean} [opts.dryRun=false] - If true, validate but don't write
 * @returns {Promise<{success: boolean, created: number, errors: Array, results: Array}>}
 */
async function writeCurrencyRates(opts) {
  const { rates, validFrom, validTo, dryRun = false } = opts;

  if (!Array.isArray(rates) || rates.length === 0) {
    throw new Error('rates array is required');
  }
  if (!validFrom || !validTo) {
    throw new Error('validFrom and validTo dates are required');
  }

  // Validate all currency codes
  for (const r of rates) {
    if (!CURRENCY_IDS[r.from]) {
      throw new Error(`Unknown currency code: ${r.from}`);
    }
    if (!CURRENCY_IDS[r.to]) {
      throw new Error(`Unknown currency code: ${r.to}`);
    }
    if (typeof r.rate !== 'number' || r.rate <= 0) {
      throw new Error(`Invalid rate for ${r.from}→${r.to}: ${r.rate}`);
    }
  }

  const results = [];
  const errors = [];
  let created = 0;

  for (const r of rates) {
    const payload = {
      'AD_Client_ID': AD_CLIENT_ID,
      'AD_Org_ID': AD_ORG_ID,
      'C_Currency_ID': CURRENCY_IDS[r.from],
      'C_Currency_ID_To': CURRENCY_IDS[r.to],
      'C_ConversionType_ID': CONVERSION_TYPE_ID,
      'ValidFrom': validFrom,
      'ValidTo': validTo,
      'MultiplyRate': r.rate,
      'DivideRate': 1 / r.rate,
      'IsActive': true,
    };

    if (dryRun) {
      results.push({
        from: r.from,
        to: r.to,
        rate: r.rate,
        payload,
        dryRun: true,
      });
      continue;
    }

    try {
      const response = await apiPost('c_conversion_rate', payload);
      results.push({
        from: r.from,
        to: r.to,
        rate: r.rate,
        id: response.id,
        success: true,
      });
      created++;
    } catch (err) {
      // Check if it's a duplicate (already exists for this date range)
      if (err.message && err.message.includes('duplicate')) {
        results.push({
          from: r.from,
          to: r.to,
          rate: r.rate,
          skipped: true,
          reason: 'duplicate',
        });
      } else {
        errors.push({
          from: r.from,
          to: r.to,
          rate: r.rate,
          error: err.message,
        });
      }
    }
  }

  return {
    success: errors.length === 0,
    created,
    skipped: results.filter(r => r.skipped).length,
    errors,
    results,
    validFrom,
    validTo,
  };
}

module.exports = {
  writeCurrencyRates,
  CURRENCY_IDS,
  CONVERSION_TYPE_ID,
};
