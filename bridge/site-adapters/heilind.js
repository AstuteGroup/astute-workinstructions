/**
 * Heilind Site Adapter
 *
 * Drives the Claude Bridge to look up parts on www.heilind.com (authenticated).
 * Returns structured pricing/stock/lead data shaped for vq-writer.
 *
 * Requires:
 *   - Bridge server running (node bridge/cli.js server)
 *   - SSH tunnel forwarding port 7681
 *   - Chrome with v3 extension installed (debugger permission)
 *   - User logged in to heilind.com (use loginIfNeeded() for unattended runs)
 *
 * USAGE:
 *   const heilind = require('./bridge/site-adapters/heilind');
 *   const data = await heilind.lookupMpn('173113-0084');
 *   // → { mpn, heilindNumber, mfr, description, stock, factoryStock, leadDays, priceTiers }
 */

const cheerio = require('cheerio');
const {
  navigate, getPage, realClick, realType, realKey, sleep,
} = require('../lib/bridge-client');

/**
 * Look up a single MPN on Heilind. Drives the search box and parses the result.
 */
async function lookupMpn(mpn) {
  // Step 1: Navigate to homepage (search box lives there) and wait for load
  await navigate('https://www.heilind.com/');
  await sleep(3000);

  // Step 2: Click into the Coveo search box (atomic-search-box web component)
  await realClick('atomic-search-box');
  await sleep(500);

  // Step 3: Type the MPN — real CDP keystrokes pierce the shadow DOM
  await realType(mpn);
  await sleep(1500); // let search suggestions populate

  // Step 4: Press Enter — Heilind redirects to product page or search results
  await realKey('Enter');
  await sleep(6000); // wait for navigation + page render (Heilind is slow)

  // Step 5: Get the page; if on search-results, follow the first product link
  let page = await getPage();
  const url = page?.url || '';

  if (url.includes('/search-results') || url.includes('/cms/search')) {
    // Extract first product URL from raw HTML (Coveo renders via shadow DOM
    // but URLs are in the page source as Open Graph / link previews)
    const html = page.html || '';
    const productUrls = [...new Set(html.match(/\/(mol|tyc|amph|jst|hir|phx|moh|wur|won|del|cui|kse|mil|gca|nkk)[a-z0-9-]+\.html/gi) || [])];
    if (productUrls.length > 0) {
      await navigate(`https://www.heilind.com${productUrls[0]}`);
      await sleep(3000);
      page = await getPage();
    }
  }

  return parseProductPage(page, mpn);
}

/**
 * Parse a Heilind product detail page into structured data.
 * Falls back gracefully if page is a search-results page (no match) or 404.
 */
function parseProductPage(page, queriedMpn) {
  const url = page?.url || '';
  const title = page?.title || '';
  const html = page?.html || '';
  const text = page?.text || '';

  const result = {
    mpn: queriedMpn,
    sourceUrl: url,
    found: false,
    heilindNumber: null,
    mfr: null,
    description: null,
    stock: null,           // 'Call' | number | null
    factoryStock: null,    // number | null
    leadDays: null,        // number | null
    priceTiers: [],        // [{qty, unitPrice}]
    rawTitle: title,
  };

  // Search-results page or 404 means "not found in catalog"
  if (/search results|404/i.test(title) || /Nothing Found/i.test(text)) {
    return result;
  }

  result.found = true;

  // Pull labeled fields by scanning lines
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = (lines[i + 1] || '').trim();

    if (/^Heilind Number:/i.test(line)) result.heilindNumber = stripLabel(line, next);
    else if (/^Manufacturer:/i.test(line)) result.mfr = stripLabel(line, next);
    else if (/^Manufacturer Number:/i.test(line)) result.mpn = stripLabel(line, next);
    else if (/^Description:/i.test(line) && i + 1 < lines.length) result.description = next;
    else if (/^In Stock:/i.test(line)) result.stock = parseStockValue(stripLabel(line, next));
    else if (/^Factory Stock:/i.test(line)) result.factoryStock = parseInt((stripLabel(line, next) || '').replace(/[,]/g, ''), 10) || null;
    else if (/^Factory Lead:/i.test(line)) result.leadDays = parseInt((stripLabel(line, next) || '').match(/(\d+)/)?.[1], 10) || null;
  }

  // Price tiers — look for "Quantity\tUnit Price\tExt. Price" then parse rows
  const tierStart = lines.findIndex(l => /Quantity\s+Unit Price\s+Ext\.?\s*Price/i.test(l));
  if (tierStart >= 0) {
    for (let i = tierStart + 1; i < lines.length && i < tierStart + 20; i++) {
      const m = lines[i].match(/^([\d,]+)\s+\$\s*([\d.]+)\s*[A-Z]?\s+\$\s*([\d,.]+)/);
      if (m) {
        result.priceTiers.push({
          qty: parseInt(m[1].replace(/,/g, ''), 10),
          unitPrice: parseFloat(m[2]),
          extPrice: parseFloat(m[3].replace(/,/g, '')),
        });
      } else if (lines[i].length > 80) {
        // Hit a long line — probably out of the table; stop
        break;
      }
    }
  }

  return result;
}

function stripLabel(labelLine, nextLine) {
  // "In Stock:\tCall" pattern OR "In Stock:" on one line, "Call" on the next
  const inline = labelLine.replace(/^[^:]+:\s*/, '').trim();
  return inline || nextLine || null;
}

function parseStockValue(s) {
  if (!s) return null;
  if (/call/i.test(s)) return 'Call';
  const n = parseInt(s.replace(/[,]/g, ''), 10);
  return isNaN(n) ? s : n;
}

/**
 * Shape an adapter result into the franchiseResults format that vq-writer expects.
 * vq-writer wants an array of {qty, price, packaging, leadTime, stock, ...} per pricing row.
 */
function toFranchiseResults(adapterResult) {
  if (!adapterResult.found || adapterResult.priceTiers.length === 0) return [];

  return adapterResult.priceTiers.map(tier => ({
    distributor: 'Heilind',
    distributorPartNumber: adapterResult.heilindNumber,
    mpn: adapterResult.mpn,
    mfr: adapterResult.mfr,
    qty: tier.qty,
    price: tier.unitPrice,
    currency: 'USD',
    packaging: null, // Heilind PDP doesn't surface packaging consistently — flag for review
    stock: typeof adapterResult.stock === 'number' ? adapterResult.stock : 0,
    leadTimeDays: adapterResult.leadDays,
    sourceUrl: adapterResult.sourceUrl,
    fetchedAt: new Date().toISOString(),
  }));
}

module.exports = {
  lookupMpn,
  parseProductPage,
  toFranchiseResults,
};
