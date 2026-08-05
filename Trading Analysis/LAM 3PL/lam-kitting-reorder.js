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
 *
 *   # Or use Infor xlsx directly (no inventory cleanup needed):
 *   node lam-kitting-reorder.js --xlsx="/path/to/ASTItemLotsReport.xlsx" "./LAM_Master_Roster.xlsx"
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');

// Use shared utilities
const { readCSVFile } = require('../../shared/csv-utils');
const { createNotifier } = require('../../shared/notifier');
const { normalizeMPN } = require('../../shared/mpn-normalization');
const { parseInventoryFile, getWarehouseRows } = require('../../shared/inventory-parser');
const { loadCachedInventory } = require('../../shared/inventory-fetch-and-parse');

// LAM Kitting handler - for Additional Review visibility
let _lamKittingHandler = null;
function getFlaggedCPCsFromHandler() {
  if (!_lamKittingHandler) {
    try {
      _lamKittingHandler = require('../../shared/workflow-actions/lam-kitting');
    } catch (e) {
      console.log('  WARNING: Could not load lam-kitting handler for flagged CPC visibility');
      return [];
    }
  }
  return _lamKittingHandler.getFlaggedCPCs ? _lamKittingHandler.getFlaggedCPCs() : [];
}

// Email configuration - LAM Kitting dedicated account
// NOTE: Manual runs (direct script invocation) go to Jake only.
//       Cron runs go through lam-kitting-runner.js which has its own email logic.
const EMAIL_ACCOUNT = 'lamkitting';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';  // Manual runs → Jake only
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

/**
 * Validate that Purchased MPN is on the AVL for this CPC
 * @param {string} cpc - The CPC
 * @param {string} rosterMpn - The MPN from the Master Roster
 * @param {string} purchasedMpn - The MPN actually purchased (from POV)
 * @returns {object} { valid: boolean, flag: string }
 *   - valid: true if purchasedMpn is on AVL or matches rosterMpn
 *   - flag: '' if OK, 'AVL' if on AVL but different, 'NOT ON AVL' if not approved
 */
function validatePurchasedMPN(cpc, rosterMpn, purchasedMpn) {
  // No purchased MPN or same as roster (exact match) = OK
  if (!purchasedMpn || purchasedMpn === rosterMpn) {
    return { valid: true, flag: '' };
  }

  // Check if this CPC+Purchased MPN pair has been cleared
  if (isNotOnAvlCleared(cpc, purchasedMpn)) {
    return { valid: true, flag: '' };
  }

  // Different MPN - check if it's on AVL using EXACT string comparison first
  // Then fall back to normalized comparison for functional equivalence
  const approvedMpns = getAllApprovedMPNs(cpc, rosterMpn);

  // Check for exact match on AVL
  const exactMatchOnAvl = approvedMpns.some(mpn => mpn === purchasedMpn);
  if (exactMatchOnAvl) {
    return { valid: true, flag: 'AVL' };
  }

  // Check for normalized match on AVL (functionally equivalent)
  const normalizedPurchased = normalizeMPN(purchasedMpn);
  const normalizedMatchOnAvl = approvedMpns.some(mpn =>
    mpn && normalizeMPN(mpn) === normalizedPurchased
  );

  if (normalizedMatchOnAvl) {
    // Functionally same but different formatting - still flag for reconciliation
    // User wants to be safe and reconcile any differences
    return { valid: false, flag: 'NOT ON AVL' };
  }

  // Not on AVL at all - escalate
  return { valid: false, flag: 'NOT ON AVL' };
}

// -----------------------------------------------------------------------------
// NOT ON AVL Clearing Mechanism
// -----------------------------------------------------------------------------
// Tracks CPC+Purchased MPN pairs that have been reviewed and cleared.
// Once cleared, they won't appear on the "NOT ON AVL" tab again.
// Sidecar file: lam-not-on-avl-cleared.json
// Format: { "CPC|PurchasedMPN": { clearedDate, clearedBy, notes }, ... }

const NOT_ON_AVL_CLEARED_FILE = path.join(__dirname, 'lam-not-on-avl-cleared.json');

let _notOnAvlClearedCache = null;

/**
 * Load the NOT ON AVL cleared tracking file
 */
function loadNotOnAvlCleared() {
  if (_notOnAvlClearedCache) return _notOnAvlClearedCache;

  if (fs.existsSync(NOT_ON_AVL_CLEARED_FILE)) {
    try {
      _notOnAvlClearedCache = JSON.parse(fs.readFileSync(NOT_ON_AVL_CLEARED_FILE, 'utf8'));
    } catch (e) {
      console.log('  WARNING: Could not parse lam-not-on-avl-cleared.json, starting fresh');
      _notOnAvlClearedCache = {};
    }
  } else {
    _notOnAvlClearedCache = {};
  }

  return _notOnAvlClearedCache;
}

/**
 * Check if a CPC+Purchased MPN pair has been cleared
 */
function isNotOnAvlCleared(cpc, purchasedMpn) {
  const cleared = loadNotOnAvlCleared();
  const key = `${cpc}|${purchasedMpn}`;
  return !!cleared[key];
}

/**
 * Clear a NOT ON AVL item (mark as reviewed/reconciled)
 * Call this from terminal or email workflow when item is cleared.
 *
 * @param {string} cpc - The CPC
 * @param {string} purchasedMpn - The Purchased MPN that was flagged
 * @param {object} opts - { clearedBy, notes }
 */
function clearNotOnAvlItem(cpc, purchasedMpn, opts = {}) {
  const cleared = loadNotOnAvlCleared();
  const key = `${cpc}|${purchasedMpn}`;

  cleared[key] = {
    cpc,
    purchasedMpn,
    clearedDate: new Date().toISOString().split('T')[0],
    clearedBy: opts.clearedBy || 'operator',
    notes: opts.notes || '',
  };

  fs.writeFileSync(NOT_ON_AVL_CLEARED_FILE, JSON.stringify(cleared, null, 2) + '\n');
  _notOnAvlClearedCache = cleared;

  console.log(`Cleared NOT ON AVL: ${cpc} | ${purchasedMpn}`);
  return true;
}

/**
 * List all cleared NOT ON AVL items
 */
function listClearedNotOnAvl() {
  const cleared = loadNotOnAvlCleared();
  return Object.values(cleared);
}

// -----------------------------------------------------------------------------
// Last Inventory Date Tracking
// -----------------------------------------------------------------------------
// Tracks when each CPC last had inventory. Used to filter out stale POVs:
// If a CPC had inventory after a POV was created, that POV is considered
// fulfilled and should not resurface as "PENDING RECEIPT" when inventory
// is later consumed.
//
// Sidecar file: lam-last-inventory-date.json
// Format: { "CPC": "YYYY-MM-DD", ... }

const LAST_INVENTORY_DATE_FILE = path.join(__dirname, 'lam-last-inventory-date.json');

let _lastInventoryDateCache = null;

/**
 * Load the last inventory date tracking file
 * @returns {Object} Map of CPC -> date string (YYYY-MM-DD)
 */
function loadLastInventoryDates() {
  if (_lastInventoryDateCache) return _lastInventoryDateCache;

  if (fs.existsSync(LAST_INVENTORY_DATE_FILE)) {
    try {
      _lastInventoryDateCache = JSON.parse(fs.readFileSync(LAST_INVENTORY_DATE_FILE, 'utf8'));
    } catch (e) {
      console.log('  WARNING: Could not parse lam-last-inventory-date.json, starting fresh');
      _lastInventoryDateCache = {};
    }
  } else {
    _lastInventoryDateCache = {};
  }

  return _lastInventoryDateCache;
}

/**
 * Save the last inventory date tracking file
 */
function saveLastInventoryDates() {
  if (!_lastInventoryDateCache) return;

  fs.writeFileSync(
    LAST_INVENTORY_DATE_FILE,
    JSON.stringify(_lastInventoryDateCache, null, 2)
  );
}

/**
 * Update last inventory dates based on current inventory levels
 * Call this after loading inventory data for the week.
 *
 * @param {Object} inventoryByCpc - Map of CPC -> qty (from W111 + W115)
 * @returns {number} Number of CPCs updated
 */
function updateLastInventoryDates(inventoryByCpc) {
  const dates = loadLastInventoryDates();
  const today = new Date().toISOString().split('T')[0];
  let updatedCount = 0;

  for (const [cpc, qty] of Object.entries(inventoryByCpc)) {
    if (qty > 0) {
      // CPC has inventory today - record the date
      if (dates[cpc] !== today) {
        dates[cpc] = today;
        updatedCount++;
      }
    }
  }

  if (updatedCount > 0) {
    saveLastInventoryDates();
    console.log(`  Last inventory dates updated: ${updatedCount} CPCs`);
  }

  return updatedCount;
}

/**
 * Check if a POV should be filtered out based on last inventory date
 * Returns true if the POV is stale (created before the CPC last had inventory)
 *
 * @param {string} cpc - The CPC
 * @param {string} povCreatedDate - POV creation date (YYYY-MM-DD)
 * @returns {boolean} True if POV should be filtered out
 */
function isPovStale(cpc, povCreatedDate) {
  const dates = loadLastInventoryDates();
  const lastInvDate = dates[cpc];

  if (!lastInvDate) {
    // No record of inventory for this CPC - keep the POV
    return false;
  }

  // If POV was created before the last inventory date, it's stale
  // (parts were received after the order was placed)
  return povCreatedDate < lastInvDate;
}

/**
 * Validate data integrity before output generation
 * Catches row-offset corruption, MPN/CPC mismatches, and manufacturer inconsistencies
 *
 * @param {Array} alerts - Reorder alerts to validate
 * @param {Object} excelData - Master Roster data indexed by MPN
 * @returns {Array} - Array of { type, cpc, mpn, message } for each issue found
 */
