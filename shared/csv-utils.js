/**
 * Shared CSV Utilities for Astute Analytics
 *
 * ALWAYS use these functions instead of naive string.split(',')
 * to properly handle:
 * - Quoted fields containing commas
 * - Escaped quotes within fields
 * - Multiline values (if needed)
 *
 * Usage:
 *   const { parseCSV, parseCSVLine, readCSVFile } = require('../shared/csv-utils');
 *
 *   // Parse a single line
 *   const fields = parseCSVLine('foo,"bar,baz",qux');
 *
 *   // Parse entire file
 *   const { headers, rows } = readCSVFile('/path/to/file.csv');
 *
 *   // Get field by header name
 *   const value = rows[0][headers.indexOf('Warehouse')];
 */

const fs = require('fs');

/**
 * Parse a single CSV line, properly handling quoted fields
 * @param {string} line - Single line of CSV
 * @returns {string[]} Array of field values
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote ("") inside quoted field
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Don't forget the last field
  result.push(current.trim());
  return result;
}

/**
 * Parse entire CSV content string
 * @param {string} content - Full CSV file content
 * @param {Object} options - Options
 * @param {boolean} options.hasHeader - First row is header (default: true)
 * @param {number} options.skipRows - Number of rows to skip at start (default: 0)
 * @returns {Object} { headers: string[], rows: string[][] }
 */
function parseCSV(content, options = {}) {
  const { hasHeader = true, skipRows = 0 } = options;

  const lines = content.split('\n').filter(line => line.trim());
  const dataLines = lines.slice(skipRows);

  if (dataLines.length === 0) {
    return { headers: [], rows: [] };
  }

  let headers = [];
  let startIndex = 0;

  if (hasHeader) {
    headers = parseCSVLine(dataLines[0]);
    startIndex = 1;
  }

  const rows = [];
  for (let i = startIndex; i < dataLines.length; i++) {
    rows.push(parseCSVLine(dataLines[i]));
  }

  return { headers, rows };
}

/**
 * Read and parse a CSV file
 * @param {string} filePath - Path to CSV file
 * @param {Object} options - Same options as parseCSV
 * @returns {Object} { headers: string[], rows: string[][], getColumn: Function }
 */
function readCSVFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { headers, rows } = parseCSV(content, options);

  /**
   * Get all values for a column by name
   * @param {string} columnName - Header name
   * @returns {string[]} Array of values
   */
  function getColumn(columnName) {
    const idx = headers.indexOf(columnName);
    if (idx === -1) {
      throw new Error(`Column "${columnName}" not found. Available: ${headers.join(', ')}`);
    }
    return rows.map(row => row[idx] || '');
  }

  /**
   * Filter rows by column value
   * @param {string} columnName - Header name
   * @param {string|Function} matcher - Value to match or predicate function
   * @returns {string[][]} Filtered rows
   */
  function filterByColumn(columnName, matcher) {
    const idx = headers.indexOf(columnName);
    if (idx === -1) {
      throw new Error(`Column "${columnName}" not found. Available: ${headers.join(', ')}`);
    }

    const matchFn = typeof matcher === 'function'
      ? matcher
      : (val) => val === matcher;

    return rows.filter(row => matchFn(row[idx] || ''));
  }

  /**
   * Get column index by name
   * @param {string} columnName - Header name
   * @returns {number} Column index (-1 if not found)
   */
  function colIndex(columnName) {
    return headers.indexOf(columnName);
  }

  /**
   * Sum numeric values in a column, optionally filtered
   * @param {string} columnName - Header name
   * @param {Function} filterFn - Optional filter function on rows
   * @returns {number} Sum of numeric values
   */
  function sumColumn(columnName, filterFn = null) {
    const idx = headers.indexOf(columnName);
    if (idx === -1) {
      throw new Error(`Column "${columnName}" not found`);
    }

    const targetRows = filterFn ? rows.filter(filterFn) : rows;

    return targetRows.reduce((sum, row) => {
      const val = parseFloat((row[idx] || '').replace(/[,$]/g, '')) || 0;
      return sum + val;
    }, 0);
  }

  return {
    headers,
    rows,
    getColumn,
    filterByColumn,
    colIndex,
    sumColumn,
    rowCount: rows.length
  };
}

/**
 * Write rows to CSV file with proper quoting
 * @param {string} filePath - Output path
 * @param {string[]} headers - Column headers
 * @param {string[][]} rows - Data rows
 */
function writeCSVFile(filePath, headers, rows) {
  const escapeField = (val) => {
    const str = String(val ?? '');
    // Quote if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines = [
    headers.map(escapeField).join(','),
    ...rows.map(row => row.map(escapeField).join(','))
  ];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

module.exports = {
  parseCSVLine,
  parseCSV,
  readCSVFile,
  writeCSVFile
};
