#!/usr/bin/env node
/**
 * LAM Wrong Warehouse Check
 *
 * Identifies LAM roster parts in non-LAM warehouses.
 * Runs weekly as part of the LAM Kitting workflow.
 *
 * Usage:
 *   node lam-wrong-warehouse-check.js <inventory-folder>
 *   node lam-wrong-warehouse-check.js <inventory-folder> --dry-run
 *
 * Output:
 *   - output/LAM_Wrong_Warehouse_YYYY-MM-DD.xlsx
 *   - Email notification if any "Move to W111" items found
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');

// === CONFIGURATION ===

const SCRIPT_DIR = __dirname;
const ROSTER_PATH = path.join(SCRIPT_DIR, 'LAM_Master_Roster.xlsx');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const KNOWN_NON_LAM_PATH = path.join(SCRIPT_DIR, 'lam-wrong-warehouse-exclusions.json');
const PENDING_TRANSFERS_PATH = path.join(SCRIPT_DIR, 'lam-wrong-warehouse-pending-transfers.json');

// LAM warehouses - exclude from check (stock here is correct)
const LAM_WAREHOUSES = ['W111', 'W115', 'W118'];

// All warehouses to exclude from results
const EXCLUDE_WAREHOUSES = ['W111', 'W115', 'W118', 'W112', 'W117', 'W106'];

// Email config
const EMAIL_ACCOUNT = 'lamkitting';
const EMAIL_TO = 'jake.harris@astutegroup.com';

// === EXCLUSION PERSISTENCE ===
// Items confirmed as "not LAM" are stored by MPN+Lot so they don't repeat

function loadExclusions() {
  if (!fs.existsSync(KNOWN_NON_LAM_PATH)) {
    return new Map();
  }
  try {
    const data = JSON.parse(fs.readFileSync(KNOWN_NON_LAM_PATH, 'utf8'));
    // Format: { "MPN|Lot": { mpn, lot, wh, reason, date } }
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('Warning: Could not load exclusions file:', err.message);
    return new Map();
  }
}

function saveExclusions(exclusions) {
  const obj = Object.fromEntries(exclusions);
  fs.writeFileSync(KNOWN_NON_LAM_PATH, JSON.stringify(obj, null, 2));
}

function makeExclusionKey(mpn, lot) {
  return `${mpn}|${lot}`;
}

function isExcluded(exclusions, mpn, lot) {
  return exclusions.has(makeExclusionKey(mpn, lot));
}

function addExclusion(exclusions, mpn, lot, wh, reason) {
  const key = makeExclusionKey(mpn, lot);
  exclusions.set(key, {
    mpn,
    lot,
    wh,
    reason: reason || 'Confirmed not LAM stock',
    date: new Date().toISOString().split('T')[0],
  });
}

// === PENDING TRANSFERS ===
// Items confirmed as LAM stock with transfer submitted - tracked until they move to W111

function loadPendingTransfers() {
  if (!fs.existsSync(PENDING_TRANSFERS_PATH)) {
    return new Map();
  }
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_TRANSFERS_PATH, 'utf8'));
    // Format: { "MPN": { mpn, cpc, qty, fromWh, date, notes } }
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('Warning: Could not load pending transfers file:', err.message);
    return new Map();
  }
}

function savePendingTransfers(transfers) {
  const obj = Object.fromEntries(transfers);
  fs.writeFileSync(PENDING_TRANSFERS_PATH, JSON.stringify(obj, null, 2));
}

function getPendingTransfer(transfers, mpn) {
  return transfers.get(mpn.toUpperCase().trim());
}

function addPendingTransfer(transfers, mpn, cpc, qty, fromWh, notes) {
  const key = mpn.toUpperCase().trim();
  transfers.set(key, {
    mpn: mpn.trim(),
    cpc: cpc || '',
    qty: qty || 0,
    fromWh: fromWh || '',
    notes: notes || 'Transfer submitted',
    date: new Date().toISOString().split('T')[0],
  });
}

function removePendingTransfer(transfers, mpn) {
  return transfers.delete(mpn.toUpperCase().trim());
}

// === MAIN ===

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const markNonLam = args.includes('--mark-non-lam');
  const inventoryFolder = args.find(a => !a.startsWith('--'));

  const listExclusions = args.includes('--list-exclusions');
  const clearExclusion = args.includes('--clear-exclusion');

  if (!inventoryFolder && !markNonLam && !listExclusions && !clearExclusion) {
    console.error('Usage:');
    console.error('  node lam-wrong-warehouse-check.js <inventory-folder> [--dry-run]');
    console.error('  node lam-wrong-warehouse-check.js --mark-non-lam <mpn> <lot> [reason]');
    console.error('  node lam-wrong-warehouse-check.js --clear-exclusion <mpn> <lot>');
    console.error('  node lam-wrong-warehouse-check.js --list-exclusions');
    console.error('');
    console.error('Options:');
    console.error('  --dry-run          Run without sending email');
    console.error('  --mark-non-lam     Mark an MPN+Lot as not LAM (excludes from future checks)');
    console.error('  --clear-exclusion  Remove an MPN+Lot from exclusions');
    console.error('  --list-exclusions  Show all current exclusions');
    process.exit(1);
  }

  // Handle listing exclusions
  if (args.includes('--list-exclusions')) {
    const exclusions = loadExclusions();
    console.log('=== KNOWN NON-LAM ITEMS ===');
    console.log(`Total: ${exclusions.size}`);
    console.log('');
    for (const [key, val] of exclusions) {
      console.log(`${val.mpn} | Lot: ${val.lot}`);
      console.log(`  Reason: ${val.reason}`);
      console.log(`  Added: ${val.date}`);
      console.log('');
    }
    return { listed: true, count: exclusions.size };
  }

  // Handle clearing an exclusion
  if (args.includes('--clear-exclusion')) {
    const mpn = args[args.indexOf('--clear-exclusion') + 1];
    const lot = args[args.indexOf('--clear-exclusion') + 2];

    if (!mpn || !lot) {
      console.error('Usage: node lam-wrong-warehouse-check.js --clear-exclusion <mpn> <lot>');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    const key = makeExclusionKey(mpn, lot);
    if (exclusions.has(key)) {
      exclusions.delete(key);
      saveExclusions(exclusions);
      console.log(`Removed exclusion: ${mpn} | Lot: ${lot}`);
      console.log(`Remaining exclusions: ${exclusions.size}`);
    } else {
      console.log(`No exclusion found for: ${mpn} | Lot: ${lot}`);
    }
    return { cleared: true, mpn, lot };
  }

  // Handle marking items as non-LAM
  if (markNonLam) {
    const mpn = args[args.indexOf('--mark-non-lam') + 1];
    const lot = args[args.indexOf('--mark-non-lam') + 2];
    const reason = args.slice(args.indexOf('--mark-non-lam') + 3).join(' ') || 'Confirmed not LAM stock';

    if (!mpn || !lot) {
      console.error('Usage: node lam-wrong-warehouse-check.js --mark-non-lam <mpn> <lot> [reason]');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    addExclusion(exclusions, mpn, lot, '', reason);
    saveExclusions(exclusions);
    console.log(`Marked as non-LAM: ${mpn} | Lot: ${lot}`);
    console.log(`Reason: ${reason}`);
    console.log(`Total exclusions: ${exclusions.size}`);
    return { marked: true, mpn, lot };
  }

  console.log('=== LAM Wrong Warehouse Check ===');
  console.log('Inventory folder:', inventoryFolder);
  console.log('Dry run:', dryRun);
  console.log('');

  // Step 1: Load Master Roster
  console.log('Step 1: Loading Master Roster...');
  const rosterMPNs = loadRoster();
  console.log(`  Loaded ${rosterMPNs.size} roster MPNs`);

  // Step 1b: Load exclusions (items already confirmed as not LAM)
  console.log('Step 1b: Loading exclusions...');
  const exclusions = loadExclusions();
  console.log(`  Loaded ${exclusions.size} known non-LAM items`);

  // Step 1c: Load pending transfers (items with transfer submitted)
  console.log('Step 1c: Loading pending transfers...');
  const pendingTransfers = loadPendingTransfers();
  console.log(`  Loaded ${pendingTransfers.size} pending transfers`);

  // Step 2: Find main inventory file
  console.log('Step 2: Finding inventory file...');
  const invFile = findInventoryFile(inventoryFolder);
  if (!invFile) {
    console.error('  ERROR: No inventory file found in', inventoryFolder);
    process.exit(1);
  }
  console.log(`  Found: ${path.basename(invFile)}`);

  // Step 2b: Check inventory file age - warn if stale (>14 days old)
  const fileStats = fs.statSync(invFile);
  const fileAgeDays = Math.floor((Date.now() - fileStats.mtime.getTime()) / (1000 * 60 * 60 * 24));
  if (fileAgeDays > 14) {
    console.log('');
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log(`  WARNING: Inventory file is ${fileAgeDays} days old!`);
    console.log('  This data may be stale. Check if inventory cleanup cron is running.');
    console.log('  File:', path.basename(invFile));
    console.log('  Modified:', fileStats.mtime.toISOString().split('T')[0]);
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('');
  }

  // Step 3: Load inventory and analyze
  console.log('Step 3: Loading inventory and analyzing...');
  const invData = loadInventory(invFile);
  console.log(`  Loaded ${invData.length} inventory rows`);

  // Step 4: Find roster MPNs in LAM warehouses (for cross-reference)
  const inLAMWarehouses = buildLAMWarehouseMap(invData);
  console.log(`  Found ${inLAMWarehouses.size} roster MPNs in LAM warehouses`);

  // Step 5: Find roster MPNs in wrong warehouses
  console.log('Step 4: Finding roster parts in wrong warehouses...');
  const { results, excludedCount } = findWrongWarehouseStock(invData, rosterMPNs, inLAMWarehouses, exclusions);
  console.log(`  Found ${results.length} inventory rows to review`);
  if (excludedCount > 0) {
    console.log(`  Skipped ${excludedCount} rows (previously marked as non-LAM)`);
  }

  // Step 5b: Cross-reference against OT VQ/PO activity
  // Only query OT for the specific MPNs found in wrong warehouses (not all MPNs)
  console.log('Step 5b: Cross-referencing against OT activity...');

  // Extract unique MPNs from results (excluding LAM bin items - those are definitely LAM)
  const mpnsToCheck = [...new Set(
    results
      .filter(r => !r.isLAMLoc)
      .map(r => r.mpn)
  )];
  console.log(`  Checking ${mpnsToCheck.length} unique MPNs against OT...`);

  // Query OT for both other customer activity AND LAM activity
  const otherCustomerActivity = checkOtherCustomerActivity(mpnsToCheck);
  const lamActivity = checkLAMActivity(mpnsToCheck);
  console.log(`  Other customer activity: ${otherCustomerActivity.size} MPNs`);
  console.log(`  LAM PO activity: ${lamActivity.size} MPNs`);

  let otherCustomerMatchCount = 0;
  let lamMatchCount = 0;
  let lamNoPovCount = 0;

  for (const r of results) {
    // Skip items in LAM bin locations - those are definitely LAM stock
    if (r.isLAMLoc) continue;

    // Check for other customer match first (takes precedence)
    const otherMatch = findOtherCustomerMatch(r.mpn, r.qty, otherCustomerActivity);
    if (otherMatch) {
      r.otherCustomerMatch = otherMatch;
      otherCustomerMatchCount++;
      continue;
    }

    // Check for LAM PO match
    const lamMatch = findLAMMatch(r.mpn, r.qty, lamActivity);
    if (lamMatch) {
      r.lamMatch = lamMatch;
      lamMatchCount++;
      if (!lamMatch.inforPov) {
        lamNoPovCount++;
      }
    }
  }
  console.log(`  Other customer matches: ${otherCustomerMatchCount}`);
  console.log(`  LAM PO matches: ${lamMatchCount} (${lamNoPovCount} need Infor POV)`);


  // Step 6: Classify, add pending transfer notes, and sort
  results.forEach(r => {
    r.status = classifyStatus(r);
    // Check for pending transfer notes
    const pendingTransfer = getPendingTransfer(pendingTransfers, r.mpn);
    if (pendingTransfer) {
      r.notes = pendingTransfer.notes || `Transfer submitted ${pendingTransfer.date}`;
      // Update status to reflect pending transfer
      if (!r.status.includes('Transfer')) {
        r.status = `Transfer pending - ${pendingTransfer.date}`;
      }
    } else {
      r.notes = '';
    }
  });
  sortResults(results);

  // Step 7: Generate summary
  const summary = generateSummary(results);
  console.log('');
  console.log('=== SUMMARY ===');
  Object.entries(summary).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });

  // Step 8: Write output
  const today = new Date().toISOString().split('T')[0];
  const outputPath = path.join(OUTPUT_DIR, `LAM_Wrong_Warehouse_${today}.xlsx`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('');
  console.log('Step 5: Writing output...');
  writeExcel(results, summary, outputPath);
  console.log(`  Wrote: ${outputPath}`);

  // Write JSON sidecar for runner integration (CPC -> wrong warehouse info)
  const sidecarPath = outputPath.replace('.xlsx', '.json');
  const sidecarData = {};
  for (const r of results) {
    if (!sidecarData[r.cpc]) {
      sidecarData[r.cpc] = [];
    }
    sidecarData[r.cpc].push({
      wh: r.wh,
      whName: r.whName,
      mpn: r.mpn,
      qty: r.qty,
      loc: r.loc,
      status: r.status,
      isLAMLoc: r.isLAMLoc,
      otherCustomer: r.otherCustomerMatch || null,
      lamPO: r.lamMatch ? r.lamMatch.otPo : null,
      inforPOV: r.lamMatch ? (r.lamMatch.inforPov || null) : null,
      tracking: r.lamMatch ? (r.lamMatch.tracking || null) : null,
      notes: r.notes || null
    });
  }
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecarData, null, 2));
  console.log(`  Wrote sidecar: ${sidecarPath}`);

  // Step 9: Email if misplaced stock found
  const misplacedCount = summary['Move to W111 - LAM bin location'] || 0;

  if (misplacedCount > 0 && !dryRun) {
    console.log('');
    console.log('Step 6: Sending email notification...');
    await sendNotification(results, summary, outputPath, today);
    console.log('  Email sent');
  } else if (misplacedCount > 0) {
    console.log('');
    console.log('Step 6: [DRY RUN] Would send email for', misplacedCount, 'misplaced items');
  } else {
    console.log('');
    console.log('Step 6: No misplaced LAM stock found - skipping email');
  }

  // Return results for runner integration
  return {
    totalRows: results.length,
    misplacedCount,
    outputPath,
    summary,
  };
}

// === HELPER FUNCTIONS ===

function loadRoster() {
  const wb = XLSX.readFile(ROSTER_PATH);
  const ws = wb.Sheets['Master Roster'];
  const data = XLSX.utils.sheet_to_json(ws);

  const rosterMPNs = new Map(); // MPN (uppercase, trimmed) → CPC
  for (const row of data) {
    if (row.MPN && row.CPC) {
      const mpn = String(row.MPN).toUpperCase().trim();
      rosterMPNs.set(mpn, String(row.CPC).trim());
    }
  }
  return rosterMPNs;
}

function findInventoryFile(folderOrFile) {
  // If a direct file path was provided, use it
  if (fs.existsSync(folderOrFile) && fs.statSync(folderOrFile).isFile()) {
    return folderOrFile;
  }

  // Look in the specified folder
  if (fs.existsSync(folderOrFile) && fs.statSync(folderOrFile).isDirectory()) {
    const files = fs.readdirSync(folderOrFile);

    // Priority: ASTItemLotsReportInputs files
    const mainFile = files.find(f =>
      f.includes('ASTItemLotsReportInputs') &&
      (f.endsWith('.xlsx') || f.endsWith('.xls'))
    );
    if (mainFile) return path.join(folderOrFile, mainFile);

    // Fallback: any xlsx file in folder
    const anyExcel = files.find(f => f.endsWith('.xlsx') || f.endsWith('.xls'));
    if (anyExcel) return path.join(folderOrFile, anyExcel);
  }

  // Check /tmp for the raw Infor file (common location for email downloads)
  const tmpFiles = fs.readdirSync('/tmp');
  const inforFile = tmpFiles.find(f =>
    f.includes('ASTItemLotsReportInputs') &&
    (f.endsWith('.xlsx') || f.endsWith('.xls'))
  );
  if (inforFile) return path.join('/tmp', inforFile);

  return null;
}

function loadInventory(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames[0]];

  // Find the header row (row containing "Item" in column A)
  // Typically row 8 (1-indexed) = row 7 (0-indexed) for Infor files
  const allData = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let headerRowIndex = 7; // default

  for (let i = 0; i < Math.min(15, allData.length); i++) {
    if (allData[i] && allData[i][0] === 'Item') {
      headerRowIndex = i;
      break;
    }
  }

  // Read with the correct header row
  const data = XLSX.utils.sheet_to_json(ws, { range: headerRowIndex });
  return data;
}

function buildLAMWarehouseMap(invData) {
  const inLAMWarehouses = new Map(); // MPN → [{wh, qty}]

  for (const row of invData) {
    const mpn = String(row['Item'] || '').trim();
    const wh = String(row['Warehouse'] || '').trim();
    const qty = parseFloat(row['Lot Quantity'] || 0);

    if (mpn && qty > 0 && LAM_WAREHOUSES.includes(wh)) {
      if (!inLAMWarehouses.has(mpn)) inLAMWarehouses.set(mpn, []);
      inLAMWarehouses.get(mpn).push({ wh, qty: Math.round(qty) });
    }
  }
  return inLAMWarehouses;
}

function findWrongWarehouseStock(invData, rosterMPNs, inLAMWarehouses, exclusions) {
  const results = [];
  let excludedCount = 0;

  for (const row of invData) {
    const mpn = String(row['Item'] || '').trim();
    const mpnUpper = mpn.toUpperCase();
    const wh = String(row['Warehouse'] || '').trim();
    const qty = parseFloat(row['Lot Quantity'] || 0);
    const lot = String(row['Lot'] || '').trim();

    // Skip if not a roster MPN, no qty, or in excluded warehouse
    if (!mpn || qty <= 0 || !rosterMPNs.has(mpnUpper) || EXCLUDE_WAREHOUSES.includes(wh)) {
      continue;
    }

    // Skip if this MPN+Lot was previously marked as non-LAM
    if (isExcluded(exclusions, mpn, lot)) {
      excludedCount++;
      continue;
    }

    const cpc = rosterMPNs.get(mpnUpper);
    const loc = String(row['Location'] || '').trim();
    const isLAMLoc = loc.toUpperCase().includes('LAM');
    const lamStock = inLAMWarehouses.get(mpn) || [];

    results.push({
      wh,
      whName: String(row['Warehouse Name'] || '').trim(),
      cpc,
      mpn,
      qty: Math.round(qty),
      loc,
      lot,
      isLAMLoc,
      alsoInW111: lamStock.some(s => s.wh === 'W111'),
      alsoInW115: lamStock.some(s => s.wh === 'W115'),
      alsoInW118: lamStock.some(s => s.wh === 'W118'),
    });
  }

  return { results, excludedCount };
}

function classifyStatus(r) {
  // If we found a matching VQ/PO for another customer, use that
  if (r.otherCustomerMatch) {
    return `Other customer - ${r.otherCustomerMatch}`;
  }
  // If we found a matching LAM PO, check if it has Infor POV
  if (r.lamMatch) {
    if (r.lamMatch.inforPov) {
      return `Move to W111 - ${r.lamMatch.otPo} (${r.lamMatch.inforPov})`;
    } else {
      return `Pending POV - ${r.lamMatch.otPo}`;
    }
  }
  if (r.isLAMLoc) {
    return 'Move to W111 - LAM bin location';
  } else if (r.alsoInW111 || r.alsoInW118) {
    return 'Verify ownership - also in W111/W118';
  } else if (r.alsoInW115) {
    return 'Review - also in W115';
  } else {
    return 'Verify ownership';
  }
}

/**
 * Query OT for LAM VQ/PO activity for specific MPNs.
 * Returns a Map of MPN -> array of { qty, otPo, inforPov, cpc, tracking }
 */
