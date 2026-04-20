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
const { createNotifier } = require('../../shared/notifier');

// Email configuration - same account as Inventory File Cleanup (triggered together)
const EMAIL_ACCOUNT = 'excess';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: `${EMAIL_ACCOUNT}@orangetsunami.com`,
  fromName: 'LAM Kitting Reorder'
});

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const W111_FILENAME = 'W111_LAM_3PL.csv';
const W115_FILENAME = 'W115_LAM_Dead_Inventory.csv';

// Column names in Chuboe output
const CHUBOE_MPN_COL = 'Chuboe_MPN';
const CHUBOE_QTY_COL = 'Qty';

// Column indices in Excel INVENTORY sheet (0-based)
// A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, I=8, J=9
const EXCEL = {
  CPC: 0,           // A - Lam P/N
  MPN: 1,           // B - MPN
  MANUFACTURER: 2,  // C - Manufacturer
  DESCRIPTION: 3,   // D - Item Description
  LEAD_TIME: 4,     // E - Lead Time
  BASE_PRICE: 5,    // F - Base Unit Price
  RESALE_PRICE: 6,  // G - Resale Price
  MIN_QTY: 7,       // H - MIN QTY
  MOQ: 8,           // I - MOQ
  HIST_BUYER: 9     // J - Buyer (historical, from SIPOC)
};

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--no-email');
  const skipEmail = process.argv.includes('--no-email');

  if (args.length < 2) {
    console.error('Usage: node lam-kitting-reorder.js <inventory-folder> <excel-file> [output-file] [--no-email]');
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

  // Step 4b: Load recent POVs (vendor receipts in last 4 months)
  console.log('');
  console.log('Step 4b: Loading recent POVs (last 4 months)...');
  const recentPOVs = loadRecentPOVs();
  console.log(`  Recent POVs found: ${Object.keys(recentPOVs).length} MPNs`);

  // Step 5: Join and identify reorder candidates
  console.log('');
  console.log('Step 5: Identifying reorder candidates...');
  const reorderAlerts = identifyReorderCandidates(aggregated, excelData, historicalData, recentPOVs);
  console.log(`  Reorder candidates: ${reorderAlerts.length} items`);

  // Step 5b: Check other warehouses for available stock
  console.log('');
  console.log('Step 5b: Checking other warehouse stock...');
  const reorderMPNs = reorderAlerts.map(a => a['MPN']);
  const otherStock = loadOtherWarehouseStock(inventoryFolder, reorderMPNs);
  const stockMatches = Object.keys(otherStock).filter(mpn => otherStock[mpn].length > 0).length;
  console.log(`  Stock matches found: ${stockMatches} MPNs in other warehouses`);

  // Enrich alerts with other warehouse stock
  for (const alert of reorderAlerts) {
    const matches = otherStock[alert['MPN']] || [];
    if (matches.length > 0) {
      alert['Available Stock (Other WH)'] = matches.map(m => m.warehouse).join(', ');
      alert['Available Qty (Other WH)'] = matches.reduce((sum, m) => sum + m.qty, 0);
    }
  }

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
    const pendingReceipt = reorderAlerts.filter(r => r.Priority === 'PENDING RECEIPT').length;
    console.log(`  CRITICAL priority (zero stock, no recent PO): ${criticalPriority}`);
    console.log(`  HIGH priority: ${highPriority}`);
    console.log(`  MEDIUM priority: ${medPriority}`);
    console.log(`  LOW priority: ${lowPriority}`);
    console.log(`  PENDING RECEIPT (recent PO in flight, informational): ${pendingReceipt}`);

    const withHistory = reorderAlerts.filter(r => r['OT Previous Supplier']).length;
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

  // Step 7: Email results (unless --no-email flag is set)
  if (skipEmail) {
    console.log('');
    console.log('Step 7: Skipping email (--no-email flag set).');
  } else {
    console.log('');
    console.log('Step 7: Emailing results...');
    const critCount = reorderAlerts.filter(r => r.Priority === 'CRITICAL').length;
    const highCount = reorderAlerts.filter(r => r.Priority === 'HIGH').length;
    const medCount = reorderAlerts.filter(r => r.Priority === 'MEDIUM').length;
    const lowCount = reorderAlerts.filter(r => r.Priority === 'LOW').length;
    const pendingCount = reorderAlerts.filter(r => r.Priority === 'PENDING RECEIPT').length;

    const emailBody = `LAM Kitting Reorder Alerts generated ${getDateStamp()}.

${reorderAlerts.length} items below threshold:
- CRITICAL (zero stock, no recent PO): ${critCount}
- HIGH: ${highCount}
- MEDIUM: ${medCount}
- LOW: ${lowCount}
- PENDING RECEIPT (recent PO in flight, informational): ${pendingCount}

Inventory source: ${path.basename(inventoryFolder)}`;

    const sent = await sendEmail(
      NOTIFY_EMAIL,
      `LAM Kitting Reorder Alerts - ${getDateStamp()}`,
      emailBody,
      [outputFile]
    );
    console.log(sent ? '  Email sent.' : '  Email failed (check Himalaya config).');
  }
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
      MOQ: parseFloat(row[EXCEL.MOQ]) || 0,
      Historical_Buyer: (row[EXCEL.HIST_BUYER] || '').toString().trim()
    };
  }

  return excelData;
}

