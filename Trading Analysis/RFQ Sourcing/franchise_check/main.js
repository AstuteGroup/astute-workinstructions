#!/usr/bin/env node
/**
 * Franchise Screening Tool
 *
 * Screens RFQ parts against franchise distributors (APIs + FindChips fallback)
 * to identify low-value opportunities that don't need broker sourcing.
 *
 * Also captures franchise pricing as VQs for ERP import.
 *
 * Distributor APIs are managed centrally via shared/franchise-api.js.
 * Adding a new API there automatically includes it in screening.
 *
 * Usage:
 *   # Screen a single part
 *   node main.js -p "LM358N" -q 100
 *
 *   # Screen from Excel file
 *   node main.js -f rfq_parts.xlsx
 *
 *   # Screen from iDempiere RFQ
 *   node main.js --rfq 1130292
 *
 *   # Custom threshold (default $50)
 *   node main.js --rfq 1130292 --threshold 100
 *
 *   # Skip franchise APIs (FindChips only)
 *   node main.js --rfq 1130292 --no-api
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const config = require('./config');
const { searchPart: findChipsSearch } = require('./search');
const { searchAllDistributors, getActiveDistributors, extractStockAndLtRows } = require('../../../shared/franchise-api');
const { writePricingResult } = require('../../../shared/api-result-writer');

// =============================================================================
// Database Functions
// =============================================================================

async function loadPartsFromDatabase(rfqNumber) {
  const client = new Client({
    host: '/var/run/postgresql',
    database: 'idempiere_replica',
    // Uses local socket auth - no password needed
  });

  try {
    await client.connect();

    const query = `
      SELECT DISTINCT
        rfq_search_key as rfq_number,
        rfq_mpn_mpn as mpn,
        rfq_mpn_clean_mpn as mpn_clean,
        rfq_mpn_qty as qty,
        rfq_mpn_target_price as target_price,
        rfq_bpartner_name as customer
      FROM adempiere.bi_rfq_mpn_v
      WHERE rfq_search_key = $1
        AND rfq_mpn_mpn IS NOT NULL
        AND rfq_mpn_mpn != ''
      ORDER BY rfq_mpn_mpn
    `;

    const result = await client.query(query, [rfqNumber]);
    console.log(`Loaded ${result.rows.length} parts from RFQ ${rfqNumber}`);
    return result.rows;

  } finally {
    await client.end();
  }
}

// =============================================================================
// File I/O Functions
// =============================================================================

function loadPartsFromFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filepath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    return data.map(row => ({
      rfq_number: row.rfq_number || row.RFQ || row['RFQ Number'] || '',
      mpn: row.mpn || row.MPN || row.part_number || row['Part Number'] || '',
      cpc: row.cpc || row.CPC || row['Customer Part Code'] || '',
      qty: parseInt(row.qty || row.Qty || row.quantity || row.Quantity || 0),
      target_price: parseFloat(row.target_price || row['Target Price'] || 0) || null,
      customer: row.customer || row.Customer || '',
    })).filter(p => p.mpn);
  }

  // Plain text - one part per line
  const content = fs.readFileSync(filepath, 'utf-8');
  return content.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(mpn => ({ rfq_number: '', mpn, cpc: '', qty: 0, target_price: null, customer: '' }));
}

function saveResults(results, outputPath) {
  const wsData = [
    [
      'RFQ Number', 'MPN', 'CPC', 'Qty', 'Target Price', 'Customer',
      'Franchise Avail', 'Franchise Qty', 'Franchise Price', 'Franchise Bulk Price',
      'Opportunity Value', 'Send to Broker', 'Reason', 'Distributor Count', 'Price Warning'
    ],
  ];

  for (const r of results) {
    wsData.push([
      r.rfq_number,
      r.mpn,
      r.cpc,
      r.qty,
      r.target_price || '',
      r.customer || '',
      r.franchise_available ? 'Yes' : 'No',
      r.franchise_qty,
      r.franchise_price || '',
      r.franchise_bulk_price || '',
      r.opportunity_value || '',
      r.send_to_broker ? 'Yes' : 'No',
      r.reason,
      r.distributor_count,
      r.price_warning || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Screening Results');
  XLSX.writeFile(wb, outputPath);
  console.log(`Results saved to: ${outputPath}`);
}

function saveBrokerList(results, outputPath) {
  const brokerParts = results.filter(r => r.send_to_broker);

  const wsData = [
    [
      'RFQ Number', 'MPN', 'CPC', 'Qty', 'Target Price', 'Customer',
      'Franchise Qty', 'Franchise Bulk Price', 'Opportunity Value'
    ],
  ];

  for (const r of brokerParts) {
    wsData.push([
      r.rfq_number,
      r.mpn,
      r.cpc,
      r.qty,
      r.target_price || '',
      r.customer || '',
      r.franchise_qty || 0,
      r.franchise_bulk_price || '',
      r.opportunity_value || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Broker RFQ List');
  XLSX.writeFile(wb, outputPath);
  console.log(`Broker list saved to: ${outputPath} (${brokerParts.length} parts)`);
}

/**
 * Save VQ batch export for ERP import
 * Captures franchise pricing at RFQ qty for ALL parts with franchise availability
 * Creates separate rows for each franchise distributor with pricing
 */
