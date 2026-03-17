#!/usr/bin/env node
/**
 * LAM Kitting Sourcing Script
 *
 * Runs franchise screening on reorder alerts and enriches with sourcing data.
 * Uses the franchise API modules from rfq_sourcing/franchise_check/
 *
 * Usage:
 *   node lam-kitting-source.js <reorder-alerts-csv> [output-csv]
 *
 * Example:
 *   node lam-kitting-source.js output/LAM_Reorder_Alerts_2026-03-17.csv
 */

const fs = require('fs');
const path = require('path');

// Import franchise API modules
const franchiseDir = path.join(__dirname, '../../rfq_sourcing/franchise_check');
const digikey = require(path.join(franchiseDir, 'digikey'));
const arrow = require(path.join(franchiseDir, 'arrow'));
const rutronik = require(path.join(franchiseDir, 'rutronik'));
const future = require(path.join(franchiseDir, 'future'));
const master = require(path.join(franchiseDir, 'master'));

// Use shared CSV utility
const { readCSVFile } = require('../../shared/csv-utils');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const FRANCHISE_APIS = [
  { name: 'DigiKey', module: digikey, bpName: 'Digi-Key Electronics' },
  { name: 'Arrow', module: arrow, bpName: 'Arrow Electronics' },
  { name: 'Rutronik', module: rutronik, bpName: 'Rutronik UK' },
  { name: 'Future', module: future, bpName: 'Future Electronics Corporation' },
  { name: 'Master', module: master, bpName: 'Master Electronics' },
];

const DELAY_BETWEEN_PARTS = 500; // ms between parts to avoid rate limiting

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node lam-kitting-source.js <reorder-alerts-csv> [output-csv]');
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1] || inputFile.replace('.csv', '_sourced.csv');

  console.log('LAM Kitting Sourcing');
  console.log('====================');
  console.log(`Input: ${inputFile}`);
  console.log(`Output: ${outputFile}`);
  console.log('');

  // Load reorder alerts
  console.log('Loading reorder alerts...');
  const csv = readCSVFile(inputFile);
  const headers = csv.headers;
  const mpnIdx = headers.indexOf('MPN');
  const moqIdx = headers.indexOf('MOQ');

  if (mpnIdx === -1) {
    console.error('ERROR: MPN column not found');
    process.exit(1);
  }

  if (moqIdx === -1) {
    console.error('ERROR: MOQ column not found');
    process.exit(1);
  }

  console.log(`  ${csv.rows.length} items to source`);
  console.log(`  Querying at MOQ quantities for accurate pricing`);
  console.log('');

  // Process each item
  console.log('Running franchise screening...');
  console.log('');

  const results = [];

  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const mpn = row[mpnIdx];
    const moq = parseInt(row[moqIdx]) || 100;

    console.log(`[${i + 1}/${csv.rows.length}] ${mpn} (MOQ: ${moq})`);

    // Query all franchise APIs at MOQ
    const franchiseResults = await queryFranchiseAPIs(mpn, moq);

    // Find best in-stock option and best lead time option
    const inStockOption = findBestInStock(franchiseResults, moq);
    const leadTimeOption = findBestLeadTime(franchiseResults);

    // Add franchise data to row
    const enrichedRow = {
      originalRow: row,
      franchise: {
        // In-stock columns
        inStockSupplier: inStockOption?.supplier || '',
        inStockPrice: inStockOption?.price || '',
        inStockQty: inStockOption?.qty || '',
        // Lead time columns (for items not in stock or as alternative)
        leadTimeSupplier: leadTimeOption?.supplier || '',
        leadTimePrice: leadTimeOption?.price || '',
        leadTimeWeeks: leadTimeOption?.leadTime || '',
      }
    };

    results.push(enrichedRow);

    // Brief status
    if (inStockOption) {
      console.log(`    ✓ In Stock: ${inStockOption.supplier} - $${inStockOption.price} x ${inStockOption.qty}`);
    } else if (leadTimeOption) {
      console.log(`    ~ Lead Time: ${leadTimeOption.supplier} - $${leadTimeOption.price} (${leadTimeOption.leadTime})`);
    } else {
      console.log(`    ✗ No franchise coverage`);
    }

    // Delay between parts
    if (i < csv.rows.length - 1) {
      await sleep(DELAY_BETWEEN_PARTS);
    }
  }

  // Write output
  console.log('');
  console.log('Writing output...');
  await writeEnrichedOutput(results, headers, outputFile);
  console.log(`  CSV written to: ${outputFile}`);

  // Summary
  console.log('');
  console.log('=== Summary ===');
  const inStock = results.filter(r => r.franchise.inStockSupplier).length;
  const leadTimeOnly = results.filter(r => !r.franchise.inStockSupplier && r.franchise.leadTimeSupplier).length;
  const noCoverage = results.filter(r => !r.franchise.inStockSupplier && !r.franchise.leadTimeSupplier).length;
  console.log(`  In Stock: ${inStock}`);
  console.log(`  Lead Time Only: ${leadTimeOnly}`);
  console.log(`  No franchise coverage: ${noCoverage}`);
}

