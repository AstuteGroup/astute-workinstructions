/**
 * Heilind Linecard Fetcher
 *
 * Endpoint: GET https://www.heilind.com/sitemaps/sitemap-manufacturers.xml
 * Auth:     none — public sitemap, served past the Incapsula WAF that
 *           guards the rest of www.heilind.com (so plain curl works here
 *           even though estore + product pages tarpit headless Chromium).
 * Response: ~14KB XML — <url><loc>https://www.heilind.com/cms/manufacturers/{slug}/</loc></url>
 *           ~145 unique slugs as of 2026-05-12 (IP&E-focused: TE family,
 *           Amphenol family, Molex, JST, Hirose, Wago, Phoenix Contact
 *           alts, sensors, switches, fans).
 *
 * Background: Heilind has no public REST API and the estore is Imperva-
 *             protected (see project_heilind_edi memory). The sitemap is
 *             the only public endpoint that doesn't tarpit. We use the
 *             linecard for franchise-gating Heilind jobs that the Claude
 *             Chrome extension actions in an authenticated browser tab —
 *             pre-filtering by line card avoids submitting MPNs whose MFR
 *             Heilind doesn't carry.
 *
 * Slug → display name: title-case the kebab slug, but uppercase common
 *             acronyms (TE, ITT, ITW, NKK, JAE, JST, APEM, EDAC, RAF, AZ)
 *             and preserve "3M". Canonical resolution to chuboe_mfr is
 *             done downstream via shared/mfr-equivalence — we only need
 *             stable, recognizable display strings here.
 *
 * Exports: fetchLinecard() → Promise<Array<{ id: string, name: string }>>
 *          where `id` is the slug (also the URL path component for
 *          product detail pages, useful for future PDP scraping).
 */

const https = require('https');

const ACRONYMS = new Set([
  'TE', 'ITT', 'ITW', 'NKK', 'JAE', 'JST', 'APEM', 'EDAC', 'RAF', 'AZ',
  'PCD', 'LTW', 'TPI', 'SV', 'RF', 'BEI', 'AB', 'LED',
]);

function slugToName(slug) {
  // Preserve "3M" pattern: digit-prefixed tokens with no separators
  if (/^\d/.test(slug)) {
    return slug.toUpperCase();
  }
  return slug
    .split('-')
    .map(part => {
      const upper = part.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ')
    // Repair hyphenated brand spellings the split lost
    .replace(/\bL Com\b/, 'L-com')
    .replace(/\bJ Tech\b/, 'J-Tech')
    .replace(/\bE Switch\b/, 'E-Switch')
    .replace(/\bWi2wi\b/i, 'Wi2Wi');
}

async function fetchLinecard() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.heilind.com',
      path: '/sitemaps/sitemap-manufacturers.xml',
      method: 'GET',
      headers: {
        'Accept': 'application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; AstuteLinecardFetcher/1.0)',
      },
      agent: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('Heilind sitemap rate-limited (429)'));
        if (res.statusCode !== 200) {
          return reject(new Error(`Heilind sitemap HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const slugs = new Set();
          const re = /<loc>https:\/\/www\.heilind\.com\/cms\/manufacturers\/([^<\/]+)\/?<\/loc>/g;
          let m;
          while ((m = re.exec(data)) !== null) {
            // Defensive scrub: occasional stray '<' / trailing slash inside
            // the captured slug (seen once in the 2026-05-12 sample —
            // "amphenol-all-sensors<").
            const slug = m[1].replace(/[<>\s/]+$/g, '').trim();
            if (slug) slugs.add(slug);
          }
          if (slugs.size === 0) {
            return reject(new Error('Heilind sitemap empty — shape may have changed'));
          }
          const list = [...slugs]
            .sort()
            .map(slug => ({ id: slug, name: slugToName(slug) }));
          resolve(list);
        } catch (e) {
          reject(new Error(`Heilind linecard parse: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Heilind linecard timeout')); });
    req.end();
  });
}

module.exports = { fetchLinecard, disty: 'heilind', distyName: 'Heilind' };