function validateDataIntegrity(alerts, excelData) {
  const issues = [];
  const seenCPCs = new Map();  // CPC -> first MPN seen (detect duplicates with different MPNs)

  for (const alert of alerts) {
    const cpc = alert['CPC'] || '';
    const mpn = alert['MPN'] || '';
    const mfr = alert['Manufacturer'] || '';

    // Skip if no CPC (shouldn't happen but defensive)
    if (!cpc) continue;

    // Check 1: CPC uniqueness - same CPC should always have same MPN
    if (seenCPCs.has(cpc)) {
      const firstMpn = seenCPCs.get(cpc);
      if (firstMpn !== mpn) {
        issues.push({
          type: 'DUPLICATE_CPC_DIFF_MPN',
          cpc,
          mpn,
          message: `CPC appears twice with different MPNs: "${firstMpn}" vs "${mpn}"`
        });
      }
    } else {
      seenCPCs.set(cpc, mpn);
    }

    // Check 2: MPN/CPC consistency against Master Roster
    // Look up by CPC in excelData values to find the roster entry
    let rosterEntry = null;
    for (const [key, val] of Object.entries(excelData)) {
      if (val.CPC === cpc) {
        rosterEntry = val;
        break;
      }
    }

    if (rosterEntry) {
      // Find the roster MPN by looking up what key maps to this CPC's entry
      // The key in excelData is the MPN (or CPC for placeholders)
      let rosterMpn = null;
      for (const [key, val] of Object.entries(excelData)) {
        if (val === rosterEntry) {
          // If the key looks like a CPC (starts with digits followed by dash), it's a placeholder
          // Otherwise the key IS the MPN
          if (!/^\d+-\d+-\d+/.test(key)) {
            rosterMpn = key;
          }
          break;
        }
      }

      // If we found a roster MPN and it doesn't match the alert MPN, flag it
      if (rosterMpn && normalizeMPN(rosterMpn) !== normalizeMPN(mpn)) {
        // Check if it's an approved alternate via AVL
        const approvedMpns = getAllApprovedMPNs(cpc, rosterMpn);
        const isApprovedAlt = approvedMpns.some(m => normalizeMPN(m) === normalizeMPN(mpn));

        if (!isApprovedAlt) {
          issues.push({
            type: 'MPN_MISMATCH',
            cpc,
            mpn,
            message: `Alert MPN "${mpn}" does not match roster MPN "${rosterMpn}" and is not on AVL`
          });
        }
      }

      // Check 3: Manufacturer plausibility
      // Flag if manufacturer in alert doesn't match roster (could indicate row offset)
      const rosterMfr = rosterEntry.Manufacturer || '';
      if (mfr && rosterMfr && mfr.toUpperCase() !== rosterMfr.toUpperCase()) {
        // Allow minor variations (e.g., "TEXAS INSTRUMENTS" vs "TEXAS INSTRUMENTS (P)")
        const normAlert = mfr.toUpperCase().replace(/\s*\([^)]*\)\s*/g, '').trim();
        const normRoster = rosterMfr.toUpperCase().replace(/\s*\([^)]*\)\s*/g, '').trim();
        if (normAlert !== normRoster) {
          issues.push({
            type: 'MFR_MISMATCH',
            cpc,
            mpn,
            message: `Manufacturer "${mfr}" does not match roster "${rosterMfr}"`
          });
        }
      }
    }
  }

  return issues;
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

// Pending transfers file - parts confirmed as LAM stock being transferred to W111
// Human reviews wrong warehouse check output, confirms LAM stock, adds here
// Auto-cleared when part appears in W111/W115 inventory
const PENDING_TRANSFERS_FILE = path.join(__dirname, 'lam-wrong-warehouse-pending-transfers.json');

/**
 * Load pending transfers (confirmed LAM stock being moved to W111)
 * Returns Map of MPN -> { qty, fromWh, notes, cpc }
 */
function loadPendingTransfers() {
  if (!fs.existsSync(PENDING_TRANSFERS_FILE)) {
    return new Map();
  }

  try {
    const data = JSON.parse(fs.readFileSync(PENDING_TRANSFERS_FILE, 'utf-8'));
    const transfers = new Map();

    for (const [mpn, info] of Object.entries(data)) {
      transfers.set(mpn, {
        qty: info.qty || 0,
        fromWh: info.fromWh || '',
        notes: info.notes || '',
        cpc: info.cpc || ''
      });
    }

    return transfers;
  } catch (e) {
    console.log(`  WARNING: Could not parse ${PENDING_TRANSFERS_FILE}: ${e.message}`);
    return new Map();
  }
}

/**
 * Save pending transfers back to file (used for auto-clearing completed transfers)
 */
