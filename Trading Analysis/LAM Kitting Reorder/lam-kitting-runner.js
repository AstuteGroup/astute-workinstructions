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

const ESCALATIONS_STATE_FILE = path.join(SCRIPT_DIR, 'lam-escalations.json');

function loadEscalationsState() {
  if (!fs.existsSync(ESCALATIONS_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(ESCALATIONS_STATE_FILE, 'utf-8'));
  } catch (err) {
    log(`  WARNING: could not parse ${ESCALATIONS_STATE_FILE}: ${err.message}`);
    return null;
  }
}

// Drop entries whose MPN no longer appears on the weekly reorder list — implicit
// resolution (inventory came back above threshold, Kitting DB was updated, etc.).
// Writes the trimmed state back in place so next week starts clean.
function persistResolvedEscalations(state, csv, mpnIdx) {
  const currentMPNs = new Set(csv.rows.map(r => (r[mpnIdx] || '').trim()));
  const before = state.entries.length;
  const stillActive = state.entries.filter(e => currentMPNs.has(e.mpn));
  const resolved = state.entries.filter(e => !currentMPNs.has(e.mpn));
  if (resolved.length === 0) return;
  const updated = { ...state, entries: stillActive };
  fs.writeFileSync(ESCALATIONS_STATE_FILE, JSON.stringify(updated, null, 2) + '\n');
  log(`  Auto-resolved ${resolved.length} escalation(s) (no longer on reorder list): ${resolved.map(e => e.mpn).join(', ')}`);
  log(`  Remaining open escalations: ${stillActive.length} (was ${before})`);
}

// Column classification — shared between the main tab and the Escalations tab.
const CURRENCY_COLS = ['Base Unit Price', 'Resale Price', 'Historical Purchase Price', 'In Stock Price', 'Lead Time Price'];
const INT_COLS = ['Reorder Threshold', 'LAM MOQ', 'QTY ON HAND', 'Shortfall', 'In Stock Qty', 'On Order Qty', 'Available Qty (Other WH)', 'RFQ Line #'];
const PCT_COLS = ['In Stock Margin %', 'Lead Time Margin %'];

function getMarginColor(margin) {
  if (margin > 18) return 'FF90EE90';
  if (margin >= 0) return 'FFFFFF99';
  return 'FFFF9999';
}

// Coerce a CSV value to the Excel-ready type for its column. Numeric columns
// parse to numbers; percentage columns strip the '%' and divide by 100 so Excel's
// '0.0%' format renders correctly. Non-numeric cells pass through as strings.
function parseCellForExcel(v, header) {
  if (CURRENCY_COLS.includes(header) || INT_COLS.includes(header)) {
    const n = parseFloat(v); return isNaN(n) ? v : n;
  }
  if (PCT_COLS.includes(header)) {
    const n = parseFloat(String(v).replace('%', ''));
    return isNaN(n) ? v : n / 100;
  }
  return v;
}

// Color-coding applied consistently to the main tab AND the Escalations tab.
// Margin cells get traffic-light shading, Sourcing Status gets state colors,
// and Priority gets severity colors. Column positions are computed from the
// sheet's own headers array so the same helper works on both tabs (Escalations
// has a 2-column offset for Escalation Reason + Escalation Date).
function applyRowShading(excelRow, headers) {
  const inStockMarginCol = headers.indexOf('In Stock Margin %') + 1;
  const leadTimeMarginCol = headers.indexOf('Lead Time Margin %') + 1;
  const statusCol = headers.indexOf('Sourcing Status') + 1;
  const priorityCol = headers.indexOf('Priority') + 1;

  if (inStockMarginCol > 0) {
    const cell = excelRow.getCell(inStockMarginCol);
    if (typeof cell.value === 'number') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: getMarginColor(cell.value * 100) } };
    }
  }
  if (leadTimeMarginCol > 0) {
    const cell = excelRow.getCell(leadTimeMarginCol);
    if (typeof cell.value === 'number') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: getMarginColor(cell.value * 100) } };
    }
  }
  if (statusCol > 0) {
    const cell = excelRow.getCell(statusCol);
    if (cell.value === 'SKIPPED - TIMEOUT/ERROR') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
      cell.font = { bold: true };
    } else if (typeof cell.value === 'string' && cell.value.startsWith('RESTRICTED')) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      cell.font = { bold: true };
    } else if (cell.value === 'NO COVERAGE') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD580' } };
      cell.font = { bold: true };
    }
  }
  if (priorityCol > 0) {
    const cell = excelRow.getCell(priorityCol);
    if (cell.value === 'CRITICAL') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
      cell.font = { bold: true };
    } else if (cell.value === 'PENDING RECEIPT') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5F4E6' } };
    } else if (cell.value === 'HIGH') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    }
  }
}

