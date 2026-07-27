#!/usr/bin/env node
/**
 * LAM Threshold Check (Decoupled)
 *
 * Compare LAM inventory levels against thresholds from Lam_Kitting_DB.xlsx
 *
 * DATA SOURCES (in order of preference):
 * 1. OT offers (getLAMInventory) — query chuboe_offer for LAM Kitting Inventory
 * 2. Infor xlsx (inventory-parser) — parse fresh xlsx directly, no cleanup needed
 * 3. Infor CSVs — legacy fallback from inventory cleanup output
 *
 * This module is DECOUPLED from inventory_cleanup.js — it can run independently
 * at any time without waiting for the weekly inventory cleanup.
 *
 * Usage:
 *   # Query OT for inventory (preferred)
 *   node lam-threshold-check.js --source=ot
 *
 *   # Parse Infor xlsx directly (recommended when OT is stale)
 *   node lam-threshold-check.js --source=xlsx --xlsx-path="/path/to/ASTItemLotsReport.xlsx"
 *
 *   # Use pre-parsed CSVs (legacy)
 *   node lam-threshold-check.js --source=csv --inventory-folder="/path/to/Inventory 2026-07-09"
 *
 *   # Auto-select best source (OT if fresh, else xlsx if available, else CSV)
 *   node lam-threshold-check.js
 *
 * Output: JSON with reorder candidates, can be piped to sourcing/RFQ writer
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { getLAMInventoryByMPN, checkInventoryFreshness } = require('./ot-inventory-reader');
const { readCSVFile } = require('./csv-utils');
const { parseInventoryFile, getWarehouseRows } = require('./inventory-parser');

const LAM_3PL_DIR = path.join(__dirname, '../Trading Analysis/LAM 3PL');

/**
 * Find the latest Lam_Kitting_DB Excel file
 */
function findLatestKittingDB() {
  const files = fs.readdirSync(LAM_3PL_DIR)
    .filter(f => f.match(/^Lam_Kitting_DB.*\.xlsx$/))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error('No Lam_Kitting_DB*.xlsx found in ' + LAM_3PL_DIR);
  }

  return path.join(LAM_3PL_DIR, files[0]);
}

/**
 * Load threshold data from Kitting DB Excel
 *
 * @returns {Map<string, { mpn, cpc, threshold, moq, mfr, basePrice, resalePrice, leadTime, buyer }>}
 */
function loadThresholds(excelPath) {
  const wb = XLSX.readFile(excelPath, { raw: true });
  const ws = wb.Sheets['INVENTORY'];
  const data = XLSX.utils.sheet_to_json(ws, { raw: true });

  const thresholds = new Map();

  for (const row of data) {
    const mpn = (row['MPN'] || '').toString().trim();
    if (!mpn) continue;

    // Normalize MPN for matching (uppercase, trim)
    const mpnKey = mpn.toUpperCase();

    thresholds.set(mpnKey, {
      mpn: mpn,
      cpc: row['Lam P/N'] || '',
      mfr: row['Manufacturer'] || '',
      description: row['Item Description'] || '',
      threshold: parseFloat(row['MIN QTY']) || 0,
      moq: parseFloat(row['MOQ']) || 0,
      basePrice: parseFloat(row['Base Unit Price']) || 0,
      resalePrice: parseFloat(row['Resale Price']) || 0,
      leadTime: row['Lead Time'] || '',
      buyer: row['Buyer'] || '',
      notes: row['Notes'] || '',
    });
  }

  return thresholds;
}

/**
 * Load inventory from Infor CSVs (fallback path)
 *
 * @param {string} inventoryFolder - Path to "Inventory YYYY-MM-DD" folder
 * @returns {Map<string, { qty: number }>}
 */
