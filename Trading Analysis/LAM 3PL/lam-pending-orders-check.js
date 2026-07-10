#!/usr/bin/env node
/**
 * LAM Pending Orders Check
 *
 * Identifies orders that were processed in OT but not placed in Infor.
 * These are "stuck" POs that need to be chased.
 *
 * Also provides lookup tools to cross-reference between OT, Infor inventory,
 * and Infor POV files.
 *
 * Criteria for stuck orders:
 *   - VQ ticked as purchased OR OT PO exists
 *   - BUT no chuboe_po_string (POV stamp from Infor)
 *   - Recency: PO cut ≤90d OR promise date ≥ today
 *
 * Usage:
 *   node lam-pending-orders-check.js [--dry-run]
 *   node lam-pending-orders-check.js --list-exclusions
 *   node lam-pending-orders-check.js --mark-ok <vq_id> [reason]
 *   node lam-pending-orders-check.js --clear-exclusion <vq_id>
 *
 * Lookup commands:
 *   node lam-pending-orders-check.js --find-pov <pov_number> [--inventory <file>]
 *   node lam-pending-orders-check.js --find-mpn <mpn> [--inventory <file>]
 *   node lam-pending-orders-check.js --validate-pov <pov_file>  # Cross-reference POV file vs OT
 *
 * The --inventory flag cross-references against Infor inventory to show receipt status.
 * Receipt status comes from Infor (not OT) - OT qtydelivered is always 0 for LAM.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const XLSX = require('xlsx');

// Load environment
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const SCRIPT_DIR = __dirname;
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const EXCLUSIONS_FILE = path.join(SCRIPT_DIR, 'lam-pending-orders-exclusions.json');

// LAM customer BP ID
const LAM_BP_ID = 1000730;

// Email config
const EMAIL_ACCOUNT = 'lamkitting';
const EMAIL_TO = 'jake.harris@astutegroup.com';

// === EXCLUSION PERSISTENCE ===

function loadExclusions() {
  if (!fs.existsSync(EXCLUSIONS_FILE)) {
    return new Map();
  }
  try {
    const data = JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8'));
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('Warning: Could not load exclusions file:', err.message);
    return new Map();
  }
}

function saveExclusions(exclusions) {
  const obj = Object.fromEntries(exclusions);
  fs.writeFileSync(EXCLUSIONS_FILE, JSON.stringify(obj, null, 2));
}

function addExclusion(exclusions, vqId, reason) {
  exclusions.set(String(vqId), {
    vqId,
    reason: reason || 'Intentionally not placed yet',
    date: new Date().toISOString().split('T')[0],
  });
}

// === INVENTORY FILE LOADING ===

/**
 * Load Infor inventory file and build MPN lookup.
 * Returns Map of MPN -> { totalQty, warehouses: [{wh, qty, lot}] }
 *
 * IMPORTANT: Receipt status for LAM comes from Infor inventory, NOT OT.
 * OT qtydelivered is always 0 for LAM orders.
 */