function savePendingTransfers(transfers) {
  const obj = {};
  for (const [mpn, info] of transfers) {
    obj[mpn] = {
      mpn,
      cpc: info.cpc || '',
      qty: info.qty || 0,
      fromWh: info.fromWh || '',
      date: info.date || new Date().toISOString().split('T')[0],
      notes: info.notes || ''
    };
  }
  fs.writeFileSync(PENDING_TRANSFERS_FILE, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Auto-clear pending transfers that have completed (part now in W111/W115)
 * Matches by qty to ensure we're clearing the right transfer, not unrelated stock.
 * Returns the cleared MPNs for logging
 */
function autoClearCompletedTransfers(pendingTransfers, aggregated) {
  const cleared = [];

  for (const [mpn, transfer] of pendingTransfers) {
    const inv = aggregated[mpn];
    if (!inv) continue;

    const lamQty = (inv.W111_Qty || 0) + (inv.W115_Qty || 0);
    const transferQty = transfer.qty || 0;

    // Clear if:
    // 1. Part now has stock in W111/W115, AND
    // 2. The qty matches (or exceeds) the pending transfer qty
    //    This catches the case where transfer completed and matches expected qty
    if (lamQty > 0 && lamQty >= transferQty) {
      cleared.push({
        mpn,
        cpc: transfer.cpc,
        expectedQty: transferQty,
        actualQty: lamQty,
        match: lamQty === transferQty ? 'exact' : 'exceeds'
      });
      pendingTransfers.delete(mpn);
    }
  }

  // Save updated file if any were cleared
  if (cleared.length > 0) {
    savePendingTransfers(pendingTransfers);
  }

  return cleared;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  // Parse arguments
  const skipEmail = process.argv.includes('--no-email');
  let xlsxPath = null;
  const positionalArgs = [];

  for (const arg of process.argv.slice(2)) {
    if (arg === '--no-email') continue;
    if (arg.startsWith('--xlsx=')) {
      xlsxPath = arg.split('=')[1];
    } else {
      positionalArgs.push(arg);
    }
  }

  // Determine inventory source and roster file
  // Priority: --xlsx > folder arg > cache (default)
  let inventoryFolder = null;
  let excelFile = null;
  let inventorySource = 'cache'; // 'cache', 'xlsx', or 'csv'

  if (xlsxPath) {
    // --xlsx mode: xlsx path + roster file
    inventorySource = 'xlsx';
    if (positionalArgs.length < 1) {
      console.error('Usage: node lam-kitting-reorder.js --xlsx="<infor.xlsx>" <master-roster-file> [output-file] [--no-email]');
      process.exit(1);
    }
    excelFile = positionalArgs[0];
  } else if (positionalArgs.length >= 2 && fs.existsSync(positionalArgs[0]) && fs.statSync(positionalArgs[0]).isDirectory()) {
    // Legacy CSV mode: inventory folder + roster file
    inventorySource = 'csv';
    inventoryFolder = positionalArgs[0];
    excelFile = positionalArgs[1];
  } else if (positionalArgs.length >= 1) {
    // Cache mode (default): just roster file
    inventorySource = 'cache';
    excelFile = positionalArgs[0];
  } else {
    console.error('Usage:');
    console.error('  node lam-kitting-reorder.js <master-roster-file> [output-file] [--no-email]     # Uses cache (default)');
    console.error('  node lam-kitting-reorder.js --xlsx="<infor.xlsx>" <master-roster-file>          # Uses xlsx');
    console.error('  node lam-kitting-reorder.js <inventory-folder> <master-roster-file>             # Legacy CSV mode');
    process.exit(1);
  }

  const scriptDir = path.dirname(__filename);
  const outputDir = path.join(scriptDir, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Determine output file position based on mode
  let outputFile;
  if (inventorySource === 'xlsx') {
    outputFile = positionalArgs[1] || path.join(outputDir, `LAM_Reorder_Alerts_${getDateStamp()}.csv`);
  } else if (inventorySource === 'csv') {
    outputFile = positionalArgs[2] || path.join(outputDir, `LAM_Reorder_Alerts_${getDateStamp()}.csv`);
  } else {
    outputFile = positionalArgs[1] || path.join(outputDir, `LAM_Reorder_Alerts_${getDateStamp()}.csv`);
  }

  console.log('LAM 3PL Reorder');
  console.log('===============');
  if (inventorySource === 'xlsx') {
    console.log(`Inventory source: xlsx (${path.basename(xlsxPath)})`);
  } else if (inventorySource === 'csv') {
    console.log(`Inventory source: csv (${inventoryFolder})`);
  } else {
    console.log('Inventory source: cache');
  }
  console.log(`Master Roster: ${excelFile}`);
  console.log(`Output file: ${outputFile}`);
  console.log('');

  // Step 1: Load inventory files
  console.log('Step 1: Loading inventory files...');

  let w111Inventory, w115Inventory;
  let inventoryFileInfo = null;
  let cacheData = null;  // For cache mode - used by other warehouse check

  if (inventorySource === 'xlsx') {
    // Parse xlsx directly
    console.log(`  Parsing: ${path.basename(xlsxPath)}`);
    w111Inventory = loadInventoryFromXlsx(xlsxPath, 'W111');
    w115Inventory = loadInventoryFromXlsx(xlsxPath, 'W115');

    // Get file age for staleness check
    if (fs.existsSync(xlsxPath)) {
      const fileStats = fs.statSync(xlsxPath);
      inventoryFileInfo = {
        path: xlsxPath,
        mtime: fileStats.mtime,
        ageDays: Math.floor((Date.now() - fileStats.mtime.getTime()) / (1000 * 60 * 60 * 24)),
      };
    }
  } else if (inventorySource === 'csv') {
    // Load from pre-parsed CSVs
    const w111Path = path.join(inventoryFolder, W111_FILENAME);
    const w115Path = path.join(inventoryFolder, W115_FILENAME);

    w111Inventory = loadChuboeInventory(w111Path, 'W111');
    w115Inventory = loadChuboeInventory(w115Path, 'W115');

    // Get file age for staleness check
    if (fs.existsSync(w111Path)) {
      const fileStats = fs.statSync(w111Path);
      inventoryFileInfo = {
        path: w111Path,
        mtime: fileStats.mtime,
        ageDays: Math.floor((Date.now() - fileStats.mtime.getTime()) / (1000 * 60 * 60 * 24)),
      };
    }
  } else {
    // Cache mode (default)
    console.log('  Loading from cache...');
    cacheData = loadCachedInventory({ allowStale: true });
    if (!cacheData) {
      console.error('  ERROR: No inventory cache found. Run inventory-fetch-and-parse first.');
      process.exit(1);
    }

    console.log(`  Cache date: ${cacheData.metadata.cachedAt}`);
    console.log(`  Week of: ${cacheData.metadata.weekOf}`);
    if (cacheData.metadata.stale) {
      console.log('  WARNING: Using stale cache');
    }

    // Extract W111 and W115 from cache
    w111Inventory = loadInventoryFromCache(cacheData, 'W111');
    w115Inventory = loadInventoryFromCache(cacheData, 'W115');

    // Set file info for staleness check
    const cachedAt = new Date(cacheData.metadata.cachedAt);
    inventoryFileInfo = {
      path: `cache (${cacheData.metadata.weekOf})`,
      mtime: cachedAt,
      ageDays: Math.floor((Date.now() - cachedAt.getTime()) / (1000 * 60 * 60 * 24)),
    };
  }

  console.log(`  W111 (LAM 3PL): ${Object.keys(w111Inventory).length} unique MPNs`);
  console.log(`  W115 (Dead Inventory): ${Object.keys(w115Inventory).length} unique MPNs`);

  // Step 1b: Check inventory file age - warn if stale (>7 days old per spec)
  if (inventoryFileInfo && inventoryFileInfo.ageDays > 7) {
    console.log('');
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log(`  WARNING: Inventory file is ${inventoryFileInfo.ageDays} days old!`);
    console.log('  This data may be stale. Check if inventory cleanup cron is running.');
    console.log('  File:', path.basename(inventoryFileInfo.path));
    console.log('  Modified:', inventoryFileInfo.mtime.toISOString().split('T')[0]);
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('');
  }

  // Step 2: Aggregate by MPN
  console.log('');
  console.log('Step 2: Aggregating inventory by MPN...');
  const aggregated = aggregateInventory(w111Inventory, w115Inventory);
  console.log(`  Combined: ${Object.keys(aggregated).length} unique MPNs`);

  // Step 2b: Load pending transfers (confirmed LAM stock being moved to W111)
  // Auto-clear any that have completed (part now in W111/W115)
  console.log('');
  console.log('Step 2b: Loading pending transfers...');
  const pendingTransfers = loadPendingTransfers();
  if (pendingTransfers.size > 0) {
    console.log(`  Pending transfers: ${pendingTransfers.size} MPNs`);

    // Auto-clear completed transfers (matches by qty)
    const cleared = autoClearCompletedTransfers(pendingTransfers, aggregated);
    if (cleared.length > 0) {
      console.log(`  Auto-cleared ${cleared.length} completed transfers:`);
      for (const c of cleared) {
        const matchInfo = c.match === 'exact'
          ? `${c.actualQty} pcs (exact match)`
          : `${c.actualQty} pcs (expected ${c.expectedQty})`;
        console.log(`    ✓ ${c.mpn} (${c.cpc}) - now has ${matchInfo} in W111/W115`);
      }
    }

    // Log remaining pending transfers
    if (pendingTransfers.size > 0) {
      console.log(`  Still pending: ${pendingTransfers.size} MPNs`);
    }
  } else {
    console.log('  No pending transfers');
  }

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

  // Step 3c: Load recent POVs (needed for Purchased MPN lookup in inventory tracking)
  // Load POVs BEFORE updating inventory dates so we can include Purchased MPNs
  console.log('');
  console.log('Step 3c: Loading recent POVs (for Purchased MPN lookup)...');
  const recentPOVsRaw = loadRecentPOVs();
  console.log(`  Recent POVs found: ${Object.keys(recentPOVsRaw).length} CPCs/MPNs`);

  // Step 3d: Update last inventory dates for POV staleness tracking
  // For each CPC with inventory, record today as the "last seen with inventory" date.
  // This prevents stale POVs from resurfacing when inventory is later consumed.
  // IMPORTANT: Include Purchased MPNs from POVs, not just AVL MPNs (fix 2026-08-05)
  console.log('');
  console.log('Step 3d: Updating last inventory dates...');
  const inventoryByCpc = {};
  for (const [mpn, excel] of Object.entries(excelData)) {
    const cpc = excel.CPC;
    if (!cpc) continue;
    // Get inventory for this MPN (and any AVL alternates)
    const allMpns = getAllApprovedMPNs(cpc, mpn);

    // Also include Purchased MPN from POV if different from AVL
    // This handles cases where inventory arrives under a non-AVL MPN
    const pov = recentPOVsRaw[cpc] || recentPOVsRaw[normalizeMPN(mpn)];
    const purchasedMpn = pov?.Purchased_MPN;
    const mpnsToCheck = [...allMpns];
    if (purchasedMpn && !allMpns.some(m => normalizeMPN(m) === normalizeMPN(purchasedMpn))) {
      mpnsToCheck.push(purchasedMpn);
    }

    let totalQty = 0;
    for (const m of mpnsToCheck) {
      const inv = aggregated[m] || aggregated[normalizeMPN(m)];
      if (inv) totalQty += inv.Total_Qty || 0;
    }
    if (totalQty > 0) {
      inventoryByCpc[cpc] = (inventoryByCpc[cpc] || 0) + totalQty;
    }
  }
  updateLastInventoryDates(inventoryByCpc);

  // Step 4: Load historical purchase data from ERP
  console.log('');
  console.log('Step 4: Loading historical purchase data from ERP...');
  const mpnsToQuery = Object.keys(aggregated);
  const historicalData = loadHistoricalPurchaseData(mpnsToQuery);
  console.log(`  Historical data found: ${Object.keys(historicalData).length} MPNs`);

  // Step 4b: Filter stale POVs (created before the CPC last had inventory)
  // This prevents old fulfilled orders from resurfacing when inventory is consumed.
  console.log('');
  console.log('Step 4b: Filtering stale POVs...');
  const recentPOVs = {};
  let staleFiltered = 0;
  for (const [key, pov] of Object.entries(recentPOVsRaw)) {
    const poCreated = pov.PO_Created_Date;
    if (poCreated && isPovStale(key, poCreated)) {
      staleFiltered++;
      // Log for visibility (only first few)
      if (staleFiltered <= 3) {
        console.log(`    Filtered stale POV: ${key} (PO created ${poCreated})`);
      }
    } else {
      recentPOVs[key] = pov;
    }
  }
  if (staleFiltered > 0) {
    console.log(`  Filtered ${staleFiltered} stale POVs (created before last inventory)`);
  }

  // Step 4c: Load recent VQ pricing (from Monday's full run)
  console.log('');
  console.log('Step 4c: Loading recent VQ pricing (past 7 days)...');
  const recentVQPricing = loadRecentVQPricing();
  console.log(`  Recent VQ pricing found: ${Object.keys(recentVQPricing.byCpc).length} CPCs, ${Object.keys(recentVQPricing.byMpn).length} MPNs`);

  // Step 5: Join and identify reorder candidates
  // Pass both raw POVs (for Purchased MPN lookup) and filtered POVs (for priority)
  // This ensures inventory under Purchased MPNs is counted even when the POV is stale
  console.log('');
  console.log('Step 5: Identifying reorder candidates...');
  const reorderAlerts = identifyReorderCandidates(aggregated, excelData, historicalData, recentPOVs, pendingTransfers, recentVQPricing, recentPOVsRaw);
  console.log(`  Reorder candidates: ${reorderAlerts.length} items`);

  // Step 5b: Check other warehouses for available stock
  console.log('');
  console.log('Step 5b: Checking other warehouse stock...');
  const reorderMPNs = reorderAlerts.map(a => a['MPN']);
  const otherStock = loadOtherWarehouseStock(inventoryFolder, reorderMPNs, xlsxPath, cacheData);
  const stockMatches = Object.keys(otherStock).filter(mpn => otherStock[mpn].length > 0).length;
  console.log(`  Stock matches found: ${stockMatches} MPNs in other warehouses`);

  // Enrich alerts with other warehouse stock
  for (const alert of reorderAlerts) {
    const matches = otherStock[alert['MPN']] || [];
    if (matches.length > 0) {
      const warehouses = matches.map(m => m.warehouse);
      const totalQty = matches.reduce((sum, m) => sum + m.qty, 0);
      alert['Available Stock (Other WH)'] = warehouses.join(', ');
      alert['Available Qty (Other WH)'] = totalQty;
    }
  }

  // Step 5c: Data integrity validation (catch row-offset corruption before output)
  console.log('');
  console.log('Step 5c: Validating data integrity...');
  const validationIssues = validateDataIntegrity(reorderAlerts, excelData);
  if (validationIssues.length > 0) {
    console.log(`  WARNING: ${validationIssues.length} data integrity issue(s) detected:`);
    for (const issue of validationIssues.slice(0, 10)) {
      console.log(`    - ${issue.type}: CPC ${issue.cpc} - ${issue.message}`);
    }
    if (validationIssues.length > 10) {
      console.log(`    ... and ${validationIssues.length - 10} more`);
    }
  } else {
    console.log('  All records passed validation.');
  }

  // Step 5d: Scan ALL POVs for NOT ON AVL items (regardless of reorder status)
  // This catches items with stock that have Purchased MPNs needing reconciliation
  console.log('');
  console.log('Step 5d: Scanning for NOT ON AVL items (all POVs)...');
  const additionalNotOnAvl = findAllNotOnAvlItems(excelData, recentPOVsRaw, aggregated, reorderAlerts);
  if (additionalNotOnAvl.length > 0) {
    console.log(`  Additional NOT ON AVL items found: ${additionalNotOnAvl.length} (items with stock, not on reorder list)`);
  } else {
    console.log('  No additional NOT ON AVL items beyond reorder list.');
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
  const actualOutputFile = writeReorderAlerts(readyToOrder, outputFile, additionalNotOnAvl);
  // writeReorderAlerts logs its own output details (CSV vs Excel with tabs)

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

  // Step 6c: NOT ON AVL sidecar - items needing reconciliation
  // The runner will load this and add a "NOT ON AVL - Reconcile" tab to the final output
  const notOnAvlFromReorder = readyToOrder.filter(a => a['MPN Flag'] === 'NOT ON AVL');
  const allNotOnAvlItems = [...notOnAvlFromReorder, ...additionalNotOnAvl];
  if (allNotOnAvlItems.length > 0) {
    const notOnAvlFile = outputFile.replace('.csv', '_not_on_avl.json');
    fs.writeFileSync(notOnAvlFile, JSON.stringify({
      generated: new Date().toISOString(),
      count: allNotOnAvlItems.length,
      items: allNotOnAvlItems,
    }, null, 2) + '\n');
    console.log(`  NOT ON AVL sidecar written: ${allNotOnAvlItems.length} items`);
  }

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`Total items below threshold: ${reorderAlerts.length}`);
  console.log(`  Ready to order: ${readyToOrder.length}`);
  console.log(`  Pending LAM approval: ${pendingApprovals.length}`);

  if (readyToOrder.length > 0) {
    const criticalPriority = readyToOrder.filter(r => r.Priority === 'CRITICAL').length;
    const vqTickedCount = readyToOrder.filter(r => r.Priority === 'VQ TICKED - NEED PO').length;
    const highPriority = readyToOrder.filter(r => r.Priority === 'HIGH').length;
    const medPriority = readyToOrder.filter(r => r.Priority === 'MEDIUM').length;
    const lowPriority = readyToOrder.filter(r => r.Priority === 'LOW').length;
    const pendingOrder = readyToOrder.filter(r => r.Priority === 'PENDING ORDER PLACEMENT').length;
    const pendingReceipt = readyToOrder.filter(r => r.Priority === 'PENDING RECEIPT').length;
    const pendingTransfer = readyToOrder.filter(r => r.Priority.startsWith('PENDING WAREHOUSE TRANSFER')).length;
    console.log('');
    console.log('Ready to Order breakdown:');
    console.log(`  CRITICAL priority (zero stock, no recent PO): ${criticalPriority}`);
    if (vqTickedCount > 0) {
      console.log(`  VQ TICKED - NEED PO (procurement bottleneck): ${vqTickedCount}`);
    }
    console.log(`  HIGH priority: ${highPriority}`);
    console.log(`  MEDIUM priority: ${medPriority}`);
    console.log(`  LOW priority: ${lowPriority}`);
    console.log(`  PENDING ORDER PLACEMENT (PO cut, awaiting Infor): ${pendingOrder}`);
    console.log(`  PENDING RECEIPT (waiting on vendor): ${pendingReceipt}`);
    if (pendingTransfer > 0) {
      console.log(`  PENDING WAREHOUSE TRANSFER (warehouse transfer in progress): ${pendingTransfer}`);
    }

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

  // Check for Additional Review parts (flagged discrepancies awaiting operator decision)
  const flaggedCPCs = getFlaggedCPCsFromHandler();
  const additionalReviewParts = Object.values(excelData).filter(e => e.Status === 'Additional Review');
  if (additionalReviewParts.length > 0 || flaggedCPCs.length > 0) {
    console.log('');
    console.log('=== Additional Review (Flagged Discrepancies) ===');
    console.log(`  Parts with discrepancies: ${additionalReviewParts.length}`);
    if (flaggedCPCs.length > 0) {
      console.log(`  CPCs with pending flags: ${flaggedCPCs.join(', ')}`);
    }
    console.log('  → Approval was applied, but email mentioned other field changes');
    console.log('  → Reply to lamkitting@ with APPROVE/SKIP commands to resolve');
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
    const vqTickedEmailCount = readyToOrder.filter(r => r.Priority === 'VQ TICKED - NEED PO').length;
    const highCount = readyToOrder.filter(r => r.Priority === 'HIGH').length;
    const medCount = readyToOrder.filter(r => r.Priority === 'MEDIUM').length;
    const lowCount = readyToOrder.filter(r => r.Priority === 'LOW').length;
    const pendingOrderCount = readyToOrder.filter(r => r.Priority === 'PENDING ORDER PLACEMENT').length;
    const pendingReceiptCount = readyToOrder.filter(r => r.Priority === 'PENDING RECEIPT').length;

    // Calculate aging for pending approvals
    const oldestPending = pendingApprovals.length > 0
      ? Math.max(...pendingApprovals.map(p => p['Days Pending'] || 0))
      : 0;

    const vqTickedLine = vqTickedEmailCount > 0 ? `\n- VQ TICKED - NEED PO (procurement bottleneck): ${vqTickedEmailCount}` : '';

    // Check for Additional Review parts
    const flaggedCPCs = getFlaggedCPCsFromHandler();
    const additionalReviewParts = Object.values(excelData).filter(e => e.Status === 'Additional Review');

    let emailBody = `LAM 3PL Reorder Report - ${getDateStamp()}

=== REORDER ALERTS (Ready to Order) ===
${readyToOrder.length} items below threshold:
- CRITICAL (zero stock, no recent PO): ${critCount}${vqTickedLine}
- HIGH: ${highCount}
- MEDIUM: ${medCount}
- LOW: ${lowCount}
- PENDING ORDER PLACEMENT (PO cut, awaiting Infor): ${pendingOrderCount}
- PENDING RECEIPT (waiting on vendor): ${pendingReceiptCount}

=== PENDING APPROVALS ===
${pendingApprovals.length} items awaiting LAM approval`;

    // Add Additional Review section if any
    if (additionalReviewParts.length > 0 || flaggedCPCs.length > 0) {
      emailBody += `

=== ADDITIONAL REVIEW (Flagged Discrepancies) ===
${additionalReviewParts.length} parts have discrepancies flagged for operator review.
These had their primary approval applied, but the email mentioned other field changes.

Reply to lamkitting@orangetsunami.com with APPROVE/SKIP commands:
  APPROVE LEADTIME — update lead time to email value
  APPROVE MOQ — update MOQ to email value
  SKIP ALL — skip all flagged items for this CPC`;
      if (flaggedCPCs.length > 0) {
        emailBody += `

CPCs pending review: ${flaggedCPCs.join(', ')}`;
      }
    }

    if (pendingApprovals.length > 0) {
      emailBody += `
- Oldest pending: ${oldestPending} days`;
    }

    emailBody += `

Inventory source: ${inventoryFolder ? path.basename(inventoryFolder) : inventorySource}`;

    // Attach both files
    // IMPORTANT: Use actualOutputFile (returned from writeReorderAlerts) - it's .xlsx if NOT ON AVL items exist
    const attachments = [actualOutputFile];
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

/**
 * Load inventory directly from Infor xlsx using inventory-parser
 * Returns same format as loadChuboeInventory for compatibility
 *
 * @param {string} xlsxPath - Path to ASTItemLotsReport xlsx
 * @param {string} warehouseCode - e.g., 'W111' or 'W115'
 * @returns {object} { mpn: { qty, warehouse }, ... }
 */
function loadInventoryFromXlsx(xlsxPath, warehouseCode) {
  const parsed = parseInventoryFile(xlsxPath);
  const rows = parsed.byWarehouse[warehouseCode] || [];

  const inventory = {};

  for (const row of rows) {
    const mpn = (row.mpn || '').trim();
    const qty = row.qty || 0;

    if (!mpn) continue;

    // Aggregate by MPN (handles multiple lots)
    if (!inventory[mpn]) {
      inventory[mpn] = { qty: 0, warehouse: warehouseCode };
    }
    inventory[mpn].qty += qty;
  }

  return inventory;
}

/**
 * Load inventory from cache data
 * Returns same format as loadChuboeInventory for compatibility
 *
 * @param {object} cacheData - Cache data from loadCachedInventory
 * @param {string} warehouseCode - e.g., 'W111' or 'W115'
 * @returns {object} { mpn: { qty, warehouse }, ... }
 */
function loadInventoryFromCache(cacheData, warehouseCode) {
  const rows = cacheData.byWarehouse[warehouseCode] || [];

  const inventory = {};

  for (const row of rows) {
    const mpn = (row.mpn || '').trim();
    const qty = row.qty || 0;

    if (!mpn) continue;

    // Aggregate by MPN (handles multiple lots)
    if (!inventory[mpn]) {
      inventory[mpn] = { qty: 0, warehouse: warehouseCode };
    }
    inventory[mpn].qty += qty;
  }

  console.log(`  ${warehouseCode}: ${Object.keys(inventory).length} unique MPNs`);
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

/**
 * Parse threshold value, preserving the distinction between:
 * - Empty/missing → null (needs threshold from LAM)
 * - Zero → 0 (intentionally set to zero)
 * - Number → that number
 */
function parseThreshold(v) {
  if (v == null || v === '') return null;
  const str = String(v).trim();
  if (str === '') return null;
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
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

  // Placeholder MPNs that aren't real part numbers - key by CPC instead to avoid collisions
  const PLACEHOLDER_MPNS = [
    'ORDER TO SPECIFICATION',
    'BUILD TO PRINT',
    'BUILT TO PRINT',
    'CUSTOM',
    'SPECIAL ORDER',
    'TBD',
    'N/A',
    'NA',
    'NONE',
  ];

  function isPlaceholderMPN(mpn) {
    if (!mpn) return false;
    const upper = mpn.toUpperCase().trim();
    return PLACEHOLDER_MPNS.some(p => upper === p || upper.includes(p));
  }

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
      MIN_QTY: colIdx.THRESHOLD >= 0 ? parseThreshold(row[colIdx.THRESHOLD]) : null,
      MOQ: colIdx.MOQ >= 0 ? (parseFloat(row[colIdx.MOQ]) || 0) : 0,
      Historical_Buyer: cellToString(row[colIdx.BUYER]),
      // Pending approval workflow fields
      Pending: pending,
      Proposed_Resale: proposedResale != null ? (parseFloat(proposedResale) || null) : null,
      Last_Approved: colIdx.LAST_APPROVED >= 0 ? cellToString(row[colIdx.LAST_APPROVED]) : '',
      Status: status,
      Submitted_Date: submittedDate,
    };

    // Use CPC as key for placeholder MPNs to avoid collisions (multiple CPCs can have same placeholder)
    const excelKey = isPlaceholderMPN(mpn) ? record.CPC : mpn;
    if (!excelKey) continue;  // Skip if no valid key
    excelData[excelKey] = record;

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

// Track OT availability status across queries
let _otAvailable = true;
let _otErrorMessage = null;

function isOtAvailable() {
  return _otAvailable;
}

function getOtErrorMessage() {
  return _otErrorMessage;
}

// Detect infrastructure errors (connection refused, auth failed, etc.)
function isInfrastructureError(errorMessage) {
  const infraPatterns = [
    'connection refused',
    'could not connect',
    'fe_sendauth',
    'no password supplied',
    'authentication failed',
    'FATAL:',
    'timeout expired',
    'network is unreachable'
  ];
  const msg = (errorMessage || '').toLowerCase();
  return infraPatterns.some(p => msg.includes(p.toLowerCase()));
}

// Run a psql query via temp file; return stdout as string.
// Detects infrastructure errors and sets _otAvailable = false
function runPsql(sql, label) {
  const tmpSql = `/tmp/lam_kitting_${label}.sql`;
  const tmpOut = `/tmp/lam_kitting_${label}.out`;
  fs.writeFileSync(tmpSql, sql);
  try {
    execSync(`psql -U analytics_user -d idempiere_replica -t -A -F '|' -f ${tmpSql} -o ${tmpOut}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    const errorMsg = (e.message || '') + (e.stderr ? e.stderr.toString() : '');

    // Check for infrastructure errors (OT unavailable)
    if (isInfrastructureError(errorMsg)) {
      _otAvailable = false;
      _otErrorMessage = `OT database unavailable: ${errorMsg.slice(0, 200)}`;
      console.error(`  ERROR: ${_otErrorMessage}`);
      return '';
    }

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
// Step 4c: Load Recent VQ Pricing (past 7 days - from Monday's full run)
// -----------------------------------------------------------------------------

/**
 * Load recent VQ pricing data for LAM parts.
 * This provides reference pricing from Monday's full API run for use in
 * mid-week refreshes (no API calls needed).
 *
 * Returns TWO maps for flexible lookup:
 *   - byCpc: CPC -> { supplier, cost, date, qty, mpn }
 *   - byMpn: normalized MPN -> { supplier, cost, date, qty, cpc }
 *
 * Caller should check BOTH and reconcile (CPC is source of truth, MPN for verification).
 */
function loadRecentVQPricing() {
  // Get VQs from LAM RFQs created in the past 7 days
  // This captures Monday's full run and any ad-hoc VQs written during the week
  // Include CPC from RFQ line for cross-reference
  const sql = `
    SELECT
      TRIM(rl.chuboe_cpc) AS cpc,
      TRIM(vl.chuboe_mpn) AS mpn,
      bp.name AS supplier_name,
      vl.cost AS vq_cost,
      vl.created::date AS vq_date,
      vl.qty AS vq_qty
    FROM adempiere.chuboe_vq_line vl
    JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line rl ON vl.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
    WHERE rfq.c_bpartner_id = 1000730  -- LAM Research only
      AND vl.isactive = 'Y'
      AND vl.cost IS NOT NULL
      AND vl.cost > 0
      AND vl.created >= CURRENT_DATE - INTERVAL '7 days'
      AND vl.chuboe_mpn IS NOT NULL
      AND vl.chuboe_mpn != ''
    ORDER BY vl.created DESC;
  `;

  const byCpc = {};
  const byMpn = {};

  try {
    const result = runPsql(sql, 'vq_pricing');
    for (const line of result.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
      const [cpc, mpn, supplier, cost, date, qty] = line.split('|');
      const cpcKey = (cpc || '').trim();
      const mpnKey = normalizeMPN(mpn);

      const data = {
        VQ_Supplier: (supplier || '').trim(),
        VQ_Cost: parseFloat(cost) || 0,
        VQ_Date: (date || '').trim(),
        VQ_Qty: parseFloat(qty) || 0,
        VQ_MPN: (mpn || '').trim(),
        VQ_CPC: cpcKey
      };

      // Index by CPC (most recent wins - query ordered by created DESC)
      if (cpcKey && !byCpc[cpcKey]) {
        byCpc[cpcKey] = data;
      }

      // Index by MPN (most recent wins)
      if (mpnKey && !byMpn[mpnKey]) {
        byMpn[mpnKey] = data;
      }
    }
  } catch (e) {
    console.log(`  WARNING: Could not load recent VQ pricing: ${e.message}`);
  }

  return { byCpc, byMpn };
}

// -----------------------------------------------------------------------------
// Step 4b: Load Recent POVs (vendor receipts in last 4 months)
// -----------------------------------------------------------------------------

function loadRecentPOVs() {
  // Surface open LAM purchase activity per CPC. Inclusion rules:
  //   1. Infor-stamped POs (chuboe_po_string LIKE 'POV%') with Completed/In Progress status
  //      — included regardless of age. A POV stamp + CO/IP status means it's a committed
  //      vendor order; we're just waiting on shipment (even if delayed).
  //   2. Draft POs (docstatus = 'DR') — even with POV stamp, only included if recent
  //      (created within 120 days OR promise within 30 days). Old Draft POs with POV
  //      stamps are likely abandoned orders that were never finalized.
  //   3. Non-stamped activity (OT drafts without POV, VQ_TICKED) — included if:
  //      - PO/RFQ created within last 120 days, OR
  //      - promise date is today or future
  //      Otherwise dropped as stuck/orphan activity needing cleanup.
  //
  // IMPORTANT: OT does NOT track receipts — Infor does. We cannot use qtydelivered
  // to determine if parts were received. Use inventory files as source of truth.
  //
  // VQ_TICKED branch (ispurchased='Y' with no PO cut yet) uses rfq.created and
  // vl.datepromised for recency checks.
  //
  // Once a row passes the filter it qualifies for PENDING RECEIPT (POV stamped)
  // or PENDING ORDER PLACEMENT (no POV stamp yet — OT PO without Infor stamp,
  // or VQ ticked with no PO at all). Both states are informational at the
  // bottom of the priority sort.
  //
  // On Order Qty = SUM of open qty across all qualifying activity for the CPC.
  // Recent POV cell shows the single most-recent activity row (preferring PO over VQ_TICKED).
  // KEY: Join by CPC (via RFQ line), not MPN — ensures alternate-MPN purchases
  // surface for the roster MPN.
  const sql = `
    WITH all_activity AS (
      -- Open POs (with or without Infor POV stamp)
      -- Key by CPC if available, otherwise fall back to clean MPN (for LAM RFQs missing CPC)
      SELECT
        COALESCE(NULLIF(TRIM(rl.chuboe_cpc), ''), ol.chuboe_mpn_clean) AS cpc,
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
        u_buyer.name AS buyer,
        ol.updated::date AS last_updated
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.chuboe_vq_line vl ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
      LEFT JOIN adempiere.chuboe_rfq_line rl ON vl.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      LEFT JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      LEFT JOIN adempiere.ad_user u_buyer ON u_buyer.ad_user_id = o.salesrep_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND o.docstatus IN ('CO', 'IP', 'DR')
        AND ol.qtyordered > ol.qtydelivered
        AND rfq.c_bpartner_id = 1000730
        -- Inclusion rules:
        -- 1. POV stamped + Completed/In Progress = committed vendor order, always keep
        -- 2. Draft orders (even with POV) = only keep if recent (abandoned drafts excluded)
        -- 3. Non-stamped = only keep if recent
        -- NOTE: OT does NOT track receipts (Infor does), so we cannot rely on qtydelivered
        AND (
          (ol.chuboe_po_string LIKE 'POV%' AND o.docstatus IN ('CO', 'IP'))  -- POV + completed = always keep
          OR o.created::date >= CURRENT_DATE - INTERVAL '90 days'             -- Recent PO = keep
          OR ol.datepromised::date >= CURRENT_DATE - INTERVAL '30 days'       -- Promise within 30 days = keep
        )

      UNION ALL

      -- VQs ticked (ispurchased='Y') but no PO cut yet → buyer committed, procurement catching up
      -- Key by CPC if available, otherwise fall back to clean MPN
      SELECT
        COALESCE(NULLIF(TRIM(rl.chuboe_cpc), ''), vl.chuboe_mpn_clean) AS cpc,
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
        u_vq_buyer.name AS buyer,
        vl.updated::date AS last_updated
      FROM adempiere.chuboe_vq_line vl
      JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line rl ON vl.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.ad_user u_vq_buyer ON u_vq_buyer.ad_user_id = vl.createdby
      LEFT JOIN adempiere.c_orderline ol2
        ON ol2.chuboe_vq_line_id = vl.chuboe_vq_line_id AND ol2.isactive = 'Y'
      WHERE vl.ispurchased = 'Y'
        AND vl.isactive = 'Y'
        AND rfq.c_bpartner_id = 1000730
        AND rfq.isactive = 'Y'
        AND ol2.c_orderline_id IS NULL
        -- Same recency rule: keep iff RFQ created recently OR VQ promise date still ≥ today
        AND (
          rfq.created::date >= CURRENT_DATE - INTERVAL '90 days'
          OR vl.datepromised::date >= CURRENT_DATE
        )
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY cpc ORDER BY preference ASC, sort_date DESC NULLS LAST) AS rn,
        SUM(qty) OVER (PARTITION BY cpc) AS total_qty
      FROM all_activity
    )
    SELECT cpc, mpn, pov_number, ot_po_number, qty, total_qty, promise_date, po_created_date,
           supplier, rfq_number, state, tracking, buyer, last_updated
    FROM ranked
    WHERE rn = 1;
  `;

  const result = runPsql(sql, 'povs');
  const povData = {};
  for (const line of result.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [cpc, mpn, pov, otPo, qty, totalQty, promiseDate, poCreated, supplier, rfqNum, state, tracking, buyer, lastUpdated] = line.split('|');
    const key = (cpc || '').trim();  // Key by CPC, not MPN
    if (key) {
      // Recency is enforced in SQL — anything returned here is by definition still relevant.
      const record = {
        State: (state || '').trim(),                    // 'PO' or 'VQ_TICKED'
        POV_Number: (pov || '').trim(),                 // populated once Infor stamps
        OT_PO_Number: (otPo || '').trim(),              // OT PO# (pre-Infor-stamp fallback)
        Purchased_MPN: (mpn || '').trim(),              // The actual MPN purchased (may differ from roster)
        POV_Qty: parseFloat(qty) || 0,                  // qty on the displayed row
        POV_Date: (promiseDate || '').trim(),           // vendor promise date on the displayed row
        PO_Created_Date: (poCreated || '').trim(),      // when we cut the PO
        POV_Supplier: (supplier || '').trim(),
        RFQ_Number: (rfqNum || '').trim(),
        Qty_On_Order: parseFloat(totalQty) || 0,        // total across all RECENT open activity for the CPC
        Tracking: (tracking || '').trim(),              // tracking number or notes
        Buyer: (buyer || '').trim(),                    // OT buyer (salesrep on PO, or VQ creator)
        Last_Updated: (lastUpdated || '').trim(),       // when order line was last modified
      };
      povData[key] = record;

      // When CPC is null, SQL falls back to MPN as the key. Store under BOTH
      // the raw MPN (with hyphens) AND the normalized MPN (without hyphens) to
      // ensure lookup matches regardless of normalization. The lookup in
      // identifyReorderCandidates uses normalizeMPN() which strips hyphens,
      // so we need the normalized key to match.
      const normalizedKey = normalizeMPN(key);
      if (normalizedKey !== key && !povData[normalizedKey]) {
        povData[normalizedKey] = record;
      }

      // ALSO store under normalized MPN for CPC mismatch scenarios.
      // When multiple CPCs exist for the same MPN (common in LAM), the PO may be
      // keyed by one CPC while the roster uses another. The MPN fallback in
      // selectBetterPOV() ensures we still find the POV data even when CPCs differ.
      const mpnKey = normalizeMPN((mpn || '').trim());
      if (mpnKey && !povData[mpnKey]) {
        povData[mpnKey] = record;
      }
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

// Warehouse code → label mapping for xlsx mode
const OTHER_WAREHOUSE_CODES = [
  { code: 'W102', label: 'W102 Stevenage' },
  { code: 'W103', label: 'W103 GE Consignment' },
  { code: 'W104', label: 'W104 Austin' },
  { code: 'W106', label: 'W106 Taxan Consignment' },
  { code: 'W107', label: 'W107 Spartronics Consignment' },
  { code: 'W108', label: 'W108 Hong Kong' },
  { code: 'W112', label: 'W112 Austin' },
  { code: 'W113', label: 'W113 Hong Kong' },
  { code: 'W117', label: 'W117 Eaton Consignment' },
  { code: 'W118', label: 'W118 LAM Consignment' },
];

function loadOtherWarehouseStock(inventoryFolder, targetMPNs, xlsxPath = null, cacheData = null) {
  const targetSet = new Set(targetMPNs);
  const results = {}; // mpn → [{ warehouse, qty }]
  for (const mpn of targetMPNs) results[mpn] = [];

  if (cacheData) {
    // Cache mode — use cache data directly
    for (const wh of OTHER_WAREHOUSE_CODES) {
      const rows = cacheData.byWarehouse[wh.code] || [];

      // Aggregate by MPN within this warehouse
      const whStock = {};
      for (const row of rows) {
        const mpn = (row.mpn || '').trim();
        if (!mpn || !targetSet.has(mpn)) continue;
        whStock[mpn] = (whStock[mpn] || 0) + (row.qty || 0);
      }

      for (const [mpn, qty] of Object.entries(whStock)) {
        if (qty > 0) {
          results[mpn].push({ warehouse: wh.label, qty });
        }
      }
    }
  } else if (xlsxPath) {
    // xlsx mode — use parser
    const parsed = parseInventoryFile(xlsxPath);

    for (const wh of OTHER_WAREHOUSE_CODES) {
      const rows = parsed.byWarehouse[wh.code] || [];

      // Aggregate by MPN within this warehouse
      const whStock = {};
      for (const row of rows) {
        const mpn = (row.mpn || '').trim();
        if (!mpn || !targetSet.has(mpn)) continue;
        whStock[mpn] = (whStock[mpn] || 0) + (row.qty || 0);
      }

      for (const [mpn, qty] of Object.entries(whStock)) {
        if (qty > 0) {
          results[mpn].push({ warehouse: wh.label, qty });
        }
      }
    }
  } else if (inventoryFolder) {
    // CSV mode — use pre-parsed files
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
  }

  return results;
}

// Column order — single source of truth for buildAlert() and writeReorderAlerts()
// To add/remove/reorder columns: update this array AND the buildAlert() values below
const ALERT_COLUMNS = [
  // Part identification
  'Lam P/N',
  'MPN',
  'Purchased MPN',  // Shows alternate MPN if sourced differently from roster
  'MPN Flag',       // '' = OK, 'AVL' = alt MPN on AVL, 'NOT ON AVL' = escalate
  'Manufacturer',
  'Item Description',
  // Inventory & priority
  'QTY ON HAND',
  'W115 Stale Inventory',
  'Reorder Threshold',
  'Shortfall',
  'Priority',  // Includes "PENDING WAREHOUSE TRANSFER - X pcs from WH" when applicable
  'On Order Qty',
  'OT PO',
  'Recent POV',
  'Tracking',
  'Last Promise Date',
  'PO Created Date',
  'Last Updated',
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
  // Recent VQ pricing (from Monday's full run - reference pricing for mid-week refreshes)
  'Recent VQ Supplier',
  'Recent VQ Price',
  'Recent VQ Margin %',
  'Recent VQ Date',
];

// Render the "Recent POV" cell based on the activity state reported by loadRecentPOVs.
// Three states, in descending procurement maturity:
//   PO + POV stamp: "POV0075568 (2026-04-13, 60 pcs from Master, RFQ 1132328)"
//   PO only:        "OT PO809630 pending Infor stamp (2026-04-13, 60 pcs from Master, RFQ 1132328)"
//   VQ ticked only: "VQ ticked - PO pending (60 pcs from Master, RFQ 1132328)"
// Date shown is the PO issue date (when order was placed), not the promise date.
function formatPOVCell(pov) {
  if (!pov || !pov.State) return '';
  const rfqTag = pov.RFQ_Number ? `, RFQ ${pov.RFQ_Number}` : '';
  if (pov.State === 'PO') {
    const id = pov.POV_Number || (pov.OT_PO_Number ? `OT ${pov.OT_PO_Number} pending Infor stamp` : '');
    if (!id) return '';
    // Use PO issue date, not promise date (promise dates are vendor ETAs, not reliable)
    const datePart = pov.PO_Created_Date ? `${pov.PO_Created_Date}, ` : '';
    return `${id} (${datePart}${pov.POV_Qty} pcs from ${pov.POV_Supplier}${rfqTag})`;
  }
  if (pov.State === 'VQ_TICKED') {
    return `VQ ticked - PO pending (${pov.POV_Qty} pcs from ${pov.POV_Supplier}${rfqTag})`;
  }
  return '';
}

function buildAlert(mpn, excel, totalQty, lamOwned, shortfall, priority, history, pov) {
  // Show purchased MPN only if it differs from roster MPN (alternate sourcing)
  const purchasedMpn = pov && pov.Purchased_MPN && pov.Purchased_MPN !== mpn ? pov.Purchased_MPN : '';

  // Validate purchased MPN is on AVL for this CPC (spec requirement)
  const mpnValidation = validatePurchasedMPN(excel.CPC, mpn, pov && pov.Purchased_MPN);

  return {
    'Lam P/N': excel.CPC,
    'MPN': mpn,
    'Purchased MPN': purchasedMpn,  // Shows alternate MPN if sourced differently
    'MPN Flag': mpnValidation.flag,  // '' = OK, 'AVL' = on AVL but different, 'NOT ON AVL' = escalate
    'Manufacturer': excel.Manufacturer,
    'Item Description': excel.Description,
    'QTY ON HAND': totalQty,
    'W115 Stale Inventory': lamOwned,
    'Reorder Threshold': excel.MIN_QTY,
    'Shortfall': shortfall,
    'Priority': priority,  // Includes "PENDING WAREHOUSE TRANSFER - X pcs from WH" when applicable
    'On Order Qty': pov ? (pov.Qty_On_Order || '') : '',
    'OT PO': pov ? (pov.OT_PO_Number || '') : '',
    'Recent POV': formatPOVCell(pov),
    'Tracking': pov ? (pov.Tracking || '') : '',
    'Base Unit Price': excel.Base_Unit_Price,
    'Resale Price': excel.Resale_Price,
    'Historical Purchase Price': history.Historical_Purchase_Price || '',
    'OT Previous Supplier': history.OT_Previous_Supplier || '',
    'OT Buyer': pov && pov.Buyer ? pov.Buyer : (history.OT_Buyer || ''),
    'Historical Buyer': excel.Historical_Buyer || '',
    'Last Promise Date': pov && pov.POV_Date ? pov.POV_Date : (history.Last_Purchase_Date || ''),
    'PO Created Date': pov && pov.PO_Created_Date ? pov.PO_Created_Date : '',
    'Last Updated': pov && pov.Last_Updated ? pov.Last_Updated : '',
    'Last RFQ': history.RFQ_Number ? `${history.RFQ_Number} (${history.RFQ_Customer || ''})` : '',
    'Lead Time': excel.Lead_Time,
    'LAM MOQ': excel.MOQ,
  };
}

// If the MPN has recent in-flight purchase activity (gated by SQL: PO cut in last 90d
// OR promise date still ≥ today), the row is informational — split into:
//   - PENDING RECEIPT          → Infor POV stamp exists, waiting on shipment
//   - PENDING ORDER PLACEMENT  → PO cut but no Infor stamp yet
//   - VQ APPROVED - CHASE PO   → VQ ticked but no PO cut — procurement bottleneck
// Shortfall-based priority is retained when no recent activity exists.
function resolvePriority(shortfallBasedPriority, pov) {
  if (!pov) return shortfallBasedPriority;
  if (pov.POV_Number) return 'PENDING RECEIPT';
  if (pov.State === 'VQ_TICKED') return 'VQ TICKED - NEED PO';
  return 'PENDING ORDER PLACEMENT';
}

// When looking up recent POVs by both CPC and MPN, we may get different results.
// Prefer the one that represents a more committed state:
//   1. PO with POV stamp (PENDING RECEIPT) > PO without stamp (PENDING ORDER PLACEMENT)
//   2. PO (either) > VQ_TICKED (no PO cut yet)
// This handles cases where the PO's RFQ line had no CPC (keyed by MPN) but a newer
// VQ has CPC. We want to surface the committed PO, not the pending VQ.
function selectBetterPOV(pov1, pov2) {
  if (!pov1) return pov2;
  if (!pov2) return pov1;

  // Score: higher = more committed
  function score(pov) {
    if (pov.POV_Number) return 3;  // PO with POV stamp
    if (pov.State === 'PO') return 2;  // PO without stamp
    if (pov.State === 'VQ_TICKED') return 1;  // VQ only
    return 0;
  }

  const s1 = score(pov1);
  const s2 = score(pov2);

  if (s1 > s2) return pov1;
  if (s2 > s1) return pov2;

  // Same score - prefer the one with more qty on order
  if ((pov1.Qty_On_Order || 0) >= (pov2.Qty_On_Order || 0)) return pov1;
  return pov2;
}

function identifyReorderCandidates(aggregated, excelData, historicalData, recentPOVs = {}, pendingTransfers = new Map(), recentVQPricing = {}, recentPOVsRaw = null) {
  const alerts = [];
  const inventoryMPNs = new Set(Object.keys(aggregated));

  // Use raw POVs for Purchased MPN lookup (includes stale POVs that still have inventory)
  // Use filtered POVs for priority determination (stale POVs shouldn't show as PENDING RECEIPT)
  const povForMpnLookup = recentPOVsRaw || recentPOVs;

  // Build CPC -> total inventory by summing ALL approved MPNs from AVL
  // This handles cases where we have both original MPN and alternate(s) in stock
  const cpcTotalInventory = new Map();  // CPC -> { total, w111, w115, mpnsWithStock }
  const processedCPCs = new Set();

  // First pass: aggregate inventory by CPC using AVL + Purchased MPNs from POVs
  // We need to include Purchased MPNs because:
  // 1. A part may have been bought under a non-AVL MPN
  // 2. When that MPN arrives in inventory, it should still count for the CPC
  // IMPORTANT: Use RAW POVs (povForMpnLookup) here, not filtered POVs
  // This ensures inventory is counted even when the POV is stale (fix 2026-08-05)
  for (const [rosterMpn, excel] of Object.entries(excelData)) {
    const cpc = excel.CPC;
    if (!cpc || processedCPCs.has(cpc)) continue;
    processedCPCs.add(cpc);

    const approvedMPNs = getAllApprovedMPNs(cpc, rosterMpn);

    // Also include Purchased MPN from POV if different from roster/AVL
    // This handles cases where we bought a non-AVL MPN and it's now in inventory
    // Use raw POVs so stale POVs still contribute their Purchased MPN for inventory lookup
    const pov = povForMpnLookup[cpc] || povForMpnLookup[normalizeMPN(rosterMpn)];
    const purchasedMpn = pov?.Purchased_MPN;
    const mpnsToCheck = [...approvedMPNs];
    if (purchasedMpn && !approvedMPNs.some(m => normalizeMPN(m) === normalizeMPN(purchasedMpn))) {
      mpnsToCheck.push(purchasedMpn);
    }

    let totalQty = 0;
    let w111Qty = 0;
    let w115Qty = 0;
    const mpnsWithStock = [];

    for (const mpn of mpnsToCheck) {
      // Try both exact match and normalized match
      const inv = aggregated[mpn] || aggregated[normalizeMPN(mpn)];
      if (inv && inv.Total_Qty > 0) {
        totalQty += inv.Total_Qty;
        w111Qty += inv.W111_Qty || 0;
        w115Qty += inv.W115_Qty || 0;
        const isFromPurchase = purchasedMpn && normalizeMPN(mpn) === normalizeMPN(purchasedMpn) &&
                               !approvedMPNs.some(m => normalizeMPN(m) === normalizeMPN(purchasedMpn));
        mpnsWithStock.push({ mpn, qty: inv.Total_Qty, fromPurchase: isFromPurchase });
      }
    }

    cpcTotalInventory.set(cpc, { total: totalQty, w111: w111Qty, w115: w115Qty, mpnsWithStock, approvedMPNs, purchasedMpn });
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
    const hasThreshold = minQty !== undefined && minQty !== null && minQty !== '';
    const cpcInv = cpcTotalInventory.get(cpc) || { total: 0, w111: 0, w115: 0, mpnsWithStock: [] };
    const totalQty = cpcInv.total;

    // Check if below threshold OR zero stock with no threshold
    // Zero stock = CRITICAL regardless of threshold setting
    const belowThreshold = hasThreshold && totalQty < minQty;
    const zeroStockNoThreshold = !hasThreshold && totalQty === 0;

    if (belowThreshold || zeroStockNoThreshold) {
      const shortfall = hasThreshold ? (minQty - totalQty) : 0;
      const shortfallPct = hasThreshold && minQty > 0 ? (shortfall / minQty) * 100 : 0;

      // CRITICAL if zero stock across ALL approved MPNs
      let basePriority;
      if (totalQty === 0) {
        basePriority = 'CRITICAL';
      } else {
        basePriority = shortfallPct >= 75 ? 'HIGH' : shortfallPct >= 50 ? 'MEDIUM' : 'LOW';
      }

      // Look up POV by BOTH CPC and MPN, then prefer the better match.
      // Sometimes the PO's RFQ line has no CPC (keyed by MPN), while a newer
      // VQ has CPC. We want to prefer PO over VQ regardless of which key finds it.
      //
      // IMPORTANT: Use filtered POVs for priority (stale POVs shouldn't show PENDING RECEIPT)
      // but use raw POVs for Purchased MPN lookup (inventory may exist under Purchased MPN)
      const povByCpc = recentPOVs[cpc];
      const povByMpn = recentPOVs[normalizeMPN(rosterMpn)];
      const pov = selectBetterPOV(povByCpc, povByMpn);
      const priority = resolvePriority(basePriority, pov);
      const lamOwned = cpcInv.w115 > 0 ? 'YES' : 'NO';

      // For Purchased MPN validation, use raw POVs (includes stale POVs)
      // This ensures we can flag NOT ON AVL even when the POV is stale
      const rawPovByCpc = povForMpnLookup[cpc];
      const rawPovByMpn = povForMpnLookup[normalizeMPN(rosterMpn)];
      const povForMpnValidation = selectBetterPOV(rawPovByCpc, rawPovByMpn);

      const alert = buildAlert(rosterMpn, excel, totalQty, lamOwned, shortfall, priority,
        historicalData[normalizeMPN(rosterMpn)] || {}, povForMpnValidation);

      // Add note if stock is spread across multiple MPNs
      if (cpcInv.mpnsWithStock.length > 1) {
        const stockDetail = cpcInv.mpnsWithStock.map(m => `${m.mpn}:${m.qty}`).join(', ');
        alert['Stock Detail'] = stockDetail;
      }

      // Flag if no threshold is set (needs threshold from LAM)
      if (!hasThreshold) {
        alert['Needs Threshold'] = 'YES';
      }

      // Add recent VQ pricing (from Monday's full run)
      // Look up by CPC first (source of truth), then verify with MPN
      const vqByCpc = recentVQPricing.byCpc[cpc];
      const vqByMpn = recentVQPricing.byMpn[normalizeMPN(rosterMpn)];

      // Prefer CPC match; fall back to MPN match
      const vqPricing = vqByCpc || vqByMpn;
      if (vqPricing) {
        alert['Recent VQ Supplier'] = vqPricing.VQ_Supplier || '';
        const vqCost = parseFloat(vqPricing.VQ_Cost);
        alert['Recent VQ Price'] = isNaN(vqCost) ? '' : vqCost;
        alert['Recent VQ Date'] = vqPricing.VQ_Date || '';

        // Calculate VQ margin: (Resale - VQ Cost) / Resale * 100
        const resale = parseFloat(alert['Resale Price']);
        if (!isNaN(vqCost) && !isNaN(resale) && resale > 0) {
          const margin = ((resale - vqCost) / resale) * 100;
          alert['Recent VQ Margin %'] = margin.toFixed(1) + '%';
        } else {
          alert['Recent VQ Margin %'] = '';
        }

        // Flag if CPC and MPN lookups disagree (data quality check)
        if (vqByCpc && vqByMpn && vqByCpc.VQ_MPN !== vqByMpn.VQ_MPN) {
          alert['VQ MPN Mismatch'] = `CPC→${vqByCpc.VQ_MPN}, MPN→${vqByMpn.VQ_MPN}`;
        }
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
    // Use raw POV for MPN validation (includes stale POVs)
    const rawPov = povForMpnLookup[key];

    // Parts with no threshold: still include but flag appropriately
    if (excel.MIN_QTY <= 0) {
      // Zero stock + no threshold = flag as NO THRESHOLD unless there's recent activity
      const priority = pov ? resolvePriority('NO THRESHOLD', pov) : 'NO THRESHOLD';
      alerts.push(buildAlert(mpn, excel, 0, 'NO', 0, priority,
        historicalData[key] || {}, rawPov));
      continue;
    }

    const priority = resolvePriority('CRITICAL', pov);
    alerts.push(buildAlert(mpn, excel, 0, 'NO', excel.MIN_QTY, priority,
      historicalData[key] || {}, rawPov));
  }

  // Add PENDING WAREHOUSE TRANSFER items - confirmed transfers from pending-transfers.json
  // Human reviews wrong warehouse check output, confirms LAM stock, adds to pending-transfers.json
  // Auto-clears when part appears in W111/W115 inventory
  for (const [mpn, transfer] of pendingTransfers) {
    const cpc = transfer.cpc;

    // Check if this MPN/CPC is already on the alerts list
    const alreadyListed = alerts.some(a => a['MPN'] === mpn || a['Lam P/N'] === cpc);
    if (alreadyListed) {
      // Already on list - update priority to include transfer info if not already pending
      const existingAlert = alerts.find(a => a['MPN'] === mpn || a['Lam P/N'] === cpc);
      if (existingAlert && !existingAlert.Priority.includes('PENDING')) {
        existingAlert.Priority = `${existingAlert.Priority} + TRANSFER - ${transfer.qty} pcs from ${transfer.fromWh}`;
      }
      continue;
    }

    // Not on list yet - find the roster entry
    const excel = excelData[mpn];
    if (!excel) continue;

    const cpcInv = cpcTotalInventory.get(cpc) || { total: 0, w111: 0, w115: 0, mpnsWithStock: [] };

    // Format: "PENDING WAREHOUSE TRANSFER - 100 pcs from MAIN"
    const priority = `PENDING WAREHOUSE TRANSFER - ${transfer.qty} pcs from ${transfer.fromWh}`;

    // Use raw POV for MPN validation (includes stale POVs)
    const rawPovForTransfer = selectBetterPOV(povForMpnLookup[cpc], povForMpnLookup[normalizeMPN(mpn)]);
    const alert = buildAlert(mpn, excel, cpcInv.total, cpcInv.w115 > 0 ? 'YES' : 'NO',
      0, priority, historicalData[normalizeMPN(mpn)] || {}, rawPovForTransfer);

    alerts.push(alert);
  }

  // Sort: CRITICAL first (must source now), shortfall-based severity next,
  // then the PENDING bucket last (informational). Within the PENDING bucket,
  // PENDING ORDER PLACEMENT comes before PENDING RECEIPT — chasing an unplaced
  // PO is more actionable than waiting on a vendor that's already been ordered from.
  // PENDING WAREHOUSE TRANSFER is last (just tracking until transfer completes).
  const priorityOrder = {
    'CRITICAL': 0,
    'VQ TICKED - NEED PO': 0.5,  // Procurement bottleneck - VQ approved but no PO cut
    'HIGH': 1, 'MEDIUM': 2, 'LOW': 3,
    'NO THRESHOLD': 3.5,  // After LOW, before PENDING - need threshold from LAM
    'PENDING ORDER PLACEMENT': 4,
    'PENDING RECEIPT': 4,
    'PENDING WAREHOUSE TRANSFER': 5,  // Informational - tracking until transfer completes
  };

  // Helper to get priority order - handles dynamic priorities like "PENDING WAREHOUSE TRANSFER - 100 pcs"
  function getPriorityOrder(priority) {
    if (priorityOrder[priority] !== undefined) return priorityOrder[priority];
    // Check for prefix matches (e.g., "PENDING WAREHOUSE TRANSFER - 100 pcs from MAIN")
    if (priority.startsWith('PENDING WAREHOUSE TRANSFER')) return 5;
    if (priority.includes('+ TRANSFER')) return priorityOrder[priority.split(' + ')[0]] || 3;
    return 3; // Default to LOW-ish
  }

  // Within the PENDING bucket only, sub-order ORDER_PLACEMENT before RECEIPT.
  const pendingSubOrder = { 'PENDING ORDER PLACEMENT': 0, 'PENDING RECEIPT': 1 };
  function getPendingSubOrder(priority) {
    if (pendingSubOrder[priority] !== undefined) return pendingSubOrder[priority];
    if (priority.startsWith('PENDING WAREHOUSE TRANSFER')) return 2;
    return 99;
  }

  alerts.sort((a, b) => {
    const orderA = getPriorityOrder(a.Priority);
    const orderB = getPriorityOrder(b.Priority);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    const subA = getPendingSubOrder(a.Priority);
    const subB = getPendingSubOrder(b.Priority);
    if (subA !== subB) {
      return subA - subB;
    }
    return b.Shortfall - a.Shortfall;
  });

  return alerts;
}

// -----------------------------------------------------------------------------
// Find ALL NOT ON AVL items (regardless of reorder status)
// -----------------------------------------------------------------------------
// Scans all POVs with Purchased MPNs and checks if they're on the AVL.
// Returns items that need reconciliation - even if they have sufficient stock.
// These items won't appear on the reorder list but still need AVL reconciliation.

function findAllNotOnAvlItems(excelData, recentPOVsRaw, aggregated, existingAlerts) {
  const notOnAvlItems = [];
  const existingCPCs = new Set(existingAlerts.map(a => a['Lam P/N']));

  // Scan all roster items
  for (const [rosterMpn, excel] of Object.entries(excelData)) {
    const cpc = excel.CPC;
    if (!cpc) continue;

    // Skip if already on the reorder list (already checked)
    if (existingCPCs.has(cpc)) continue;

    // Look up POV for this CPC/MPN
    const pov = recentPOVsRaw[cpc] || recentPOVsRaw[normalizeMPN(rosterMpn)];
    if (!pov || !pov.Purchased_MPN) continue;

    // Check if Purchased MPN is NOT ON AVL
    const validation = validatePurchasedMPN(cpc, rosterMpn, pov.Purchased_MPN);
    if (validation.flag !== 'NOT ON AVL') continue;

    // Get current inventory for this CPC
    const approvedMpns = getAllApprovedMPNs(cpc, rosterMpn);
    let totalQty = 0;
    for (const mpn of approvedMpns) {
      const inv = aggregated[mpn] || aggregated[normalizeMPN(mpn)];
      if (inv) totalQty += inv.Total_Qty || 0;
    }
    // Also check Purchased MPN inventory
    const purchasedInv = aggregated[pov.Purchased_MPN] || aggregated[normalizeMPN(pov.Purchased_MPN)];
    if (purchasedInv) totalQty += purchasedInv.Total_Qty || 0;

    // Create a reconciliation entry
    notOnAvlItems.push({
      'Lam P/N': cpc,
      'MPN': rosterMpn,
      'Purchased MPN': pov.Purchased_MPN,
      'MPN Flag': 'NOT ON AVL',
      'Manufacturer': excel.Manufacturer || '',
      'Item Description': excel.Description || '',
      'QTY ON HAND': totalQty,
      'W115 Stale Inventory': '',
      'Reorder Threshold': excel.MIN_QTY || '',
      'Priority': totalQty > 0 ? 'HAS STOCK - RECONCILE AVL' : 'NO STOCK - RECONCILE AVL',
      'Shortfall': '',
      'POV Number': pov.POV_Number || '',
      'PO Status': pov.State || '',
      'Qty On Order': pov.Qty_On_Order || '',
      'Notes': `Purchased MPN "${pov.Purchased_MPN}" not on AVL for CPC ${cpc}. Roster MPN: ${rosterMpn}. Need to either add to AVL or reconcile with customer.`,
    });
  }

  return notOnAvlItems;
}

// -----------------------------------------------------------------------------
// Step 6: Write Output
// -----------------------------------------------------------------------------

function writeReorderAlerts(alerts, outputPath, additionalNotOnAvl = []) {
  // Uses ALERT_COLUMNS defined at module level — single source of truth
  const headers = ALERT_COLUMNS;

  // Count NOT ON AVL items for logging (they're handled via JSON sidecar, not separate tab here)
  // The runner builds the multi-tab Excel with all tabs including NOT ON AVL
  const notOnAvlFromReorder = alerts.filter(a => a['MPN Flag'] === 'NOT ON AVL');
  const notOnAvlCount = notOnAvlFromReorder.length + additionalNotOnAvl.length;

  // Always output CSV for runner/sourcing compatibility
  // NOT ON AVL items are written to JSON sidecar; runner builds the full multi-tab Excel
  console.log(`  Writing reorder alerts to CSV: ${path.basename(outputPath)}`);
  console.log(`    Total alerts: ${alerts.length} items`);
  if (notOnAvlCount > 0) {
    console.log(`    NOT ON AVL items: ${notOnAvlCount} (in JSON sidecar for runner)`);
  }

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
  return outputPath;
}

// -----------------------------------------------------------------------------
// Write Pending Approvals Excel File
// -----------------------------------------------------------------------------

const PENDING_APPROVAL_COLUMNS = [
  'CPC',
  'MPN',
  'Manufacturer',
  'Reason',           // Moved to column D per operator request 2026-07-17
  'Description',
  'Award',
  'Current Resale',
  'Proposed Resale',
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

  // Set column widths (order matches PENDING_APPROVAL_COLUMNS)
  ws['!cols'] = [
    { wch: 18 },  // CPC
    { wch: 25 },  // MPN
    { wch: 25 },  // Manufacturer
    { wch: 35 },  // Reason (moved to D)
    { wch: 35 },  // Description
    { wch: 8 },   // Award
    { wch: 14 },  // Current Resale
    { wch: 14 },  // Proposed Resale
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
// Exports (for use by lam-kitting.js handler)
// -----------------------------------------------------------------------------

module.exports = {
  loadHistoricalPurchaseData,
  loadRecentPOVs,
  formatPOVCell,
  buildAlert,
  ALERT_COLUMNS,
  writeReorderAlerts,
  // Exported for add_awards inventory checking
  loadChuboeInventory,
  aggregateInventory,
  W111_FILENAME,
  W115_FILENAME,
  loadAVL,
  // OT availability checking
  isOtAvailable,
  getOtErrorMessage,
  // Last inventory date tracking (POV staleness)
  loadLastInventoryDates,
  saveLastInventoryDates,
  updateLastInventoryDates,
  isPovStale,
  LAST_INVENTORY_DATE_FILE,
  // NOT ON AVL clearing mechanism
  clearNotOnAvlItem,
  isNotOnAvlCleared,
  listClearedNotOnAvl,
  loadNotOnAvlCleared,
  NOT_ON_AVL_CLEARED_FILE,
};

// -----------------------------------------------------------------------------
// Run (only when executed directly, not when required as module)
// -----------------------------------------------------------------------------

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
