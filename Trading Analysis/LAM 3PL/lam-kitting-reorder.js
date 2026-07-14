#!/usr/bin/env node
/**
 * LAM 3PL Reorder Script
 *
 * Compares W111 + W115 inventory levels against Reorder Threshold
 * to generate reorder alerts with historical purchase data.
 *
 * Contract data source: LAM_Master_Roster.xlsx (consolidated from Kitting DB,
 * EPG SIPOC, and Phase 2 Adds via scripts/build-lam-master-roster.js)
 *
 * OUTPUT: Two files generated:
 *   1. LAM_Reorder_Alerts_YYYY-MM-DD.csv   - Parts ready to order (approved pricing)
 *   2. LAM_Reorder_Pending_Approvals_YYYY-MM-DD.xlsx - Parts awaiting LAM approval
 *
 * WORKFLOW:
 *   - Reorder triggers identify parts needing replenishment
 *   - Parts with approved pricing → Reorder Alerts file
 *   - Parts needing price/lead time approval → Pending Approvals file
 *   - When approval received (email or terminal) → update roster → part moves to Reorder
 *
 * Usage:
 *   node lam-kitting-reorder.js <inventory-folder> <master-roster-file> [output-file]
 *
 * Example:
 *   node lam-kitting-reorder.js "./Inventory 2026-03-11" "./LAM_Master_Roster.xlsx"
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');

// Use shared utilities
const { readCSVFile } = require('../../shared/csv-utils');
const { createNotifier } = require('../../shared/notifier');
const { normalizeMPN } = require('../../shared/mpn-normalization');

// Email configuration - LAM Kitting dedicated account
const EMAIL_ACCOUNT = 'lamkitting';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: `${EMAIL_ACCOUNT}@orangetsunami.com`,
  fromName: 'LAM 3PL'
});

// -----------------------------------------------------------------------------
// AVL Loader - Load complete AVL for multi-MPN inventory aggregation
// -----------------------------------------------------------------------------

let _avlCache = null;
let _avlByCpcCache = null;

/**
 * Load the complete AVL (CPC -> [MPN, MPN, ...])
 * Returns a Map of CPC -> array of MPN strings
 */
function loadAVL() {
  if (_avlByCpcCache) return _avlByCpcCache;

  const avlPath = path.join(__dirname, 'LAM_Complete_AVL.xlsx');
  if (!fs.existsSync(avlPath)) {
    console.log('  WARNING: LAM_Complete_AVL.xlsx not found - using roster MPN only');
    _avlByCpcCache = new Map();
    return _avlByCpcCache;
  }

  const wb = XLSX.readFile(avlPath);
  const ws = wb.Sheets['Complete AVL'];
  if (!ws) {
    console.log('  WARNING: Complete AVL sheet not found');
    _avlByCpcCache = new Map();
    return _avlByCpcCache;
  }

  const data = XLSX.utils.sheet_to_json(ws);
  _avlByCpcCache = new Map();

  for (const row of data) {
    const cpc = row.CPC;
    const mpn = row.MPN;
    if (!cpc || !mpn) continue;

    if (!_avlByCpcCache.has(cpc)) {
      _avlByCpcCache.set(cpc, []);
    }
    _avlByCpcCache.get(cpc).push(mpn);
  }

  return _avlByCpcCache;
}

/**
 * Get all approved MPNs for a CPC
 * @param {string} cpc - The CPC
 * @param {string} rosterMpn - The MPN from the Master Roster (fallback if no AVL)
 * @returns {string[]} Array of all approved MPNs
 */
