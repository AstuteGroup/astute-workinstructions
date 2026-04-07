#!/usr/bin/env node
/**
 * LAM Kitting Reorder Runner (Cron)
 *
 * Chains: Inventory Cleanup → Reorder Alerts → Franchise Sourcing → Email
 * Scheduled: Mondays at 12:00 PM (after Inventory Cleanup at 11:00 AM)
 *
 * Sends ONE email with the final sourced report (_sourced.xlsx).
 *
 * Usage:
 *   node lam-kitting-runner.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createNotifier } = require('../../shared/notifier');

const SCRIPT_DIR = __dirname;
const INVENTORY_CLEANUP_DIR = path.join(SCRIPT_DIR, '../Inventory File Cleanup');
const EXCEL_PATTERN = /^Lam_Kitting_DB.*\.xlsx$/;

const EMAIL_ACCOUNT = 'excess';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: `${EMAIL_ACCOUNT}@orangetsunami.com`,
  fromName: 'LAM Kitting Reorder'
});

function getDateStamp() {
  return new Date().toISOString().split('T')[0];
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sendEmail(to, subject, body, attachmentPaths = []) {
  log(`  Sending email to ${to}: ${subject}`);
  const attachments = attachmentPaths
    .filter(p => fs.existsSync(p))
    .map(p => ({ filename: path.basename(p), path: p }));

  if (attachments.length > 0) {
    return await notifier.sendWithAttachment(to, subject, body, attachments);
  }
  return await notifier.sendEmail(to, subject, body);
}

async function main() {
  log('============================================================');
  log('LAM KITTING REORDER - AUTOMATED RUN');
  log('============================================================');

  // Step 1: Find today's inventory output folder
  const dateStr = getDateStamp();
  const inventoryFolder = path.join('/tmp', `Inventory ${dateStr}`);

  log(`Step 1: Looking for inventory folder: ${inventoryFolder}`);

  if (!fs.existsSync(inventoryFolder)) {
    // Inventory cleanup hasn't run yet today — run it
    log('  Inventory folder not found. Running Inventory Cleanup first...');
    try {
      const result = execSync(
        `node "${path.join(INVENTORY_CLEANUP_DIR, 'inventory_cleanup.js')}" fetch`,
        { encoding: 'utf-8', timeout: 300000 }
      );
      console.log(result);
    } catch (err) {
      log(`  ERROR: Inventory Cleanup failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Verify inventory folder exists now
  if (!fs.existsSync(inventoryFolder)) {
    log('  ERROR: Inventory folder still not found after cleanup. Exiting.');
    process.exit(1);
  }

  // Verify required files exist
  const w111File = path.join(inventoryFolder, 'W111_LAM_3PL.csv');
  if (!fs.existsSync(w111File)) {
    log(`  WARNING: ${w111File} not found — W111 may have been named differently`);
  }
  log(`  Inventory folder found: ${inventoryFolder}`);

  // Step 2: Find the latest Kitting DB Excel file
  log('Step 2: Finding latest Kitting DB Excel...');
  const excelFiles = fs.readdirSync(SCRIPT_DIR)
    .filter(f => EXCEL_PATTERN.test(f))
    .sort()
    .reverse();

  if (excelFiles.length === 0) {
    log('  ERROR: No Lam_Kitting_DB*.xlsx found. Exiting.');
    process.exit(1);
  }

  const excelFile = path.join(SCRIPT_DIR, excelFiles[0]);
  log(`  Using: ${excelFiles[0]}`);

  // Step 3: Run reorder detection (--no-email: we'll email the final sourced report instead)
  log('Step 3: Running reorder detection...');
  try {
    const result = execSync(
      `node "${path.join(SCRIPT_DIR, 'lam-kitting-reorder.js')}" "${inventoryFolder}" "${excelFile}" --no-email`,
      { encoding: 'utf-8', timeout: 120000 }
    );
    console.log(result);
  } catch (err) {
    log(`  ERROR: Reorder detection failed: ${err.message}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }

  // Step 4: Run franchise sourcing
  const alertsFile = path.join(SCRIPT_DIR, 'output', `LAM_Reorder_Alerts_${dateStr}.csv`);

  if (!fs.existsSync(alertsFile)) {
    log(`  WARNING: Alerts file not found at ${alertsFile}. Skipping sourcing.`);
    return;
  }

  log('Step 4: Running franchise sourcing...');
  try {
    const result = execSync(
      `node "${path.join(SCRIPT_DIR, 'lam-kitting-source.js')}" "${alertsFile}"`,
      { encoding: 'utf-8', timeout: 600000 }
    );
    console.log(result);
  } catch (err) {
    log(`  ERROR: Sourcing failed: ${err.message}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    // Fall through — email whatever we have
  }

  // Step 5: Email the final sourced report
  log('Step 5: Emailing sourced report...');
  const sourcedXlsx = alertsFile.replace('.csv', '_sourced.xlsx');
  const sourcedCsv = alertsFile.replace('.csv', '_sourced.csv');

  // Prefer xlsx, fall back to csv, fall back to unsourced alerts
  let attachment;
  let attachmentLabel;
  if (fs.existsSync(sourcedXlsx)) {
    attachment = sourcedXlsx;
    attachmentLabel = 'sourced Excel (with color-coded margins)';
  } else if (fs.existsSync(sourcedCsv)) {
    attachment = sourcedCsv;
    attachmentLabel = 'sourced CSV';
  } else {
    attachment = alertsFile;
    attachmentLabel = 'unsourced alerts (sourcing failed)';
  }

  // Read alerts file to get priority counts
  const alertsContent = fs.readFileSync(alertsFile, 'utf-8');
  const lines = alertsContent.split('\n').filter(l => l.trim());
  const totalAlerts = lines.length - 1; // minus header
  const critCount = lines.filter(l => l.includes('CRITICAL')).length;
  const highCount = lines.filter(l => /,HIGH[,\s]*$/i.test(l) || l.includes(',HIGH,')).length;
  const medCount = lines.filter(l => l.includes('MEDIUM')).length;
  const lowCount = lines.filter(l => /,LOW[,\s]*$/i.test(l) || l.includes(',LOW,')).length;

  const emailBody = `LAM Kitting Reorder - Sourced Report ${dateStr}

${totalAlerts} items below threshold:
- CRITICAL (zero stock): ${critCount}
- HIGH: ${highCount}
- MEDIUM: ${medCount}
- LOW: ${lowCount}

Attached: ${attachmentLabel}
Inventory source: Inventory ${dateStr}
Kitting DB: ${path.basename(excelFile)}`;

  await sendEmail(
    NOTIFY_EMAIL,
    `LAM Kitting Reorder - Sourced ${dateStr}`,
    emailBody,
    [attachment]
  );

  log('============================================================');
  log('LAM KITTING REORDER - COMPLETE');
  log('============================================================');
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
