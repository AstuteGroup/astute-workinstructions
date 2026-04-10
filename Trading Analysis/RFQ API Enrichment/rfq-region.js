/**
 * RFQ Region Classifier + Tier Assignment
 *
 * Pure functions — no DB, no side effects.
 * Used by enrich-poller.js to prioritize API enrichment.
 *
 * Tier 1: Non-PPV (Shortage, EOL/LTB, Stock, etc.) — all regions
 * Tier 2: PPV + APAC/EMEA contact
 * Tier 3: PPV + MX contact
 * Tier 4: PPV + US/CA contact (or unknown)
 */

const REGION = { APAC: 'APAC', EMEA: 'EMEA', MX: 'MX', US_CA: 'US_CA', UNKNOWN: 'UNKNOWN' };

// DB stores "Viet Nam", "Korea Republic of", etc.
const APAC_COUNTRIES = new Set([
  'China', 'India', 'Japan', 'Korea Republic of', 'Taiwan', 'Thailand',
  'Malaysia', 'Philippines', 'Viet Nam', 'Singapore', 'Indonesia',
  'Australia', 'Hong Kong', 'Myanmar', 'Myanmar (Burma)',
  'New Zealand', 'Bangladesh', 'Sri Lanka', 'Cambodia',
]);

const MX_COUNTRIES = new Set(['Mexico']);
const US_CA_COUNTRIES = new Set(['United States', 'Canada']);

function classifyRegion(countryName) {
  if (!countryName) return REGION.UNKNOWN;
  if (APAC_COUNTRIES.has(countryName)) return REGION.APAC;
  if (MX_COUNTRIES.has(countryName)) return REGION.MX;
  if (US_CA_COUNTRIES.has(countryName)) return REGION.US_CA;
  return REGION.EMEA; // Europe, LATAM (except MX), Middle East, Africa, etc.
}

function assignTier(rfqType, region) {
  if (rfqType !== 'PPV') return 1;
  if (region === REGION.APAC || region === REGION.EMEA) return 2;
  if (region === REGION.MX) return 3;
  return 4; // US_CA + UNKNOWN
}

module.exports = { REGION, classifyRegion, assignTier };
