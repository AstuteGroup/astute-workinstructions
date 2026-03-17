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
  const shortfallIdx = headers.indexOf('Shortfall');

  if (mpnIdx === -1) {
    console.error('ERROR: MPN column not found');
    process.exit(1);
  }

  console.log(`  ${csv.rows.length} items to source`);
  console.log('');

  // Process each item
  console.log('Running franchise screening...');
  console.log('');

  const results = [];

  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const mpn = row[mpnIdx];
    const qty = parseInt(row[shortfallIdx]) || 100;

    console.log(`[${i + 1}/${csv.rows.length}] ${mpn} (qty: ${qty})`);

    // Query all franchise APIs
    const franchiseResults = await queryFranchiseAPIs(mpn, qty);

    // Find best in-stock option and best lead time option
    const inStockOption = findBestInStock(franchiseResults, qty);
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
  writeEnrichedOutput(results, headers, outputFile);
  console.log(`  Output written to: ${outputFile}`);

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

function writeEnrichedOutput(results, originalHeaders, outputPath) {
  // Simplified columns: In Stock option + Lead Time option
  const newHeaders = [
    'In Stock Supplier',
    'In Stock Price',
    'In Stock Qty',
    'Lead Time Supplier',
    'Lead Time Price',
    'Lead Time (Weeks)',
  ];

  const allHeaders = [...originalHeaders, ...newHeaders];
  const lines = [allHeaders.join(',')];

  for (const result of results) {
    const originalValues = result.originalRow.map(v => formatCSVValue(v));
    const franchiseValues = [
      result.franchise.inStockSupplier,
      result.franchise.inStockPrice,
      result.franchise.inStockQty,
      result.franchise.leadTimeSupplier,
      result.franchise.leadTimePrice,
      result.franchise.leadTimeWeeks,
    ].map(v => formatCSVValue(v));

    lines.push([...originalValues, ...franchiseValues].join(','));
  }

  fs.writeFileSync(outputPath, lines.join('\n'));
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
