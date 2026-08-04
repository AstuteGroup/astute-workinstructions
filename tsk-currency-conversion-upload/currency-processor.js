#!/usr/bin/env node
/**
 * currency-processor.js
 *
 * Processes Exchange Rate Matrix Excel files into iDempiere-compatible
 * currency conversion CSV files.
 *
 * Usage:
 *   node currency-processor.js <excel-file> --start-date YYYY-MM-DD --end-date YYYY-MM-DD
 *   node currency-processor.js <excel-file>  # prompts for dates
 *
 * Example:
 *   node currency-processor.js "Exchange Rate Matrix -1 May 2026.xlsx" \
 *     --start-date 2026-05-04 --end-date 2026-06-03
 */

'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ─── TARGET CURRENCIES ───────────────────────────────────────────────────────

const TARGET_CURRENCIES = ['EUR', 'USD', 'SGD', 'INR', 'JPY', 'CAD', 'GBP'];

// Column indices in UKS tab (0-indexed) for each currency
// Row 6 (index 5) is headers: From Currency, Buy Rates:, GBP, EUR, USD, AUD, CAD, CHF, INR, ILS, NOK, NZD, JPY, SEK, SGD, ...
const COLUMN_INDICES = {
  GBP: 2,
  EUR: 3,
  USD: 4,
  AUD: 5,
  CAD: 6,
  CHF: 7,
  INR: 8,
  ILS: 9,
  NOK: 10,
  NZD: 11,
  JPY: 12,
  SEK: 13,
  SGD: 14,
};

// Row index for USD rates (0-indexed, USD is row 9 in Excel = index 8)
const USD_ROW_INDEX = 8;

// Header row index (0-indexed)
const HEADER_ROW_INDEX = 5;

// ─── MAIN PROCESSING ─────────────────────────────────────────────────────────

/**
 * Parse Exchange Rate Matrix and generate currency conversion rows.
 * @param {string} excelPath - Path to the Exchange Rate Matrix Excel file
 * @param {string} startDate - Validity start date (YYYY-MM-DD)
 * @param {string} endDate - Validity end date (YYYY-MM-DD)
 * @returns {{ rows: Array, summary: object }}
 */
function processExchangeRateMatrix(excelPath, startDate, endDate) {
  // Read the Excel file
  const workbook = XLSX.readFile(excelPath);

  // Get the UKS sheet
  const sheetName = 'UKS';
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet '${sheetName}' not found in workbook. Available sheets: ${workbook.SheetNames.join(', ')}`);
  }

  // Convert to array of arrays
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Validate we have enough rows
  if (data.length < USD_ROW_INDEX + 1) {
    throw new Error(`Sheet '${sheetName}' has insufficient rows. Expected at least ${USD_ROW_INDEX + 1}, got ${data.length}`);
  }

  // Extract USD→X rates from row 8 (index 7)
  const usdRow = data[USD_ROW_INDEX];

  // Build a map of currency → rate (USD→currency)
  // USD→USD is always 1 (skip it in the loop since it's null in the source)
  const usdToX = { USD: 1 };
  for (const [currency, colIndex] of Object.entries(COLUMN_INDICES)) {
    if (currency === 'USD') continue;  // Skip - USD→USD is always 1
    const rate = usdRow[colIndex];
    if (typeof rate !== 'number' || isNaN(rate) || rate <= 0) {
      throw new Error(`Invalid rate for USD→${currency} at column ${colIndex}: ${rate}`);
    }
    usdToX[currency] = rate;
  }

  // Calculate X→USD rates (invert USD→X)
  const xToUSD = {};
  for (const currency of TARGET_CURRENCIES) {
    xToUSD[currency] = 1 / usdToX[currency];
  }

  // Generate all currency pairs
  const rows = [];

  // First: all X→USD pairs (except USD→USD)
  for (const currency of TARGET_CURRENCIES) {
    if (currency === 'USD') continue;
    rows.push({
      from: currency,
      to: 'USD',
      rate: xToUSD[currency],
    });
  }

  // Second: all cross-rates (X→Y where neither is USD)
  const nonUsdCurrencies = TARGET_CURRENCIES.filter(c => c !== 'USD');
  for (let i = 0; i < nonUsdCurrencies.length; i++) {
    for (let j = i + 1; j < nonUsdCurrencies.length; j++) {
      const from = nonUsdCurrencies[i];
      const to = nonUsdCurrencies[j];
      // X→Y = X→USD / Y→USD
      const rate = xToUSD[from] / xToUSD[to];
      rows.push({ from, to, rate });
    }
  }

  return {
    rows,
    usdToX,
    xToUSD,
    startDate,
    endDate,
  };
}

/**
 * Format a single row for CSV output.
 * @param {{ from: string, to: string, rate: number }} row
 * @param {string} startDate
 * @param {string} endDate
 * @returns {string}
 */
function formatCsvRow(row, startDate, endDate) {
  // Rate to 6 decimal places
  const rateStr = row.rate.toFixed(6);
  return `*,${row.from},${row.to},${rateStr},${startDate},${endDate}`;
}

/**
 * Generate the full CSV content.
 * @param {Array} rows
 * @param {string} startDate
 * @param {string} endDate
 * @returns {string}
 */
function generateCsv(rows, startDate, endDate) {
  const header = 'AD_Org_ID[Name],C_Currency_ID[ISO_Code],C_Currency_ID_To[ISO_Code],MultiplyRate,ValidFrom,ValidTo';
  const lines = [header];
  for (const row of rows) {
    lines.push(formatCsvRow(row, startDate, endDate));
  }
  return lines.join('\n') + '\n';
}

/**
 * Format date for filename (M_D_YY).
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
function formatDateForFilename(dateStr) {
  const [year, month, day] = dateStr.split('-');
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  const yy = year.slice(-2);
  return `${m}_${d}_${yy}`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Usage:
  node currency-processor.js <excel-file> --start-date YYYY-MM-DD --end-date YYYY-MM-DD
  node currency-processor.js <excel-file> --output <output-path>

Options:
  --start-date   Validity start date (required)
  --end-date     Validity end date (required)
  --output       Custom output path (optional; defaults to uploaded files/)
  --dry-run      Print output to console without writing file

Examples:
  node currency-processor.js "Exchange Rate Matrix -1 May 2026.xlsx" \\
    --start-date 2026-05-04 --end-date 2026-06-03

  node currency-processor.js input.xlsx --start-date 2026-07-04 --end-date 2026-08-03 --dry-run
`);
}