function saveVqBatch(results, outputPath, rfqNumber) {
  const wsData = [
    [
      'RFQ Number',
      'BP Value',
      'Vendor Name',
      'MPN',
      'Manufacturer',
      'Description',
      'Qty',
      'Price',
      'Currency',
      'Vendor Notes',
      'Source',
    ],
  ];

  let vqCount = 0;

  for (const r of results) {
    // Each result has a vq_lines array with one entry per distributor that had pricing
    const vqLines = r.vq_lines || [];
    for (const vq of vqLines) {
      wsData.push([
        r.rfq_number || rfqNumber || '',
        vq.bpValue || '',
        vq.vendorName || '',
        vq.mpn || r.mpn,
        vq.manufacturer || '',
        vq.description || '',
        r.qty,
        vq.price,
        'USD',
        vq.vendorNotes || '',
        `${vq.source} API`,
      ]);
      vqCount++;
    }
  }

  if (vqCount === 0) {
    console.log('No VQ data to export (no franchise pricing found)');
    return;
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'VQ Import');
  XLSX.writeFile(wb, outputPath);
  console.log(`VQ batch saved to: ${outputPath} (${vqCount} VQ lines)`);
}

// =============================================================================
// Screening Logic
// =============================================================================

/**
 * Evaluate a part for screening decision
 * @param {Object} part - Part from RFQ
 * @param {Object} searchResult - Result from FindChips
 * @param {number} threshold - Opportunity value threshold
 * @param {string} dataSource - Data source label
 */
