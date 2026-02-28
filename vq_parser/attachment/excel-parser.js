const fs = require('fs');
const XLSX = require('xlsx');
const logger = require('../utils/logger');
const { COLUMN_ALIASES } = require('../../config/columns');

/**
 * Parse an Excel file and extract quote data
 * @param {string} filepath - Path to the Excel file
 * @returns {{lines: Array, confidence: number, strategy: string}}
 */
function parseExcel(filepath) {
  try {
    const workbook = XLSX.readFile(filepath);

    // Process first sheet (or sheet with most data)
    let bestSheet = null;
    let maxRows = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      if (data.length > maxRows) {
        maxRows = data.length;
        bestSheet = { name: sheetName, data };
      }
    }

    if (!bestSheet || bestSheet.data.length < 2) {
      logger.warn(`No usable data found in Excel file ${filepath}`);
      return { lines: [], confidence: 0, strategy: 'excel-empty' };
    }

    const result = parseSheetData(bestSheet.data);
    return {
      lines: result.lines,
      confidence: result.confidence,
      strategy: 'excel'
    };

  } catch (err) {
    logger.error(`Failed to parse Excel ${filepath}: ${err.message}`);
    return { lines: [], confidence: 0, strategy: 'excel-failed' };
  }
}

/**
 * Parse CSV file
 * @param {string} filepath - Path to the CSV file
 * @returns {{lines: Array, confidence: number, strategy: string}}
 */
function parseCSV(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    const workbook = XLSX.read(content, { type: 'string' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length < 2) {
      return { lines: [], confidence: 0, strategy: 'csv-empty' };
    }

    const result = parseSheetData(data);
    return {
      lines: result.lines,
      confidence: result.confidence,
      strategy: 'csv'
    };

  } catch (err) {
    logger.error(`Failed to parse CSV ${filepath}: ${err.message}`);
    return { lines: [], confidence: 0, strategy: 'csv-failed' };
  }
}

/**
 * Parse sheet data (array of arrays) into quote lines
 * @param {Array<Array>} data - Sheet data as array of rows
 * @returns {{lines: Array, confidence: number}}
 */
function parseSheetData(data) {
  const lines = [];

  // Find header row
  let headerRow = -1;
  let headerMap = {};

  for (let i = 0; i < Math.min(data.length, 10); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const mapping = mapHeaderRow(row);
    if (Object.keys(mapping).length >= 2) {
      headerRow = i;
      headerMap = mapping;
      break;
    }
  }

  if (headerRow === -1) {
    logger.debug('No header row found in spreadsheet');
    return { lines: [], confidence: 0 };
  }

  logger.debug(`Found header row at index ${headerRow}: ${JSON.stringify(headerMap)}`);

  // Parse data rows
  for (let i = headerRow + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    // Skip empty rows
    const nonEmpty = row.filter(cell => cell !== null && cell !== undefined && cell !== '');
    if (nonEmpty.length < 2) continue;

    const line = {};
    let hasData = false;

    for (const [colIdx, colName] of Object.entries(headerMap)) {
      const value = row[parseInt(colIdx)];
      if (value !== null && value !== undefined && value !== '') {
        line[colName] = String(value).trim();
        hasData = true;
      }
    }

    // Only add rows with MPN or price
    if (hasData && (line['chuboe_mpn'] || line['cost'])) {
      lines.push(line);
    }
  }

  const confidence = lines.length > 0 ? Math.min(0.9, 0.5 + (lines.length * 0.05)) : 0;
  return { lines, confidence };
}

/**
 * Map header row to column names
 * @param {Array} row - Header row
 * @returns {Object} - Map of column index to column name
 */
function mapHeaderRow(row) {
  const mapping = {};

  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    if (!cell) continue;

    const cellLower = String(cell).toLowerCase().trim();

    for (const [colName, aliases] of Object.entries(COLUMN_ALIASES)) {
      for (const alias of aliases) {
        if (cellLower === alias.toLowerCase() || cellLower.includes(alias.toLowerCase())) {
          mapping[i] = colName;
          break;
        }
      }
      if (mapping[i]) break;
    }
  }

  return mapping;
}

module.exports = { parseExcel, parseCSV };