// -----------------------------------------------------------------------------
// Step 4: Load Historical Purchase Data from ERP
// -----------------------------------------------------------------------------

// Run a psql query via temp file; return stdout as string. Errors are logged, not swallowed.
function runPsql(sql, label) {
  const tmpSql = `/tmp/lam_kitting_${label}.sql`;
  const tmpOut = `/tmp/lam_kitting_${label}.out`;
  fs.writeFileSync(tmpSql, sql);
  try {
    execSync(`psql -U analytics_user -d idempiere_replica -t -A -F '|' -f ${tmpSql} -o ${tmpOut}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    // rbash often returns non-zero even on success; only treat as a real failure if no output file
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
      console.error(`  WARNING: psql ${label} failed: ${(e.message || '').slice(0, 300)}`);
      if (e.stderr) console.error(`    stderr: ${e.stderr.toString().slice(0, 500)}`);
    }
  }
  return fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
}

function loadHistoricalPurchaseData(mpns) {
  if (!mpns || mpns.length === 0) {
    return {};
  }

  // Query A: most recent *closed* LAM PO per MPN — supplier, price, buyer, promise date, POV
  // Driven by c_orderline so it only fires when a PO has actually been cut.
  const sqlClosedPO = `
    WITH lam_purchases AS (
      SELECT
        TRIM(ol.chuboe_mpn) as chuboe_mpn,
        bp.name as supplier_name,
        ol.priceentered as purchase_price,
        ol.datepromised,
        u.name as buyer_name,
        CASE WHEN ol.chuboe_po_string LIKE 'POV%' THEN ol.chuboe_po_string ELSE '' END as pov_number,
        ROW_NUMBER() OVER (PARTITION BY TRIM(ol.chuboe_mpn) ORDER BY ol.datepromised DESC NULLS LAST) as rn
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.ad_user u ON o.createdby = u.ad_user_id
      LEFT JOIN adempiere.chuboe_vq_line vl ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
      LEFT JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND o.docstatus IN ('CO', 'IP')
        AND ol.qtyordered > 0
        AND ol.chuboe_mpn IS NOT NULL
        AND ol.chuboe_mpn != ''
        AND rfq.c_bpartner_id = 1000730
    )
    SELECT chuboe_mpn, supplier_name, purchase_price, buyer_name,
      datepromised::date, pov_number
    FROM lam_purchases
    WHERE rn = 1;
  `;

  // Query B: most recent LAM RFQ per MPN — sourced from chuboe_rfq directly, no PO required.
  // This is what "Last RFQ" actually means: the latest LAM RFQ we asked vendors about.
  // Excludes today's run so the cell shows the *prior* RFQ (the one with purchase activity to chase).
  const sqlLastRFQ = `
    SELECT DISTINCT ON (TRIM(rlm.chuboe_mpn))
      TRIM(rlm.chuboe_mpn) as mpn,
      rfq.value as rfq_number,
      rfq.created::date as rfq_date
    FROM adempiere.chuboe_rfq rfq
    JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rfq.c_bpartner_id = 1000730
      AND rfq.isactive = 'Y'
      AND rfq.created::date < CURRENT_DATE
      AND rlm.chuboe_mpn IS NOT NULL
      AND rlm.chuboe_mpn != ''
    ORDER BY TRIM(rlm.chuboe_mpn), rfq.created DESC;
  `;

  const historicalData = {};

  // Closed-PO history
  const closedResult = runPsql(sqlClosedPO, 'history');
  for (const line of closedResult.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [mpn, supplier, price, buyer, dateordered, povNum] = line.split('|');
    if (mpn && mpn.trim()) {
      historicalData[mpn.trim()] = {
        OT_Previous_Supplier: (supplier || '').trim(),
        Historical_Purchase_Price: parseFloat(price) || 0,
        OT_Buyer: (buyer || '').trim(),
        Last_Purchase_Date: (dateordered || '').trim(),
        POV_Number: (povNum || '').trim(),
        RFQ_Number: '',
        RFQ_Customer: 'Lam Research'
      };
    }
  }

  // Latest LAM RFQ (separate lookup — survives even when no PO has been cut)
  const rfqResult = runPsql(sqlLastRFQ, 'last_rfq');
  for (const line of rfqResult.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [mpn, rfqNum, rfqDate] = line.split('|');
    if (mpn && mpn.trim()) {
      const key = mpn.trim();
      if (!historicalData[key]) {
        historicalData[key] = {
          OT_Previous_Supplier: '', Historical_Purchase_Price: 0, OT_Buyer: '',
          Last_Purchase_Date: '', POV_Number: '',
          RFQ_Number: '', RFQ_Customer: 'Lam Research'
        };
      }
      historicalData[key].RFQ_Number = (rfqNum || '').trim();
      historicalData[key].RFQ_Date = (rfqDate || '').trim();
    }
  }

  return historicalData;
}

// -----------------------------------------------------------------------------
// Step 4b: Load Recent POVs (vendor receipts in last 4 months)
// -----------------------------------------------------------------------------

function loadRecentPOVs() {
  // Surface ALL open LAM purchase activity per MPN, regardless of whether:
  //   - the OT PO has been cut yet (VQ_TICKED state bridges the gap)
  //   - the Infor POV has been stamped yet (OT_PO state bridges the gap)
  // "Open" means: for POs, qtyordered > qtydelivered; for VQs, ispurchased = 'Y' with no PO line yet.
  // Receipts in Infor close POs naturally (qtydelivered catches up) and the row drops off the report.
  //
  // On Order Qty = total open qty across all open activity for the MPN (summed across all POs + any pre-PO ticks).
  // Recent POV cell shows the single most-recent activity row (preferring PO over VQ_TICKED).
  // "Recent" activity for priority purposes = PO cut (c_order.created) within 90 days.
  // Anything older still shows in the cell (so buyers can see stale 2024/2025 PO#s and triage),
  // but doesn't trigger the PENDING RECEIPT priority override. Filter tuning is deferred until
  // buyers have reviewed stale cases (promise-date-based rule is a candidate for round 2).
  const sql = `
    WITH all_activity AS (
      -- Open POs (with or without Infor POV stamp)
      SELECT
        TRIM(ol.chuboe_mpn) AS mpn,
        CASE WHEN ol.chuboe_po_string LIKE 'POV%' THEN ol.chuboe_po_string ELSE '' END AS pov_number,
        o.documentno AS ot_po_number,
        (ol.qtyordered - ol.qtydelivered) AS qty,
        ol.datepromised::date AS promise_date,
        o.created::date AS po_created_date,
        bp.name AS supplier,
        rfq.value AS rfq_number,
        'PO' AS state,
        1 AS preference,
        COALESCE(ol.datepromised, o.created) AS sort_date
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.chuboe_vq_line vl ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
      LEFT JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND o.docstatus IN ('CO', 'IP', 'DR')
        AND ol.qtyordered > ol.qtydelivered
        AND ol.chuboe_mpn IS NOT NULL
        AND ol.chuboe_mpn != ''
        AND rfq.c_bpartner_id = 1000730

      UNION ALL

      -- VQs ticked (ispurchased='Y') but no PO cut yet → buyer committed, procurement catching up
      SELECT
        TRIM(vl.chuboe_mpn) AS mpn,
        '' AS pov_number,
        '' AS ot_po_number,
        vl.qty AS qty,
        vl.datepromised::date AS promise_date,
        rfq.created::date AS po_created_date,
        bp.name AS supplier,
        rfq.value AS rfq_number,
        'VQ_TICKED' AS state,
        2 AS preference,
        rfq.created AS sort_date
      FROM adempiere.chuboe_vq_line vl
      JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.c_orderline ol2
        ON ol2.chuboe_vq_line_id = vl.chuboe_vq_line_id AND ol2.isactive = 'Y'
      WHERE vl.ispurchased = 'Y'
        AND vl.isactive = 'Y'
        AND rfq.c_bpartner_id = 1000730
        AND rfq.isactive = 'Y'
        AND ol2.c_orderline_id IS NULL
        AND vl.chuboe_mpn IS NOT NULL
        AND vl.chuboe_mpn != ''
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY mpn ORDER BY preference ASC, sort_date DESC NULLS LAST) AS rn,
        SUM(qty) OVER (PARTITION BY mpn) AS total_qty,
        -- most-recent activity per MPN (regardless of PO vs VQ_TICKED) for recency gate
        MAX(po_created_date) OVER (PARTITION BY mpn) AS latest_activity_date
      FROM all_activity
    )
    SELECT mpn, pov_number, ot_po_number, qty, total_qty, promise_date, po_created_date,
           latest_activity_date, supplier, rfq_number, state
    FROM ranked
    WHERE rn = 1;
  `;

  const result = runPsql(sql, 'povs');
  const povData = {};
  const today = new Date();
  const recencyMs = 90 * 24 * 60 * 60 * 1000;
  for (const line of result.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [mpn, pov, otPo, qty, totalQty, promiseDate, poCreated, latestActivity, supplier, rfqNum, state] = line.split('|');
    if (mpn && mpn.trim()) {
      // Is the MOST RECENT activity for this MPN within 90 days? Drives PENDING RECEIPT override.
      const latest = (latestActivity || '').trim();
      const isRecent = latest && (today - new Date(latest)) <= recencyMs;
      povData[mpn.trim()] = {
        State: (state || '').trim(),                    // 'PO' or 'VQ_TICKED'
        POV_Number: (pov || '').trim(),                 // populated once Infor stamps
        OT_PO_Number: (otPo || '').trim(),              // OT PO# (pre-Infor-stamp fallback)
        POV_Qty: parseFloat(qty) || 0,                  // qty on the displayed row
        POV_Date: (promiseDate || '').trim(),           // vendor promise date on the displayed row
        PO_Created_Date: (poCreated || '').trim(),      // when we cut the PO (recency anchor)
        POV_Supplier: (supplier || '').trim(),
        RFQ_Number: (rfqNum || '').trim(),
        Qty_On_Order: parseFloat(totalQty) || 0,        // total across all open activity for the MPN
        Is_Recent: isRecent                              // most-recent PO/VQ cut within 90 days
      };
    }
  }
  return povData;
}

// -----------------------------------------------------------------------------
// Step 5: Identify Reorder Candidates
// -----------------------------------------------------------------------------

// Warehouses to check for available stock (exclude MAIN, W105, W111, W115)
const OTHER_WAREHOUSE_FILES = [
  { file: 'W102_Free_Stock_Stevenage.csv', label: 'W102 Stevenage' },
  { file: 'W103_GE_Consignment.csv', label: 'W103 GE Consignment' },
  { file: 'W104_Franchise_Stock.csv', label: 'W104 Franchise' },
  { file: 'W104_W112_Free_Stock_Austin.csv', label: 'W104/W112 Austin' },
  { file: 'W106_Taxan_Consignment.csv', label: 'W106 Taxan Consignment' },
  { file: 'W107_Spartronics_Consignment.csv', label: 'W107 Spartronics Consignment' },
  { file: 'W108_W113_Free_Stock_Hong_Kong.csv', label: 'W108/W113 Hong Kong' },
  { file: 'W117_Eaton_Consignment.csv', label: 'W117 Eaton Consignment' },
  { file: 'W118_LAM_Consignment.csv', label: 'W118 LAM Consignment' },
];

function loadOtherWarehouseStock(inventoryFolder, targetMPNs) {
  const targetSet = new Set(targetMPNs);
  const results = {}; // mpn → [{ warehouse, qty }]
  for (const mpn of targetMPNs) results[mpn] = [];

  for (const wh of OTHER_WAREHOUSE_FILES) {
    const filePath = path.join(inventoryFolder, wh.file);
    if (!fs.existsSync(filePath)) continue;

    const csv = readCSVFile(filePath);
    const mpnIdx = csv.headers.indexOf('Chuboe_MPN');
    const qtyIdx = csv.headers.indexOf('Qty');
    if (mpnIdx === -1 || qtyIdx === -1) continue;

    // Aggregate by MPN within this warehouse
    const whStock = {};
    for (const row of csv.rows) {
      const mpn = (row[mpnIdx] || '').trim();
      if (!mpn || !targetSet.has(mpn)) continue;
      whStock[mpn] = (whStock[mpn] || 0) + (parseFloat(row[qtyIdx]) || 0);
    }

    for (const [mpn, qty] of Object.entries(whStock)) {
      if (qty > 0) {
        results[mpn].push({ warehouse: wh.label, qty });
      }
    }
  }

  return results;
}

// Column order — single source of truth for buildAlert() and writeReorderAlerts()
// To add/remove/reorder columns: update this array AND the buildAlert() values below
const ALERT_COLUMNS = [
  // Part identification
  'Lam P/N',
  'MPN',
  'Manufacturer',
  'Item Description',
  // Inventory & priority
  'QTY ON HAND',
  'Lam Owned Inventory?',
  'Reorder Threshold',
  'Shortfall',
  'Priority',
  'On Order Qty',
  'Recent POV',
  'Last Promise Date',
  'Last RFQ',
  // Pricing
  'Base Unit Price',
  'Resale Price',
  'Historical Purchase Price',
  // Purchase history
  'OT Previous Supplier',
  'OT Buyer',
  'Historical Buyer',
  // Kitting DB
  'Lead Time',
  'MOQ',
  // Other warehouse stock
  'Available Stock (Other WH)',
  'Available Qty (Other WH)',
];

// Render the "Recent POV" cell based on the activity state reported by loadRecentPOVs.
// Three states, in descending procurement maturity:
//   PO + POV stamp: "POV0075568 (2026-04-13, 60 pcs from Master, RFQ 1132328)"
//   PO only:        "OT PO809630 pending Infor stamp (2026-04-13, 60 pcs from Master, RFQ 1132328)"
//   VQ ticked only: "VQ ticked — PO pending (60 pcs from Master, RFQ 1132328)"
function formatPOVCell(pov) {
  if (!pov || !pov.State) return '';
  const rfqTag = pov.RFQ_Number ? `, RFQ ${pov.RFQ_Number}` : '';
  if (pov.State === 'PO') {
    const id = pov.POV_Number || (pov.OT_PO_Number ? `OT ${pov.OT_PO_Number} pending Infor stamp` : '');
    if (!id) return '';
    const datePart = pov.POV_Date ? `${pov.POV_Date}, ` : '';
    return `${id} (${datePart}${pov.POV_Qty} pcs from ${pov.POV_Supplier}${rfqTag})`;
  }
  if (pov.State === 'VQ_TICKED') {
    return `VQ ticked — PO pending (${pov.POV_Qty} pcs from ${pov.POV_Supplier}${rfqTag})`;
  }
  return '';
}

function buildAlert(mpn, excel, totalQty, lamOwned, shortfall, priority, history, pov) {
  return {
    'Lam P/N': excel.CPC,
    'MPN': mpn,
    'Manufacturer': excel.Manufacturer,
    'Item Description': excel.Description,
    'QTY ON HAND': totalQty,
    'Lam Owned Inventory?': lamOwned,
    'Reorder Threshold': excel.MIN_QTY,
    'Shortfall': shortfall,
    'Priority': priority,
    'On Order Qty': pov ? (pov.Qty_On_Order || '') : '',
    'Recent POV': formatPOVCell(pov),
    'Base Unit Price': excel.Base_Unit_Price,
    'Resale Price': excel.Resale_Price,
    'Historical Purchase Price': history.Historical_Purchase_Price || '',
    'OT Previous Supplier': history.OT_Previous_Supplier || '',
    'OT Buyer': history.OT_Buyer || '',
    'Historical Buyer': excel.Historical_Buyer || '',
    'Last Promise Date': history.Last_Purchase_Date || '',
    'Last RFQ': history.RFQ_Number ? `${history.RFQ_Number} (${history.RFQ_Customer || ''})` : '',
    'Lead Time': excel.Lead_Time,
    'MOQ': excel.MOQ,
  };
}

// If the MPN has recent in-flight purchase activity (PO or ticked VQ within the last 90 days)
// the row is informational — "stock is likely inbound, don't act" — rather than a severity.
// Shortfall-based priority is retained when no recent activity exists.
function resolvePriority(shortfallBasedPriority, pov) {
  if (pov && pov.Is_Recent) return 'PENDING RECEIPT';
  return shortfallBasedPriority;
}

function identifyReorderCandidates(aggregated, excelData, historicalData, recentPOVs = {}) {
  const alerts = [];
  const inventoryMPNs = new Set(Object.keys(aggregated));

  // First: Process items WITH inventory (may be below threshold)
  for (const [mpn, invData] of Object.entries(aggregated)) {
    const excel = excelData[mpn];
    if (!excel) continue;

    const minQty = excel.MIN_QTY;
    const totalQty = invData.Total_Qty;

    if (totalQty < minQty) {
      const shortfall = minQty - totalQty;
      const shortfallPct = minQty > 0 ? (shortfall / minQty) * 100 : 0;
      const basePriority = shortfallPct >= 75 ? 'HIGH' : shortfallPct >= 50 ? 'MEDIUM' : 'LOW';
      const priority = resolvePriority(basePriority, recentPOVs[mpn]);
      const lamOwned = invData.W115_Qty > 0 ? 'YES' : 'NO';

      alerts.push(buildAlert(mpn, excel, totalQty, lamOwned, shortfall, priority,
        historicalData[mpn] || {}, recentPOVs[mpn]));
    }
  }

  // Second: Process items in Excel but NOT in inventory (zero qty - CRITICAL unless recent activity)
  for (const [mpn, excel] of Object.entries(excelData)) {
    if (inventoryMPNs.has(mpn)) continue;
    if (excel.MIN_QTY <= 0) continue;

    const priority = resolvePriority('CRITICAL', recentPOVs[mpn]);
    alerts.push(buildAlert(mpn, excel, 0, 'NO', excel.MIN_QTY, priority,
      historicalData[mpn] || {}, recentPOVs[mpn]));
  }

  // Sort: CRITICAL first (must source now), shortfall-based severity next,
  // PENDING RECEIPT last (informational — stock is likely inbound, no action needed)
  const priorityOrder = { 'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3, 'PENDING RECEIPT': 4 };
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
  // Uses ALERT_COLUMNS defined at module level — single source of truth
  const headers = ALERT_COLUMNS;

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
// Email
// -----------------------------------------------------------------------------

async function sendEmail(to, subject, body, attachmentPaths = []) {
  console.log(`  Sending email to ${to}: ${subject}`);
  const attachments = attachmentPaths
    .filter(p => fs.existsSync(p))
    .map(p => ({ filename: path.basename(p), path: p }));

  if (attachments.length > 0) {
    return await notifier.sendWithAttachment(to, subject, body, attachments);
  }
  return await notifier.sendEmail(to, subject, body);
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