function loadInventoryFromCSVs(inventoryFolder) {
  const byMPN = new Map();

  const csvFiles = [
    'W111_LAM_3PL.csv',
    'W115_LAM_Dead_Inventory.csv',
  ];

  for (const csvFile of csvFiles) {
    const csvPath = path.join(inventoryFolder, csvFile);
    if (!fs.existsSync(csvPath)) {
      console.warn(`  WARNING: ${csvFile} not found in ${inventoryFolder}`);
      continue;
    }

    const rows = readCSVFile(csvPath);
    for (const row of rows) {
      const mpn = (row['Chuboe_MPN'] || row['Item'] || '').toString().trim();
      if (!mpn) continue;

      const mpnKey = mpn.toUpperCase();
      const qty = parseFloat(row['Qty'] || row['Lot Quantity'] || 0);

      if (byMPN.has(mpnKey)) {
        byMPN.get(mpnKey).qty += qty;
      } else {
        byMPN.set(mpnKey, { mpn, qty });
      }
    }
  }

  return byMPN;
}

/**
 * Load inventory from Infor xlsx using the inventory parser
 *
 * @param {string} xlsxPath - Path to ASTItemLotsReport xlsx file
 * @returns {Map<string, { qty: number }>}
 */
function loadInventoryFromXlsx(xlsxPath) {
  console.log(`  Parsing: ${path.basename(xlsxPath)}`);
  const result = parseInventoryFile(xlsxPath);

  console.log(`  Total rows: ${result.metadata.uniqueRows}`);
  console.log(`  Warehouses: ${Object.keys(result.byWarehouse).join(', ')}`);

  // Get LAM warehouses (W111 + W115 for threshold check)
  // Note: W118 (consignment) typically not included in threshold check
  const lamRows = getWarehouseRows(result, ['W111', 'W115']);
  console.log(`  LAM rows (W111+W115): ${lamRows.length}`);

  // Aggregate by MPN
  const byMPN = new Map();

  for (const row of lamRows) {
    const mpn = (row.mpn || '').trim();
    if (!mpn) continue;

    const mpnKey = mpn.toUpperCase();
    const qty = row.qty || 0;

    if (byMPN.has(mpnKey)) {
      byMPN.get(mpnKey).qty += qty;
    } else {
      byMPN.set(mpnKey, { mpn, qty });
    }
  }

  return {
    byMPN,
    metadata: {
      source: 'xlsx',
      file: path.basename(xlsxPath),
      totalRows: result.metadata.uniqueRows,
      lamRows: lamRows.length,
      uniqueMPNs: byMPN.size,
      parsedAt: result.metadata.parsedAt,
    },
  };
}

/**
 * Find the most recent Infor xlsx in common locations
 *
 * @returns {string|null} Path to xlsx or null if not found
 */
function findLatestInforXlsx() {
  const searchPaths = [
    '/home/analytics_user/workspace/file-drop',
    '/home/analytics_user/workspace',
    '/tmp',
  ];

  for (const dir of searchPaths) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir)
      .filter(f => f.match(/^ASTItemLotsReport.*\.xlsx$/i))
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        mtime: fs.statSync(path.join(dir, f)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      return files[0].path;
    }
  }

  return null;
}

/**
 * Compare inventory against thresholds
 *
 * @param {Map} inventory - MPN -> { qty, ... }
 * @param {Map} thresholds - MPN -> { threshold, moq, ... }
 * @returns {Array} Reorder candidates sorted by priority
 */
function compareThresholds(inventory, thresholds) {
  const candidates = [];

  for (const [mpnKey, threshold] of thresholds) {
    const inv = inventory.get(mpnKey);
    const qty = inv ? inv.qty : 0;
    const shortfall = threshold.threshold - qty;

    if (shortfall > 0) {
      // Determine priority
      let priority;
      const shortfallPct = shortfall / threshold.threshold;

      if (qty === 0) {
        priority = 'CRITICAL';
      } else if (shortfallPct >= 0.75) {
        priority = 'HIGH';
      } else if (shortfallPct >= 0.5) {
        priority = 'MEDIUM';
      } else {
        priority = 'LOW';
      }

      candidates.push({
        mpn: threshold.mpn,
        cpc: threshold.cpc,
        mfr: threshold.mfr,
        description: threshold.description,
        qtyOnHand: qty,
        threshold: threshold.threshold,
        shortfall,
        shortfallPct: Math.round(shortfallPct * 100),
        priority,
        moq: threshold.moq,
        basePrice: threshold.basePrice,
        resalePrice: threshold.resalePrice,
        leadTime: threshold.leadTime,
        buyer: threshold.buyer,
      });
    }
  }

  // Sort by priority (CRITICAL first)
  const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  candidates.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.shortfallPct - a.shortfallPct; // Higher shortfall % first
  });

  return candidates;
}