function parseArgs(args) {
  const result = {
    inputFile: null,
    startDate: null,
    endDate: null,
    output: null,
    dryRun: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--start-date' && args[i + 1]) {
      result.startDate = args[++i];
    } else if (arg === '--end-date' && args[i + 1]) {
      result.endDate = args[++i];
    } else if (arg === '--output' && args[i + 1]) {
      result.output = args[++i];
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-') && !result.inputFile) {
      result.inputFile = arg;
    }
    i++;
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.inputFile) {
    console.error('Error: Input Excel file required');
    printUsage();
    process.exit(1);
  }

  if (!args.startDate || !args.endDate) {
    console.error('Error: --start-date and --end-date are required');
    printUsage();
    process.exit(1);
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(args.startDate) || !dateRegex.test(args.endDate)) {
    console.error('Error: Dates must be in YYYY-MM-DD format');
    process.exit(1);
  }

  // Check input file exists
  if (!fs.existsSync(args.inputFile)) {
    console.error(`Error: Input file not found: ${args.inputFile}`);
    process.exit(1);
  }

  console.log(`Processing: ${args.inputFile}`);
  console.log(`Date range: ${args.startDate} to ${args.endDate}`);
  console.log();

  // Process the file
  const result = processExchangeRateMatrix(args.inputFile, args.startDate, args.endDate);

  // Generate CSV
  const csv = generateCsv(result.rows, args.startDate, args.endDate);

  // Print summary
  console.log('=== USD→X Rates (from Excel) ===');
  for (const [currency, rate] of Object.entries(result.usdToX)) {
    if (currency !== 'USD') {
      console.log(`  USD→${currency}: ${rate.toFixed(6)}`);
    }
  }
  console.log();

  console.log('=== X→USD Rates (inverted) ===');
  for (const [currency, rate] of Object.entries(result.xToUSD)) {
    if (currency !== 'USD') {
      console.log(`  ${currency}→USD: ${rate.toFixed(6)}`);
    }
  }
  console.log();

  console.log(`=== Generated ${result.rows.length} currency pairs ===`);
  console.log();

  if (args.dryRun) {
    console.log('=== CSV Output (dry run) ===');
    console.log(csv);
  } else {
    // Determine output path
    let outputPath;
    if (args.output) {
      outputPath = args.output;
    } else {
      const startFormatted = formatDateForFilename(args.startDate);
      const endFormatted = formatDateForFilename(args.endDate);
      const filename = `Currency Conversion Upload - ${startFormatted} - ${endFormatted}.csv`;
      outputPath = path.join(process.env.HOME, 'workspace', 'uploaded files', filename);
    }

    // Write the file
    fs.writeFileSync(outputPath, csv, 'utf8');
    console.log(`Output written to: ${outputPath}`);
  }

  return { rows: result.rows, csv };
}

// Export for use as module
module.exports = {
  processExchangeRateMatrix,
  generateCsv,
  TARGET_CURRENCIES,
  COLUMN_INDICES,
};

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