function evaluatePart(part, searchResult, threshold, dataSource = 'FindChips') {
  const result = {
    ...part,
    franchise_available: searchResult.found,
    franchise_qty: searchResult.totalQty || searchResult.franchiseQty || 0,
    franchise_price: searchResult.lowestPrice || searchResult.franchisePrice || null,
    franchise_bulk_price: searchResult.bulkPrice || searchResult.franchiseBulkPrice || null,
    franchise_rfq_price: searchResult.franchiseRfqPrice || null,
    distributor_count: searchResult.distributorCount || (searchResult.found ? 1 : 0),
    price_warning: searchResult.priceWarning || '',
    opportunity_value: null,
    send_to_broker: true,
    reason: '',
    data_source: dataSource,
    // Generic VQ lines array — populated by franchise API results
    vq_lines: [],
  };

  // For FindChips, capture aggregate VQ data
  if (dataSource === 'FindChips' && searchResult.found && searchResult.lowestPrice) {
    result.vq_lines.push({
      bpValue: '',
      vendorName: '',
      mpn: part.mpn,
      manufacturer: '',
      description: '',
      price: searchResult.lowestPrice,
      vendorNotes: `FindChips aggregate stock: ${result.franchise_qty}`,
      source: 'FindChips',
    });
  }

  // Calculate opportunity value using BULK price
  const bulkPrice = result.franchise_bulk_price || result.franchise_price || part.target_price;
  if (bulkPrice && part.qty) {
    result.opportunity_value = Math.round(bulkPrice * part.qty * 100) / 100;
  }

  // Decision logic
  if (searchResult.found && result.franchise_qty >= part.qty) {
    if (result.opportunity_value !== null && result.opportunity_value < threshold) {
      result.send_to_broker = false;
      result.reason = `Franchise OK (OV: $${result.opportunity_value} < $${threshold})`;
    } else if (result.opportunity_value !== null) {
      result.reason = `High value (OV: $${result.opportunity_value})`;
    } else {
      result.reason = 'Franchise available but no price data';
    }
  } else if (searchResult.found) {
    result.reason = `Insufficient franchise qty (${result.franchise_qty} < ${part.qty})`;
  } else {
    result.reason = 'Not found in franchise distribution';
  }

  return result;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let mode = null;
  let partNumber = null;
  let quantity = 100;
  let filepath = null;
  let rfqNumber = null;
  let apiOnly = false;
  let threshold = config.OPPORTUNITY_THRESHOLD;
  let headless = true;
  let debug = false;
  let useApis = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-p':
      case '--part':
        mode = 'single';
        partNumber = args[++i];
        break;
      case '-q':
      case '--quantity':
        quantity = parseInt(args[++i]);
        break;
      case '-f':
      case '--file':
        mode = 'file';
        filepath = args[++i];
        break;
      case '--rfq':
        mode = 'database';
        rfqNumber = args[++i];
        break;
      case '--threshold':
        threshold = parseFloat(args[++i]);
        break;
      case '--no-headless':
        headless = false;
        break;
      case '--no-api':
      case '--no-digikey':  // backward compat
        useApis = false;
        break;
      case '--api-only':
        apiOnly = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '-h':
      case '--help':
        console.log(`
Franchise Screening Tool (Franchise APIs + FindChips)

Usage:
  node main.js -p "LM358N" -q 100     # Single part
  node main.js -f rfq_parts.xlsx      # From Excel file
  node main.js --rfq 1130292          # From iDempiere RFQ

Options:
  -p, --part       Single part number to screen
  -q, --quantity   Quantity (default: 100)
  -f, --file       Excel file with parts list
  --rfq            iDempiere RFQ number
  --threshold      Opportunity value threshold (default: $${config.OPPORTUNITY_THRESHOLD})
  --no-api         Skip franchise APIs (FindChips only)
  --api-only       Skip FindChips, use APIs only (fast)
  --no-headless    Run browser in visible mode
  --debug          Enable debug output
  -h, --help       Show this help
        `);
        process.exit(0);
    }
  }

  if (!mode) {
    console.error('Error: Must specify -p, -f, or --rfq');
    process.exit(1);
  }

  // Load parts
  let parts = [];
  if (mode === 'single') {
    parts = [{ rfq_number: '', mpn: partNumber, cpc: '', qty: quantity, target_price: null, customer: '' }];
  } else if (mode === 'file') {
    parts = loadPartsFromFile(filepath);
  } else if (mode === 'database') {
    parts = await loadPartsFromDatabase(rfqNumber);
  }

  if (parts.length === 0) {
    console.error('No parts to process');
    process.exit(1);
  }

  // Show active distributors
  const activeDistributors = getActiveDistributors();
  const distributorNames = activeDistributors.map(d => d.name).join(', ');

  console.log(`\nFranchise Screening`);
  console.log(`===================`);
  console.log(`Parts to screen: ${parts.length}`);
  console.log(`Opportunity threshold: $${threshold}`);
  console.log(`Franchise APIs: ${useApis ? `Enabled (${activeDistributors.length}: ${distributorNames})` : 'Disabled'}`);
  console.log(`Mode: ${apiOnly ? 'API-only (no FindChips)' : 'FindChips + APIs'}`);
  console.log(`Headless: ${headless}`);
  console.log();

  // Launch browser for FindChips (skip if api-only mode)
  let browser = null;
  if (!apiOnly) {
    browser = await chromium.launch({ headless });
  }

  const results = [];
  let skipCount = 0;
  let brokerCount = 0;
  let totalVqLines = 0;

  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      console.log(`[${i + 1}/${parts.length}] Searching: ${part.mpn} (Qty: ${part.qty})`);

      let evaluated;

      if (apiOnly) {
        // API-only mode: skip FindChips, create empty result to populate from APIs
        evaluated = evaluatePart(part, { found: false, totalQty: 0 }, threshold, 'API');
      } else {
        // 1. FindChips search (primary - for screening decision)
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();
        const findchipsResult = await findChipsSearch(page, part.mpn, debug);
        await context.close();

        // Evaluate screening decision based on FindChips
        evaluated = evaluatePart(part, findchipsResult, threshold, 'FindChips');
      }

      // 2. All franchise APIs in parallel (for VQ capture)
      if (useApis) {
        try {
          const apiResults = await searchAllDistributors(part.mpn, part.qty, {
            parallel: true,
            onResult: (r) => {
              if (debug && r.error) {
                console.log(`    [DEBUG] ${r.name} error: ${r.error}`);
              }
            },
          });

          // Capture full API pricing data (all price breaks) for market intelligence
          writePricingResult({ searchResult: apiResults, mpn: part.mpn, qty: part.qty, source: 'franchise-screening' })
            .catch(err => console.error(`  API result capture failed: ${err.message}`));

          // Log each distributor with stock
          for (const d of apiResults.distributors) {
            if (d.found && d.franchiseQty > 0 && d.vqPrice) {
              const stockInfo = d.franchiseQty > 0
                ? d.franchiseQty.toLocaleString()
                : `LT: ${d.vqLeadTime || 'N/A'}`;
              console.log(`    ${d.name}: ${stockInfo} @ $${d.vqPrice}`);
            } else if (d.found && d.franchiseQty > 0) {
              console.log(`    ${d.name}: ${d.franchiseQty.toLocaleString()} (no pricing)`);
            } else if (debug && d.error) {
              // Already logged via onResult
            }
          }

          // Build VQ lines from API results via the centralized extractor.
          // Per architectural guidance 2026-04-09: don't roll your own
          // d.vqPrice/d.vqMpn field access — use extractStockAndLtRows so
          // qty-break tier pricing and stock-vs-LT splits are handled the
          // same way across all consumers (vq-writer, sweep, enrichment, etc).
          for (const d of apiResults.found) {
            const rows = extractStockAndLtRows(d, part.mpn, part.qty || 1) || [];
            for (const row of rows) {
              if (!row.cost || row.cost <= 0) continue;
              evaluated.vq_lines.push({
                bpValue: row.vendorBP || d.bpValue,
                vendorName: row.vendorName || d.bpName,
                mpn: row.mpn || part.mpn,
                manufacturer: row.manufacturer || d.vqManufacturer || '',
                description: row.description || d.vqDescription || '',
                price: row.cost,
                qty: row.qty,
                leadTime: row.leadTime || null,
                vendorNotes: row.vendorNotes || d.vqVendorNotes || '',
                source: row.channel || d.name,
              });
            }
          }

          // Update data source label
          const apiSources = apiResults.found.filter(d => d.vqPrice > 0).map(d => d.name);
          if (apiSources.length > 0) {
            evaluated.data_source = apiOnly
              ? apiSources.join(' + ')
              : `FindChips + ${apiSources.join(' + ')}`;
          }

          // Update summary with API aggregate data (richer than FindChips alone)
          if (apiResults.summary.totalStock > evaluated.franchise_qty) {
            evaluated.franchise_qty = apiResults.summary.totalStock;
          }
          if (apiResults.summary.lowestPrice && (!evaluated.franchise_bulk_price || apiResults.summary.lowestPrice < evaluated.franchise_bulk_price)) {
            evaluated.franchise_bulk_price = apiResults.summary.lowestPrice;
          }
          evaluated.distributor_count = Math.max(
            evaluated.distributor_count,
            apiResults.summary.distributorsWithStock
          );

          // In api-only mode, re-evaluate screening decision with API data
          if (apiOnly) {
            evaluated.franchise_available = apiResults.summary.totalStock > 0;
            const bulkPrice = evaluated.franchise_bulk_price || part.target_price;
            if (bulkPrice && part.qty) {
              evaluated.opportunity_value = Math.round(bulkPrice * part.qty * 100) / 100;
            }
            if (evaluated.franchise_available && evaluated.franchise_qty >= part.qty) {
              if (evaluated.opportunity_value !== null && evaluated.opportunity_value < threshold) {
                evaluated.send_to_broker = false;
                evaluated.reason = `Franchise OK (OV: $${evaluated.opportunity_value} < $${threshold})`;
              } else if (evaluated.opportunity_value !== null) {
                evaluated.reason = `High value (OV: $${evaluated.opportunity_value})`;
              } else {
                evaluated.reason = 'Franchise available but no price data';
              }
            } else if (evaluated.franchise_available) {
              evaluated.reason = `Insufficient franchise qty (${evaluated.franchise_qty} < ${part.qty})`;
            } else {
              evaluated.reason = 'Not found in franchise distribution';
            }
          }

          totalVqLines += evaluated.vq_lines.length;

        } catch (err) {
          console.log(`    API error: ${err.message}`);
        }
      }

      results.push(evaluated);

      if (evaluated.send_to_broker) {
        brokerCount++;
      } else {
        skipCount++;
      }

      console.log(`    -> ${evaluated.reason}`);
      if (evaluated.price_warning) {
        console.log(`    !!  ${evaluated.price_warning}`);
      }

      // Rate limiting between parts
      if (i < parts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, config.SEARCH_DELAY));
      }
    }

  } finally {
    if (browser) await browser.close();
  }

  // Generate output filenames
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const prefix = rfqNumber ? `RFQ_${rfqNumber}` : 'screening';

  // Ensure output directory exists
  const outputDir = rfqNumber
    ? path.join(config.OUTPUT_DIR, `RFQ_${rfqNumber}`)
    : config.OUTPUT_DIR;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const resultsPath = path.join(outputDir, `${prefix}_FranchiseScreen_${timestamp}.xlsx`);
  const brokerPath = path.join(outputDir, `${prefix}_ForBrokerRFQ_${timestamp}.xlsx`);
  const vqPath = path.join(outputDir, `${prefix}_VQ_Import_${timestamp}.xlsx`);

  // Save results
  saveResults(results, resultsPath);
  saveBrokerList(results, brokerPath);

  // Save VQ batch (for ERP import)
  if (useApis) {
    saveVqBatch(results, vqPath, rfqNumber);
  }

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total parts screened: ${results.length}`);
  console.log(`Skip broker (franchise OK): ${skipCount}`);
  console.log(`Send to broker: ${brokerCount}`);
  if (useApis) {
    console.log(`VQ lines captured: ${totalVqLines} (across ${activeDistributors.length} distributors)`);
  }
  console.log(`\nOutput files:`);
  console.log(`  Screening results: ${resultsPath}`);
  console.log(`  Broker list:       ${brokerPath}`);
  if (useApis && totalVqLines > 0) {
    console.log(`  VQ import:         ${vqPath}`);
  }

  return 0;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
