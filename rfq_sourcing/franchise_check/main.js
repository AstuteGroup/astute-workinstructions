#!/usr/bin/env node
/**
 * Franchise Screening Tool
 *
 * Screens RFQ parts against franchise distributors (DigiKey API + FindChips fallback)
 * to identify low-value opportunities that don't need broker sourcing.
 *
 * Also captures franchise pricing as VQs for ERP import.
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
 *   # Skip DigiKey API (FindChips only)
 *   node main.js --rfq 1130292 --no-digikey
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const config = require('./config');
const { searchPart } = require('./search');
const digikey = require('./digikey');

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
      r.franchise_bulk_price || '',  // Last column / bulk pricing
      r.opportunity_value || '',
      r.send_to_broker ? 'Yes' : 'No',
      r.reason,
      r.distributor_count,
      r.price_warning || '',  // Flag for suspect pricing
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Screening Results');
  XLSX.writeFile(wb, outputPath);
  console.log(`Results saved to: ${outputPath}`);
}

function saveBrokerList(results, outputPath) {
  // Save only parts that should go to brokers, with all needed fields
  // Includes franchise data needed by RFQ Sourcing for min order value filtering
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
      r.franchise_bulk_price || '',  // Needed by RFQ Sourcing for min order value filter
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
 * (regardless of whether they go to broker or not)
 */