/**
 * Run threshold check
 *
 * @param {Object} options
 * @param {string} options.source - 'ot', 'xlsx', 'csv', or 'auto'
 * @param {string} options.xlsxPath - Path to Infor xlsx (required if source='xlsx')
 * @param {string} options.inventoryFolder - Path to CSV folder (required if source='csv')
 * @param {string} options.excelPath - Path to Kitting DB (optional, auto-finds latest)
 * @param {number} options.maxStaleAgeDays - Max age for OT data to be considered fresh (default: 7)
 */
async function runThresholdCheck(options = {}) {
  const {
    source = 'auto',
    xlsxPath = null,
    inventoryFolder = null,
    excelPath = null,
    maxStaleAgeDays = 7,
  } = options;

  console.log('LAM Threshold Check (Decoupled)');
  console.log('================================');

  // Load thresholds
  const dbPath = excelPath || findLatestKittingDB();
  console.log(`Kitting DB: ${path.basename(dbPath)}`);
  const thresholds = loadThresholds(dbPath);
  console.log(`  ${thresholds.size} items with thresholds`);

  // Determine inventory source
  let inventory;
  let metadata = {};

  // Source: xlsx — parse Infor xlsx directly
  if (source === 'xlsx') {
    if (!xlsxPath) {
      throw new Error('--xlsx-path required when source=xlsx');
    }
    console.log(`\nUsing Infor xlsx...`);
    const result = loadInventoryFromXlsx(xlsxPath);
    inventory = result.byMPN;
    metadata = result.metadata;
    console.log(`  ${inventory.size} unique MPNs from xlsx`);
  }
  // Source: csv — use pre-parsed CSVs (legacy)
  else if (source === 'csv') {
    if (!inventoryFolder) {
      throw new Error('--inventory-folder required when source=csv');
    }
    console.log(`\nUsing Infor CSVs from: ${inventoryFolder}`);
    inventory = loadInventoryFromCSVs(inventoryFolder);
    metadata = { source: 'csv', folder: inventoryFolder };
    console.log(`  ${inventory.size} unique MPNs from CSVs`);
  }
  // Source: ot — query OT directly
  else if (source === 'ot') {
    console.log('\nUsing OT inventory data...');
    const result = await getLAMInventoryByMPN();
    inventory = result.byMPN;
    metadata = {
      source: 'ot',
      offerKey: result.metadata.offerKey,
      offerCreated: result.metadata.created,
      ageInDays: result.metadata.ageInDays,
    };
    console.log(`  ${inventory.size} unique MPNs from OT`);
  }
  // Source: auto — try OT first, then xlsx, then csv
  else if (source === 'auto') {
    console.log('\nChecking OT inventory...');
    const freshness = await checkInventoryFreshness(maxStaleAgeDays);
    console.log(`  Offer: ${freshness.offerKey}`);
    console.log(`  Created: ${freshness.created}`);
    console.log(`  Age: ${freshness.ageInDays} days`);
    console.log(`  Fresh: ${freshness.fresh}`);

    if (freshness.fresh) {
      console.log('\nUsing OT inventory data...');
      const result = await getLAMInventoryByMPN();
      inventory = result.byMPN;
      metadata = {
        source: 'ot',
        offerKey: result.metadata.offerKey,
        offerCreated: result.metadata.created,
        ageInDays: result.metadata.ageInDays,
      };
      console.log(`  ${inventory.size} unique MPNs from OT`);
    } else {
      // OT stale — try xlsx first
      const autoXlsx = xlsxPath || findLatestInforXlsx();
      if (autoXlsx && fs.existsSync(autoXlsx)) {
        console.log(`\nOT data is stale (${freshness.ageInDays} days old), falling back to Infor xlsx...`);
        const result = loadInventoryFromXlsx(autoXlsx);
        inventory = result.byMPN;
        metadata = result.metadata;
        console.log(`  ${inventory.size} unique MPNs from xlsx`);
      } else if (inventoryFolder && fs.existsSync(inventoryFolder)) {
        // No xlsx, try CSV
        console.log(`\nOT data is stale, no xlsx found, falling back to CSVs...`);
        inventory = loadInventoryFromCSVs(inventoryFolder);
        metadata = { source: 'csv', folder: inventoryFolder };
        console.log(`  ${inventory.size} unique MPNs from CSVs`);
      } else {
        // No fallback available — use stale OT data
        console.log(`\nWARNING: OT data is stale and no fallback available.`);
        console.log(`  Using stale OT data anyway...`);
        const result = await getLAMInventoryByMPN();
        inventory = result.byMPN;
        metadata = {
          source: 'ot',
          offerKey: result.metadata.offerKey,
          offerCreated: result.metadata.created,
          ageInDays: result.metadata.ageInDays,
          stale: true,
        };
        console.log(`  ${inventory.size} unique MPNs from OT (STALE)`);
      }
    }
  }

  // Compare thresholds
  console.log('\nComparing inventory vs thresholds...');
  const candidates = compareThresholds(inventory, thresholds);

  // Count by priority
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of candidates) {
    counts[c.priority]++;
  }

  console.log('\n=== RESULTS ===');
  console.log(`Total below threshold: ${candidates.length}`);
  console.log(`  CRITICAL (zero stock): ${counts.CRITICAL}`);
  console.log(`  HIGH (75%+ shortfall): ${counts.HIGH}`);
  console.log(`  MEDIUM (50-74% shortfall): ${counts.MEDIUM}`);
  console.log(`  LOW (<50% shortfall): ${counts.LOW}`);

  // Close the pool
  const { close } = require('./ot-inventory-reader');
  await close();

  return {
    metadata,
    thresholdCount: thresholds.size,
    inventoryCount: inventory.size,
    candidates,
    counts,
  };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  let source = 'auto';
  let xlsxPath = null;
  let inventoryFolder = null;
  let excelPath = null;
  let outputJson = false;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1];
    } else if (arg.startsWith('--xlsx-path=')) {
      xlsxPath = arg.split('=')[1];
    } else if (arg.startsWith('--inventory-folder=')) {
      inventoryFolder = arg.split('=')[1];
    } else if (arg.startsWith('--excel=')) {
      excelPath = arg.split('=')[1];
    } else if (arg === '--json') {
      outputJson = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
LAM Threshold Check

Usage:
  node lam-threshold-check.js [options]

Options:
  --source=TYPE      Data source: ot, xlsx, csv, auto (default: auto)
  --xlsx-path=PATH   Path to Infor xlsx (required if source=xlsx)
  --inventory-folder=PATH  Path to CSV folder (required if source=csv)
  --excel=PATH       Path to Kitting DB xlsx (default: auto-find latest)
  --json             Output results as JSON
  --help             Show this help

Examples:
  # Auto-select best source (OT if fresh, else xlsx, else CSV)
  node lam-threshold-check.js

  # Use OT data
  node lam-threshold-check.js --source=ot

  # Parse Infor xlsx directly
  node lam-threshold-check.js --source=xlsx --xlsx-path=/path/to/ASTItemLotsReport.xlsx

  # Use pre-parsed CSVs (legacy)
  node lam-threshold-check.js --source=csv --inventory-folder=/path/to/Inventory-2026-07-09
`);
      process.exit(0);
    }
  }

  runThresholdCheck({ source, xlsxPath, inventoryFolder, excelPath })
    .then(result => {
      if (outputJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('\nTop 10 CRITICAL items:');
        result.candidates
          .filter(c => c.priority === 'CRITICAL')
          .slice(0, 10)
          .forEach(c => {
            console.log(`  ${c.mpn} | ${c.mfr} | qty: ${c.qtyOnHand} | threshold: ${c.threshold}`);
          });
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('ERROR:', err.message);
      process.exit(1);
    });
}

module.exports = {
  runThresholdCheck,
  loadThresholds,
  loadInventoryFromCSVs,
  loadInventoryFromXlsx,
  compareThresholds,
  findLatestKittingDB,
  findLatestInforXlsx,
};
