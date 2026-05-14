/**
 * Page Scraper Workflow
 *
 * Processes page_content messages from the Chrome extension.
 * Extracts structured data (tables, lists, forms) and optionally loads to OT.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/**
 * Parse HTML and extract structured data
 */
function extractData(html, options = {}) {
  const $ = cheerio.load(html);
  const result = {
    tables: [],
    lists: [],
    forms: [],
    links: [],
    text: ''
  };

  // Extract tables
  $('table').each((i, table) => {
    const rows = [];
    $(table).find('tr').each((j, tr) => {
      const cells = [];
      $(tr).find('th, td').each((k, cell) => {
        cells.push($(cell).text().trim());
      });
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length > 0) {
      result.tables.push({
        index: i,
        headers: rows[0],
        rows: rows.slice(1),
        rowCount: rows.length - 1
      });
    }
  });

  // Extract lists
  $('ul, ol').each((i, list) => {
    const items = [];
    $(list).find('> li').each((j, li) => {
      items.push($(li).text().trim());
    });
    if (items.length > 0) {
      result.lists.push({ index: i, items });
    }
  });

  // Extract forms
  $('form').each((i, form) => {
    const fields = [];
    $(form).find('input, select, textarea').each((j, field) => {
      fields.push({
        type: $(field).attr('type') || field.tagName.toLowerCase(),
        name: $(field).attr('name'),
        id: $(field).attr('id'),
        value: $(field).val()
      });
    });
    result.forms.push({
      index: i,
      action: $(form).attr('action'),
      method: $(form).attr('method'),
      fields
    });
  });

  // Extract links
  $('a[href]').each((i, a) => {
    const href = $(a).attr('href');
    const text = $(a).text().trim();
    if (href && text) {
      result.links.push({ href, text });
    }
  });

  // Clean text content
  result.text = $('body').text().replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Process a page_content message
 */
async function processPageContent(msg, options = {}) {
  const { payload } = msg;
  const { url, html, title } = payload;

  console.log(`[scraper] Processing: ${title || url}`);

  const extracted = extractData(html);

  // Save raw extraction
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = (title || 'page').replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  const filename = `${timestamp}-${safeName}.json`;

  const output = {
    url,
    title,
    timestamp: payload.timestamp,
    extracted,
    summary: {
      tables: extracted.tables.length,
      lists: extracted.lists.length,
      forms: extracted.forms.length,
      links: extracted.links.length,
      textLength: extracted.text.length
    }
  };

  fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(output, null, 2));
  console.log(`[scraper] Saved: ${filename}`);

  return output;
}

/**
 * Extract specific selector from HTML
 */
function extractSelector(html, selector) {
  const $ = cheerio.load(html);
  const elements = $(selector);

  if (elements.length === 0) {
    return { found: false, selector };
  }

  const results = [];
  elements.each((i, el) => {
    results.push({
      html: $(el).html(),
      text: $(el).text().trim(),
      attributes: el.attribs
    });
  });

  return {
    found: true,
    selector,
    count: results.length,
    results
  };
}

module.exports = {
  extractData,
  processPageContent,
  extractSelector
};
