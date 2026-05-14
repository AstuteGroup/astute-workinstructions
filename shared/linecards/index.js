/**
 * Linecard Fetcher Registry
 *
 * Central index of per-disty linecard fetchers. Each fetcher exports a
 * `fetchLinecard()` async function returning Array<{id, name}>.
 *
 * Current coverage:
 *   - digikey  — /products/v4/search/manufacturers (~3,713 MFRs, API)
 *   - mouser   — /api/v2/search/manufacturerlist   (~850 MFRs, API)
 *   - tti      — /service/api/v1/search/manufacturers (~181 MFRs, API, IP&E-heavy)
 *   - rutronik — /api/linecard (~194 MFRs, UNDOCUMENTED API — watch for breakage)
 *   - heilind  — /sitemaps/sitemap-manufacturers.xml (~145 MFRs, public sitemap;
 *     estore + product pages are Imperva-gated and only the sitemap escapes,
 *     so this is line-card-only — pricing/stock still routes through the
 *     Claude Chrome extension in an authenticated browser tab)
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
  heilind:  require('./heilind'),
};
