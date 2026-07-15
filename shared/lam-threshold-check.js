#!/usr/bin/env node
/**
 * LAM Threshold Check (Decoupled)
 *
 * Compare LAM inventory levels against thresholds from Lam_Kitting_DB.xlsx
 *
 * DATA SOURCES (in order of preference):
 * 1. OT offers (getLAMInventory) — query chuboe_offer for LAM Kitting Inventory
 * 2. Infor CSVs — fallback when OT data is stale or unavailable
 *
 * This module is DECOUPLED from inventory_cleanup.js — it can run independently
 * at any time without waiting for the weekly inventory cleanup.
 *
 * Usage:
 *   # Query OT for inventory (preferred)
 *   node lam-threshold-check.js --source=ot
 *
 *   # Use Infor CSVs (fallback)
 *   node lam-threshold-check.js --source=infor --inventory-folder="/path/to/Inventory 2026-07-09"
 *
 *   # Auto-select best source
 *   node lam-threshold-check.js
 *
 * Output: JSON with reorder candidates, can be piped to sourcing/RFQ writer
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { getLAMInventoryByMPN, checkInventoryFreshness } = require('./ot-inventory-reader');
const { readCSVFile } = require('./csv-utils');

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
 * @param {string} options.source - 'ot', 'infor', or 'auto'
 * @param {string} options.inventoryFolder - Required if source='infor'
 * @param {string} options.excelPath - Path to Kitting DB (optional, auto-finds latest)
 * @param {number} options.maxStaleAgeDays - Max age for OT data to be considered fresh (default: 7)
 */
async function runThresholdCheck(options = {}) {
  const {
    source = 'auto',
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

  if (source === 'ot' || source === 'auto') {
    console.log('\nChecking OT inventory...');
    const freshness = await checkInventoryFreshness(maxStaleAgeDays);
    console.log(`  Offer: ${freshness.offerKey}`);
    console.log(`  Created: ${freshness.created}`);
    console.log(`  Age: ${freshness.ageInDays} days`);
    console.log(`  Fresh: ${freshness.fresh}`);

    if (freshness.fresh || source === 'ot') {
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
    } else if (source === 'auto' && inventoryFolder) {
      console.log(`\nOT data is stale (${freshness.ageInDays} days old), falling back to Infor CSVs...`);
      inventory = loadInventoryFromCSVs(inventoryFolder);
      metadata = { source: 'infor', folder: inventoryFolder };
      console.log(`  ${inventory.size} unique MPNs from CSVs`);
    } else if (source === 'auto') {
      console.log(`\nWARNING: OT data is stale and no inventory folder provided.`);
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
  } else if (source === 'infor') {
    if (!inventoryFolder) {
      throw new Error('--inventory-folder required when source=infor');
    }
    console.log(`\nUsing Infor CSVs from: ${inventoryFolder}`);
    inventory = loadInventoryFromCSVs(inventoryFolder);
    metadata = { source: 'infor', folder: inventoryFolder };
    console.log(`  ${inventory.size} unique MPNs from CSVs`);
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
  let inventoryFolder = null;
  let excelPath = null;
  let outputJson = false;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1];
    } else if (arg.startsWith('--inventory-folder=')) {
      inventoryFolder = arg.split('=')[1];
    } else if (arg.startsWith('--excel=')) {
      excelPath = arg.split('=')[1];
    } else if (arg === '--json') {
      outputJson = true;
    }
  }

  runThresholdCheck({ source, inventoryFolder, excelPath })
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
  compareThresholds,
  findLatestKittingDB,
};