function loadInventoryFile(inventoryPath) {
  if (!fs.existsSync(inventoryPath)) {
    console.error(`Inventory file not found: ${inventoryPath}`);
    return null;
  }

  const wb = XLSX.readFile(inventoryPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allData = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Find header row (contains "Item" in first column)
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(15, allData.length); i++) {
    if (allData[i] && allData[i][0] === 'Item') {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    console.error('Could not find header row in inventory file');
    return null;
  }

  // Parse with correct header row
  const data = XLSX.utils.sheet_to_json(ws, { range: headerRowIndex });

  // LAM warehouses where receipts would appear
  const LAM_WAREHOUSES = ['W111', 'W115', 'W118'];

  // Build MPN -> inventory lookup
  const inventory = new Map();

  for (const row of data) {
    const mpn = (row['Item'] || '').toString().trim().toUpperCase();
    const wh = (row['Warehouse'] || '').toString().trim();
    const qty = parseFloat(row['Lot Quantity'] || 0);
    const lot = (row['Lot'] || '').toString().trim();

    if (!mpn || qty <= 0) continue;

    if (!inventory.has(mpn)) {
      inventory.set(mpn, { totalQty: 0, lamQty: 0, warehouses: [] });
    }

    const inv = inventory.get(mpn);
    inv.totalQty += qty;
    if (LAM_WAREHOUSES.includes(wh)) {
      inv.lamQty += qty;
    }
    inv.warehouses.push({ wh, qty: Math.round(qty), lot });
  }

  console.log(`Loaded inventory: ${inventory.size} unique MPNs`);
  return inventory;
}

/**
 * Check if an MPN has been received based on inventory.
 * Returns { received: bool, lamQty: number, details: string }
 */
function checkReceiptStatus(mpn, orderedQty, inventory) {
  if (!inventory) {
    return { received: null, lamQty: null, details: 'No inventory file' };
  }

  const mpnUpper = mpn.trim().toUpperCase();
  const inv = inventory.get(mpnUpper);

  if (!inv) {
    return { received: false, lamQty: 0, details: 'Not in inventory' };
  }

  // Check LAM warehouse stock specifically
  const lamStock = inv.warehouses.filter(w => ['W111', 'W115', 'W118'].includes(w.wh));
  const lamQty = lamStock.reduce((sum, w) => sum + w.qty, 0);

  if (lamQty >= orderedQty) {
    return { received: true, lamQty, details: `RECEIVED (${lamQty} in LAM)` };
  } else if (lamQty > 0) {
    return { received: 'partial', lamQty, details: `PARTIAL (${lamQty}/${orderedQty} in LAM)` };
  } else if (inv.totalQty > 0) {
    return { received: false, lamQty: 0, details: `In other WH (${inv.totalQty} total)` };
  }

  return { received: false, lamQty: 0, details: 'Not in inventory' };
}

// === LOOKUP FUNCTIONS ===

/**
 * Find OT records by Infor POV number.
 * Searches chuboe_po_string field which contains the POV stamp.
 * Returns structured results with tracking info.
 */
async function findByPOV(povNumber) {
  // Normalize POV - handle with or without POV prefix
  const searchPov = povNumber.toUpperCase().startsWith('POV')
    ? povNumber.toUpperCase()
    : `POV${povNumber}`;

  const sql = `
    SELECT
      vl.chuboe_vq_line_id AS vq_id,
      rfq.value AS rfq_number,
      rfq.c_bpartner_id AS customer_bp_id,
      bp_cust.name AS customer,
      rlm.chuboe_mpn AS mpn,
      rlm.chuboe_mfr_text AS manufacturer,
      vl.qty AS qty,
      vl.cost AS cost,
      vl.datepromised AS promise_date,
      vl.ispurchased,
      bp_vendor.name AS supplier,
      o.documentno AS ot_po_number,
      o.created AS po_created,
      ol.chuboe_po_string AS pov_stamp,
      ol.chuboe_trackingnumbers AS tracking,
      CASE WHEN rfq.c_bpartner_id = ${LAM_BP_ID} THEN 'Y' ELSE 'N' END AS is_lam
    FROM chuboe_vq_line vl
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vl.chuboe_rfq_line_id
    JOIN chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    JOIN c_bpartner bp_cust ON bp_cust.c_bpartner_id = rfq.c_bpartner_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN c_bpartner bp_vendor ON bp_vendor.c_bpartner_id = vl.c_bpartner_id
    LEFT JOIN c_orderline ol ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
    LEFT JOIN c_order o ON o.c_order_id = ol.c_order_id
    WHERE UPPER(ol.chuboe_po_string) = '${searchPov}'
      AND vl.isactive = 'Y'
    ORDER BY rlm.chuboe_mpn
  `;

  const rows = await executeQuery(sql, 'pov_search');

  // Parse into structured objects
  // Columns: vq_id, rfq, customer_bp, customer, mpn, mfr, qty, cost, promise, ispurchased, supplier, ot_po, po_created, pov, tracking, is_lam
  return rows.map(r => ({
    vqId: r[0],
    rfq: r[1],
    customerBpId: r[2],
    customer: r[3],
    mpn: r[4],
    mfr: r[5],
    qty: parseInt(r[6]) || 0,
    cost: parseFloat(r[7]) || 0,
    promiseDate: r[8],
    isPurchased: r[9] === 'Y',
    supplier: r[10],
    otPo: r[11],
    poCreated: r[12],
    pov: r[13],
    tracking: r[14] || '',
    isLam: r[15] === 'Y',
  }));
}

/**
 * Find LAM orders by MPN (all statuses - pending, ordered, received).
 * Useful when you have a part but don't know the POV.
 */
async function findByMPN(mpn) {
  const normalizedMpn = mpn.trim().toUpperCase();

  const sql = `
    SELECT
      vl.chuboe_vq_line_id AS vq_id,
      rfq.value AS rfq_number,
      rlm.chuboe_mpn AS mpn,
      rlm.chuboe_mfr_text AS manufacturer,
      vl.qty AS qty,
      vl.cost AS cost,
      vl.datepromised AS promise_date,
      vl.created AS vq_created,
      vl.ispurchased,
      bp_vendor.name AS supplier,
      o.documentno AS ot_po_number,
      o.created AS po_created,
      ol.chuboe_po_string AS pov_stamp,
      CASE
        WHEN ol.chuboe_po_string LIKE 'POV%' THEN 'PLACED IN INFOR'
        WHEN o.c_order_id IS NOT NULL THEN 'OT PO EXISTS - NO INFOR'
        WHEN vl.ispurchased = 'Y' THEN 'VQ TICKED - NO PO'
        ELSE 'VQ NOT TICKED'
      END AS status
    FROM chuboe_vq_line vl
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vl.chuboe_rfq_line_id
    JOIN chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN c_bpartner bp_vendor ON bp_vendor.c_bpartner_id = vl.c_bpartner_id
    LEFT JOIN c_orderline ol ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
    LEFT JOIN c_order o ON o.c_order_id = ol.c_order_id
    WHERE rfq.c_bpartner_id = ${LAM_BP_ID}
      AND rfq.isactive = 'Y'
      AND vl.isactive = 'Y'
      AND UPPER(TRIM(rlm.chuboe_mpn)) = '${normalizedMpn}'
      AND vl.created >= CURRENT_DATE - INTERVAL '180 days'
    ORDER BY vl.created DESC
  `;

  return executeQuery(sql, 'mpn_search');
}

/**
 * Validate a POV file from Infor against OT records.
 * Identifies:
 * - Items in POV but not in OT (missing in OT)
 * - Items in OT but not stamped (stuck)
 */
async function validatePOVFile(povFilePath) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(povFilePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws);

  // Extract POV items
  const povItems = [];
  let povNumber = null;

  for (const row of data) {
    const pov = row['PO'] || row['POV'] || '';
    const mpn = row['Item'] || '';
    const qty = parseInt(row['Ordered'] || row['Qty'] || 0);
    const status = row['Line Status'] || row['Status'] || '';
    const vendor = row['Vendor Name'] || row['Vendor'] || '';

    if (pov && mpn) {
      if (!povNumber) povNumber = pov;
      povItems.push({ pov, mpn: mpn.trim().toUpperCase(), qty, status, vendor });
    }
  }

  console.log(`Loaded ${povItems.length} items from POV file (${povNumber || 'unknown'})`);

  // Get OT records for this POV
  const otRecords = povNumber ? await findByPOV(povNumber) : [];
  console.log(`Found ${otRecords.length} OT records with POV stamp`);

  // Build lookup of OT records by MPN
  const otByMpn = new Map();
  for (const rec of otRecords) {
    const mpn = (rec.mpn || '').trim().toUpperCase();
    if (!otByMpn.has(mpn)) otByMpn.set(mpn, []);
    otByMpn.get(mpn).push(rec);
  }

  // Compare
  const results = {
    matched: [],
    inPovNotOt: [],
    povNumber,
    otRecordCount: otRecords.length,
    povItemCount: povItems.length,
  };

  for (const povItem of povItems) {
    const otMatches = otByMpn.get(povItem.mpn) || [];
    if (otMatches.length > 0) {
      results.matched.push({
        ...povItem,
        otMatches: otMatches.map(m => ({
          vq_id: m.vq_id,
          rfq: m.rfq_number,
          ot_po: m.ot_po_number,
        })),
      });
    } else {
      results.inPovNotOt.push(povItem);
    }
  }

  return results;
}

