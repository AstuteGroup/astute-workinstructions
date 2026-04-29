/**
 * Linecard Fetcher Registry
 *
 * Central index of per-disty linecard fetchers. Each fetcher exports a
 * `fetchLinecard()` async function returning Array<{id, name}>.
 *
 * Current coverage (all API-based, no scraping):
 *   - digikey  — /products/v4/search/manufacturers (~3,713 MFRs)
 *   - mouser   — /api/v2/search/manufacturerlist   (~850 MFRs)
 *   - tti      — /service/api/v1/search/manufacturers (~181 MFRs, IP&E-heavy)
 *   - rutronik — /api/linecard (UNDOCUMENTED — watch for breakage, ~194 MFRs)
 *
 * Not covered (no discoverable API manufacturer endpoint as of 2026-04-21):
 *   - arrow, future, newark, waldom, sager — each has a clean, exhaustive
 *     public API doc showing only transactional endpoints. Speculative
 *     probing confirmed no hidden linecard endpoints. These remain as
 *     probe-sampler + 180d TTL only.
 *   - master — N/A (independent, not franchise-based)
 */

module.exports = {
  digikey:  require('./digikey'),
  mouser:   require('./mouser'),
  tti:      require('./tti'),
  rutronik: require('./rutronik'),
};