// Apply column widths + number formats to a worksheet given its headers array.
// Shared so both tabs get the same visual treatment (number formatting was
// previously duplicated between buildEscalationsTab and rebuildExcelWithRfqLines).
function applyColumnFormats(sheet, headers) {
  headers.forEach((h, i) => {
    const col = sheet.getColumn(i + 1);
    if (h === 'Escalation Reason') col.width = 60;
    else if (h === 'Escalation Date') col.width = 14;
    else if (h === 'Item Description') col.width = 45;
    else if (h === 'Manufacturer' || h.includes('Supplier')) col.width = 25;
    else if (h === 'MPN' || h === 'Lam P/N') col.width = 25;
    else if (h === 'Recent POV') col.width = 55;
    else if (h === 'Priority') col.width = 18;
    else if (h.includes('Margin') || h === 'Sourcing Status') col.width = 18;
    else if (h === 'RFQ Line #') col.width = 12;
    else if (h === 'Request to Purchase') col.width = 18;
    else col.width = 18;
    if (CURRENCY_COLS.includes(h)) col.numFmt = '$#,##0.0000';
    else if (INT_COLS.includes(h)) col.numFmt = '#,##0';
    else if (PCT_COLS.includes(h)) col.numFmt = '0.0%';
  });
}

// Build the Escalations worksheet — one row per open escalation entry, populated
// from this week's reorder-alert data keyed by MPN. Columns A/B carry the
// buyer-supplied Escalation Reason and Escalation Date; the rest mirrors the
// main tab so the buyer has full context in one view. Escalated rows are REMOVED
// from the main tab (see rebuildExcelWithRfqLines) so each item lives in exactly
// one place — keeps the main tab focused on actionable buys.
function buildEscalationsTab(workbook, state, csv, allHeaders, rfqMapping) {
  const mpnIdx = csv.headers.indexOf('MPN');
  const autoRequests = (rfqMapping && rfqMapping.autoRequests) || {};
  // Build lookup: MPN → CSV row (with RFQ Line # + Request to Purchase spliced in
  // at columns 2-3 to match the main tab's column layout)
  const byMpn = {};
  for (const row of csv.rows) {
    const mpn = (row[mpnIdx] || '').trim();
    if (!mpn) continue;
    const rowData = [...row];
    rowData.splice(1, 0, rfqMapping.lines[mpn] || '', autoRequests[mpn] || '');
    byMpn[mpn] = rowData;
  }

  const escHeaders = ['Escalation Reason', 'Escalation Date', ...allHeaders];
  const ws = workbook.addWorksheet('Escalations');
  ws.addRow(escHeaders);
  const hdr = ws.getRow(1);
  hdr.font = { bold: true };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };

  for (const entry of state.entries) {
    const rowData = byMpn[entry.mpn];
    if (!rowData) continue; // defensive — auto-resolved by the caller
    const excelRowData = [entry.reason || '', entry.date || '',
      ...rowData.map((v, idx) => parseCellForExcel(v, allHeaders[idx]))];
    const excelRow = ws.addRow(excelRowData);
    applyRowShading(excelRow, escHeaders);
  }

  applyColumnFormats(ws, escHeaders);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/**
 * Rebuild the sourced Excel with an "RFQ Line #" column and RFQ search key.
 * Items with on-order/recent POV get blank RFQ Line (they were skipped).
 */
