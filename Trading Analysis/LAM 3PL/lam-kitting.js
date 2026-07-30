#!/usr/bin/env node
/**
 * LAM Kitting CLI - Modular Workflow
 *
 * Usage:
 *   node lam-kitting.js refresh [--send]     # Re-pull OT data, generate report (no APIs)
 *   node lam-kitting.js source [--send]      # Run franchise APIs on existing CSV
 *   node lam-kitting.js full [--send]        # refresh + source (weekly run)
 *   node lam-kitting.js excel [--send]       # Just rebuild xlsx from existing CSV
 *
 * Options:
 *   --send          Email the report after generating
 *   --date YYYY-MM-DD   Use specific date (default: today)
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const ROSTER_PATH = path.join(SCRIPT_DIR, 'LAM_Master_Roster.xlsx');

function getDateStamp(dateArg) {
  if (dateArg) return dateArg;
  return new Date().toISOString().split('T')[0];
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function runScript(scriptPath, args = [], opts = {}) {
  // Quote each argument to handle paths with spaces
  const quotedArgs = args.map(a => `"${a}"`).join(' ');
  const cmd = `node "${scriptPath}" ${quotedArgs}`;
  log(`Running: ${cmd}`);
  try {
    execSync(cmd, {
      stdio: 'inherit',
      cwd: SCRIPT_DIR,
      timeout: opts.timeout || 300000,
      shell: '/bin/bash'  // Use bash for proper quoting
    });
    return true;
  } catch (e) {
    log(`ERROR: Script failed - ${e.message}`);
    return false;
  }
}

// Extract stats from CSV for email context
function extractStats(csvPath) {
  const { readCSVFile } = require('../../shared/csv-utils');

  try {
    const csv = readCSVFile(csvPath);
    const priorityIdx = csv.headers.indexOf('Priority');

    if (priorityIdx === -1) return null;

    const stats = {
      total: csv.rows.length,
      critical: 0,
      pendingReceipt: 0,
      pendingOrder: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    for (const row of csv.rows) {
      const priority = (row[priorityIdx] || '').toUpperCase();
      if (priority === 'CRITICAL') stats.critical++;
      else if (priority === 'PENDING RECEIPT') stats.pendingReceipt++;
      else if (priority === 'PENDING ORDER PLACEMENT') stats.pendingOrder++;
      else if (priority === 'HIGH') stats.high++;
      else if (priority === 'MEDIUM') stats.medium++;
      else if (priority === 'LOW') stats.low++;
    }

    return stats;
  } catch (e) {
    log(`Warning: Could not extract stats - ${e.message}`);
    return null;
  }
}

// Step: Refresh - Re-pull OT data, generate CSV + xlsx (no APIs)
// If _sourced.csv exists, merge fresh OT data INTO it (preserving API pricing)
// Returns: { csvPath, additions: [], removals: [] }
async function stepRefresh(dateStamp) {
  log('=== STEP: REFRESH ===');
  log('Re-pulling data from OT (no APIs)...');

  const reorderScript = path.join(SCRIPT_DIR, 'lam-kitting-reorder.js');
  const csvPath = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}.csv`);
  const sourcedPath = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}_sourced.csv`);

  // Run reorder script to get fresh OT data
  const success = runScript(reorderScript, [ROSTER_PATH, '--no-email']);
  if (!success) {
    log('ERROR: Reorder step failed');
    return null;
  }

  // Check if OT was available during the refresh
  const { isOtAvailable, getOtErrorMessage } = require('./lam-kitting-reorder.js');
  if (!isOtAvailable()) {
    log('');
    log('ERROR: OT database was unavailable during refresh');
    log(`  ${getOtErrorMessage()}`);
    log('');
    log('Cannot proceed with stale data. Please retry later.');

    // Send notification about OT unavailability
    await sendOtUnavailableNotification(dateStamp, getOtErrorMessage());

    return null;  // Do NOT continue with stale data
  }

  if (!fs.existsSync(csvPath)) {
    log(`ERROR: Expected output not found: ${csvPath}`);
    return null;
  }

  // If sourced CSV exists, merge fresh OT data into it (preserving API pricing)
  if (fs.existsSync(sourcedPath)) {
    log('Merging fresh OT data into existing sourced file...');
    const mergeResult = mergeRefreshIntoSourced(csvPath, sourcedPath);
    if (mergeResult) {
      // Handle removals - must notify Jake + Josh
      if (mergeResult.removals && mergeResult.removals.length > 0) {
        log(`  WARNING: ${mergeResult.removals.length} CPC(s) removed from roster`);
        await sendRemovalNotification(mergeResult.removals, dateStamp);
      }

      // Log additions
      if (mergeResult.additions && mergeResult.additions.length > 0) {
        log(`  INFO: ${mergeResult.additions.length} new CPC(s) added from roster`);
      }

      return {
        csvPath: mergeResult.outputPath,
        additions: mergeResult.additions || [],
        removals: mergeResult.removals || []
      };
    }
  }

  log(`Reorder CSV: ${csvPath}`);
  return { csvPath, additions: [], removals: [] };
}

// Send removal notification to Jake + Josh (required before removing CPCs)
async function sendRemovalNotification(removedCpcs, dateStamp) {
  const { sendLamEmail } = require('./lam-email-templates');

  log('  Sending removal notification to Jake + Josh...');

  const cpcList = removedCpcs.map(cpc => `  - ${cpc}`).join('\n');

  await sendLamEmail('removal', {
    date: dateStamp,
    to: 'jake.harris@astutegroup.com,josh.syre@astutegroup.com',
    stats: { removed: removedCpcs.length },
    notes: `The following CPCs were in the previous output but are no longer in the roster:\n\n${cpcList}\n\nThese parts will be removed from future outputs. Please acknowledge.`
  });

  log('  Removal notification sent');
}

// Send OT unavailable notification - alerts that refresh failed
async function sendOtUnavailableNotification(dateStamp, errorMessage) {
  const { sendLamEmail } = require('./lam-email-templates');

  log('  Sending OT unavailable notification...');

  await sendLamEmail('otUnavailable', {
    date: dateStamp,
    to: 'jake.harris@astutegroup.com,josh.syre@astutegroup.com',
    notes: `The OT database was unavailable during the LAM Kitting refresh.\n\nError: ${errorMessage}\n\nThe workflow did NOT proceed with stale data. Please retry when OT is available.`
  });

  log('  OT unavailable notification sent');
}

// Merge fresh OT data (POV, tracking, priority) into existing sourced CSV
// Preserves API pricing columns from the sourced file
// Uses CPC (Lam P/N) as primary key, NOT MPN
// Returns: { outputPath, additions: [], removals: [] }
function mergeRefreshIntoSourced(freshCsvPath, sourcedCsvPath) {
  const { readCSVFile } = require('../../shared/csv-utils');

  try {
    const fresh = readCSVFile(freshCsvPath);
    const sourced = readCSVFile(sourcedCsvPath);

    // CPC is primary key (column: "Lam P/N")
    const freshCpcIdx = fresh.headers.indexOf('Lam P/N');
    const sourcedCpcIdx = sourced.headers.indexOf('Lam P/N');

    if (freshCpcIdx < 0 || sourcedCpcIdx < 0) {
      log('  ERROR: Lam P/N column not found');
      return null;
    }

    // Build lookup of fresh data by CPC
    const freshByCpc = {};
    for (const row of fresh.rows) {
      const cpc = row[freshCpcIdx];
      if (cpc) freshByCpc[cpc] = row;
    }

    // Build set of sourced CPCs for removal detection
    const sourcedCpcs = new Set();
    for (const row of sourced.rows) {
      const cpc = row[sourcedCpcIdx];
      if (cpc) sourcedCpcs.add(cpc);
    }

    // Columns to update from fresh data (OT-sourced columns)
    const otColumns = [
      'QTY ON HAND', 'W115 Stale Inventory', 'Shortfall', 'Priority',
      'On Order Qty', 'OT PO', 'Recent POV', 'Tracking',
      'Last Promise Date', 'PO Created Date', 'Last Updated',
      'Purchased MPN', 'MPN Flag'  // MPN validation from POV data
    ];

    // Get column indices in both files
    const freshColIdx = {};
    const sourcedColIdx = {};
    for (const col of otColumns) {
      freshColIdx[col] = fresh.headers.indexOf(col);
      sourcedColIdx[col] = sourced.headers.indexOf(col);
    }

    let updated = 0;
    const additions = [];  // CPCs in fresh but not in sourced
    const removals = [];   // CPCs in sourced but not in fresh

    // Update existing sourced rows with fresh OT data
    for (const row of sourced.rows) {
      const cpc = row[sourcedCpcIdx];
      const freshRow = freshByCpc[cpc];
      if (freshRow) {
        for (const col of otColumns) {
          if (freshColIdx[col] >= 0 && sourcedColIdx[col] >= 0) {
            row[sourcedColIdx[col]] = freshRow[freshColIdx[col]];
          }
        }
        updated++;
      } else if (cpc) {
        // CPC in sourced but not in fresh roster = removal candidate
        removals.push(cpc);
      }
    }

    // Detect additions: CPCs in fresh but not in sourced
    for (const cpc of Object.keys(freshByCpc)) {
      if (!sourcedCpcs.has(cpc)) {
        additions.push(cpc);
      }
    }

    // Add new rows for additions (with empty API columns)
    if (additions.length > 0) {
      log(`  Adding ${additions.length} new CPC(s) from roster`);
      for (const cpc of additions) {
        const freshRow = freshByCpc[cpc];
        // Create new row with sourced headers, copying fresh data where columns match
        const newRow = new Array(sourced.headers.length).fill('');
        for (let i = 0; i < sourced.headers.length; i++) {
          const col = sourced.headers[i];
          const freshIdx = fresh.headers.indexOf(col);
          if (freshIdx >= 0) {
            newRow[i] = freshRow[freshIdx];
          }
        }
        sourced.rows.push(newRow);
      }
    }

    // Log removals (will be handled by caller for notification)
    if (removals.length > 0) {
      log(`  Detected ${removals.length} CPC(s) removed from roster`);
    }

    // Remove rows for removed CPCs (after notification is sent by caller)
    // For now, mark them but don't remove - caller decides
    // TODO: Caller should send notification, then call removeFromOutput()

    // Write back to sourced file
    const csvContent = [
      sourced.headers.join(','),
      ...sourced.rows.map(r => r.map(v => {
        const s = String(v || '');
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
    ].join('\n');

    fs.writeFileSync(sourcedCsvPath, csvContent);
    log(`  Updated ${updated} rows with fresh OT data`);

    return {
      outputPath: sourcedCsvPath,
      additions: additions,
      removals: removals
    };
  } catch (e) {
    log(`  ERROR merging: ${e.message}`);
    return null;
  }
}

// Step: Excel - Rebuild xlsx from existing CSV
async function stepExcel(csvPath, dateStamp) {
  log('=== STEP: EXCEL ===');
  log('Rebuilding xlsx with formatting...');

  const { rebuildExcelWithRfqLines } = require('./lam-kitting-runner');
  const xlsxPath = csvPath.replace('.csv', '.xlsx');
  const rfqMappingPath = csvPath.replace('.csv', '_rfq_mapping.json');

  let rfqMapping = {};
  if (fs.existsSync(rfqMappingPath)) {
    rfqMapping = JSON.parse(fs.readFileSync(rfqMappingPath, 'utf8'));
  }

  await rebuildExcelWithRfqLines(csvPath, xlsxPath, rfqMapping, {});

  log(`Excel: ${xlsxPath}`);
  return xlsxPath;
}

// Step: Source - Run franchise APIs
async function stepSource(csvPath, dateStamp) {
  log('=== STEP: SOURCE ===');
  log('Running franchise APIs...');

  const sourceScript = path.join(SCRIPT_DIR, 'lam-kitting-source.js');
  const sourcedCsv = csvPath.replace('.csv', '_sourced.csv');

  const success = runScript(sourceScript, [csvPath], { timeout: 600000 });
  if (!success) {
    log('ERROR: Sourcing step failed');
    return null;
  }

  if (!fs.existsSync(sourcedCsv)) {
    log(`ERROR: Expected output not found: ${sourcedCsv}`);
    return null;
  }

  log(`Sourced CSV: ${sourcedCsv}`);
  return sourcedCsv;
}

// Build audit trail for email
function buildAuditTrail(dateStamp) {
  const auditTrail = {
    otPullTimestamp: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT'
  };

  // Get inventory cache date
  try {
    const { getCacheStatus } = require('../../shared/inventory-fetch-and-parse');
    const cacheStatus = getCacheStatus();
    if (cacheStatus && cacheStatus.parsedDate) {
      auditTrail.inventoryDate = cacheStatus.parsedDate;
      // Calculate age in days
      const cacheDate = new Date(cacheStatus.parsedDate);
      const now = new Date();
      auditTrail.inventoryAgeDays = Math.floor((now - cacheDate) / (1000 * 60 * 60 * 24));
    }
  } catch (e) {
    log(`  Warning: Could not get inventory cache status: ${e.message}`);
  }

  // Get API cache date (last modified time of sourced CSV)
  const sourcedPath = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}_sourced.csv`);
  if (fs.existsSync(sourcedPath)) {
    const stats = fs.statSync(sourcedPath);
    auditTrail.apiCacheDate = stats.mtime.toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT';
  }

  return auditTrail;
}

// Validate data before sending - returns { valid: boolean, warnings: string[] }
function validateBeforeSend(csvPath, xlsxPath, auditTrail, stats) {
  const warnings = [];

  // 1. Check inventory cache age (should be ≤7 days)
  if (auditTrail.inventoryAgeDays && auditTrail.inventoryAgeDays > 7) {
    warnings.push(`Inventory cache is ${auditTrail.inventoryAgeDays} days old (max 7 days)`);
  }

  // 2. Check row count is reasonable (not 0)
  if (!stats || stats.total === 0) {
    warnings.push('Output has 0 rows - this may indicate a data issue');
  }

  // 3. Verify CSV and XLSX both exist
  if (!fs.existsSync(csvPath)) {
    warnings.push(`CSV file not found: ${csvPath}`);
  }
  if (!fs.existsSync(xlsxPath)) {
    warnings.push(`XLSX file not found: ${xlsxPath}`);
  }

  // 4. Verify stats were extracted from the correct file
  // (stats should match what's in the CSV)
  if (fs.existsSync(csvPath)) {
    const { readCSVFile } = require('../../shared/csv-utils');
    try {
      const csv = readCSVFile(csvPath);
      if (stats && stats.total !== undefined && stats.total !== csv.rows.length) {
        warnings.push(`Stats mismatch: email says ${stats.total} rows, CSV has ${csv.rows.length} rows`);
      }
    } catch (e) {
      warnings.push(`Could not verify CSV row count: ${e.message}`);
    }
  }

  // Log warnings
  if (warnings.length > 0) {
    log('');
    log('=== VALIDATION WARNINGS ===');
    warnings.forEach(w => log(`  - ${w}`));
    log('');
  }

  return {
    valid: warnings.length === 0,
    warnings: warnings
  };
}

// Step: Send - Email the report
async function stepSend(xlsxPath, dateStamp, command, stats, auditTrail) {
  log('=== STEP: SEND ===');
  log('Sending email...');

  const { sendLamEmail } = require('./lam-email-templates');

  // Only include Josh on automated full runs
  // Partials/one-offs go to Jake only
  const isFullRun = command === 'full';
  const to = isFullRun
    ? 'jake.harris@astutegroup.com,josh.syre@astutegroup.com'
    : 'jake.harris@astutegroup.com';

  const result = await sendLamEmail('reorder', {
    date: dateStamp,
    mode: command,
    stats: stats,
    to: to,
    auditTrail: auditTrail,
    attachments: [{ filename: path.basename(xlsxPath), path: xlsxPath }]
  });

  log(`Email sent to: ${result.to}`);
  return true;
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const sendFlag = args.includes('--send');

  let dateArg = null;
  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1 && args[dateIdx + 1]) {
    dateArg = args[dateIdx + 1];
  }

  const dateStamp = getDateStamp(dateArg);

  log('============================================================');
  log('LAM KITTING CLI');
  log('============================================================');
  log(`Command: ${command || '(none)'}`);
  log(`Date: ${dateStamp}`);
  log(`Send: ${sendFlag}`);
  log('');

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Usage:
  node lam-kitting.js refresh [--send]     Re-pull OT data, generate report (no APIs)
  node lam-kitting.js source [--send]      Run franchise APIs on existing CSV
  node lam-kitting.js full [--send]        refresh + source (weekly run)
  node lam-kitting.js excel [--send]       Just rebuild xlsx from existing CSV

Options:
  --send              Email the report after generating
  --date YYYY-MM-DD   Use specific date (default: today)
`);
    process.exit(0);
  }

  let csvPath = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}.csv`);
  let xlsxPath = null;

  let refreshResult = null;  // Track additions/removals from refresh

  try {
    switch (command) {
      case 'refresh':
        // Re-pull OT data, generate CSV, build xlsx
        refreshResult = await stepRefresh(dateStamp);
        if (!refreshResult || !refreshResult.csvPath) process.exit(1);
        csvPath = refreshResult.csvPath;
        xlsxPath = await stepExcel(csvPath, dateStamp);
        break;

      case 'source':
        // Run APIs on existing CSV
        if (!fs.existsSync(csvPath)) {
          log(`ERROR: No CSV found for ${dateStamp}. Run 'refresh' first.`);
          process.exit(1);
        }
        const sourcedCsv = await stepSource(csvPath, dateStamp);
        if (!sourcedCsv) process.exit(1);
        xlsxPath = sourcedCsv.replace('.csv', '.xlsx');
        break;

      case 'excel':
        // Just rebuild xlsx from existing CSV
        // ALWAYS prefer _sourced.csv if it exists (has API pricing data)
        const sourcedPathExcel = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}_sourced.csv`);

        if (fs.existsSync(sourcedPathExcel)) {
          csvPath = sourcedPathExcel;
          log(`Using sourced CSV (has API pricing data)`);
        } else if (!fs.existsSync(csvPath)) {
          log(`ERROR: No CSV found for ${dateStamp}. Run 'refresh' first.`);
          process.exit(1);
        } else {
          log(`Using base CSV (no sourced file found - API pricing will be missing)`);
        }

        xlsxPath = await stepExcel(csvPath, dateStamp);
        break;

      case 'full':
        // Full run: refresh + source
        refreshResult = await stepRefresh(dateStamp);
        if (!refreshResult || !refreshResult.csvPath) process.exit(1);
        csvPath = refreshResult.csvPath;
        const sourced = await stepSource(csvPath, dateStamp);
        if (!sourced) process.exit(1);
        xlsxPath = sourced.replace('.csv', '.xlsx');
        // Update csvPath to sourced for stats extraction
        csvPath = sourced;
        break;

      default:
        log(`ERROR: Unknown command '${command}'`);
        log("Run 'node lam-kitting.js --help' for usage.");
        process.exit(1);
    }

    if (sendFlag && xlsxPath && fs.existsSync(xlsxPath)) {
      // Extract stats from the CSV used to generate the xlsx
      const stats = extractStats(csvPath);
      // Build audit trail for traceability
      const auditTrail = buildAuditTrail(dateStamp);

      // Validate before sending
      const validation = validateBeforeSend(csvPath, xlsxPath, auditTrail, stats);

      if (!validation.valid) {
        log('');
        log('VALIDATION FAILED - Email will still be sent but review warnings above.');
        log('');
        // Note: We still send but with warnings visible in the log
        // Future enhancement: --strict flag to block send on validation failure
      }

      await stepSend(xlsxPath, dateStamp, command, stats, auditTrail);
    }

    log('');
    log('=== DONE ===');
    if (xlsxPath) log(`Output: ${xlsxPath}`);

  } catch (e) {
    log(`ERROR: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
}

main();