function checkLAMActivity(mpnsToCheck) {
  if (!mpnsToCheck || mpnsToCheck.length === 0) return new Map();

  const LAM_BP_ID = 1000730;
  const mpnList = mpnsToCheck.map(m => `'${m.toUpperCase().trim().replace(/'/g, "''")}'`).join(',');

  const sql = `
    SELECT
      UPPER(TRIM(COALESCE(ol.chuboe_mpn, rlm.chuboe_mpn))) AS mpn,
      COALESCE(ol.qtyordered, vl.qty) AS qty,
      o.documentno AS ot_po,
      vl.chuboe_po_string AS infor_pov,
      rl.chuboe_cpc AS cpc,
      COALESCE(ol.chuboe_trackingnumbers, '') AS tracking
    FROM chuboe_vq_line vl
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vl.chuboe_rfq_line_id
    JOIN chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN c_orderline ol ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
    LEFT JOIN c_order o ON o.c_order_id = ol.c_order_id AND o.issotrx = 'N'
    WHERE rfq.c_bpartner_id = ${LAM_BP_ID}
      AND vl.isactive = 'Y'
      AND vl.ispurchased = 'Y'
      AND o.documentno IS NOT NULL
      AND vl.created >= CURRENT_DATE - INTERVAL '180 days'
      AND UPPER(TRIM(COALESCE(ol.chuboe_mpn, rlm.chuboe_mpn))) IN (${mpnList})
    ORDER BY mpn, qty
  `;

  const tmpFile = `/tmp/lam_activity_check_${Date.now()}.sql`;
  const outFile = `/tmp/lam_activity_check_${Date.now()}.out`;

  fs.writeFileSync(tmpFile, sql);

  try {
    execSync(
      `psql -U analytics_user -d idempiere_replica -t -A -F '|' -f "${tmpFile}" -o "${outFile}"`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const content = fs.readFileSync(outFile, 'utf8').trim();
    if (!content) return new Map();

    const activityMap = new Map();

    for (const line of content.split('\n').filter(l => l.trim())) {
      const [mpn, qty, otPo, inforPov, cpc, tracking] = line.split('|');
      if (!mpn) continue;

      const key = mpn.trim().toUpperCase();
      if (!activityMap.has(key)) {
        activityMap.set(key, []);
      }
      activityMap.get(key).push({
        qty: parseInt(qty) || 0,
        otPo: (otPo || '').trim(),
        inforPov: (inforPov || '').trim(),
        cpc: (cpc || '').trim(),
        tracking: (tracking || '').trim(),
      });
    }

    return activityMap;
  } catch (err) {
    console.warn('  Warning: Could not check LAM activity:', err.message);
    return new Map();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
  }
}

/**
 * Query OT for VQ/PO activity for specific MPNs for other customers (not LAM).
 * Only queries the MPNs we found in wrong warehouses - much more efficient.
 * Returns a Map of MPN -> { customer, qty, rfq, poNumber }
 */
function checkOtherCustomerActivity(mpnsToCheck) {
  if (!mpnsToCheck || mpnsToCheck.length === 0) return new Map();

  const LAM_BP_ID = 1000730;

  // Build MPN list for SQL IN clause
  const mpnList = mpnsToCheck.map(m => `'${m.toUpperCase().trim().replace(/'/g, "''")}'`).join(',');

  const sql = `
    SELECT DISTINCT
      UPPER(TRIM(COALESCE(ol.chuboe_mpn, rlm.chuboe_mpn))) AS mpn,
      bp.name AS customer,
      COALESCE(ol.qtyordered, vl.qty) AS qty,
      rfq.value AS rfq_number,
      o.documentno AS po_number
    FROM chuboe_vq_line vl
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vl.chuboe_rfq_line_id
    JOIN chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    JOIN c_bpartner bp ON bp.c_bpartner_id = rfq.c_bpartner_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN c_orderline ol ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
    LEFT JOIN c_order o ON o.c_order_id = ol.c_order_id
    WHERE rfq.c_bpartner_id != ${LAM_BP_ID}
      AND rfq.isactive = 'Y'
      AND vl.isactive = 'Y'
      AND vl.created >= CURRENT_DATE - INTERVAL '120 days'
      AND UPPER(TRIM(COALESCE(ol.chuboe_mpn, rlm.chuboe_mpn))) IN (${mpnList})
    ORDER BY mpn, qty
  `;

  const tmpFile = `/tmp/other_customer_check_${Date.now()}.sql`;
  const outFile = `/tmp/other_customer_check_${Date.now()}.out`;

  fs.writeFileSync(tmpFile, sql);

  try {
    execSync(
      `psql -U analytics_user -d idempiere_replica -t -A -F '|' -f "${tmpFile}" -o "${outFile}"`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const content = fs.readFileSync(outFile, 'utf8').trim();
    if (!content) return new Map();

    // Build map: MPN -> array of {customer, qty, rfq, po}
    const activityMap = new Map();

    for (const line of content.split('\n').filter(l => l.trim())) {
      const [mpn, customer, qty, rfq, po] = line.split('|');
      if (!mpn) continue;

      const key = mpn.trim().toUpperCase();
      if (!activityMap.has(key)) {
        activityMap.set(key, []);
      }
      activityMap.get(key).push({
        customer: (customer || '').trim(),
        qty: parseInt(qty) || 0,
        rfq: (rfq || '').trim(),
        po: (po || '').trim(),
      });
    }

    return activityMap;
  } catch (err) {
    console.warn('  Warning: Could not check other customer activity:', err.message);
    return new Map();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
  }
}

/**
 * Check if the qty matches any other customer's VQ/PO for this MPN.
 * Returns the customer name if a match is found, null otherwise.
 */
function findOtherCustomerMatch(mpn, qty, otherCustomerActivity) {
  const mpnUpper = mpn.toUpperCase().trim();
  const activity = otherCustomerActivity.get(mpnUpper);

  if (!activity || activity.length === 0) return null;

  // Look for exact qty match first
  for (const a of activity) {
    if (a.qty === qty) {
      return a.customer;
    }
  }

  // Look for close match (within 10%)
  for (const a of activity) {
    const diff = Math.abs(a.qty - qty);
    if (diff <= qty * 0.1) {
      return a.customer;
    }
  }

  return null;
}

/**
 * Check if the qty matches any LAM VQ/PO for this MPN.
 * Returns { otPo, inforPov, cpc, tracking } if a match is found, null otherwise.
 */
function findLAMMatch(mpn, qty, lamActivity) {
  const mpnUpper = mpn.toUpperCase().trim();
  const activity = lamActivity.get(mpnUpper);

  if (!activity || activity.length === 0) return null;

  // Look for exact qty match first
  for (const a of activity) {
    if (a.qty === qty) {
      return { otPo: a.otPo, inforPov: a.inforPov, cpc: a.cpc, tracking: a.tracking };
    }
  }

  // Look for close match (within 10%)
  for (const a of activity) {
    const diff = Math.abs(a.qty - qty);
    if (diff <= qty * 0.1) {
      return { otPo: a.otPo, inforPov: a.inforPov, cpc: a.cpc, tracking: a.tracking };
    }
  }

  return null;
}

function sortResults(results) {
  results.sort((a, b) => {
    // LAM bin locations first (highest priority)
    if (a.isLAMLoc && !b.isLAMLoc) return -1;
    if (!a.isLAMLoc && b.isLAMLoc) return 1;
    // Parts also in W115 next
    if (a.alsoInW115 && !b.alsoInW115) return -1;
    if (!a.alsoInW115 && b.alsoInW115) return 1;
    // Alphabetical by warehouse
    return a.wh.localeCompare(b.wh);
  });
}

function generateSummary(results) {
  const summary = {};
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  return summary;
}

function writeExcel(results, summary, outputPath) {
  const wb = XLSX.utils.book_new();

  // Main results sheet
  const rows = results.map(r => ({
    'Warehouse': r.wh,
    'Warehouse Name': r.whName,
    'LAM CPC': r.cpc,
    'MPN': r.mpn,
    'Qty': r.qty,
    'Location': r.loc,
    'Lot': r.lot,
    'LAM Bin?': r.isLAMLoc ? 'YES' : '',
    'Also in LAM WH': [
      r.alsoInW111 ? 'W111' : '',
      r.alsoInW115 ? 'W115' : '',
      r.alsoInW118 ? 'W118' : '',
    ].filter(Boolean).join(', '),
    'OT Match': r.otherCustomerMatch || (r.lamMatch ? `LAM ${r.lamMatch.otPo}` : ''),
    'Infor POV': r.lamMatch ? (r.lamMatch.inforPov || 'MISSING') : '',
    'Tracking': r.lamMatch ? (r.lamMatch.tracking || '') : '',
    'Status': r.status,
    'Notes': r.notes || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths
  ws['!cols'] = [
    { wch: 10 },  // Warehouse
    { wch: 25 },  // Warehouse Name
    { wch: 18 },  // LAM CPC
    { wch: 25 },  // MPN
    { wch: 8 },   // Qty
    { wch: 15 },  // Location
    { wch: 12 },  // Lot
    { wch: 10 },  // LAM Bin?
    { wch: 15 },  // Also in LAM WH
    { wch: 20 },  // OT Match
    { wch: 15 },  // Infor POV
    { wch: 25 },  // Tracking
    { wch: 35 },  // Status
    { wch: 40 },  // Notes
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Wrong Warehouse');

  // Summary sheet
  const summaryRows = Object.entries(summary).map(([status, count]) => ({
    'Status': status,
    'Count': count,
  }));
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 50 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  XLSX.writeFile(wb, outputPath);
}

async function sendNotification(results, summary, attachmentPath, date) {
  // Filter to just misplaced items for the email
  const misplaced = results.filter(r => r.status === 'Move to W111 - LAM bin location');

  const subject = `LAM Roster Warehouse Review - ${date}`;

  let body = `Hi,\n\n`;
  body += `The weekly LAM wrong warehouse check found ${misplaced.length} item(s) that appear to be misplaced LAM stock:\n\n`;

  // Show first 10 misplaced items
  const showItems = misplaced.slice(0, 10);
  for (const r of showItems) {
    body += `• ${r.mpn} (CPC: ${r.cpc}) - ${r.qty} pcs in ${r.wh} at ${r.loc}\n`;
  }
  if (misplaced.length > 10) {
    body += `• ... and ${misplaced.length - 10} more (see attachment)\n`;
  }

  body += `\nThese items are in LAM-labeled bin locations but not in LAM warehouses (W111/W115/W118).\n`;
  body += `Action: Move to W111.\n\n`;

  body += `Full report attached.\n\n`;
  body += `Thanks,\nClaude`;

  // Use the Python email sender (himalaya has issues with attachments)
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

# Attach file
filename = '${path.basename(attachmentPath)}'
filepath = '${attachmentPath}'
with open(filepath, 'rb') as f:
    part = MIMEBase('application', 'octet-stream')
    part.set_payload(f.read())
encoders.encode_base64(part)
part.add_header('Content-Disposition', f'attachment; filename="{filename}"')
msg.attach(part)

# Send
server = smtplib.SMTP_SSL('smtp.mail.us-east-1.awsapps.com', 465)
server.login('${EMAIL_ACCOUNT}@orangetsunami.com', os.environ.get('SMTP_PASSWORD', 'A$tuteu$a'))
server.send_message(msg)
server.quit()
print('Email sent successfully')
`;

  execSync(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`, { stdio: 'inherit' });
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
