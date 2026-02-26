/**
 * TrustedParts search functionality
 * Searches for parts and extracts franchise distributor availability/pricing
 */

const config = require('./config');

/**
 * Search for a part on TrustedParts
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} partNumber - Part number to search
 * @returns {Promise<Object>} Search results
 */
async function searchPart(page, partNumber, debug = false) {
  const result = {
    partNumber,
    found: false,
    totalQty: 0,
    lowestPrice: null,
    distributorCount: 0,
    distributors: [],
    error: null,
  };

  try {
    // Navigate to search URL based on data source
    let searchUrl;
    if (config.DATA_SOURCE === 'findchips') {
      searchUrl = `${config.FINDCHIPS_SEARCH_URL}/${encodeURIComponent(partNumber)}`;
    } else {
      searchUrl = `${config.TRUSTEDPARTS_SEARCH_URL}/${encodeURIComponent(partNumber)}`;
    }
    if (debug) console.log(`    [DEBUG] Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { timeout: config.PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });

    // Wait for content to render
    await page.waitForTimeout(2000);
    if (debug) console.log(`    [DEBUG] Page loaded, URL: ${page.url()}`);

    // Debug: save screenshot and HTML
    if (debug) {
      const fs = require('fs');
      const path = require('path');
      const debugDir = path.join(config.OUTPUT_DIR, 'debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

      await page.screenshot({ path: path.join(debugDir, `${partNumber}_screenshot.png`), fullPage: true });
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, `${partNumber}_page.html`), html);
      console.log(`    [DEBUG] Saved screenshot and HTML to ${debugDir}`);
    }

    // FindChips uses tr.row elements with data attributes
    // Look for rows that have data-instock attribute - check this FIRST
    const distributorRows = await page.$$('tr.row[data-instock]');


    // If no data rows found, check for "no results" messaging
    if (distributorRows.length === 0) {
      const pageText = await page.innerText('body');
      if (pageText.includes('No results found') ||
          pageText.includes('No results were found') ||
          pageText.includes('Similar Parts')) {
        if (debug) console.log(`    [DEBUG] No exact results found`);
      }
      return result;
    }

    if (debug) {
      console.log(`    [DEBUG] Found ${distributorRows.length} potential rows`);
    }

    // Parse using data attributes (much more reliable than text parsing)
    for (const row of distributorRows) {
      try {
        const instock = await row.getAttribute('data-instock');
        const mfrPartNumber = await row.getAttribute('data-mfrpartnumber');
        const distName = await row.getAttribute('data-distributor_name');
        const priceData = await row.getAttribute('data-price');

        // Validate MPN matches (normalize: remove dashes, spaces, case-insensitive)
        const normalize = (s) => s.toLowerCase().replace(/[-\s]/g, '');
        const normalizedSearch = normalize(partNumber);
        const normalizedResult = normalize(mfrPartNumber || '');

        // Must be exact match after normalization, or result starts with search term
        // (to handle suffixes like -TR500, -TR750)
        if (normalizedResult !== normalizedSearch && !normalizedResult.startsWith(normalizedSearch)) {
          if (debug) console.log(`    [DEBUG] Skipping non-match: ${mfrPartNumber}`);
          continue;
        }

        const qty = parseInt(instock, 10) || 0;
        let price = null;

        // Parse price from JSON array: [[qty, "USD", "0.123"], ...]
        if (priceData) {
          try {
            const prices = JSON.parse(priceData);
            if (prices.length > 0) {
              // Get the first price tier
              price = parseFloat(prices[0][2]) || null;
            }
          } catch (e) {
            // Price parsing failed
          }
        }

        if (qty > 0) {
          result.distributors.push({ name: distName || 'Unknown', qty, price });
          result.totalQty += qty;

          if (price && (result.lowestPrice === null || price < result.lowestPrice)) {
            result.lowestPrice = price;
          }
        }
      } catch (e) {
        // Row parsing failed
        if (debug) console.log(`    [DEBUG] Row parse error: ${e.message}`);
      }
    }

    result.distributorCount = result.distributors.length;
    result.found = result.distributorCount > 0;

    if (debug && result.found) {
      console.log(`    [DEBUG] Total qty: ${result.totalQty}, Lowest price: $${result.lowestPrice}`);
    }

  } catch (error) {
    result.error = error.message;
    if (debug) console.log(`    [DEBUG] Error: ${error.message}`);
  }

  return result;
}

/**
 * Parse a distributor row to extract data
 * @param {import('playwright').ElementHandle} row
 * @returns {Promise<Object|null>}
 */
async function parseDistributorRow(row) {
  try {
    // Get all text content from the row
    const text = await row.innerText();

    // Try to extract distributor name
    const nameEl = await row.$('.distributor-name, .dist-name, [data-distributor-name], td:first-child a, .company-name');
    const name = nameEl ? await nameEl.innerText() : extractDistributorName(text);

    // Try to extract quantity
    const qtyEl = await row.$('.quantity, .qty, .stock, [data-quantity], .inventory-qty');
    let qtyText = qtyEl ? await qtyEl.innerText() : '';
    if (!qtyText) {
      qtyText = extractQuantity(text);
    }
    const qty = parseQuantity(qtyText);

    // Try to extract price
    const priceEl = await row.$('.price, .unit-price, [data-price], .pricing');
    let priceText = priceEl ? await priceEl.innerText() : '';
    if (!priceText) {
      priceText = extractPrice(text);
    }
    const price = parsePrice(priceText);

    if (qty > 0) {
      return { name: name.trim(), qty, price };
    }
  } catch (e) {
    // Row parsing failed
  }
  return null;
}

/**
 * Extract distributor name from text blob
 */
function extractDistributorName(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  return lines[0] || 'Unknown';
}

/**
 * Extract quantity from text using regex
 */
function extractQuantity(text) {
  // Look for patterns like "1,234" or "5K" or "In Stock: 500"
  const patterns = [
    /stock[:\s]+(\d[\d,]*)/i,
    /qty[:\s]+(\d[\d,]*)/i,
    /available[:\s]+(\d[\d,]*)/i,
    /(\d[\d,]*)\s*(?:pcs?|pieces?|units?|available|in stock)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  // Fall back to first number found
  const numMatch = text.match(/\b(\d{1,3}(?:,\d{3})*)\b/);
  return numMatch ? numMatch[1] : '0';
}

/**
 * Extract price from text using regex
 */
function extractPrice(text) {
  // Look for price patterns like "$1.23" or "USD 0.95"
  const patterns = [
    /\$\s*(\d+\.?\d*)/,
    /USD\s*(\d+\.?\d*)/i,
    /(\d+\.\d{2,4})\s*(?:USD|\$|per|each|ea)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

/**
 * Parse quantity string to number
 */
function parseQuantity(qtyStr) {
  if (!qtyStr) return 0;

  const cleaned = qtyStr.toString().replace(/,/g, '').trim().toUpperCase();

  // Handle K/M suffixes
  if (cleaned.endsWith('K')) {
    return Math.floor(parseFloat(cleaned.slice(0, -1)) * 1000);
  }
  if (cleaned.endsWith('M')) {
    return Math.floor(parseFloat(cleaned.slice(0, -1)) * 1000000);
  }

  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;

  const cleaned = priceStr.toString().replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

module.exports = {
  searchPart,
  parseQuantity,
  parsePrice,
};
