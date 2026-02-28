const cheerio = require('cheerio');
const { COLUMN_ALIASES } = require('../../config/columns');
const { cleanString, stripCurrency } = require('../utils/sanitize');
const logger = require('../utils/logger');

function fuzzyMatchColumn(headerText) {
  const normalized = cleanString(headerText).toLowerCase();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (normalized === alias || normalized.includes(alias)) {
        return field;
      }
    }
  }
  return null;
}

function parseHtmlTables(html) {
  if (!html || !html.includes('<table')) {
    return { lines: [], confidence: 0 };
  }

  const $ = cheerio.load(html);
  const tables = $('table');
  let bestResult = { lines: [], confidence: 0 };

  tables.each((tableIdx, table) => {
    const rows = $(table).find('tr');
    if (rows.length < 2) return; // Need header + at least 1 data row

    // Find header row
    let headerRow = null;
    let headerIdx = -1;
    rows.each((i, row) => {
      const cells = $(row).find('th, td');
      const texts = [];
      cells.each((j, cell) => texts.push(cleanString($(cell).text())));

      // Check if this looks like a header row
      const matchedFields = texts.map(t => fuzzyMatchColumn(t)).filter(Boolean);
      if (matchedFields.length >= 2 && !headerRow) {
        headerRow = texts;
        headerIdx = i;
      }
    });

    if (!headerRow) return;

    // Map header columns to VQ fields
    const columnMap = {};
    headerRow.forEach((text, idx) => {
      const field = fuzzyMatchColumn(text);
      if (field) columnMap[idx] = field;
    });

    const hasMPN = Object.values(columnMap).includes('chuboe_mpn');
    const hasCost = Object.values(columnMap).includes('cost');

    if (!hasMPN && !hasCost) return;

    // Extract data rows
    const lines = [];
    rows.each((i, row) => {
      if (i <= headerIdx) return; // Skip header and rows above it

      const cells = $(row).find('td');
      if (cells.length === 0) return;

      const line = {};
      let hasData = false;
      cells.each((j, cell) => {
        if (columnMap[j]) {
          const value = cleanString($(cell).text());
          if (value) {
            line[columnMap[j]] = value;
            hasData = true;
          }
        }
      });

      if (hasData && (line['chuboe_mpn'] || line['cost'])) {
        lines.push(line);
      }
    });

    if (lines.length > 0) {
      const confidence = (hasMPN && hasCost) ? 0.9 : 0.7;
      if (confidence > bestResult.confidence || lines.length > bestResult.lines.length) {
        bestResult = { lines, confidence };
      }
    }
  });

  return bestResult;
}

module.exports = { parseHtmlTables, fuzzyMatchColumn };
