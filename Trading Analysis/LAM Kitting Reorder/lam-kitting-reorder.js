#!/usr/bin/env node
/**
 * LAM Kitting Reorder Script
 *
 * Compares W111 + W115 inventory levels against MIN QTY thresholds
 * to generate reorder alerts with historical purchase data.
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
const { execSync } = require('child_process');

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
// A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, I=8, J=9, K=10, L=11
const EXCEL = {
  CPC: 0,           // A - Lam P/N
  MPN: 1,           // B - MPN
  MANUFACTURER: 2,  // C - Manufacturer
  DESCRIPTION: 3,   // D - Item Description
  LEAD_TIME: 4,     // E - Lead Time
  QTY_ON_HAND: 5,   // F - QTY ON HAND (we'll use our calculated total)
  BASE_PRICE: 6,    // G - Base Unit Price
  RESALE_PRICE: 7,  // H - Resale Price
  MIN_QTY: 8,       // I - MIN QTY
  // STATUS: 9,     // J - STATUS (excluded)
  MOQ: 10,          // K - MOQ
  LAM_OWNED: 11     // L - Lam Owned Inventory? (made dynamic)
};

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

  // Step 3: Load thresholds from Excel (all columns A-L except J)
  console.log('');
  console.log('Step 3: Loading data from Excel...');
  const excelData = loadExcelData(excelFile);
  console.log(`  Excel rows loaded: ${Object.keys(excelData).length} MPNs`);

  // Step 4: Load historical purchase data from ERP
  console.log('');
  console.log('Step 4: Loading historical purchase data from ERP...');
  const mpnsToQuery = Object.keys(aggregated);
  const historicalData = loadHistoricalPurchaseData(mpnsToQuery);
  console.log(`  Historical data found: ${Object.keys(historicalData).length} MPNs`);

  // Step 5: Join and identify reorder candidates
  console.log('');
  console.log('Step 5: Identifying reorder candidates...');
  const reorderAlerts = identifyReorderCandidates(aggregated, excelData, historicalData);
  console.log(`  Reorder candidates: ${reorderAlerts.length} items`);

  // Step 6: Generate output
  console.log('');
  console.log('Step 6: Generating output...');
  writeReorderAlerts(reorderAlerts, outputFile);
  console.log(`  Output written to: ${outputFile}`);

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`Total items below threshold: ${reorderAlerts.length}`);

  if (reorderAlerts.length > 0) {
    const criticalPriority = reorderAlerts.filter(r => r.Priority === 'CRITICAL').length;
    const highPriority = reorderAlerts.filter(r => r.Priority === 'HIGH').length;
    const medPriority = reorderAlerts.filter(r => r.Priority === 'MEDIUM').length;
    const lowPriority = reorderAlerts.filter(r => r.Priority === 'LOW').length;
    console.log(`  CRITICAL priority (zero stock): ${criticalPriority}`);
    console.log(`  HIGH priority: ${highPriority}`);
    console.log(`  MEDIUM priority: ${medPriority}`);
    console.log(`  LOW priority: ${lowPriority}`);

    const withHistory = reorderAlerts.filter(r => r['Previous Supplier']).length;
    console.log(`  With historical purchase data: ${withHistory}`);
  }

  // Show unmatched stats
  const inventoryMPNs = new Set(Object.keys(aggregated));
  const excelMPNs = new Set(Object.keys(excelData));
  const inInventoryNotExcel = [...inventoryMPNs].filter(mpn => !excelMPNs.has(mpn));
  const inExcelNotInventory = [...excelMPNs].filter(mpn => !inventoryMPNs.has(mpn));

  console.log('');
  console.log('=== Match Statistics ===');
  console.log(`  In inventory but not in Excel: ${inInventoryNotExcel.length} MPNs`);
  console.log(`  In Excel but not in inventory: ${inExcelNotInventory.length} MPNs`);
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
// Step 3: Load Excel Data (Columns A-L except J)
// -----------------------------------------------------------------------------

function loadExcelData(excelPath) {
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
  const excelData = {};

  // Skip header row (index 0)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;

    const mpn = (row[EXCEL.MPN] || '').toString().trim();
    if (!mpn) continue;

    excelData[mpn] = {
      CPC: (row[EXCEL.CPC] || '').toString().trim(),
      Manufacturer: (row[EXCEL.MANUFACTURER] || '').toString().trim(),
      Description: (row[EXCEL.DESCRIPTION] || '').toString().trim(),
      Lead_Time: (row[EXCEL.LEAD_TIME] || '').toString().trim(),
      Base_Unit_Price: parseFloat(row[EXCEL.BASE_PRICE]) || 0,
      Resale_Price: parseFloat(row[EXCEL.RESALE_PRICE]) || 0,
      MIN_QTY: parseFloat(row[EXCEL.MIN_QTY]) || 0,
      MOQ: parseFloat(row[EXCEL.MOQ]) || 0
      // LAM_Owned will be calculated dynamically based on W115 qty
    };
  }

  return excelData;
}

// -----------------------------------------------------------------------------
// Step 4: Load Historical Purchase Data from ERP
// -----------------------------------------------------------------------------

function loadHistoricalPurchaseData(mpns) {
  if (!mpns || mpns.length === 0) {
    return {};
  }

  // Build SQL query for most recent purchase per MPN
  const sql = `
    WITH recent_purchases AS (
      SELECT
        ol.chuboe_mpn,
        bp.name as supplier_name,
        ol.priceentered as purchase_price,
        o.dateordered,
        u.name as buyer_name,
        ROW_NUMBER() OVER (PARTITION BY ol.chuboe_mpn ORDER BY o.dateordered DESC) as rn
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.ad_user u ON o.createdby = u.ad_user_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND ol.chuboe_mpn IS NOT NULL
        AND ol.chuboe_mpn != ''
    )
    SELECT chuboe_mpn, supplier_name, purchase_price, buyer_name
    FROM recent_purchases
    WHERE rn = 1;
  `;

  try {
    // Execute query using psql
    const result = execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024  // 50MB buffer
    });

    const historicalData = {};
    const lines = result.trim().split('\n').filter(l => l.trim());

    for (const line of lines) {
      const [mpn, supplier, price, buyer] = line.split('|');
      if (mpn && mpn.trim()) {
        historicalData[mpn.trim()] = {
          Previous_Supplier: (supplier || '').trim(),
          Historical_Purchase_Price: parseFloat(price) || 0,
          Buyer: (buyer || '').trim()
        };
      }
    }

    return historicalData;
  } catch (err) {
    console.error('  WARNING: Could not load historical data from ERP');
    console.error(`  ${err.message}`);
    return {};
  }
}

// -----------------------------------------------------------------------------
// Step 5: Identify Reorder Candidates
// -----------------------------------------------------------------------------

function identifyReorderCandidates(aggregated, excelData, historicalData) {
  const alerts = [];
  const inventoryMPNs = new Set(Object.keys(aggregated));

  // First: Process items WITH inventory (may be below threshold)
  for (const [mpn, invData] of Object.entries(aggregated)) {
    const excel = excelData[mpn];

    if (!excel) {
      // MPN not in Excel - skip
      continue;
    }

    const minQty = excel.MIN_QTY;
    const totalQty = invData.Total_Qty;

    if (totalQty < minQty) {
      const shortfall = minQty - totalQty;
      const shortfallPct = minQty > 0 ? (shortfall / minQty) * 100 : 0;

      // Priority based on shortfall percentage
      let priority;
      if (shortfallPct >= 75) {
        priority = 'HIGH';
      } else if (shortfallPct >= 50) {
        priority = 'MEDIUM';
      } else {
        priority = 'LOW';
      }

      // LAM Owned Inventory is YES if there's any W115 qty
      const lamOwned = invData.W115_Qty > 0 ? 'YES' : 'NO';

      // Get historical data if available
      const history = historicalData[mpn] || {};

      alerts.push({
        'Lam P/N': excel.CPC,
        'MPN': mpn,
        'Manufacturer': excel.Manufacturer,
        'Item Description': excel.Description,
        'Lead Time': excel.Lead_Time,
        'QTY ON HAND': totalQty,
        'Base Unit Price': excel.Base_Unit_Price,
        'Resale Price': excel.Resale_Price,
        'MIN QTY': minQty,
        'MOQ': excel.MOQ,
        'Lam Owned Inventory?': lamOwned,
        'Previous Supplier': history.Previous_Supplier || '',
        'Buyer': history.Buyer || '',
        'Historical Purchase Price': history.Historical_Purchase_Price || '',
        'Shortfall': shortfall,
        'Priority': priority
      });
    }
  }

  // Second: Process items in Excel but NOT in inventory (zero qty - CRITICAL)
  for (const [mpn, excel] of Object.entries(excelData)) {
    if (inventoryMPNs.has(mpn)) {
      // Already processed above
      continue;
    }

    // This MPN is in Excel but has zero inventory (not in W111 or W115)
    const minQty = excel.MIN_QTY;

    // Skip if MIN_QTY is 0 (no reorder needed)
    if (minQty <= 0) continue;

    const history = historicalData[mpn] || {};

    alerts.push({
      'Lam P/N': excel.CPC,
      'MPN': mpn,
      'Manufacturer': excel.Manufacturer,
      'Item Description': excel.Description,
      'Lead Time': excel.Lead_Time,
      'QTY ON HAND': 0,  // Zero inventory
      'Base Unit Price': excel.Base_Unit_Price,
      'Resale Price': excel.Resale_Price,
      'MIN QTY': minQty,
      'MOQ': excel.MOQ,
      'Lam Owned Inventory?': 'NO',  // No inventory = not LAM owned
      'Previous Supplier': history.Previous_Supplier || '',
      'Buyer': history.Buyer || '',
      'Historical Purchase Price': history.Historical_Purchase_Price || '',
      'Shortfall': minQty,  // 100% shortfall
      'Priority': 'CRITICAL'  // Highest priority - zero stock
    });
  }

  // Sort by priority (CRITICAL first), then by shortfall descending
  const priorityOrder = { 'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3 };
  alerts.sort((a, b) => {
    if (priorityOrder[a.Priority] !== priorityOrder[b.Priority]) {
      return priorityOrder[a.Priority] - priorityOrder[b.Priority];
    }
    return b.Shortfall - a.Shortfall;
  });

  return alerts;
}

// -----------------------------------------------------------------------------
// Step 6: Write Output
// -----------------------------------------------------------------------------

function writeReorderAlerts(alerts, outputPath) {
  // Output columns matching Excel A-L (minus J) plus historical + calculated
  const headers = [
    'Lam P/N',
    'MPN',
    'Manufacturer',
    'Item Description',
    'Lead Time',
    'QTY ON HAND',
    'Base Unit Price',
    'Resale Price',
    'MIN QTY',
    'MOQ',
    'Lam Owned Inventory?',
    'Previous Supplier',
    'Buyer',
    'Historical Purchase Price',
    'Shortfall',
    'Priority'
  ];

  const lines = [headers.join(',')];

  for (const alert of alerts) {
    const row = headers.map(h => {
      const val = alert[h];
      // Quote strings that might contain commas or quotes
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
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
