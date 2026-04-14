/**
 * RFQ Region Classifier + Tier Assignment — DEPRECATED
 *
 * Replaced by `rfq-priority.js` (J8 refactor, 2026-04-14).
 *
 * The old tier model assumed "US is sleeping, prioritize regions that are in
 * their workday." That premise doesn't hold for Astute's 24/7 footprint
 * (Mexico + Texas core commercial + China + India + Singapore + South Korea).
 * Region-based tiering is no longer a useful urgency signal.
 *
 * The new model in rfq-priority.js uses demand signals:
 *   P1 Express — any RFQ < 100 MPNs (any type)
 *   P2 Main    — non-PPV ≥ 100 MPNs (Shortage, EOL, 3PL/VMI, Hot Parts, Stock)
 *   P3 Backlog — PPV ≥ 100 MPNs, Proactive Offer, etc.
 *
 * This file is retained only for historical reference. Do not import.
 * Old tier numbering (T1-T4) → new priority codes (P1-P3).
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