// -----------------------------------------------------------------------------
// Franchise API Queries
// -----------------------------------------------------------------------------

async function queryFranchiseAPIs(mpn, qty) {
  const results = {};

  for (const api of FRANCHISE_APIS) {
    try {
      const result = await api.module.searchPart(mpn, qty);

      if (result && result.found) {
        // Handle different field names across APIs
        const availQty = result.franchiseQty || result.qty || 0;
        const price = result.franchiseRfqPrice || result.franchiseBulkPrice || result.price || null;
        const leadTime = result.leadTime || result.vqLeadTime || '';

        if (availQty > 0) {
          results[api.name] = {
            qty: availQty,
            price: price,
            leadTime: leadTime,
            supplier: api.bpName,
          };
        }
      }
    } catch (err) {
      // API error - skip this supplier
      // console.error(`    ${api.name} error: ${err.message}`);
    }
  }

  return results;
}

// -----------------------------------------------------------------------------
// Find Best Options
// -----------------------------------------------------------------------------

/**
 * Find best in-stock option (has qty available)
 * Returns supplier with lowest price among those with stock
 */
function findBestInStock(franchiseResults, neededQty) {
  let best = null;

  for (const [name, data] of Object.entries(franchiseResults)) {
    if (!data || data.qty <= 0) continue;

    // Only consider if has stock
    if (!best) {
      best = { ...data, supplier: name };
      continue;
    }

    // Pick lowest price
    if (data.price && (!best.price || data.price < best.price)) {
      best = { ...data, supplier: name };
    }
  }

  return best;
}

/**
 * Find best lead time option (for items without immediate stock)
 * Returns supplier with lead time info and lowest price
 */
function findBestLeadTime(franchiseResults) {
  let best = null;

  for (const [name, data] of Object.entries(franchiseResults)) {
    if (!data) continue;

    // Only consider if has lead time info
    if (!data.leadTime) continue;

    if (!best) {
      best = { ...data, supplier: name };
      continue;
    }

    // Pick lowest price among those with lead time
    if (data.price && (!best.price || data.price < best.price)) {
      best = { ...data, supplier: name };
    }
  }

  return best;
}

// -----------------------------------------------------------------------------
// Write Output
// -----------------------------------------------------------------------------