/**
 * Execute a SQL query and return parsed results.
 */
function executeQuery(sql, queryName) {
  const tmpFile = `/tmp/${queryName}_${Date.now()}.sql`;
  const outFile = `/tmp/${queryName}_${Date.now()}.out`;

  fs.writeFileSync(tmpFile, sql);

  try {
    execSync(
      `psql -U analytics_user -d idempiere_replica -t -A -F '|' -f "${tmpFile}" -o "${outFile}"`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const content = fs.readFileSync(outFile, 'utf8').trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l.trim());
    return lines.map(line => {
      const values = line.split('|');
      // Return as array - caller knows the column order
      return values;
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
  }
}

// === MAIN ===

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Handle listing exclusions
  if (args.includes('--list-exclusions')) {
    const exclusions = loadExclusions();
    console.log('=== EXCLUDED VQ LINES ===');
    console.log(`Total: ${exclusions.size}`);
    console.log('');
    for (const [key, val] of exclusions) {
      console.log(`VQ ID: ${val.vqId}`);
      console.log(`  Reason: ${val.reason}`);
      console.log(`  Added: ${val.date}`);
      console.log('');
    }
    return { listed: true, count: exclusions.size };
  }

  // Handle marking as OK
  if (args.includes('--mark-ok')) {
    const vqId = args[args.indexOf('--mark-ok') + 1];
    const reason = args.slice(args.indexOf('--mark-ok') + 2).join(' ') || 'Intentionally not placed yet';

    if (!vqId) {
      console.error('Usage: node lam-pending-orders-check.js --mark-ok <vq_id> [reason]');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    addExclusion(exclusions, vqId, reason);
    saveExclusions(exclusions);
    console.log(`Marked as OK: VQ ${vqId}`);
    console.log(`Reason: ${reason}`);
    console.log(`Total exclusions: ${exclusions.size}`);
    return { marked: true, vqId };
  }

  // Handle clearing exclusion
  if (args.includes('--clear-exclusion')) {
    const vqId = args[args.indexOf('--clear-exclusion') + 1];

    if (!vqId) {
      console.error('Usage: node lam-pending-orders-check.js --clear-exclusion <vq_id>');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    if (exclusions.has(String(vqId))) {
      exclusions.delete(String(vqId));
      saveExclusions(exclusions);
      console.log(`Removed exclusion: VQ ${vqId}`);
      console.log(`Remaining exclusions: ${exclusions.size}`);
    } else {
      console.log(`No exclusion found for VQ ${vqId}`);
    }
    return { cleared: true, vqId };
  }

  // Handle POV lookup
  if (args.includes('--find-pov')) {
    const pov = args[args.indexOf('--find-pov') + 1];

    if (!pov) {
      console.error('Usage: node lam-pending-orders-check.js --find-pov <pov_number> [--inventory <file>]');
      console.error('Example: node lam-pending-orders-check.js --find-pov POV0075252 --inventory ~/file-drop/ASTItemLotsReportInputs.xlsx');
      process.exit(1);
    }

    // Load inventory file if provided (for receipt status)
    let inventory = null;
    if (args.includes('--inventory')) {
      const invPath = args[args.indexOf('--inventory') + 1];
      if (invPath && fs.existsSync(invPath)) {
        inventory = loadInventoryFile(invPath);
      } else {
        console.warn(`Warning: Inventory file not found: ${invPath}`);
      }
    }

    console.log(`\n=== OT Records for POV: ${pov.toUpperCase()} ===\n`);
    const results = await findByPOV(pov);

    if (results.length === 0) {
      console.log('No OT records found with this POV stamp.');
      console.log('This could mean:');
      console.log('  1. The POV was never entered in OT (order not placed through OT)');
      console.log('  2. The POV number is incorrect');
      console.log('  3. The POV stamp hasnt been applied to the OT order lines yet');
      console.log('\nTry searching by MPN instead:');
      console.log('  node lam-pending-orders-check.js --find-mpn <mpn>');
      return { found: false, pov };
    }

    console.log(`Found ${results.length} record(s):\n`);

    if (inventory) {
      // With inventory - show receipt status
      console.log('MPN                          | Qty  | Cost     | Tracking         | Receipt Status');
      console.log('-'.repeat(100));

      for (const r of results) {
        const mpn = (r.mpn || '').substring(0, 28).padEnd(28);
        const qty = String(r.qty).padStart(4);
        const cost = ('$' + r.cost.toFixed(2)).padStart(8);
        const tracking = (r.tracking || '-').substring(0, 16).padEnd(16);
        const receiptStatus = checkReceiptStatus(r.mpn, r.qty, inventory);

        console.log(`${mpn} | ${qty} | ${cost} | ${tracking} | ${receiptStatus.details}`);
      }

      // Summary
      const received = results.filter(r => checkReceiptStatus(r.mpn, r.qty, inventory).received === true).length;
      const partial = results.filter(r => checkReceiptStatus(r.mpn, r.qty, inventory).received === 'partial').length;
      const pending = results.length - received - partial;

      console.log('');
      console.log(`Summary: ${received} received, ${partial} partial, ${pending} pending`);
    } else {
      // Without inventory - show tracking only
      console.log('MPN                          | Qty  | Cost     | Supplier                   | Tracking');
      console.log('-'.repeat(110));
      console.log('(Add --inventory <file> to see receipt status from Infor)');
      console.log('');

      for (const r of results) {
        const mpn = (r.mpn || '').substring(0, 28).padEnd(28);
        const qty = String(r.qty).padStart(4);
        const cost = ('$' + r.cost.toFixed(2)).padStart(8);
        const supplier = (r.supplier || '').substring(0, 26).padEnd(26);
        const tracking = r.tracking || '-';

        console.log(`${mpn} | ${qty} | ${cost} | ${supplier} | ${tracking}`);
      }
    }

    return { found: true, pov, count: results.length, results };
  }

  // Handle MPN lookup
  if (args.includes('--find-mpn')) {
    const mpn = args[args.indexOf('--find-mpn') + 1];

    if (!mpn) {
      console.error('Usage: node lam-pending-orders-check.js --find-mpn <mpn>');
      console.error('Example: node lam-pending-orders-check.js --find-mpn DG406EUI+');
      process.exit(1);
    }

    console.log(`\n=== LAM Orders for MPN: ${mpn.toUpperCase()} (last 180 days) ===\n`);
    const results = await findByMPN(mpn);

    if (results.length === 0) {
      console.log('No LAM orders found for this MPN in the last 180 days.');
      return { found: false, mpn };
    }

    console.log(`Found ${results.length} order(s):\n`);
    console.log('VQ ID      | RFQ #      | Qty  | Cost     | Supplier                   | OT PO      | POV Stamp      | Status');
    console.log('-'.repeat(130));

    for (const r of results) {
      // Columns: vq_id, rfq, mpn, mfr, qty, cost, promise, created, ispurchased, supplier, ot_po, po_created, pov, status
      const vqId = r[0].padEnd(10);
      const rfq = (r[1] || '').padEnd(10);
      const qty = (r[4] || '').padStart(4);
      const cost = ('$' + parseFloat(r[5] || 0).toFixed(2)).padStart(8);
      const supplier = (r[9] || '').substring(0, 26).padEnd(26);
      const otPo = (r[10] || '').padEnd(10);
      const pov = (r[12] || '-').padEnd(14);
      const status = r[13] || '';

      console.log(`${vqId} | ${rfq} | ${qty} | ${cost} | ${supplier} | ${otPo} | ${pov} | ${status}`);
    }

    return { found: true, mpn, count: results.length, results };
  }

  // Handle POV file validation
  if (args.includes('--validate-pov')) {
    const povFile = args[args.indexOf('--validate-pov') + 1];

    if (!povFile) {
      console.error('Usage: node lam-pending-orders-check.js --validate-pov <pov_file.xlsx>');
      process.exit(1);
    }

    if (!fs.existsSync(povFile)) {
      console.error(`File not found: ${povFile}`);
      process.exit(1);
    }

    console.log(`\n=== Validating POV File: ${povFile} ===\n`);
    const results = await validatePOVFile(povFile);

    console.log(`POV: ${results.povNumber || 'Unknown'}`);
    console.log(`Items in POV file: ${results.povItemCount}`);
    console.log(`OT records with stamp: ${results.otRecordCount}`);
    console.log(`Matched: ${results.matched.length}`);
    console.log(`In POV but not in OT: ${results.inPovNotOt.length}`);

    if (results.inPovNotOt.length > 0) {
      console.log('\n--- Items in POV file but NOT found in OT ---');
      console.log('(These may not have been ordered through OT, or MPN doesnt match)\n');
      console.log('MPN                          | Qty  | Status    | Vendor');
      console.log('-'.repeat(80));

      for (const item of results.inPovNotOt) {
        const mpn = item.mpn.substring(0, 28).padEnd(28);
        const qty = String(item.qty).padStart(4);
        const status = (item.status || '').substring(0, 9).padEnd(9);
        const vendor = (item.vendor || '').substring(0, 25);
        console.log(`${mpn} | ${qty} | ${status} | ${vendor}`);
      }
    }

    return results;
  }

  console.log('=== LAM Pending Orders Check ===');
  console.log('Dry run:', dryRun);
  console.log('');

  // Load exclusions
  console.log('Step 1: Loading exclusions...');
  const exclusions = loadExclusions();
  console.log(`  ${exclusions.size} VQ lines excluded`);

  // Query for stuck orders
  console.log('');
  console.log('Step 2: Querying for pending orders...');
  const results = await queryPendingOrders(exclusions);
  console.log(`  Found ${results.length} stuck orders`);

  if (results.length === 0) {
    console.log('');
    console.log('No pending orders found. All clear!');
    return { count: 0 };
  }

  // Generate summary
  console.log('');
  console.log('=== SUMMARY ===');
  const bySupplier = {};
  const byAge = { '0-7d': 0, '8-30d': 0, '31-60d': 0, '60d+': 0 };

  for (const r of results) {
    bySupplier[r.supplier] = (bySupplier[r.supplier] || 0) + 1;
    const age = r.days_stuck;
    if (age <= 7) byAge['0-7d']++;
    else if (age <= 30) byAge['8-30d']++;
    else if (age <= 60) byAge['31-60d']++;
    else byAge['60d+']++;
  }

  console.log('By age:');
  Object.entries(byAge).forEach(([k, v]) => {
    if (v > 0) console.log(`  ${k}: ${v}`);
  });

  console.log('');
  console.log('By supplier:');
  Object.entries(bySupplier).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });

  // Write output
  const today = new Date().toISOString().split('T')[0];
  const outputPath = path.join(OUTPUT_DIR, `LAM_Pending_Orders_${today}.xlsx`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('');
  console.log('Step 3: Writing output...');
  writeExcel(results, outputPath);
  console.log(`  Wrote: ${outputPath}`);

  // Send email if items found
  if (!dryRun && results.length > 0) {
    console.log('');
    console.log('Step 4: Sending email notification...');
    await sendNotification(results, outputPath, today);
    console.log('  Email sent');
  } else if (dryRun && results.length > 0) {
    console.log('');
    console.log(`Step 4: [DRY RUN] Would send email for ${results.length} stuck orders`);
  }

  return {
    count: results.length,
    outputPath,
    byAge,
    bySupplier,
  };
}

async function queryPendingOrders(exclusions) {
  const sql = `
    SELECT
      vl.chuboe_vq_line_id AS vq_id,
      rfq.value AS rfq_number,
      rlm.chuboe_mpn AS mpn,
      rlm.chuboe_mfr_text AS manufacturer,
      vl.qty AS qty,
      vl.cost AS cost,
      vl.datepromised AS promise_date,
      vl.created AS vq_created,
      vl.ispurchased,
      bp_vendor.name AS supplier,
      o.documentno AS ot_po_number,
      o.created AS po_created,
      ol.chuboe_po_string AS pov_stamp,
      CURRENT_DATE - vl.created::date AS days_stuck,
      u.name AS created_by
    FROM chuboe_vq_line vl
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vl.chuboe_rfq_line_id
    JOIN chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN c_bpartner bp_vendor ON bp_vendor.c_bpartner_id = vl.c_bpartner_id
    LEFT JOIN c_orderline ol ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
    LEFT JOIN c_order o ON o.c_order_id = ol.c_order_id
    LEFT JOIN ad_user u ON u.ad_user_id = vl.createdby
    WHERE rfq.c_bpartner_id = ${LAM_BP_ID}
      AND rfq.isactive = 'Y'
      AND vl.isactive = 'Y'
      AND (vl.ispurchased = 'Y' OR o.c_order_id IS NOT NULL)
      AND (ol.chuboe_po_string IS NULL OR ol.chuboe_po_string = '' OR ol.chuboe_po_string NOT LIKE 'POV%')
      AND (
        vl.created >= CURRENT_DATE - INTERVAL '90 days'
        OR vl.datepromised >= CURRENT_DATE
      )
    ORDER BY days_stuck DESC, supplier, mpn
  `;

  const tmpFile = `/tmp/pending_orders_${Date.now()}.sql`;
  const outFile = `/tmp/pending_orders_${Date.now()}.out`;

  fs.writeFileSync(tmpFile, sql);

  try {
    execSync(
      `psql -U analytics_user -d idempiere_replica -t -A -F '|' -f "${tmpFile}" -o "${outFile}"`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const content = fs.readFileSync(outFile, 'utf8').trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return [];

    // Pipe-separated output: vq_id|rfq_number|mpn|manufacturer|qty|cost|promise_date|vq_created|ispurchased|supplier|ot_po_number|po_created|pov_stamp|days_stuck|created_by
    const results = [];

    for (const line of lines) {
      const values = line.split('|');
      if (values.length < 15) continue;

      const vqId = values[0];

      // Skip excluded VQ lines
      if (exclusions.has(String(vqId))) {
        continue;
      }

      results.push({
        vq_id: vqId,
        rfq_number: values[1],
        mpn: values[2],
        manufacturer: values[3],
        qty: parseInt(values[4]) || 0,
        cost: parseFloat(values[5]) || 0,
        promise_date: values[6],
        vq_created: values[7],
        is_purchased: values[8] === 'Y',
        supplier: values[9] || 'Unknown',
        ot_po_number: values[10] || '',
        po_created: values[11] || '',
        pov_stamp: values[12] || '',
        days_stuck: parseInt(values[13]) || 0,
        created_by: values[14] || '',
      });
    }

    return results;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
  }
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function writeExcel(results, outputPath) {
  const wb = XLSX.utils.book_new();

  const rows = results.map(r => ({
    'VQ ID': r.vq_id,
    'RFQ #': r.rfq_number,
    'MPN': r.mpn,
    'Manufacturer': r.manufacturer,
    'Qty': r.qty,
    'Cost': r.cost,
    'Supplier': r.supplier,
    'OT PO #': r.ot_po_number,
    'PO Created': r.po_created ? r.po_created.split('T')[0] : '',
    'VQ Ticked': r.is_purchased ? 'Y' : 'N',
    'VQ Created': r.vq_created ? r.vq_created.split('T')[0] : '',
    'Promise Date': r.promise_date ? r.promise_date.split('T')[0] : '',
    'Days Stuck': r.days_stuck,
    'POV Stamp': r.pov_stamp,
    'Created By': r.created_by,
    'Status': r.ot_po_number ? 'Has OT PO - needs Infor stamp' : 'VQ ticked - needs PO',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 10 },  // VQ ID
    { wch: 12 },  // RFQ #
    { wch: 25 },  // MPN
    { wch: 20 },  // Manufacturer
    { wch: 8 },   // Qty
    { wch: 10 },  // Cost
    { wch: 25 },  // Supplier
    { wch: 12 },  // OT PO #
    { wch: 12 },  // PO Created
    { wch: 10 },  // VQ Ticked
    { wch: 12 },  // VQ Created
    { wch: 12 },  // Promise Date
    { wch: 10 },  // Days Stuck
    { wch: 15 },  // POV Stamp
    { wch: 15 },  // Created By
    { wch: 30 },  // Status
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Pending Orders');
  XLSX.writeFile(wb, outputPath);
}

async function sendNotification(results, attachmentPath, date) {
  const subject = `LAM Pending Orders Check - ${results.length} stuck orders - ${date}`;

  // Group by age
  const recent = results.filter(r => r.days_stuck <= 7);
  const old = results.filter(r => r.days_stuck > 30);

  let body = `Hi,\n\n`;
  body += `The LAM pending orders check found ${results.length} order(s) that were processed in OT but not placed in Infor:\n\n`;

  if (old.length > 0) {
    body += `⚠️ ${old.length} orders are 30+ days old and need urgent attention:\n`;
    old.slice(0, 5).forEach(r => {
      body += `  • ${r.mpn} - ${r.supplier} - ${r.days_stuck} days (${r.ot_po_number || 'no PO yet'})\n`;
    });
    if (old.length > 5) body += `  ... and ${old.length - 5} more\n`;
    body += `\n`;
  }

  if (recent.length > 0) {
    body += `${recent.length} recent orders (≤7 days) - may still be in process:\n`;
    recent.slice(0, 3).forEach(r => {
      body += `  • ${r.mpn} - ${r.supplier} - ${r.days_stuck} days\n`;
    });
    if (recent.length > 3) body += `  ... and ${recent.length - 3} more\n`;
    body += `\n`;
  }

  body += `Full report attached.\n\n`;
  body += `To exclude a VQ from future checks (if intentionally not placed):\n`;
  body += `  node lam-pending-orders-check.js --mark-ok <vq_id> "reason"\n\n`;
  body += `Thanks,\nClaude`;

  // Use Python for email with attachment
  const pythonScript = `
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
import os

msg = MIMEMultipart()
msg['From'] = '${EMAIL_ACCOUNT}@orangetsunami.com'
msg['To'] = '${EMAIL_TO}'
msg['Subject'] = '''${subject}'''

body = '''${body.replace(/'/g, "\\'")}'''
msg.attach(MIMEText(body, 'plain'))

filename = '${path.basename(attachmentPath)}'
filepath = '${attachmentPath}'
with open(filepath, 'rb') as f:
    part = MIMEBase('application', 'octet-stream')
    part.set_payload(f.read())
encoders.encode_base64(part)
part.add_header('Content-Disposition', f'attachment; filename="{filename}"')
msg.attach(part)

server = smtplib.SMTP_SSL('smtp.mail.us-east-1.awsapps.com', 465)
server.login('${EMAIL_ACCOUNT}@orangetsunami.com', os.environ.get('SMTP_PASSWORD', 'A$tuteu$a'))
server.send_message(msg)
server.quit()
print('Email sent successfully')
`;

  execSync(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`, { stdio: 'inherit' });
}

// Run
if (require.main === module) {
  main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