async function rebuildExcelWithRfqLines(sourcedCsvPath, xlsxPath, rfqMapping) {
  const ExcelJS = require('exceljs');
  const csv = readCSVFile(sourcedCsvPath);
  const mpnIdx = csv.headers.indexOf('MPN');

  // Insert "RFQ Line #" + "Request to Purchase" as columns 2 and 3 (after Lam P/N).
  // Request to Purchase is populated only for auto-approved lines (in-stock margin
  // >= 18% AND stock >= LAM MOQ); blank for manual-review lines.
  const allHeaders = [...csv.headers];
  allHeaders.splice(1, 0, 'RFQ Line #', 'Request to Purchase');
  const autoRequests = (rfqMapping && rfqMapping.autoRequests) || {};

  // Load escalations FIRST so main-tab rendering can skip escalated MPNs.
  // Each item lives in exactly one place — if it's flagged for escalation,
  // it moves to the Escalations tab and disappears from the main list.
  const escalationsState = loadEscalationsState();
  const escalatedMPNs = new Set(
    (escalationsState && escalationsState.entries) ? escalationsState.entries.map(e => e.mpn) : []
  );

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Sourced Reorder Alerts');

  // Header row
  ws.addRow(allHeaders);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  let skippedForEscalation = 0;
  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const mpn = (row[mpnIdx] || '').trim();
    if (escalatedMPNs.has(mpn)) { skippedForEscalation++; continue; }

    const rfqLine = rfqMapping.lines[mpn] || '';
    const reqDocNo = autoRequests[mpn] || '';
    const rowData = [...row];
    rowData.splice(1, 0, rfqLine, reqDocNo);
    const excelRowData = rowData.map((v, idx) => parseCellForExcel(v, allHeaders[idx]));
    const excelRow = ws.addRow(excelRowData);
    applyRowShading(excelRow, allHeaders);
  }
  if (skippedForEscalation > 0) {
    log(`  Moved ${skippedForEscalation} row(s) to Escalations tab — hidden from main tab for clarity`);
  }

  applyColumnFormats(ws, allHeaders);
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Escalations tab — state-file driven. Manual review surface: items the buyer
  // has flagged for deeper investigation (price approvals, vendor changes, etc.)
  // carried forward week-over-week until the MPN drops off the reorder list.
  if (escalationsState && escalationsState.entries && escalationsState.entries.length > 0) {
    buildEscalationsTab(workbook, escalationsState, csv, allHeaders, rfqMapping);
    // Auto-resolve: drop entries whose MPN is no longer on the reorder list.
    persistResolvedEscalations(escalationsState, csv, mpnIdx);
  }

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

  let rfqWriteFailed = false;
  let rfqWriteError = null;
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
      // Email still goes out so the buyer sees the sourced report, but
      // mark the run as failed so cron-runner doesn't advance the sentinel.
      // Next hourly tick will retry once OT is back.
      rfqWriteFailed = true;
      rfqWriteError = err.message;
    }
  } else {
    log('Step 4b: Skipping RFQ write — sourced CSV or franchise data not found.');
  }

  // Step 5: Rebuild the sourced Excel with RFQ line numbers, then email
  log('Step 5: Preparing and emailing sourced report...');
  const defaultSourcedXlsx = alertsFile.replace('.csv', '_sourced.xlsx');
  let sourcedXlsx = defaultSourcedXlsx;

  // If we have an RFQ mapping, rebuild the Excel with the RFQ Line # column AND
  // bake the RFQ number into the filename so the buyer can grep their inbox /
  // Downloads folder by RFQ. Also clean up the plain _sourced.xlsx that
  // lam-kitting-source.js wrote so there's only one file on disk per run.
  if (rfqMapping && rfqMapping.rfqSearchKey && fs.existsSync(sourcedCsv)) {
    sourcedXlsx = alertsFile.replace('.csv', `_RFQ${rfqMapping.rfqSearchKey}_sourced.xlsx`);
    try {
      await rebuildExcelWithRfqLines(sourcedCsv, sourcedXlsx, rfqMapping);
      log(`  Excel rebuilt with RFQ line numbers → ${path.basename(sourcedXlsx)}`);
      if (fs.existsSync(defaultSourcedXlsx) && defaultSourcedXlsx !== sourcedXlsx) {
        fs.unlinkSync(defaultSourcedXlsx);
      }
    } catch (err) {
      log(`  WARNING: Could not rebuild Excel with RFQ lines: ${err.message}`);
      // Fall back to the plain file the source script left behind.
      sourcedXlsx = defaultSourcedXlsx;
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
  // and count RESTRICTED lines separately (those are working-as-designed, not failures).
  let notSourcedCount = 0;
  let sourcedCount = 0;
  let restrictedCount = 0;
  if (fs.existsSync(sourcedCsv)) {
    const sourcedContent = fs.readFileSync(sourcedCsv, 'utf-8');
    const sourcedLines = sourcedContent.split('\n').filter(l => l.trim());
    notSourcedCount = sourcedLines.filter(l => l.includes('SKIPPED - TIMEOUT/ERROR')).length;
    restrictedCount = sourcedLines.filter(l => l.includes(',RESTRICTED - ')).length;
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

  const autoCount = rfqMapping && rfqMapping.autoRequests
    ? Object.keys(rfqMapping.autoRequests).length : 0;
  const rfqSection = rfqMapping && rfqMapping.rfqSearchKey
    ? `\nRFQ Created: ${rfqMapping.rfqSearchKey} (3PL/VMI)\n  ${rfqMapping.linesWritten} lines written, ${rfqMapping.vqItems} items with VQ data\n  Contact: Rob Johnson | Salesrep: Josh Syre\n  Auto-approved (margin ≥ 18% + stock ≥ LAM MOQ): ${autoCount}\n`
    : '';

  // Escalation summary — reflects state AFTER this run's auto-resolution pass.
  let escalationSection = '';
  try {
    const escState = loadEscalationsState();
    const openCount = escState?.entries?.length || 0;
    if (openCount > 0) {
      escalationSection = `\nOpen Escalations: ${openCount} — see the "Escalations" tab in the attached xlsx.\n`;
    }
  } catch (_) { /* non-fatal */ }

  const emailSubject = rfqWriteFailed
    ? `❌ LAM Kitting Reorder - RFQ WRITE FAILED ${dateStr}`
    : isPartial
    ? `⚠️ LAM Kitting Reorder - PARTIAL Sourced ${dateStr}`
    : `LAM Kitting Reorder - Sourced ${dateStr}`;
  const rfqFailWarning = rfqWriteFailed
    ? `\n❌ RFQ WRITE FAILED — no RFQs/VQs created in OT this run.\n   Cause: ${rfqWriteError}\n   The cron-runner will retry on the next hourly tick once OT is healthy.\n`
    : '';

  const restrictedSection = restrictedCount > 0
    ? `\nRestricted MFRs (franchise pricing hidden, manual sourcing required): ${restrictedCount}\n`
    : '';

  const emailBody = `LAM Kitting Reorder - Sourced Report ${dateStr}
${rfqFailWarning}${partialWarning}${rfqSection}${escalationSection}${restrictedSection}
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
  if (rfqWriteFailed) {
    log('LAM KITTING REORDER - FAILED (RFQ write step)');
    log('============================================================');
    process.exitCode = 1;
  } else {
    log('LAM KITTING REORDER - COMPLETE');
    log('============================================================');
  }
}

// Run main() only when invoked directly (`node lam-kitting-runner.js`).
// Requiring this module from a test driver or one-off script exposes the
// helper functions without triggering the full cron flow.
if (require.main === module) {
  main().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  rebuildExcelWithRfqLines,
  buildEscalationsTab,
  loadEscalationsState,
  persistResolvedEscalations,
  applyRowShading,
  applyColumnFormats,
  parseCellForExcel,
};
