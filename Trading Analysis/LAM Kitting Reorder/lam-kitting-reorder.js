#!/usr/bin/env node
/**
 * LAM Kitting Reorder Script
 *
 * Compares W111 + W115 inventory levels against MIN QTY thresholds
 * to generate reorder alerts.
 *
 * Usage:
 *   node lam-kitting-reorder.js <inventory-folder> <excel-file> [output-file]
 *
 * Example:
 *   node lam-kitting-reorder.js "./Inventory 2026-03-11" "./Lam_Kitting_DB_03132026.xlsx"
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Use shared CSV utility
const { readCSVFile } = require('../../shared/csv-utils');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const W111_FILENAME = 'LAM_3PL_chuboe.csv';
const W115_FILENAME = 'LAM_Dead_Inventory_chuboe.csv';

// Column names in Chuboe output
const CHUBOE_MPN_COL = 'Chuboe_MPN';
const CHUBOE_QTY_COL = 'Qty';

// Column indices in Excel INVENTORY sheet (0-based)
const EXCEL_MPN_IDX = 1;      // Column B - MPN
const EXCEL_CPC_IDX = 0;      // Column A - Lam P/N (CPC)
const EXCEL_MIN_QTY_IDX = 8;  // Column I - MIN QTY
const EXCEL_DESC_IDX = 3;     // Column D - Item Description
const EXCEL_LEAD_TIME_IDX = 4; // Column E - Lead Time

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node lam-kitting-reorder.js <inventory-folder> <excel-file> [output-file]');
    console.error('');
    console.error('Example:');
    console.error('  node lam-kitting-reorder.js "./Inventory 2026-03-11" "./Lam_Kitting_DB_03132026.xlsx"');
    process.exit(1);
  }

  const inventoryFolder = args[0];
  const excelFile = args[1];
  const scriptDir = path.dirname(__filename);
  const outputDir = path.join(scriptDir, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputFile = args[2] || path.join(outputDir, `LAM_Reorder_Alerts_${getDateStamp()}.csv`);

  console.log('LAM Kitting Reorder');
  console.log('===================');
  console.log(`Inventory folder: ${inventoryFolder}`);
  console.log(`Excel file: ${excelFile}`);
  console.log(`Output file: ${outputFile}`);
  console.log('');

  // Step 1: Load inventory files
  console.log('Step 1: Loading inventory files...');
  const w111Path = path.join(inventoryFolder, W111_FILENAME);
  const w115Path = path.join(inventoryFolder, W115_FILENAME);

  const w111Inventory = loadChuboeInventory(w111Path, 'W111');
  const w115Inventory = loadChuboeInventory(w115Path, 'W115');

  console.log(`  W111 (LAM 3PL): ${Object.keys(w111Inventory).length} unique MPNs`);
  console.log(`  W115 (Dead Inventory): ${Object.keys(w115Inventory).length} unique MPNs`);

  // Step 2: Aggregate by MPN
  console.log('');
  console.log('Step 2: Aggregating inventory by MPN...');
  const aggregated = aggregateInventory(w111Inventory, w115Inventory);
  console.log(`  Combined: ${Object.keys(aggregated).length} unique MPNs`);

  // Step 3: Load thresholds from Excel
  console.log('');
  console.log('Step 3: Loading thresholds from Excel...');
  const thresholds = loadExcelThresholds(excelFile);
  console.log(`  Thresholds loaded: ${Object.keys(thresholds).length} MPNs`);

  // Step 4: Join and identify reorder candidates
  console.log('');
  console.log('Step 4: Identifying reorder candidates...');
  const reorderAlerts = identifyReorderCandidates(aggregated, thresholds);
  console.log(`  Reorder candidates: ${reorderAlerts.length} items`);

  // Step 5: Generate output
  console.log('');
  console.log('Step 5: Generating output...');
  writeReorderAlerts(reorderAlerts, outputFile);
  console.log(`  Output written to: ${outputFile}`);

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`Total items below threshold: ${reorderAlerts.length}`);

  if (reorderAlerts.length > 0) {
    const highPriority = reorderAlerts.filter(r => r.Priority === 'HIGH').length;
    const medPriority = reorderAlerts.filter(r => r.Priority === 'MEDIUM').length;
    const lowPriority = reorderAlerts.filter(r => r.Priority === 'LOW').length;
    console.log(`  HIGH priority: ${highPriority}`);
    console.log(`  MEDIUM priority: ${medPriority}`);
    console.log(`  LOW priority: ${lowPriority}`);
  }

  // Show unmatched stats
  const inventoryMPNs = new Set(Object.keys(aggregated));
  const thresholdMPNs = new Set(Object.keys(thresholds));
  const inInventoryNotThreshold = [...inventoryMPNs].filter(mpn => !thresholdMPNs.has(mpn));
  const inThresholdNotInventory = [...thresholdMPNs].filter(mpn => !inventoryMPNs.has(mpn));

  console.log('');
  console.log('=== Match Statistics ===');
  console.log(`  In inventory but not in Excel: ${inInventoryNotThreshold.length} MPNs`);
  console.log(`  In Excel but not in inventory: ${inThresholdNotInventory.length} MPNs`);
}

// -----------------------------------------------------------------------------
// Step 1: Load Chuboe Inventory
// -----------------------------------------------------------------------------

function loadChuboeInventory(filePath, warehouseLabel) {
  if (!fs.existsSync(filePath)) {
    console.error(`  ERROR: File not found: ${filePath}`);
    return {};
  }

  const csv = readCSVFile(filePath);
  const headers = csv.headers;

  const mpnIdx = headers.indexOf(CHUBOE_MPN_COL);
  const qtyIdx = headers.indexOf(CHUBOE_QTY_COL);

  if (mpnIdx === -1 || qtyIdx === -1) {
    console.error(`  ERROR: Required columns not found in ${filePath}`);
    console.error(`    Looking for: ${CHUBOE_MPN_COL}, ${CHUBOE_QTY_COL}`);
    console.error(`    Found: ${headers.join(', ')}`);
    return {};
  }

  const inventory = {};

  for (const row of csv.rows) {
    const mpn = (row[mpnIdx] || '').trim();
    const qty = parseFloat(row[qtyIdx]) || 0;

    if (!mpn) continue;

    // Aggregate by MPN within this warehouse (handles multiple lots)
    if (!inventory[mpn]) {
      inventory[mpn] = { qty: 0, warehouse: warehouseLabel };
    }
    inventory[mpn].qty += qty;
  }

  return inventory;
}

// -----------------------------------------------------------------------------
// Step 2: Aggregate Inventory
// -----------------------------------------------------------------------------

function aggregateInventory(w111, w115) {
  const aggregated = {};

  // Add W111 inventory
  for (const [mpn, data] of Object.entries(w111)) {
    if (!aggregated[mpn]) {
      aggregated[mpn] = { W111_Qty: 0, W115_Qty: 0, Total_Qty: 0 };
    }
    aggregated[mpn].W111_Qty = data.qty;
    aggregated[mpn].Total_Qty += data.qty;
  }

  // Add W115 inventory
  for (const [mpn, data] of Object.entries(w115)) {
    if (!aggregated[mpn]) {
      aggregated[mpn] = { W111_Qty: 0, W115_Qty: 0, Total_Qty: 0 };
    }
    aggregated[mpn].W115_Qty = data.qty;
    aggregated[mpn].Total_Qty += data.qty;
  }

  return aggregated;
}

// -----------------------------------------------------------------------------
// Step 3: Load Excel Thresholds
// -----------------------------------------------------------------------------

function loadExcelThresholds(excelPath) {
  if (!fs.existsSync(excelPath)) {
    console.error(`  ERROR: Excel file not found: ${excelPath}`);
    return {};
  }

  const workbook = XLSX.readFile(excelPath);
  const sheet = workbook.Sheets['INVENTORY'];

  if (!sheet) {
    console.error('  ERROR: INVENTORY sheet not found in Excel file');
    return {};
  }

  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const thresholds = {};

  // Skip header row (index 0)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;

    const mpn = (row[EXCEL_MPN_IDX] || '').toString().trim();
    const cpc = (row[EXCEL_CPC_IDX] || '').toString().trim();
    const minQty = parseFloat(row[EXCEL_MIN_QTY_IDX]) || 0;
    const description = (row[EXCEL_DESC_IDX] || '').toString().trim();
    const leadTime = (row[EXCEL_LEAD_TIME_IDX] || '').toString().trim();

    if (!mpn) continue;

    thresholds[mpn] = {
      CPC: cpc,
      MIN_QTY: minQty,
      Description: description,
      Lead_Time: leadTime
    };
  }

  return thresholds;
}

// -----------------------------------------------------------------------------
// Step 4: Identify Reorder Candidates
// -----------------------------------------------------------------------------

function identifyReorderCandidates(aggregated, thresholds) {
  const alerts = [];

  for (const [mpn, invData] of Object.entries(aggregated)) {
    const threshold = thresholds[mpn];

    if (!threshold) {
      // MPN not in Excel - skip (or could flag as "unknown threshold")
      continue;
    }

    const minQty = threshold.MIN_QTY;
    const totalQty = invData.Total_Qty;

    if (totalQty < minQty) {
      const shortfall = minQty - totalQty;
      const shortfallPct = minQty > 0 ? (shortfall / minQty) * 100 : 0;

      // Priority based on shortfall percentage
      let priority;
      if (shortfallPct >= 75) {
        priority = 'HIGH';      // 75%+ shortfall
      } else if (shortfallPct >= 50) {
        priority = 'MEDIUM';    // 50-74% shortfall
      } else {
        priority = 'LOW';       // <50% shortfall
      }

      alerts.push({
        CPC: threshold.CPC,
        MPN: mpn,
        Description: threshold.Description,
        W111_Qty: invData.W111_Qty,
        W115_Qty: invData.W115_Qty,
        Total_Qty: totalQty,
        MIN_QTY: minQty,
        Shortfall: shortfall,
        Shortfall_Pct: shortfallPct.toFixed(1) + '%',
        Lead_Time: threshold.Lead_Time,
        Priority: priority
      });
    }
  }

  // Sort by priority (HIGH first), then by shortfall descending
  const priorityOrder = { 'HIGH': 0, 'MEDIUM': 1, 'LOW': 2 };
  alerts.sort((a, b) => {
    if (priorityOrder[a.Priority] !== priorityOrder[b.Priority]) {
      return priorityOrder[a.Priority] - priorityOrder[b.Priority];
    }
    return b.Shortfall - a.Shortfall;
  });

  return alerts;
}

// -----------------------------------------------------------------------------
// Step 5: Write Output
// -----------------------------------------------------------------------------

function writeReorderAlerts(alerts, outputPath) {
  const headers = [
    'CPC',
    'MPN',
    'Description',
    'W111_Qty',
    'W115_Qty',
    'Total_Qty',
    'MIN_QTY',
    'Shortfall',
    'Shortfall_Pct',
    'Lead_Time',
    'Priority'
  ];

  const lines = [headers.join(',')];

  for (const alert of alerts) {
    const row = headers.map(h => {
      const val = alert[h];
      // Quote strings that might contain commas
      if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val ?? '';
    });
    lines.push(row.join(','));
  }

  fs.writeFileSync(outputPath, lines.join('\n'));
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function getDateStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
