const { execSync } = require('child_process');
const logger = require('../utils/logger');
const { COLUMN_ALIASES } = require('../../config/columns');

// Known quote portal domains and patterns
const QUOTE_URL_PATTERNS = [
  /https?:\/\/[^\s<>"]+\/(?:quote|offer|rfq|quotation)[^\s<>"]*/gi,
  /https?:\/\/(?:www\.)?greenchips\.com\/[^\s<>"]+\/offer\/[^\s<>"]*/gi,
  /https?:\/\/[^\s<>"]+\/view[_-]?quote[^\s<>"]*/gi,
  /https?:\/\/[^\s<>"]+\?[^\s<>"]*(?:quote|rfq|ref)[^\s<>"]*/gi,
];

// URLs to exclude
const EXCLUDE_PATTERNS = [
  /linkedin\.com/i,
  /youtube\.com/i,
  /facebook\.com/i,
  /twitter\.com/i,
  /unsubscribe/i,
  /mailto:/i,
  /tel:/i,
  /\.(?:png|jpg|jpeg|gif|svg)$/i,
  /privacy/i,
  /terms/i,
  /logo/i,
];

/**
 * Extract quote-related URLs from email body
 */
function extractQuoteLinks(emailBody) {
  const urls = new Set();
  const allUrlPattern = /https?:\/\/[^\s<>"'\)]+/gi;
  const allMatches = emailBody.match(allUrlPattern) || [];

  for (const url of allMatches) {
    let cleanUrl = url.replace(/[.,;:\)]+$/, '');
    if (EXCLUDE_PATTERNS.some(pattern => pattern.test(cleanUrl))) continue;

    for (const pattern of QUOTE_URL_PATTERNS) {
      if (pattern.test(cleanUrl)) {
        urls.add(cleanUrl);
        break;
      }
    }
  }

  // Context-based link extraction
  const contextPatterns = [
    /view\s+(?:your\s+)?quote[:\s]+<?([^\s<>"]+)/gi,
    /click\s+here\s+to\s+view[:\s]+<?([^\s<>"]+)/gi,
    /quote\s+(?:is\s+)?available\s+(?:at|here)[:\s]+<?([^\s<>"]+)/gi,
  ];

  for (const pattern of contextPatterns) {
    let match;
    while ((match = pattern.exec(emailBody)) !== null) {
      const url = match[1];
      if (url.startsWith('http') && !EXCLUDE_PATTERNS.some(p => p.test(url))) {
        urls.add(url.replace(/[.,;:\)>]+$/, ''));
      }
    }
  }

  logger.debug(`Found ${urls.size} potential quote URL(s)`);
  return Array.from(urls);
}

/**
 * Fetch and parse content from a quote URL
 * Always uses Playwright for reliable JS rendering
 */
async function fetchAndParseQuoteUrl(url) {
  try {
    logger.info(`Fetching quote URL: ${url}`);

    // Use Playwright for reliable extraction
    const result = await fetchWithPlaywright(url);

    return {
      lines: result.lines,
      confidence: result.confidence,
      strategy: 'url-' + result.strategy,
      sourceUrl: url
    };

  } catch (err) {
    logger.error(`Failed to fetch URL ${url}: ${err.message}`);
    return { lines: [], confidence: 0, strategy: 'url-failed' };
  }
}

/**
 * Fetch URL with Playwright and extract structured quote data
 */
async function fetchWithPlaywright(url) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000); // Wait for dynamic content

    // Try structured extraction first
    const structuredData = await extractStructuredData(page);
    if (structuredData.confidence > 0.5) {
      await browser.close();
      return structuredData;
    }

    // Fallback to text extraction
    const textData = await extractFromPageText(page);
    await browser.close();
    return textData;

  } catch (err) {
    logger.error(`Playwright fetch failed: ${err.message}`);
    if (browser) await browser.close();
    return { lines: [], confidence: 0, strategy: 'playwright-failed' };
  }
}

/**
 * Extract structured data using page selectors
 */
async function extractStructuredData(page) {
  const line = {};
  let matchCount = 0;

  // Common label/value patterns on quote pages
  const selectors = {
    'chuboe_mpn': [
      '[data-testid*="part"], [data-testid*="mpn"]',
      '.part-number, .mpn, .product-code',
      'td:has-text("Part") + td, th:has-text("Part") ~ td',
      '[class*="part"], [class*="mpn"], [class*="sku"]',
    ],
    'chuboe_mfr_text': [
      '[data-testid*="manufacturer"], [data-testid*="brand"]',
      '.manufacturer, .brand, .mfr',
      'td:has-text("Manufacturer") + td, td:has-text("Brand") + td',
    ],
    'qty': [
      '[data-testid*="quantity"], [data-testid*="stock"]',
      '.quantity, .stock, .available',
      'td:has-text("Quantity") + td, td:has-text("Stock") + td, td:has-text("Available") + td',
    ],
    'cost': [
      '[data-testid*="price"]',
      '.price, .unit-price, .cost',
      'td:has-text("Price") + td, td:has-text("Unit") + td',
    ],
    'chuboe_date_code': [
      '[data-testid*="datecode"], [data-testid*="dc"]',
      '.date-code, .datecode, .dc',
      'td:has-text("Date Code") + td, td:has-text("DC") + td',
    ],
    'c_country_id': [
      '[data-testid*="origin"], [data-testid*="coo"]',
      '.origin, .coo, .country',
      'td:has-text("Origin") + td, td:has-text("COO") + td',
    ],
    'chuboe_lead_time': [
      '[data-testid*="leadtime"], [data-testid*="delivery"]',
      '.lead-time, .leadtime, .delivery, .shipping',
      'td:has-text("Lead") + td, td:has-text("Ship") + td',
    ],
  };

  for (const [field, selectorList] of Object.entries(selectors)) {
    for (const selector of selectorList) {
      try {
        const element = await page.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim().length > 0 && text.trim().length < 100) {
            line[field] = cleanExtractedValue(field, text.trim());
            matchCount++;
            logger.debug(`Extracted ${field}: ${line[field]}`);
            break;
          }
        }
      } catch {
        // Selector not found, try next
      }
    }
  }

  if (matchCount >= 2) {
    return {
      lines: [line],
      confidence: Math.min(0.9, 0.5 + (matchCount * 0.1)),
      strategy: 'playwright-structured'
    };
  }

  return { lines: [], confidence: 0, strategy: 'playwright-structured-none' };
}

/**
 * Extract data from visible page text
 */
async function extractFromPageText(page) {
  try {
    // Scroll down to load any lazy content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Get all visible text
    const text = await page.evaluate(() => {
      return document.body.innerText;
    });

    // Also try to extract price/qty from specific table cells or elements
    const priceQtyData = await page.evaluate(() => {
      const data = {};

      // Look for price elements
      const priceElements = document.querySelectorAll('[class*="price"], [data-testid*="price"], td');
      for (const el of priceElements) {
        const text = el.textContent || '';
        const priceMatch = text.match(/[\$€£]\s*([0-9]+\.[0-9]{2})/);
        if (priceMatch) {
          data.price = priceMatch[1];
          break;
        }
      }

      // Look for quantity elements
      const qtyElements = document.querySelectorAll('[class*="qty"], [class*="stock"], [class*="quantity"], td');
      for (const el of qtyElements) {
        const text = el.textContent || '';
        const qtyMatch = text.match(/^([0-9,]+)$/);
        if (qtyMatch && parseInt(qtyMatch[1].replace(/,/g, '')) > 10) {
          data.qty = qtyMatch[1].replace(/,/g, '');
          break;
        }
      }

      return data;
    });

    if (!text || text.length < 50) {
      return { lines: [], confidence: 0, strategy: 'playwright-text-empty' };
    }

    logger.debug(`Page text length: ${text.length}`);
    logger.debug(`Page text preview: ${text.substring(0, 500)}`);
    logger.debug(`Direct extraction: price=${priceQtyData.price}, qty=${priceQtyData.qty}`);

    const result = extractDataFromText(text);

    // Merge directly extracted values if text extraction didn't find them
    if (result.lines.length > 0) {
      if (!result.lines[0].cost && priceQtyData.price) {
        result.lines[0].cost = priceQtyData.price;
        logger.debug(`Added direct extracted price: ${priceQtyData.price}`);
      }
      if (!result.lines[0].qty && priceQtyData.qty) {
        result.lines[0].qty = priceQtyData.qty;
        logger.debug(`Added direct extracted qty: ${priceQtyData.qty}`);
      }
    }

    result.strategy = 'playwright-' + result.strategy;
    return result;

  } catch (err) {
    logger.error(`Text extraction failed: ${err.message}`);
    return { lines: [], confidence: 0, strategy: 'playwright-text-failed' };
  }
}

/**
 * Clean extracted value based on field type
 */
function cleanExtractedValue(field, value) {
  if (!value) return '';

  switch (field) {
    case 'cost':
      // Extract numeric value from price strings like "$1.50 USD"
      const priceMatch = value.match(/[\d,]+\.?\d*/);
      return priceMatch ? priceMatch[0].replace(/,/g, '') : value;

    case 'qty':
      const qtyMatch = value.match(/[\d,]+/);
      return qtyMatch ? qtyMatch[0].replace(/,/g, '') : value;

    case 'c_country_id':
      // Extract 2-letter country code or map common names
      const codeMatch = value.match(/\b([A-Z]{2})\b/);
      if (codeMatch) return codeMatch[1];
      // Common mappings
      const countryMap = {
        'china': 'CN', 'taiwan': 'TW', 'malaysia': 'MY', 'japan': 'JP',
        'usa': 'US', 'united states': 'US', 'netherlands': 'NL', 'germany': 'DE',
        'korea': 'KR', 'philippines': 'PH', 'thailand': 'TH', 'mexico': 'MX'
      };
      const lower = value.toLowerCase();
      for (const [name, code] of Object.entries(countryMap)) {
        if (lower.includes(name)) return code;
      }
      return value;

    case 'chuboe_mpn':
      // Clean MPN - remove extra whitespace, uppercase
      return value.replace(/\s+/g, '').toUpperCase();

    default:
      return value.trim();
  }
}

/**
 * Extract quote data from cleaned text
 */
function extractDataFromText(text) {
  const line = {};
  let matchCount = 0;

  // Patterns for extracting data from text
  const patterns = {
    'chuboe_mpn': [
      /(?:Part|Article|MPN|Part\s*(?:Number|#|No))[\s:]+([A-Z0-9][A-Z0-9\-\/\.]+)/i,
      /(?:^|\n)([A-Z0-9][A-Z0-9\-\/\.]{5,})\s+(?:Halo|Texas|Analog|Microchip|NXP|STM|Infineon|ON Semi|Vishay|Murata)/im,
    ],
    'chuboe_mfr_text': [
      /(?:Manufacturer|Brand|Mfr)[\s:]+([A-Za-z][A-Za-z\s\-\.]{2,30}?)(?:\s{2,}|\n|$)/i,
      /(Halo Electronics|Texas Instruments|Analog Devices|Microchip|NXP|STMicroelectronics|Infineon|ON Semiconductor|Vishay|Murata|Littelfuse)/i,
    ],
    'qty': [
      /(?:Quantity|Stock|Available|Qty)[\s:]+([0-9,]+)/i,
      /([0-9,]+)\s*(?:pcs|pieces|units|available|in stock)/i,
      /In-Stock[\s\n]+([0-9,]+)/i,
      /([0-9,]+)\s*(?:pcs|pc|units?)\s*(?:in stock|available)/i,
    ],
    'cost': [
      // Price patterns - must have currency symbol or "USD/EUR" nearby
      /[\$€£]\s*([0-9]+\.[0-9]{2,})/i,  // $1.50
      /(?:Price|Cost|Unit\s*Price)[\s:]+[\$€£]?\s*([0-9]+\.[0-9]{2,})/i,
      /([0-9]+\.[0-9]{2,})\s*(?:USD|EUR|GBP)/i,
      /Unit\s*Pr[ice]*[\s:]*[\$€£]?\s*([0-9]+\.[0-9]{2,})/i,
    ],
    'chuboe_date_code': [
      /(?:Date\s*Code|DC|Datecode)[\s:]+([0-9]{2,4}[\+\/]?[A-Z0-9]*)/i,
      /\b(\d{2}\+\/[A-Z]{2})\b/,  // e.g., "21+/CN"
    ],
    'c_country_id': [
      /(?:Country|Origin|COO|Made\s*in)[\s:]+([A-Z]{2})\b/i,
      /\/([A-Z]{2})(?:\s|$|\))/,  // e.g., "21+/CN"
    ],
    'chuboe_packaging_id': [
      /(?:Packaging|Package|Pkg)[\s:]+([A-Za-z\s\&]+?)(?:\s{2,}|\n|$)/i,
      /(Tape\s*&?\s*Reel|Tray|Tube|Cut\s*Tape|Bulk|Reel)/i,
    ],
    'chuboe_lead_time': [
      /(?:Lead\s*Time|Delivery|Shipping)[\s:]+([A-Za-z0-9\s\-]{3,25})/i,
      /(Ready\s+to\s+ship|Ships?\s+immediately|In\s+Stock|Stock|[0-9]+\s*(?:days?|weeks?|business\s+days?))/i,
      /(?:Ship|Delivery)[\s:]+([0-9]+\s*(?:days?|weeks?))/i,
    ],
  };

  for (const [field, fieldPatterns] of Object.entries(patterns)) {
    for (const pattern of fieldPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const value = cleanExtractedValue(field, match[1].trim());
        if (value && value.length > 0) {
          line[field] = value;
          matchCount++;
          logger.debug(`Text extracted ${field}: ${value}`);
          break;
        }
      }
    }
  }

  if (matchCount >= 2) {
    const confidence = Math.min(0.85, 0.4 + (matchCount * 0.1));
    return { lines: [line], confidence, strategy: 'text-extract' };
  }

  return { lines: [], confidence: 0, strategy: 'text-none' };
}

module.exports = { extractQuoteLinks, fetchAndParseQuoteUrl };
