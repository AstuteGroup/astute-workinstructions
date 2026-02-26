/**
 * Configuration for TrustedParts Screening
 */

module.exports = {
  // Data source: 'trustedparts' or 'findchips'
  DATA_SOURCE: 'findchips',

  // TrustedParts URLs
  TRUSTEDPARTS_BASE_URL: 'https://www.trustedparts.com',
  TRUSTEDPARTS_SEARCH_URL: 'https://www.trustedparts.com/en/search',

  // FindChips URLs
  FINDCHIPS_BASE_URL: 'https://www.findchips.com',
  FINDCHIPS_SEARCH_URL: 'https://www.findchips.com/search',

  // Opportunity value threshold - skip broker RFQ if below this AND franchise has stock
  OPPORTUNITY_THRESHOLD: 50.00,

  // Timing (milliseconds)
  SEARCH_DELAY: 1500,        // Delay between searches
  PAGE_TIMEOUT: 30000,       // Page load timeout

  // Output
  OUTPUT_DIR: __dirname,
};
