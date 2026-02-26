#!/usr/bin/env node
/**
 * TrustedParts Franchise Screening Tool
 *
 * Screens RFQ parts against TrustedParts to identify low-value opportunities
 * that don't need broker sourcing.
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
      'Franchise Avail', 'Franchise Qty', 'Franchise Price', 'Opportunity Value',
      'Send to Broker', 'Reason', 'Distributor Count'
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
      r.opportunity_value || '',
      r.send_to_broker ? 'Yes' : 'No',
      r.reason,
      r.distributor_count,
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
  const brokerParts = results.filter(r => r.send_to_broker);

  const wsData = [
    ['RFQ Number', 'MPN', 'CPC', 'Qty', 'Target Price', 'Customer', 'Opportunity Value'],
  ];

  for (const r of brokerParts) {
    wsData.push([
      r.rfq_number,
      r.mpn,
      r.cpc,
      r.qty,
      r.target_price || '',
      r.customer || '',
      r.opportunity_value || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Broker RFQ List');
  XLSX.writeFile(wb, outputPath);
  console.log(`Broker list saved to: ${outputPath} (${brokerParts.length} parts)`);
}

// =============================================================================
// Screening Logic
// =============================================================================

function evaluatePart(part, searchResult, threshold) {
  const result = {
    ...part,
    franchise_available: searchResult.found,
    franchise_qty: searchResult.totalQty,
    franchise_price: searchResult.lowestPrice,
    distributor_count: searchResult.distributorCount,
    opportunity_value: null,
    send_to_broker: true,
    reason: '',
  };

  // Calculate opportunity value
  const price = searchResult.lowestPrice || part.target_price;
  if (price && part.qty) {
    result.opportunity_value = Math.round(price * part.qty * 100) / 100;
  }

  // Decision logic:
  // Skip broker if: franchise has enough qty AND opportunity value < threshold
  if (searchResult.found && searchResult.totalQty >= part.qty) {
    if (result.opportunity_value !== null && result.opportunity_value < threshold) {
      result.send_to_broker = false;
      result.reason = `Franchise OK (OV: $${result.opportunity_value} < $${threshold})`;
    } else if (result.opportunity_value !== null) {
      result.reason = `High value (OV: $${result.opportunity_value})`;
    } else {
      result.reason = 'Franchise available but no price data';
    }
  } else if (searchResult.found) {
    result.reason = `Insufficient franchise qty (${searchResult.totalQty} < ${part.qty})`;
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
  let threshold = config.OPPORTUNITY_THRESHOLD;
  let headless = true;
  let debug = false;

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
      case '--debug':
        debug = true;
        break;
      case '-h':
      case '--help':
        console.log(`
TrustedParts Franchise Screening Tool

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
  --no-headless    Run browser in visible mode
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

  console.log(`\nTrustedParts Screening`);
  console.log(`======================`);
  console.log(`Parts to screen: ${parts.length}`);
  console.log(`Opportunity threshold: $${threshold}`);
  console.log(`Headless: ${headless}`);
  console.log();

  // Launch browser
  const browser = await chromium.launch({ headless });

  const results = [];
  let skipCount = 0;
  let brokerCount = 0;

  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      console.log(`[${i + 1}/${parts.length}] Searching: ${part.mpn} (Qty: ${part.qty})`);

      // Create fresh context for each search to avoid session state issues
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      const searchResult = await searchPart(page, part.mpn, debug);
      await context.close();
      const evaluated = evaluatePart(part, searchResult, threshold);
      results.push(evaluated);

      if (evaluated.send_to_broker) {
        brokerCount++;
      } else {
        skipCount++;
      }

      console.log(`    → ${evaluated.reason}`);

      // Rate limiting (use native setTimeout since page context is closed)
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

  const resultsPath = path.join(outputDir, `${prefix}_TrustedParts_${timestamp}.xlsx`);
  const brokerPath = path.join(outputDir, `${prefix}_ForBrokerRFQ_${timestamp}.xlsx`);

  // Save results
  saveResults(results, resultsPath);
  saveBrokerList(results, brokerPath);

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total parts screened: ${results.length}`);
  console.log(`Skip broker (franchise OK): ${skipCount}`);
  console.log(`Send to broker: ${brokerCount}`);
  console.log(`\nOutput files:`);
  console.log(`  Full results: ${resultsPath}`);
  console.log(`  Broker list:  ${brokerPath}`);

  return 0;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