function saveVqBatch(results, outputPath, rfqNumber) {
  // Filter to parts with franchise availability and pricing
  const vqParts = results.filter(r => r.franchise_available && r.vq_price);

  if (vqParts.length === 0) {
    console.log('No VQ data to export (no franchise pricing found)');
    return;
  }

  // VQ Mass Upload Template format
  // See: rfq_sourcing/vq_loading/vq-loading.md for field reference
  const wsData = [
    [
      'RFQ Number',           // For reference (not in upload template)
      'BP Value',             // Vendor BP Value
      'Vendor Name',          // For reference
      'MPN',                  // Part number
      'Manufacturer',         // Mfr name
      'Description',          // Part description
      'Qty',                  // Quantity quoted (RFQ qty)
      'Price',                // Price at RFQ qty
      'Currency',             // USD
      'Vendor Notes',         // Stock info + DigiKey PN
      'Source',               // Data source (DigiKey API, FindChips)
    ],
  ];

  for (const r of vqParts) {
    wsData.push([
      r.rfq_number || rfqNumber || '',
      r.vq_bp_value || '',
      r.vq_vendor_name || '',
      r.vq_mpn || r.mpn,
      r.vq_manufacturer || '',
      r.vq_description || '',
      r.qty,
      r.vq_price,
      'USD',
      r.vq_vendor_notes || '',
      r.data_source || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'VQ Import');
  XLSX.writeFile(wb, outputPath);
  console.log(`VQ batch saved to: ${outputPath} (${vqParts.length} parts)`);
}

// =============================================================================
// Screening Logic
// =============================================================================

/**
 * Evaluate a part for screening decision
 * @param {Object} part - Part from RFQ
 * @param {Object} searchResult - Result from DigiKey or FindChips
 * @param {number} threshold - Opportunity value threshold
 * @param {string} dataSource - 'DigiKey API' or 'FindChips'
 */
function evaluatePart(part, searchResult, threshold, dataSource = 'FindChips') {
  const result = {
    ...part,
    franchise_available: searchResult.found,
    franchise_qty: searchResult.totalQty || searchResult.franchiseQty || 0,
    franchise_price: searchResult.lowestPrice || searchResult.franchisePrice || null,
    franchise_bulk_price: searchResult.bulkPrice || searchResult.franchiseBulkPrice || null,
    franchise_rfq_price: searchResult.franchiseRfqPrice || null,  // Price at RFQ qty
    distributor_count: searchResult.distributorCount || (searchResult.found ? 1 : 0),
    price_warning: searchResult.priceWarning || '',
    opportunity_value: null,
    send_to_broker: true,
    reason: '',
    data_source: dataSource,
    // VQ fields (for ERP import)
    vq_price: null,
    vq_mpn: null,
    vq_manufacturer: null,
    vq_description: null,
    vq_vendor_notes: null,
    vq_bp_value: null,
    vq_vendor_name: null,
  };

  // Populate VQ fields if from DigiKey
  if (dataSource === 'DigiKey API' && searchResult.found) {
    result.vq_price = searchResult.franchiseRfqPrice || searchResult.vqPrice;
    result.vq_mpn = searchResult.vqMpn || part.mpn;
    result.vq_manufacturer = searchResult.vqManufacturer || '';
    result.vq_description = searchResult.vqDescription || '';
    result.vq_vendor_notes = searchResult.vqVendorNotes || '';
    result.vq_bp_value = digikey.DIGIKEY_CONFIG.bpValue;
    result.vq_vendor_name = digikey.DIGIKEY_CONFIG.bpName;
  }

  // For FindChips, we can still capture VQ data but with less detail
  if (dataSource === 'FindChips' && searchResult.found && searchResult.lowestPrice) {
    // Use lowest price as approximation for RFQ qty price
    result.vq_price = searchResult.lowestPrice;
    result.vq_mpn = part.mpn;
    result.vq_vendor_notes = `FindChips aggregate stock: ${result.franchise_qty}`;
    // Can't assign a single BP for FindChips - multiple distributors
  }

  // Calculate opportunity value using BULK price for realistic secondary market valuation
  // Bulk price = best available franchise price (for screening decision)
  const bulkPrice = result.franchise_bulk_price || result.franchise_price || part.target_price;
  if (bulkPrice && part.qty) {
    result.opportunity_value = Math.round(bulkPrice * part.qty * 100) / 100;
  }

  // Decision logic:
  // Skip broker if: franchise has enough qty AND opportunity value < threshold
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

/**
 * Search DigiKey API for a part
 * Returns normalized result compatible with evaluatePart()
 */
async function searchDigiKey(mpn, qty) {
  try {
    const result = await digikey.searchPart(mpn, qty);
    return {
      found: result.found,
      franchiseQty: result.franchiseQty,
      franchisePrice: result.franchisePrice,
      franchiseBulkPrice: result.franchiseBulkPrice,
      franchiseRfqPrice: result.franchiseRfqPrice,
      vqPrice: result.vqPrice,
      vqMpn: result.vqMpn,
      vqManufacturer: result.vqManufacturer,
      vqDescription: result.vqDescription,
      vqVendorNotes: result.vqVendorNotes,
      distributorCount: 1,  // DigiKey is single source
      error: null,
    };
  } catch (error) {
    return {
      found: false,
      error: error.message,
    };
  }
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
  let threshold = config.OPPORTUNITY_THRESHOLD;
  let headless = true;
  let debug = false;
  let useDigiKey = true;  // Try DigiKey API first by default

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
      case '--no-digikey':
        useDigiKey = false;
        break;
      case '--debug':
        debug = true;
        break;
      case '-h':
      case '--help':
        console.log(`
Franchise Screening Tool (FindChips + DigiKey API)

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
  --no-digikey     Skip DigiKey API (no VQ capture)
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

  console.log(`\nFranchise Screening`);
  console.log(`===================`);
  console.log(`Parts to screen: ${parts.length}`);
  console.log(`Opportunity threshold: $${threshold}`);
  console.log(`DigiKey API: ${useDigiKey ? 'Enabled (VQ capture)' : 'Disabled'}`);
  console.log(`Headless: ${headless}`);
  console.log();

  // Launch browser for FindChips
  const browser = await chromium.launch({ headless });

  const results = [];
  let skipCount = 0;
  let brokerCount = 0;
  let vqCount = 0;

  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      console.log(`[${i + 1}/${parts.length}] Searching: ${part.mpn} (Qty: ${part.qty})`);

      // 1. FindChips search (primary - for screening decision)
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      const findchipsResult = await searchPart(page, part.mpn, debug);
      await context.close();

      // Evaluate screening decision based on FindChips
      const evaluated = evaluatePart(part, findchipsResult, threshold, 'FindChips');

      // 2. DigiKey API call (additional - for VQ capture)
      if (useDigiKey) {
        try {
          const dkResult = await searchDigiKey(part.mpn, part.qty);
          if (dkResult.found && dkResult.vqPrice) {
            // Merge DigiKey VQ data into result
            evaluated.vq_price = dkResult.vqPrice;
            evaluated.vq_mpn = dkResult.vqMpn;
            evaluated.vq_manufacturer = dkResult.vqManufacturer;
            evaluated.vq_description = dkResult.vqDescription;
            evaluated.vq_vendor_notes = dkResult.vqVendorNotes;
            evaluated.vq_bp_value = digikey.DIGIKEY_CONFIG.bpValue;
            evaluated.vq_vendor_name = digikey.DIGIKEY_CONFIG.bpName;
            evaluated.data_source = 'FindChips + DigiKey';
            vqCount++;
            console.log(`    📦 DigiKey: ${dkResult.franchiseQty} @ $${dkResult.vqPrice}`);
          } else if (dkResult.error) {
            if (debug) console.log(`    [DEBUG] DigiKey error: ${dkResult.error}`);
          }
        } catch (err) {
          if (debug) console.log(`    [DEBUG] DigiKey error: ${err.message}`);
        }
      }

      results.push(evaluated);

      if (evaluated.send_to_broker) {
        brokerCount++;
      } else {
        skipCount++;
      }

      console.log(`    → ${evaluated.reason}`);
      if (evaluated.price_warning) {
        console.log(`    ⚠️  ${evaluated.price_warning}`);
      }

      // Rate limiting
      if (i < parts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, config.SEARCH_DELAY));
      }
    }

  } finally {
    await browser.close();
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
  if (useDigiKey) {
    saveVqBatch(results, vqPath, rfqNumber);
  }

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total parts screened: ${results.length}`);
  console.log(`Skip broker (franchise OK): ${skipCount}`);
  console.log(`Send to broker: ${brokerCount}`);
  if (useDigiKey) {
    console.log(`VQ data captured (DigiKey): ${vqCount}`);
  }
  console.log(`\nOutput files:`);
  console.log(`  Screening results: ${resultsPath}`);
  console.log(`  Broker list:       ${brokerPath}`);
  if (useDigiKey && vqCount > 0) {
    console.log(`  VQ import:         ${vqPath}`);
  }

  return 0;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
