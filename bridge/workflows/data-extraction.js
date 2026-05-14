/**
 * Data Extraction Workflow
 *
 * Process selected text, highlighted content, and arbitrary data from browser.
 * Parse common formats (tables, lists, key-value pairs) and structure for OT loading.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Parse text that looks like a table (tab or pipe separated)
 */
function parseTable(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  // Detect delimiter
  const firstLine = lines[0];
  let delimiter = '\t';
  if (firstLine.includes('|') && !firstLine.includes('\t')) {
    delimiter = '|';
  } else if (firstLine.includes(',') && !firstLine.includes('\t')) {
    delimiter = ',';
  }

  const rows = lines.map(line => {
    return line.split(delimiter).map(cell => cell.trim());
  });

  // Check if it looks like a table (consistent column count)
  const colCounts = rows.map(r => r.length);
  const mostCommon = colCounts.sort((a, b) =>
    colCounts.filter(v => v === a).length - colCounts.filter(v => v === b).length
  ).pop();

  if (mostCommon < 2) return null;

  const validRows = rows.filter(r => r.length === mostCommon);
  if (validRows.length < 2) return null;

  return {
    headers: validRows[0],
    rows: validRows.slice(1),
    delimiter,
    originalRowCount: lines.length
  };
}

/**
 * Parse key-value pairs from text
 */
function parseKeyValues(text) {
  const pairs = {};
  const patterns = [
    /^([^:]+):\s*(.+)$/,       // Key: Value
    /^([^=]+)=\s*(.+)$/,       // Key = Value
    /^([^\t]+)\t+(.+)$/        // Key    Value (tab separated)
  ];

  const lines = text.trim().split('\n');

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (key && value) {
          pairs[key] = value;
        }
        break;
      }
    }
  }

  return Object.keys(pairs).length > 0 ? pairs : null;
}

/**
 * Parse a list from text
 */
function parseList(text) {
  const lines = text.trim().split('\n');
  const items = [];

  for (const line of lines) {
    // Remove common list markers
    const cleaned = line
      .replace(/^[\s]*[-•*]\s*/, '')
      .replace(/^[\s]*\d+[.)]\s*/, '')
      .trim();

    if (cleaned) {
      items.push(cleaned);
    }
  }

  return items.length > 1 ? items : null;
}

/**
 * Extract part numbers from text
 */
function extractPartNumbers(text) {
  // Common MPN patterns
  const patterns = [
    /\b[A-Z]{2,4}[0-9]{3,}[A-Z0-9-]*\b/g,        // Standard MPN like LM358N
    /\b[0-9]{3,}-[A-Z0-9-]+\b/g,                  // Numeric prefix like 123-456-789
    /\b[A-Z0-9]{2,}-[A-Z0-9]+-[A-Z0-9]+\b/g,      // Multi-segment like ABC-123-XYZ
  ];

  const found = new Set();

  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => found.add(m));
  }

  return Array.from(found);
}

/**
 * Extract quantities from text (number followed by unit or standalone)
 */
function extractQuantities(text) {
  const patterns = [
    /(\d{1,3}(?:,\d{3})*)\s*(?:pcs?|pieces?|units?|ea|each)/gi,
    /qty[:\s]*(\d{1,3}(?:,\d{3})*)/gi,
    /quantity[:\s]*(\d{1,3}(?:,\d{3})*)/gi
  ];

  const found = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const qty = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(qty) && qty > 0) {
        found.push(qty);
      }
    }
  }

  return found;
}

/**
 * Extract prices from text
 */
function extractPrices(text) {
  const pattern = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  const found = [];

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(price)) {
      found.push(price);
    }
  }

  return found;
}

/**
 * Process a selection message from the browser
 */
function processSelection(msg) {
  const { payload } = msg;
  const { text, url } = payload;

  console.log(`[extraction] Processing selection from: ${url}`);
  console.log(`[extraction] Text length: ${text.length} chars`);

  const result = {
    source: url,
    timestamp: payload.timestamp || new Date().toISOString(),
    raw: text,
    parsed: {}
  };

  // Try parsing as table
  const table = parseTable(text);
  if (table) {
    result.parsed.table = table;
    console.log(`[extraction] Found table: ${table.headers.length} cols, ${table.rows.length} rows`);
  }

  // Try parsing as key-values
  const kvPairs = parseKeyValues(text);
  if (kvPairs) {
    result.parsed.keyValues = kvPairs;
    console.log(`[extraction] Found ${Object.keys(kvPairs).length} key-value pairs`);
  }

  // Try parsing as list
  const list = parseList(text);
  if (list) {
    result.parsed.list = list;
    console.log(`[extraction] Found list: ${list.length} items`);
  }

  // Extract entities
  const partNumbers = extractPartNumbers(text);
  if (partNumbers.length > 0) {
    result.parsed.partNumbers = partNumbers;
    console.log(`[extraction] Found ${partNumbers.length} part numbers`);
  }

  const quantities = extractQuantities(text);
  if (quantities.length > 0) {
    result.parsed.quantities = quantities;
  }

  const prices = extractPrices(text);
  if (prices.length > 0) {
    result.parsed.prices = prices;
  }

  // Save result
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-selection.json`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(result, null, 2));
  console.log(`[extraction] Saved: ${filename}`);

  return result;
}

/**
 * Process arbitrary data message
 */
function processData(msg) {
  const { payload } = msg;
  const { label, data, url } = payload;

  console.log(`[extraction] Processing data: ${label} from ${url}`);

  const result = {
    label,
    source: url,
    timestamp: payload.timestamp || new Date().toISOString(),
    data
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = (label || 'data').replace(/[^a-z0-9]/gi, '_');
  const filename = `${timestamp}-${safeLabel}.json`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(result, null, 2));
  console.log(`[extraction] Saved: ${filename}`);

  return result;
}

module.exports = {
  parseTable,
  parseKeyValues,
  parseList,
  extractPartNumbers,
  extractQuantities,
  extractPrices,
  processSelection,
  processData
};