function getAllApprovedMPNs(cpc, rosterMpn) {
  const avl = loadAVL();
  const mpns = avl.get(cpc);

  if (!mpns || mpns.length === 0) {
    // No AVL data - use roster MPN as sole option
    return rosterMpn ? [rosterMpn] : [];
  }

  // Ensure roster MPN is included even if not in AVL
  if (rosterMpn && !mpns.includes(rosterMpn)) {
    return [rosterMpn, ...mpns];
  }

  return mpns;
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const W111_FILENAME = 'W111_LAM_3PL.csv';
const W115_FILENAME = 'W115_LAM_Dead_Inventory.csv';

// Column names in Chuboe output
const CHUBOE_MPN_COL = 'Chuboe_MPN';
const CHUBOE_QTY_COL = 'Qty';

// Master Roster column names (header-based lookup, not index-based)
// Source: LAM_Master_Roster.xlsx 'Master Roster' sheet
// Built by scripts/build-lam-master-roster.js from 3 sources:
//   - Lam_Kitting_DB (has thresholds)
//   - Lam_EPG_SIPOC (no thresholds)
//   - Phase 2 Adds (no thresholds)
const ROSTER_COLS = {
  CPC: 'CPC',
  MPN: 'MPN',
  MANUFACTURER: 'Manufacturer',
  DESCRIPTION: 'Description',
  AWARD: 'Award',
  BASE_PRICE: 'Base Unit Price',
  RESALE_PRICE: 'Resale Price',
  PENDING: 'Pending',
  PROPOSED_RESALE: 'Proposed Resale',
  LAST_APPROVED: 'Last Approved',
  THRESHOLD: 'Reorder Threshold',
  MOQ: 'MOQ',
  LEAD_TIME: 'Contractual Lead Time',
  BUYER: 'Buyer',
  STATUS: 'Status',
  SUBMITTED_DATE: 'Submitted Date',
};

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--no-email');
  const skipEmail = process.argv.includes('--no-email');

  if (args.length < 2) {
    console.error('Usage: node lam-kitting-reorder.js <inventory-folder> <master-roster-file> [output-file] [--no-email]');
    console.error('');
    console.error('Example:');
    console.error('  node lam-kitting-reorder.js "./Inventory 2026-03-11" "./LAM_Master_Roster.xlsx"');
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

  console.log('LAM 3PL Reorder');
  console.log('===============');
  console.log(`Inventory folder: ${inventoryFolder}`);
  console.log(`Master Roster: ${excelFile}`);
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

  // Step 1b: Check inventory file age - warn if stale (>14 days old)
  if (fs.existsSync(w111Path)) {
    const fileStats = fs.statSync(w111Path);
    const fileAgeDays = Math.floor((Date.now() - fileStats.mtime.getTime()) / (1000 * 60 * 60 * 24));
    if (fileAgeDays > 14) {
      console.log('');
      console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.log(`  WARNING: Inventory file is ${fileAgeDays} days old!`);
      console.log('  This data may be stale. Check if inventory cleanup cron is running.');
      console.log('  File:', path.basename(w111Path));
      console.log('  Modified:', fileStats.mtime.toISOString().split('T')[0]);
      console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.log('');
    }
  }

  // Step 2: Aggregate by MPN
  console.log('');
  console.log('Step 2: Aggregating inventory by MPN...');
  const aggregated = aggregateInventory(w111Inventory, w115Inventory);
  console.log(`  Combined: ${Object.keys(aggregated).length} unique MPNs`);

  // Step 3: Load contract data from Master Roster
  console.log('');
  console.log('Step 3: Loading data from Master Roster...');
  const { data: excelData, pendingApprovals } = loadExcelData(excelFile);
  console.log(`  Master Roster rows loaded: ${Object.keys(excelData).length} MPNs`);
  if (pendingApprovals.length > 0) {
    console.log(`  Pending approval items: ${pendingApprovals.length}`);
  }

  // Step 3b: Load AVL for multi-MPN inventory aggregation
  console.log('');
  console.log('Step 3b: Loading AVL for multi-MPN aggregation...');
  const avl = loadAVL();
  const multiMpnCPCs = [...avl.entries()].filter(([_, mpns]) => mpns.length > 1).length;
  console.log(`  AVL loaded: ${avl.size} CPCs (${multiMpnCPCs} with multiple approved MPNs)`);

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

  // Step 6: Generate output files
  console.log('');
  console.log('Step 6: Generating output files...');

  // 6a: Reorder Alert (parts ready to order - exclude pending approval items)
  const readyToOrder = reorderAlerts.filter(alert => {
    const mpn = alert.MPN;
    const excel = excelData[mpn];
    // Exclude if has pending approval status
    if (excel && (excel.Pending || excel.Status === 'Pending Approval')) {
      return false;
    }
    return true;
  });
  writeReorderAlerts(readyToOrder, outputFile);
  console.log(`  Reorder alerts (ready to order): ${outputFile} (${readyToOrder.length} items)`);

  // 6b: Pending Approvals Excel (cumulative - from roster)
  const pendingApprovalsFile = outputFile.replace('.csv', '').replace('_Alerts', '_Pending_Approvals') + '.xlsx';
  const pendingFile = writePendingApprovalsExcel(pendingApprovals, pendingApprovalsFile);

  // 6c: Also write JSON sidecar for backward compatibility
  if (pendingApprovals.length > 0) {
    const pendingApprovalsJson = outputFile.replace('.csv', '_pending_approvals.json');
    fs.writeFileSync(pendingApprovalsJson, JSON.stringify({
      generated: new Date().toISOString(),
      count: pendingApprovals.length,
      items: pendingApprovals,
    }, null, 2) + '\n');
  }

  // Step 6b: Escalations sidecar (current inventory + POV state for every
  // manual-escalation MPN, even those now above threshold). Drives the
  // "stock arrived — resale renegotiation still pending" surface in the runner.
  const escalationsContextFile = outputFile.replace('.csv', '_escalations_context.json');
  writeEscalationsContext(escalationsContextFile, aggregated, excelData, recentPOVs, historicalData, reorderAlerts);

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`Total items below threshold: ${reorderAlerts.length}`);
  console.log(`  Ready to order: ${readyToOrder.length}`);
  console.log(`  Pending LAM approval: ${pendingApprovals.length}`);

  if (readyToOrder.length > 0) {
    const criticalPriority = readyToOrder.filter(r => r.Priority === 'CRITICAL').length;
    const highPriority = readyToOrder.filter(r => r.Priority === 'HIGH').length;
    const medPriority = readyToOrder.filter(r => r.Priority === 'MEDIUM').length;
    const lowPriority = readyToOrder.filter(r => r.Priority === 'LOW').length;
    const pendingOrder = readyToOrder.filter(r => r.Priority === 'PENDING ORDER PLACEMENT').length;
    const pendingReceipt = readyToOrder.filter(r => r.Priority === 'PENDING RECEIPT').length;
    console.log('');
    console.log('Ready to Order breakdown:');
    console.log(`  CRITICAL priority (zero stock, no recent PO): ${criticalPriority}`);
    console.log(`  HIGH priority: ${highPriority}`);
    console.log(`  MEDIUM priority: ${medPriority}`);
    console.log(`  LOW priority: ${lowPriority}`);
    console.log(`  PENDING ORDER PLACEMENT (chase the PO): ${pendingOrder}`);
    console.log(`  PENDING RECEIPT (waiting on vendor): ${pendingReceipt}`);

    const withHistory = readyToOrder.filter(r => r['OT Previous Supplier']).length;
    console.log(`  With historical purchase data: ${withHistory}`);
  }

  if (pendingApprovals.length > 0) {
    const oldestDays = Math.max(...pendingApprovals.map(p => p['Days Pending'] || 0));
    console.log('');
    console.log('Pending Approvals breakdown:');
    console.log(`  Total awaiting approval: ${pendingApprovals.length}`);
    console.log(`  Oldest pending: ${oldestDays} days`);
  }

  // Show unmatched stats
  const inventoryMPNs = new Set(Object.keys(aggregated));
  const rosterMPNs = new Set(Object.keys(excelData));
  const inInventoryNotRoster = [...inventoryMPNs].filter(mpn => !rosterMPNs.has(mpn));
  const inRosterNotInventory = [...rosterMPNs].filter(mpn => !inventoryMPNs.has(mpn));

  console.log('');
  console.log('=== Match Statistics ===');
  console.log(`  In inventory but not in Master Roster: ${inInventoryNotRoster.length} MPNs`);
  console.log(`  In Master Roster but not in inventory: ${inRosterNotInventory.length} MPNs`);

  // Step 7: Email results (unless --no-email flag is set)
  if (skipEmail) {
    console.log('');
    console.log('Step 7: Skipping email (--no-email flag set).');
  } else {
    console.log('');
    console.log('Step 7: Emailing results...');
    const critCount = readyToOrder.filter(r => r.Priority === 'CRITICAL').length;
    const highCount = readyToOrder.filter(r => r.Priority === 'HIGH').length;
    const medCount = readyToOrder.filter(r => r.Priority === 'MEDIUM').length;
    const lowCount = readyToOrder.filter(r => r.Priority === 'LOW').length;
    const pendingOrderCount = readyToOrder.filter(r => r.Priority === 'PENDING ORDER PLACEMENT').length;
    const pendingReceiptCount = readyToOrder.filter(r => r.Priority === 'PENDING RECEIPT').length;

    // Calculate aging for pending approvals
    const oldestPending = pendingApprovals.length > 0
      ? Math.max(...pendingApprovals.map(p => p['Days Pending'] || 0))
      : 0;

    let emailBody = `LAM 3PL Reorder Report - ${getDateStamp()}

=== REORDER ALERTS (Ready to Order) ===
${readyToOrder.length} items below threshold:
- CRITICAL (zero stock, no recent PO): ${critCount}
- HIGH: ${highCount}
- MEDIUM: ${medCount}
- LOW: ${lowCount}
- PENDING ORDER PLACEMENT (chase the PO): ${pendingOrderCount}
- PENDING RECEIPT (waiting on vendor): ${pendingReceiptCount}

=== PENDING APPROVALS ===
${pendingApprovals.length} items awaiting LAM approval`;

    if (pendingApprovals.length > 0) {
      emailBody += `
- Oldest pending: ${oldestPending} days`;
    }

    emailBody += `

Inventory source: ${path.basename(inventoryFolder)}`;

    // Attach both files
    const attachments = [outputFile];
    if (pendingFile) attachments.push(pendingFile);

    const sent = await sendEmail(
      NOTIFY_EMAIL,
      `LAM 3PL Reorder Report - ${getDateStamp()}`,
      emailBody,
      attachments
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
// Step 3: Load Master Roster Data
// -----------------------------------------------------------------------------

// Helper to safely convert cell value to string (handles numeric MPNs with full precision)
function cellToString(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim();
}

function loadExcelData(excelPath) {
  if (!fs.existsSync(excelPath)) {
    console.error(`  ERROR: Master Roster not found: ${excelPath}`);
    return { data: {}, pendingApprovals: [] };
  }

  // raw: true preserves numeric MPN cells at full precision
  const workbook = XLSX.readFile(excelPath, { raw: true });
  const sheet = workbook.Sheets['Master Roster'];

  if (!sheet) {
    console.error('  ERROR: "Master Roster" sheet not found in Excel file');
    return { data: {}, pendingApprovals: [] };
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  if (rows.length < 2) {
    console.error('  ERROR: No data rows in Master Roster');
    return { data: {}, pendingApprovals: [] };
  }

  // Build column index map from header row
  const header = rows[0];
  const colIdx = {};
  for (const [key, name] of Object.entries(ROSTER_COLS)) {
    colIdx[key] = header.findIndex(h => cellToString(h) === name);
    if (colIdx[key] < 0) {
      console.warn(`  WARNING: Column "${name}" not found in Master Roster`);
    }
  }

  const excelData = {};
  const pendingApprovals = [];

  // Process data rows (skip header)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const mpn = cellToString(row[colIdx.MPN]);
    if (!mpn) continue;

    const pending = cellToString(row[colIdx.PENDING]);
    const proposedResale = colIdx.PROPOSED_RESALE >= 0 ? row[colIdx.PROPOSED_RESALE] : null;

    const status = colIdx.STATUS >= 0 ? cellToString(row[colIdx.STATUS]) : '';
    const submittedDate = colIdx.SUBMITTED_DATE >= 0 ? cellToString(row[colIdx.SUBMITTED_DATE]) : '';

    const record = {
      CPC: cellToString(row[colIdx.CPC]),
      Manufacturer: cellToString(row[colIdx.MANUFACTURER]),
      Description: cellToString(row[colIdx.DESCRIPTION]),
      Award: cellToString(row[colIdx.AWARD]),
      Lead_Time: cellToString(row[colIdx.LEAD_TIME]),
      Base_Unit_Price: colIdx.BASE_PRICE >= 0 ? (parseFloat(row[colIdx.BASE_PRICE]) || 0) : 0,
      Resale_Price: colIdx.RESALE_PRICE >= 0 ? (parseFloat(row[colIdx.RESALE_PRICE]) || 0) : 0,
      MIN_QTY: colIdx.THRESHOLD >= 0 ? (parseFloat(row[colIdx.THRESHOLD]) || 0) : 0,
      MOQ: colIdx.MOQ >= 0 ? (parseFloat(row[colIdx.MOQ]) || 0) : 0,
      Historical_Buyer: cellToString(row[colIdx.BUYER]),
      // Pending approval workflow fields
      Pending: pending,
      Proposed_Resale: proposedResale != null ? (parseFloat(proposedResale) || null) : null,
      Last_Approved: colIdx.LAST_APPROVED >= 0 ? cellToString(row[colIdx.LAST_APPROVED]) : '',
      Status: status,
      Submitted_Date: submittedDate,
    };

    excelData[mpn] = record;

    // Track parts with pending approval for the Pending Approvals file
    if (pending || status === 'Pending Approval') {
      // Calculate days pending
      let daysPending = '';
      if (submittedDate) {
        const submitted = new Date(submittedDate);
        const now = new Date();
        daysPending = Math.floor((now - submitted) / (1000 * 60 * 60 * 24));
      }

      pendingApprovals.push({
        MPN: mpn,
        CPC: record.CPC,
        Manufacturer: record.Manufacturer,
        Description: record.Description,
        Award: record.Award,
        'Current Resale': record.Resale_Price,
        'Proposed Resale': record.Proposed_Resale,
        'Reason': pending,
        'Submitted Date': submittedDate,
        'Days Pending': daysPending,
        'Last Approved': record.Last_Approved,
        'Status': status,
      });
    }
  }

  return { data: excelData, pendingApprovals };
}

// -----------------------------------------------------------------------------
// Step 4: Load Historical Purchase Data from ERP
// -----------------------------------------------------------------------------

// Note: Uses shared/mpn-normalization.js normalizeMPN() for cross-source
// matching. Strips leading zeros, hyphens, spaces, case differences so
// variants like "9552156612741" / "09552156612741" and "ECP-U1C104MA5" /
// "ECPU1C104MA5" normalize to the same key. Applied on BOTH write and lookup
// sides of the enrichment maps so either form finds the data.

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
    const key = normalizeMPN(mpn);
    if (key) {
      historicalData[key] = {
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
    const key = normalizeMPN(mpn);
    if (key) {
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
  // Surface RECENT open LAM purchase activity per MPN, where "recent" means either:
  //   - the PO was cut in the last 90 days (normal lead-time case), OR
  //   - the promise date is today or in the future (long-lead-time case where the
  //     PO is older but the vendor commitment is still live)
  // Open POs that fail BOTH tests (e.g., 2024 cut + 2024 promise, never received,
  // never cancelled) are dropped entirely — they're stuck/orphan POs that need
  // Infor cleanup, not signals for current reorder decisions.
  //
  // VQ_TICKED branch (ispurchased='Y' with no PO cut yet) gets the same treatment
  // using rfq.created and vl.datepromised.
  //
  // Once a row passes the SQL filter it qualifies for PENDING RECEIPT (POV stamped)
  // or PENDING ORDER PLACEMENT (no POV stamp yet — OT PO without Infor stamp,
  // or VQ ticked with no PO at all). Both states are informational at the
  // bottom of the priority sort.
  //
  // On Order Qty = SUM of open qty across all RECENT activity for the MPN.
  // Recent POV cell shows the single most-recent activity row (preferring PO over VQ_TICKED).
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
        COALESCE(ol.datepromised, o.created) AS sort_date,
        COALESCE(ol.chuboe_trackingnumbers, '') AS tracking,
        u_buyer.name AS buyer
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.chuboe_vq_line vl ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
      LEFT JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      LEFT JOIN adempiere.ad_user u_buyer ON u_buyer.ad_user_id = o.salesrep_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND o.docstatus IN ('CO', 'IP', 'DR')
        AND ol.qtyordered > ol.qtydelivered
        AND ol.chuboe_mpn IS NOT NULL
        AND ol.chuboe_mpn != ''
        AND rfq.c_bpartner_id = 1000730
        -- Drop stale orphans: keep iff PO cut recently OR promise date still ≥ today
        AND (
          o.created::date >= CURRENT_DATE - INTERVAL '90 days'
          OR ol.datepromised::date >= CURRENT_DATE
        )

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
        rfq.created AS sort_date,
        '' AS tracking,
        u_vq_buyer.name AS buyer
      FROM adempiere.chuboe_vq_line vl
      JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.ad_user u_vq_buyer ON u_vq_buyer.ad_user_id = vl.createdby
      LEFT JOIN adempiere.c_orderline ol2
        ON ol2.chuboe_vq_line_id = vl.chuboe_vq_line_id AND ol2.isactive = 'Y'
      WHERE vl.ispurchased = 'Y'
        AND vl.isactive = 'Y'
        AND rfq.c_bpartner_id = 1000730
        AND rfq.isactive = 'Y'
        AND ol2.c_orderline_id IS NULL
        AND vl.chuboe_mpn IS NOT NULL
        AND vl.chuboe_mpn != ''
        -- Same recency rule: keep iff RFQ created recently OR VQ promise date still ≥ today
        AND (
          rfq.created::date >= CURRENT_DATE - INTERVAL '90 days'
          OR vl.datepromised::date >= CURRENT_DATE
        )
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY mpn ORDER BY preference ASC, sort_date DESC NULLS LAST) AS rn,
        SUM(qty) OVER (PARTITION BY mpn) AS total_qty
      FROM all_activity
    )
    SELECT mpn, pov_number, ot_po_number, qty, total_qty, promise_date, po_created_date,
           supplier, rfq_number, state, tracking, buyer
    FROM ranked
    WHERE rn = 1;
  `;

  const result = runPsql(sql, 'povs');
  const povData = {};
  for (const line of result.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [mpn, pov, otPo, qty, totalQty, promiseDate, poCreated, supplier, rfqNum, state, tracking, buyer] = line.split('|');
    const key = normalizeMPN(mpn);
    if (key) {
      // Recency is enforced in SQL — anything returned here is by definition still relevant.
      povData[key] = {
        State: (state || '').trim(),                    // 'PO' or 'VQ_TICKED'
        POV_Number: (pov || '').trim(),                 // populated once Infor stamps
        OT_PO_Number: (otPo || '').trim(),              // OT PO# (pre-Infor-stamp fallback)
        POV_Qty: parseFloat(qty) || 0,                  // qty on the displayed row
        POV_Date: (promiseDate || '').trim(),           // vendor promise date on the displayed row
        PO_Created_Date: (poCreated || '').trim(),      // when we cut the PO
        POV_Supplier: (supplier || '').trim(),
        RFQ_Number: (rfqNum || '').trim(),
        Qty_On_Order: parseFloat(totalQty) || 0,        // total across all RECENT open activity for the MPN
        Tracking: (tracking || '').trim(),              // tracking number or notes
        Buyer: (buyer || '').trim(),                    // OT buyer (salesrep on PO, or VQ creator)
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
  'W115 Stale Inventory',
  'Reorder Threshold',
  'Shortfall',
  'Priority',
  'On Order Qty',
  'Recent POV',
  'Tracking',
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
  'LAM MOQ',
  // Other warehouse stock
  'Available Stock (Other WH)',
  'Available Qty (Other WH)',
  // Multi-MPN aggregation (when stock spread across original + alt MPNs)
  'Stock Detail',
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
    'W115 Stale Inventory': lamOwned,
    'Reorder Threshold': excel.MIN_QTY,
    'Shortfall': shortfall,
    'Priority': priority,
    'On Order Qty': pov ? (pov.Qty_On_Order || '') : '',
    'Recent POV': formatPOVCell(pov),
    'Tracking': pov ? (pov.Tracking || '') : '',
    'Base Unit Price': excel.Base_Unit_Price,
    'Resale Price': excel.Resale_Price,
    'Historical Purchase Price': history.Historical_Purchase_Price || '',
    'OT Previous Supplier': history.OT_Previous_Supplier || '',
    'OT Buyer': pov && pov.Buyer ? pov.Buyer : (history.OT_Buyer || ''),
    'Historical Buyer': excel.Historical_Buyer || '',
    'Last Promise Date': history.Last_Purchase_Date || '',
    'Last RFQ': history.RFQ_Number ? `${history.RFQ_Number} (${history.RFQ_Customer || ''})` : '',
    'Lead Time': excel.Lead_Time,
    'LAM MOQ': excel.MOQ,
  };
}

// If the MPN has recent in-flight purchase activity (gated by SQL: PO cut in last 90d
// OR promise date still ≥ today), the row is informational — split into:
//   - PENDING RECEIPT          → Infor POV stamp exists, waiting on shipment
//   - PENDING ORDER PLACEMENT  → no POV stamp yet (OT PO without Infor stamp,
//                                 or VQ ticked with no PO at all) — chase the PO
// Shortfall-based priority is retained when no recent activity exists.
function resolvePriority(shortfallBasedPriority, pov) {
  if (!pov) return shortfallBasedPriority;
  return pov.POV_Number ? 'PENDING RECEIPT' : 'PENDING ORDER PLACEMENT';
}

function identifyReorderCandidates(aggregated, excelData, historicalData, recentPOVs = {}) {
  const alerts = [];
  const inventoryMPNs = new Set(Object.keys(aggregated));

  // Build CPC -> total inventory by summing ALL approved MPNs from AVL
  // This handles cases where we have both original MPN and alternate(s) in stock
  const cpcTotalInventory = new Map();  // CPC -> { total, w111, w115, mpnsWithStock }
  const processedCPCs = new Set();

  // First pass: aggregate inventory by CPC using AVL
  for (const [rosterMpn, excel] of Object.entries(excelData)) {
    const cpc = excel.CPC;
    if (!cpc || processedCPCs.has(cpc)) continue;
    processedCPCs.add(cpc);

    const approvedMPNs = getAllApprovedMPNs(cpc, rosterMpn);
    let totalQty = 0;
    let w111Qty = 0;
    let w115Qty = 0;
    const mpnsWithStock = [];

    for (const mpn of approvedMPNs) {
      const inv = aggregated[mpn];
      if (inv && inv.Total_Qty > 0) {
        totalQty += inv.Total_Qty;
        w111Qty += inv.W111_Qty || 0;
        w115Qty += inv.W115_Qty || 0;
        mpnsWithStock.push({ mpn, qty: inv.Total_Qty });
      }
    }

    cpcTotalInventory.set(cpc, { total: totalQty, w111: w111Qty, w115: w115Qty, mpnsWithStock, approvedMPNs });
  }

  // Log multi-MPN inventory aggregation stats
  const multiMpnCPCs = [...cpcTotalInventory.entries()].filter(([_, data]) => data.mpnsWithStock.length > 1);
  if (multiMpnCPCs.length > 0) {
    console.log(`  AVL multi-MPN aggregation: ${multiMpnCPCs.length} CPCs have stock across multiple approved MPNs`);
  }

  // Process by CPC using aggregated totals
  processedCPCs.clear();
  for (const [rosterMpn, excel] of Object.entries(excelData)) {
    const cpc = excel.CPC;
    if (!cpc || processedCPCs.has(cpc)) continue;
    processedCPCs.add(cpc);

    const minQty = excel.MIN_QTY;
    const cpcInv = cpcTotalInventory.get(cpc) || { total: 0, w111: 0, w115: 0, mpnsWithStock: [] };
    const totalQty = cpcInv.total;

    // Check if below threshold
    if (totalQty < minQty) {
      const shortfall = minQty - totalQty;
      const shortfallPct = minQty > 0 ? (shortfall / minQty) * 100 : 0;

      // CRITICAL if zero stock across ALL approved MPNs
      let basePriority;
      if (totalQty === 0) {
        basePriority = 'CRITICAL';
      } else {
        basePriority = shortfallPct >= 75 ? 'HIGH' : shortfallPct >= 50 ? 'MEDIUM' : 'LOW';
      }

      const key = normalizeMPN(rosterMpn);
      const priority = resolvePriority(basePriority, recentPOVs[key]);
      const lamOwned = cpcInv.w115 > 0 ? 'YES' : 'NO';

      const alert = buildAlert(rosterMpn, excel, totalQty, lamOwned, shortfall, priority,
        historicalData[key] || {}, recentPOVs[key]);

      // Add note if stock is spread across multiple MPNs
      if (cpcInv.mpnsWithStock.length > 1) {
        const stockDetail = cpcInv.mpnsWithStock.map(m => `${m.mpn}:${m.qty}`).join(', ');
        alert['Stock Detail'] = stockDetail;
      }

      alerts.push(alert);
    }
  }

  // Handle items in Excel with no CPC (shouldn't happen, but defensive)
  for (const [mpn, excel] of Object.entries(excelData)) {
    if (excel.CPC) continue;  // Already processed by CPC
    if (!inventoryMPNs.has(mpn)) continue;

    const key = normalizeMPN(mpn);
    const pov = recentPOVs[key];

    // Parts with no threshold: still include but flag appropriately
    if (excel.MIN_QTY <= 0) {
      // Zero stock + no threshold = flag as NO THRESHOLD unless there's recent activity
      const priority = pov ? resolvePriority('NO THRESHOLD', pov) : 'NO THRESHOLD';
      alerts.push(buildAlert(mpn, excel, 0, 'NO', 0, priority,
        historicalData[key] || {}, pov));
      continue;
    }

    const priority = resolvePriority('CRITICAL', pov);
    alerts.push(buildAlert(mpn, excel, 0, 'NO', excel.MIN_QTY, priority,
      historicalData[key] || {}, pov));
  }

  // Sort: CRITICAL first (must source now), shortfall-based severity next,
  // then the PENDING bucket last (informational). Within the PENDING bucket,
  // PENDING ORDER PLACEMENT comes before PENDING RECEIPT — chasing an unplaced
  // PO is more actionable than waiting on a vendor that's already been ordered from.
  const priorityOrder = {
    'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3,
    'NO THRESHOLD': 3.5,  // After LOW, before PENDING - need threshold from LAM
    'PENDING ORDER PLACEMENT': 4,
    'PENDING RECEIPT': 4,
  };
  // Within the PENDING bucket only, sub-order ORDER_PLACEMENT before RECEIPT.
  const pendingSubOrder = { 'PENDING ORDER PLACEMENT': 0, 'PENDING RECEIPT': 1 };
  alerts.sort((a, b) => {
    if (priorityOrder[a.Priority] !== priorityOrder[b.Priority]) {
      return priorityOrder[a.Priority] - priorityOrder[b.Priority];
    }
    if (pendingSubOrder[a.Priority] !== undefined && pendingSubOrder[b.Priority] !== undefined) {
      const sub = pendingSubOrder[a.Priority] - pendingSubOrder[b.Priority];
      if (sub !== 0) return sub;
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
// Write Pending Approvals Excel File
// -----------------------------------------------------------------------------

const PENDING_APPROVAL_COLUMNS = [
  'CPC',
  'MPN',
  'Manufacturer',
  'Description',
  'Award',
  'Current Resale',
  'Proposed Resale',
  'Reason',
  'Submitted Date',
  'Days Pending',
  'Last Approved',
  'Status',
];

function writePendingApprovalsExcel(pendingApprovals, outputPath) {
  if (pendingApprovals.length === 0) {
    console.log('  No pending approvals to write.');
    return null;
  }

  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();

  // Sort by days pending (oldest first) to highlight aging items
  const sorted = [...pendingApprovals].sort((a, b) => {
    const daysA = typeof a['Days Pending'] === 'number' ? a['Days Pending'] : -1;
    const daysB = typeof b['Days Pending'] === 'number' ? b['Days Pending'] : -1;
    return daysB - daysA; // Oldest first
  });

  // Create worksheet
  const ws = XLSX.utils.json_to_sheet(sorted, { header: PENDING_APPROVAL_COLUMNS });

  // Set column widths
  ws['!cols'] = [
    { wch: 18 },  // CPC
    { wch: 25 },  // MPN
    { wch: 25 },  // Manufacturer
    { wch: 35 },  // Description
    { wch: 8 },   // Award
    { wch: 14 },  // Current Resale
    { wch: 14 },  // Proposed Resale
    { wch: 30 },  // Reason
    { wch: 14 },  // Submitted Date
    { wch: 12 },  // Days Pending
    { wch: 14 },  // Last Approved
    { wch: 15 },  // Status
  ];

  // Format currency columns
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let row = 1; row <= range.e.r; row++) {
    const currentCell = ws[XLSX.utils.encode_cell({ r: row, c: 5 })]; // Current Resale
    const proposedCell = ws[XLSX.utils.encode_cell({ r: row, c: 6 })]; // Proposed Resale
    if (currentCell && typeof currentCell.v === 'number') currentCell.z = '$#,##0.00';
    if (proposedCell && typeof proposedCell.v === 'number') proposedCell.z = '$#,##0.00';
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Pending Approvals');

  // Add summary sheet
  const summaryData = [
    { 'Metric': 'Total Pending', 'Value': pendingApprovals.length },
    { 'Metric': 'Oldest (Days)', 'Value': Math.max(...pendingApprovals.map(p => p['Days Pending'] || 0)) },
    { 'Metric': 'Generated', 'Value': new Date().toISOString().split('T')[0] },
  ];
  const summaryWs = XLSX.utils.json_to_sheet(summaryData);
  summaryWs['!cols'] = [{ wch: 20 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

  XLSX.writeFile(wb, outputPath);
  console.log(`  Pending approvals written to: ${path.basename(outputPath)} (${pendingApprovals.length} items)`);

  return outputPath;
}

// Write a sidecar JSON capturing the current state of every MPN listed in
// lam-escalations.json — even MPNs that are above threshold and therefore NOT
// on the reorder list. The runner consumes this to render synthetic Escalations
// rows for "stock arrived but resale negotiation still pending" cases (Josh action).
function writeEscalationsContext(outputPath, aggregated, excelData, recentPOVs, historicalData, reorderAlerts) {
  const escalationsPath = path.join(__dirname, 'lam-escalations.json');
  if (!fs.existsSync(escalationsPath)) {
    fs.writeFileSync(outputPath, JSON.stringify({ entries: [] }, null, 2) + '\n');
    return;
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(escalationsPath, 'utf-8')); }
  catch (err) { console.log(`  WARNING: could not parse ${escalationsPath}: ${err.message}`); return; }
  const entries = (state && state.entries) || [];
  const reorderMpns = new Set(reorderAlerts.map(a => (a.MPN || '').trim()));

  const ctx = entries.map(e => {
    const raw = e.mpn;
    const key = normalizeMPN(raw);
    const inv = aggregated[raw] || aggregated[key] || { Total_Qty: 0, W111_Qty: 0, W115_Qty: 0 };
    const excel = excelData[raw] || excelData[key] || {};
    const pov = recentPOVs[key] || null;
    const hist = historicalData[key] || {};
    const onReorderList = reorderMpns.has(raw);
    const stockArrived = !onReorderList && (inv.Total_Qty > 0);
    return {
      mpn: raw,
      onReorderList,
      stockArrived,
      stock: { total: inv.Total_Qty, w111: inv.W111_Qty || 0, w115: inv.W115_Qty || 0 },
      threshold: excel.MIN_QTY ?? null,
      lamMoq: excel.MOQ ?? null,
      resalePrice: excel.Resale_Price ?? null,
      basePrice: excel.Base_Unit_Price ?? null,
      lamPN: excel.CPC || '',
      mfr: excel.Manufacturer || '',
      itemDescription: excel.Description || '',
      leadTime: excel.Lead_Time || '',
      historicalSupplier: hist.Last_Supplier || '',
      pov, // null or full pov object (POV_Number, POV_Date, POV_Supplier, etc.)
    };
  });

  const aboveThresholdStocked = ctx.filter(c => c.stockArrived).length;
  fs.writeFileSync(outputPath, JSON.stringify({
    generated: new Date().toISOString(),
    entries: ctx,
  }, null, 2) + '\n');
  console.log(`  Escalations context written: ${ctx.length} manual entries (${aboveThresholdStocked} above-threshold with stock arrived)`);
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