async function writeEnrichedOutput(results, originalHeaders, outputPath) {
  const ExcelJS = require('exceljs');

  // Get resale price index for margin calculations
  const resaleIdx = originalHeaders.indexOf('Resale Price');

  // Simplified columns: In Stock option + Lead Time option + Margins
  const newHeaders = [
    'In Stock Supplier',
    'In Stock Price',
    'In Stock Qty',
    'In Stock Margin %',
    'Lead Time Supplier',
    'Lead Time Price',
    'Lead Time (Weeks)',
    'Lead Time Margin %',
  ];

  const allHeaders = [...originalHeaders, ...newHeaders];
  const rows = [];

  // Track margin column indices (1-based for ExcelJS)
  const inStockMarginCol = allHeaders.indexOf('In Stock Margin %') + 1;
  const leadTimeMarginCol = allHeaders.indexOf('Lead Time Margin %') + 1;

  for (const result of results) {
    // Format original values - format price columns with $
    const originalValues = result.originalRow.map((v, idx) => {
      const header = originalHeaders[idx];
      if (['Base Unit Price', 'Resale Price', 'Historical Purchase Price'].includes(header)) {
        const num = parseFloat(v);
        if (!isNaN(num)) {
          return formatDollar(num);
        }
      }
      return v;
    });

    // Get resale price for margin calculations
    const resalePrice = parseFloat(result.originalRow[resaleIdx]) || 0;

    // Calculate margins
    const inStockPrice = parseFloat(result.franchise.inStockPrice) || 0;
    const leadTimePrice = parseFloat(result.franchise.leadTimePrice) || 0;

    const inStockMarginNum = (resalePrice > 0 && inStockPrice > 0)
      ? (resalePrice - inStockPrice) / resalePrice * 100
      : null;

    const leadTimeMarginNum = (resalePrice > 0 && leadTimePrice > 0)
      ? (resalePrice - leadTimePrice) / resalePrice * 100
      : null;

    const franchiseValues = [
      result.franchise.inStockSupplier || '',
      result.franchise.inStockPrice ? formatDollar(result.franchise.inStockPrice) : '',
      result.franchise.inStockQty || '',
      inStockMarginNum,  // Store as number for coloring
      result.franchise.leadTimeSupplier || '',
      result.franchise.leadTimePrice ? formatDollar(result.franchise.leadTimePrice) : '',
      result.franchise.leadTimeWeeks || '',
      leadTimeMarginNum,  // Store as number for coloring
    ];

    rows.push([...originalValues, ...franchiseValues]);
  }

  // Create workbook with ExcelJS
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sourced Reorder Alerts');

  // Add header row with styling
  worksheet.addRow(allHeaders);
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' }
  };

  // Add data rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const excelRow = worksheet.addRow(row);

    // Apply margin cell coloring
    const inStockMargin = row[inStockMarginCol - 1];
    const leadTimeMargin = row[leadTimeMarginCol - 1];

    // In Stock Margin cell
    if (inStockMargin !== null && inStockMargin !== undefined) {
      const cell = excelRow.getCell(inStockMarginCol);
      cell.value = inStockMargin.toFixed(1) + '%';
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: getMarginColor(inStockMargin) }
      };
    }

    // Lead Time Margin cell
    if (leadTimeMargin !== null && leadTimeMargin !== undefined) {
      const cell = excelRow.getCell(leadTimeMarginCol);
      cell.value = leadTimeMargin.toFixed(1) + '%';
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: getMarginColor(leadTimeMargin) }
      };
    }
  }

  // Set column widths
  worksheet.columns.forEach((col, idx) => {
    const header = allHeaders[idx];
    if (header === 'Item Description') col.width = 45;
    else if (header === 'Manufacturer' || header.includes('Supplier')) col.width = 25;
    else if (header === 'MPN' || header === 'Lam P/N') col.width = 25;
    else if (header.includes('Margin')) col.width = 15;
    else col.width = 18;
  });

  // Freeze header row
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Write Excel file
  const xlsxPath = outputPath.replace(/\.csv$/, '.xlsx');
  await workbook.xlsx.writeFile(xlsxPath);
  console.log(`  Excel written to: ${xlsxPath}`);

  // Also write CSV for compatibility
  const csvRows = [allHeaders, ...rows.map(row => row.map((v, idx) => {
    // Format margin columns for CSV
    if (idx === inStockMarginCol - 1 || idx === leadTimeMarginCol - 1) {
      return v !== null && v !== undefined ? v.toFixed(1) + '%' : '';
    }
    return v;
  }))];
  const csvLines = csvRows.map(row => row.map(v => formatCSVValue(v)).join(','));
  fs.writeFileSync(outputPath, csvLines.join('\n'));
}

/**
 * Get fill color based on margin threshold
 * >18% = green, 0-18% = yellow, <0% = red
 */
function getMarginColor(margin) {
  if (margin > 18) return 'FF90EE90';  // Light green
  if (margin >= 0) return 'FFFFFF99';   // Light yellow
  return 'FFFF9999';                     // Light red
}

/**
 * Format number as dollar amount
 */
function formatDollar(val) {
  const num = parseFloat(val);
  if (isNaN(num)) return '';
  // Use appropriate decimal places based on value
  if (num >= 1) {
    return '$' + num.toFixed(2);
  } else if (num >= 0.01) {
    return '$' + num.toFixed(4);
  } else {
    return '$' + num.toFixed(6);
  }
}

function formatCSVValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
