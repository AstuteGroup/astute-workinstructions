#!/usr/bin/env node
/**
 * LAM Kitting Reorder Runner (Cron)
 *
 * Chains: Inventory Cleanup → Reorder Alerts → Franchise Sourcing → RFQ+VQ Write → Email
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
const { readCSVFile } = require('../../shared/csv-utils');

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

/**
 * Rebuild the sourced Excel with an "RFQ Line #" column and RFQ search key.
 * Items with on-order/recent POV get blank RFQ Line (they were skipped).
 */
async function rebuildExcelWithRfqLines(sourcedCsvPath, xlsxPath, rfqMapping) {
  const ExcelJS = require('exceljs');
  const csv = readCSVFile(sourcedCsvPath);
  const mpnIdx = csv.headers.indexOf('MPN');

  // Insert "RFQ Line #" as the second column (after Lam P/N, before MPN)
  const allHeaders = [...csv.headers];
  allHeaders.splice(1, 0, 'RFQ Line #');

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Sourced Reorder Alerts');

  // Header row
  ws.addRow(allHeaders);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  // Margin color helper
  function getMarginColor(margin) {
    if (margin > 18) return 'FF90EE90';
    if (margin >= 0) return 'FFFFFF99';
    return 'FFFF9999';
  }

  const inStockMarginCol = allHeaders.indexOf('In Stock Margin %') + 1;
  const leadTimeMarginCol = allHeaders.indexOf('Lead Time Margin %') + 1;
  const statusCol = allHeaders.indexOf('Sourcing Status') + 1;

  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const mpn = row[mpnIdx];
    const rfqLine = rfqMapping.lines[mpn] || '';

    // Insert RFQ line # as second column
    const rowData = [...row];
    rowData.splice(1, 0, rfqLine);

    // Parse numeric values
    const excelRowData = rowData.map((v, idx) => {
      const h = allHeaders[idx];
      if (['Base Unit Price', 'Resale Price', 'Historical Purchase Price', 'In Stock Price', 'Lead Time Price'].includes(h)) {
        const n = parseFloat(v); return isNaN(n) ? v : n;
      }
      if (['Reorder Threshold', 'MOQ', 'QTY ON HAND', 'Shortfall', 'In Stock Qty', 'On Order Qty', 'Available Qty (Other WH)', 'RFQ Line #'].includes(h)) {
        const n = parseFloat(v); return isNaN(n) ? v : n;
      }
      if (['In Stock Margin %', 'Lead Time Margin %'].includes(h)) {
        // CSV has values like "63.8%" — parse to decimal for Excel
        const s = String(v).replace('%', '');
        const n = parseFloat(s);
        return isNaN(n) ? v : n / 100;
      }
      return v;
    });

    const excelRow = ws.addRow(excelRowData);

    // Margin coloring
    if (inStockMarginCol > 0) {
      const cell = excelRow.getCell(inStockMarginCol);
      const val = typeof cell.value === 'number' ? cell.value * 100 : null;
      if (val !== null) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: getMarginColor(val) } };
      }
    }
    if (leadTimeMarginCol > 0) {
      const cell = excelRow.getCell(leadTimeMarginCol);
      const val = typeof cell.value === 'number' ? cell.value * 100 : null;
      if (val !== null) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: getMarginColor(val) } };
      }
    }

    // Sourcing Status highlighting (matches lam-kitting-source.js):
    //   SKIPPED - TIMEOUT/ERROR → red;  NO COVERAGE → orange;  SOURCED → no fill
    if (statusCol > 0) {
      const cell = excelRow.getCell(statusCol);
      if (cell.value === 'SKIPPED - TIMEOUT/ERROR') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
        cell.font = { bold: true };
      } else if (cell.value === 'NO COVERAGE') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD580' } };
        cell.font = { bold: true };
      }
    }
  }

  // Number formats
  const currencyCols = ['Base Unit Price', 'Resale Price', 'Historical Purchase Price', 'In Stock Price', 'Lead Time Price'];
  const intCols = ['Reorder Threshold', 'MOQ', 'QTY ON HAND', 'Shortfall', 'In Stock Qty', 'On Order Qty', 'Available Qty (Other WH)', 'RFQ Line #'];
  const pctCols = ['In Stock Margin %', 'Lead Time Margin %'];

  allHeaders.forEach((h, idx) => {
    const colNum = idx + 1;
    if (currencyCols.includes(h)) ws.getColumn(colNum).numFmt = '$#,##0.0000';
    else if (intCols.includes(h)) ws.getColumn(colNum).numFmt = '#,##0';
    else if (pctCols.includes(h)) ws.getColumn(colNum).numFmt = '0.0%';
  });

  // Column widths
  ws.columns.forEach((col, idx) => {
    const h = allHeaders[idx];
    if (h === 'Item Description') col.width = 45;
    else if (h === 'Manufacturer' || h.includes('Supplier')) col.width = 25;
    else if (h === 'MPN' || h === 'Lam P/N') col.width = 25;
    else if (h.includes('Margin') || h === 'Sourcing Status') col.width = 18;
    else if (h === 'RFQ Line #') col.width = 12;
    else col.width = 18;
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  await workbook.xlsx.writeFile(xlsxPath);
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
  let sourcingFailed = false;
  try {
    const result = execSync(
      `node "${path.join(SCRIPT_DIR, 'lam-kitting-source.js')}" "${alertsFile}"`,
      { encoding: 'utf-8', timeout: 1200000 }  // 20 minutes
    );
    console.log(result);
  } catch (err) {
    log(`  ERROR: Sourcing failed: ${err.message}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    sourcingFailed = true;
    // Fall through — the source script writes partial results on SIGTERM
  }

  // Step 4b: Write RFQ + VQ lines for items without on-order
  const sourcedCsv = alertsFile.replace('.csv', '_sourced.csv');
  const franchiseJson = alertsFile.replace('.csv', '_sourced_franchise_data.json');
  const rfqMappingFile = alertsFile.replace('.csv', '_rfq_mapping.json');
  let rfqMapping = null;

  if (fs.existsSync(sourcedCsv) && fs.existsSync(franchiseJson)) {
    log('Step 4b: Writing RFQ + VQ lines for items without on-order...');
    try {
      const result = execSync(
        `node "${path.join(SCRIPT_DIR, 'lam-kitting-rfq-writer.js')}" "${sourcedCsv}" "${franchiseJson}"`,
        { encoding: 'utf-8', timeout: 300000 }  // 5 minutes
      );
      console.log(result);
      // Load the mapping for the email
      if (fs.existsSync(rfqMappingFile)) {
        rfqMapping = JSON.parse(fs.readFileSync(rfqMappingFile, 'utf-8'));
      }
    } catch (err) {
      log(`  ERROR: RFQ writing failed: ${err.message}`);
      if (err.stdout) console.log(err.stdout);
      if (err.stderr) console.error(err.stderr);
      // Non-fatal — email still goes out with sourced report
    }
  } else {
    log('Step 4b: Skipping RFQ write — sourced CSV or franchise data not found.');
  }

  // Step 5: Rebuild the sourced Excel with RFQ line numbers, then email
  log('Step 5: Preparing and emailing sourced report...');
  const sourcedXlsx = alertsFile.replace('.csv', '_sourced.xlsx');

  // If we have an RFQ mapping, rebuild the Excel with RFQ Line # column
  if (rfqMapping && rfqMapping.rfqSearchKey && fs.existsSync(sourcedCsv)) {
    try {
      await rebuildExcelWithRfqLines(sourcedCsv, sourcedXlsx, rfqMapping);
      log(`  Excel rebuilt with RFQ line numbers (RFQ ${rfqMapping.rfqSearchKey})`);
    } catch (err) {
      log(`  WARNING: Could not rebuild Excel with RFQ lines: ${err.message}`);
    }
  }

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
    attachmentLabel = 'unsourced alerts (sourcing failed entirely)';
  }

  // Detect partial sourcing — check the sourced CSV for SKIPPED - TIMEOUT/ERROR lines
  let notSourcedCount = 0;
  let sourcedCount = 0;
  if (fs.existsSync(sourcedCsv)) {
    const sourcedContent = fs.readFileSync(sourcedCsv, 'utf-8');
    const sourcedLines = sourcedContent.split('\n').filter(l => l.trim());
    notSourcedCount = sourcedLines.filter(l => l.includes('SKIPPED - TIMEOUT/ERROR')).length;
    sourcedCount = sourcedLines.length - 1 - notSourcedCount; // minus header
  }
  const isPartial = notSourcedCount > 0;

  // Read alerts file to get priority counts
  const alertsContent = fs.readFileSync(alertsFile, 'utf-8');
  const lines = alertsContent.split('\n').filter(l => l.trim());
  const totalAlerts = lines.length - 1; // minus header
  const critCount = lines.filter(l => l.includes(',CRITICAL,')).length;
  const highCount = lines.filter(l => /,HIGH[,\s]*$/i.test(l) || l.includes(',HIGH,')).length;
  const medCount = lines.filter(l => l.includes(',MEDIUM,')).length;
  const lowCount = lines.filter(l => /,LOW[,\s]*$/i.test(l) || l.includes(',LOW,')).length;
  const pendingCount = lines.filter(l => l.includes(',PENDING RECEIPT,')).length;

  const partialWarning = isPartial
    ? `\n⚠️  PARTIAL SOURCING: ${sourcedCount}/${totalAlerts} items were sourced. ${notSourcedCount} items marked "SKIPPED - TIMEOUT/ERROR" in the file (highlighted red). These items were not processed due to a timeout or error — re-run manually if needed.\n`
    : '';

  const rfqSection = rfqMapping && rfqMapping.rfqSearchKey
    ? `\nRFQ Created: ${rfqMapping.rfqSearchKey} (3PL/VMI)\n  ${rfqMapping.linesWritten} lines written, ${rfqMapping.vqItems} items with VQ data\n  Contact: Rob Johnson | Salesrep: Josh Syre\n`
    : '';

  const emailSubject = isPartial
    ? `⚠️ LAM Kitting Reorder - PARTIAL Sourced ${dateStr}`
    : `LAM Kitting Reorder - Sourced ${dateStr}`;

  const emailBody = `LAM Kitting Reorder - Sourced Report ${dateStr}
${partialWarning}${rfqSection}
${totalAlerts} items below threshold:
- CRITICAL (zero stock, no recent PO): ${critCount}
- HIGH: ${highCount}
- MEDIUM: ${medCount}
- LOW: ${lowCount}
- PENDING RECEIPT (recent PO in flight, informational): ${pendingCount}

Attached: ${attachmentLabel}
Inventory source: Inventory ${dateStr}
Kitting DB: ${path.basename(excelFile)}`;

  await sendEmail(
    NOTIFY_EMAIL,
    emailSubject,
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
