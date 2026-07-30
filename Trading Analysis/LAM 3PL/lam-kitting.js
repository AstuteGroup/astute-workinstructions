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
async function stepRefresh(dateStamp) {
  log('=== STEP: REFRESH ===');
  log('Re-pulling data from OT (no APIs)...');

  const reorderScript = path.join(SCRIPT_DIR, 'lam-kitting-reorder.js');
  const csvPath = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}.csv`);

  // Run reorder script
  const success = runScript(reorderScript, [ROSTER_PATH, '--no-email']);
  if (!success) {
    log('ERROR: Reorder step failed');
    return null;
  }

  if (!fs.existsSync(csvPath)) {
    log(`ERROR: Expected output not found: ${csvPath}`);
    return null;
  }

  log(`Reorder CSV: ${csvPath}`);
  return csvPath;
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

// Step: Send - Email the report
async function stepSend(xlsxPath, dateStamp, command, stats) {
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

  try {
    switch (command) {
      case 'refresh':
        // Re-pull OT data, generate CSV, build xlsx
        csvPath = await stepRefresh(dateStamp);
        if (!csvPath) process.exit(1);
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
        const sourcedPath = path.join(OUTPUT_DIR, `LAM_Reorder_Alerts_${dateStamp}_sourced.csv`);
        if (fs.existsSync(sourcedPath)) {
          csvPath = sourcedPath;
        } else if (!fs.existsSync(csvPath)) {
          log(`ERROR: No CSV found for ${dateStamp}. Run 'refresh' first.`);
          process.exit(1);
        }
        xlsxPath = await stepExcel(csvPath, dateStamp);
        break;

      case 'full':
        // Full run: refresh + source
        csvPath = await stepRefresh(dateStamp);
        if (!csvPath) process.exit(1);
        const sourced = await stepSource(csvPath, dateStamp);
        if (!sourced) process.exit(1);
        xlsxPath = sourced.replace('.csv', '.xlsx');
        break;

      default:
        log(`ERROR: Unknown command '${command}'`);
        log("Run 'node lam-kitting.js --help' for usage.");
        process.exit(1);
    }

    if (sendFlag && xlsxPath && fs.existsSync(xlsxPath)) {
      // Extract stats from the CSV used to generate the xlsx
      const stats = extractStats(csvPath);
      await stepSend(xlsxPath, dateStamp, command, stats);
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
