#!/usr/bin/env node
/**
 * LAM 3PL Reorder Runner (Cron)
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
const restrictedMfr = require('../../shared/restricted-mfrs');

const SCRIPT_DIR = __dirname;
const INVENTORY_CLEANUP_DIR = path.join(SCRIPT_DIR, '../Inventory File Cleanup');
const MASTER_ROSTER_FILE = 'LAM_Master_Roster.xlsx';

const EMAIL_ACCOUNT = 'lamkitting';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: `${EMAIL_ACCOUNT}@orangetsunami.com`,
  fromName: 'LAM 3PL'
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

// Sidecar written by lam-kitting-reorder.js. Contains current inventory + POV
// state for every manual-escalation MPN regardless of whether they're below
// threshold. Used to synthesize Escalations rows for above-threshold-with-stock
// MPNs (Josh action: contract resale renegotiation still pending).
function loadEscalationsContext(sourcedCsvPath) {
  const ctxPath = sourcedCsvPath.replace('_sourced.csv', '.csv').replace('.csv', '_escalations_context.json');
  if (!fs.existsSync(ctxPath)) {
    log(`  WARNING: no escalations context file at ${ctxPath}`);
    return { entries: [] };
  }
  try { return JSON.parse(fs.readFileSync(ctxPath, 'utf-8')); }
  catch (err) {
    log(`  WARNING: could not parse ${ctxPath}: ${err.message}`);
    return { entries: [] };
  }
}

// Resolve manual entries — drop only when BOTH conditions hold:
//   1. MPN is no longer on the weekly reorder list (above threshold), AND
//   2. There's no W111+W115 stock currently on hand
// "Stock arrived" entries (above threshold, qty > 0) are KEPT — their lifecycle
// is operator-controlled (Jake removes from JSON when LAM approves new resale
// pricing). Stock presence alone doesn't imply approval — we may have eaten
// the margin compression to keep the line moving while contract is renegotiated.
function persistResolvedEscalations(state, csv, mpnIdx, escalationsContext) {
  const currentMPNs = new Set(csv.rows.map(r => (r[mpnIdx] || '').trim()));
  const ctxByMpn = {};
  for (const e of (escalationsContext && escalationsContext.entries) || []) {
    ctxByMpn[e.mpn] = e;
  }
  const before = state.entries.length;
  const isResolvable = e => {
    if (currentMPNs.has(e.mpn)) return false;            // still on reorder list — keep
    const ctx = ctxByMpn[e.mpn];
    if (ctx && ctx.stock && ctx.stock.total > 0) return false; // stock arrived — keep
    return true;
  };
  const stillActive = state.entries.filter(e => !isResolvable(e));
  const resolved = state.entries.filter(isResolvable);
  if (resolved.length === 0) return;
  const updated = { ...state, entries: stillActive };
  fs.writeFileSync(ESCALATIONS_STATE_FILE, JSON.stringify(updated, null, 2) + '\n');
  log(`  Auto-resolved ${resolved.length} escalation(s) (off reorder list, zero stock): ${resolved.map(e => e.mpn).join(', ')}`);
  log(`  Remaining open escalations: ${stillActive.length} (was ${before})`);
}

// Auto-escalation pass for restricted-MFR margin compression.
// LAM contract resale is anchored on disty (franchise) pricing — when franchise
// pricing rises so margin against current contract resale falls below 18%, the
// seller (Josh) needs to push a new resale to LAM. We surface that signal here.
//
// The check is deliberately INDEPENDENT of broker corroboration: brokers may
// supply at much better margins (often the actual procurement path for
// restricted MFRs via Tracy direct), but the contractual anchor stays on
// franchise pricing. Stock-arrived signals on these escalations come through
// the manual flow (this auto-pass only writes ephemeral entries; the buyer
// promotes one to lam-escalations.json once they're tracking it.)
//
// Skips:
//   - non-restricted MFRs (handled by normal margin/auto-purchase flow)
//   - MPNs already in lam-escalations.json (manual reason takes precedence)
//
// Returns array of { mpn, reason, date, auto: true, kind: 'renegotiate'|'no_route' }.
function computeAutoEscalations(csv, sourcedCsvPath, escalationsState, dateStamp) {
  const franchiseDataPath = sourcedCsvPath.replace('_sourced.csv', '_sourced_franchise_data.json');
  if (!fs.existsSync(franchiseDataPath)) {
    log(`  WARNING: no franchise data at ${path.basename(franchiseDataPath)} — skipping auto-escalations`);
    return [];
  }
  let franchiseData;
  try { franchiseData = JSON.parse(fs.readFileSync(franchiseDataPath, 'utf-8')); }
  catch (err) { log(`  WARNING: could not parse franchise data: ${err.message}`); return []; }

  const manualMpns = new Set(((escalationsState && escalationsState.entries) || []).map(e => e.mpn));
  const idx = h => csv.headers.indexOf(h);
  const iMpn = idx('MPN');
  const iMfr = idx('Manufacturer');
  const iResale = idx('Resale Price');
  const iMoq = idx('LAM MOQ');

  const auto = [];
  for (const row of csv.rows) {
    const mpn = (row[iMpn] || '').trim();
    const mfrName = (row[iMfr] || '').trim();
    if (!mpn || !mfrName) continue;
    if (!restrictedMfr.isRestrictedMfr({ mfrName })) continue;
    if (manualMpns.has(mpn)) continue;  // manual entry takes precedence — no override

    const resale = parseFloat(row[iResale]) || 0;
    const moq = parseFloat(row[iMoq]) || 0;
    if (resale <= 0) continue;  // can't compute margin without a resale

    const fr = franchiseData[mpn];
    const summary = fr && fr.summary;
    const refPrice = summary && (summary.lowestStockedPrice || summary.lowestPrice);

    if (!refPrice || refPrice <= 0) {
      auto.push({
        mpn, auto: true, kind: 'no_route', date: dateStamp,
        reason: `[AUTO] Restricted MFR (${mfrName}) — no franchise route this run. ` +
          `APIs returned no usable pricing. Escalate to direct supplier (Tracy / authorized non-franchise channel).`,
      });
      continue;
    }

    const margin = (resale - refPrice) / resale;
    if (margin < 0.18) {
      // Pull the supplier name from the matching distributor entry, falling
      // back to whichever distributor is listed first.
      let supplier = 'best franchise';
      if (Array.isArray(fr.found) && fr.found.length > 0) {
        const match = fr.found.find(d => Math.abs((d.franchisePrice || d.vqPrice || 0) - refPrice) < 1e-6);
        supplier = (match && match.bpName) || fr.found[0].bpName || supplier;
      }
      auto.push({
        mpn, auto: true, kind: 'renegotiate', date: dateStamp,
        reason: `[AUTO] Restricted MFR (${mfrName}) — franchise ref @ LAM MOQ ${moq || 'n/a'} = ` +
          `$${refPrice.toFixed(4)} (${supplier}) → margin ${(margin * 100).toFixed(1)}% vs current ` +
          `LAM resale $${resale.toFixed(4)}. Push new LAM resale based on franchise ref.`,
      });
    }
    // margin >= 18% on a restricted MFR → no signal; LAM contract still works,
    // procurement happens through broker (Tracy) separately. No auto entry.
  }
  return auto;
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
    } else if (cell.value === 'PENDING RECEIPT' || cell.value === 'PENDING ORDER PLACEMENT') {
      // Same shade for both — the bucket should read as one visual group;
      // the Priority text itself distinguishes the two states.
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5F4E6' } };
    } else if (cell.value === 'STOCK ARRIVED') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCE5FF' } };
      cell.font = { bold: true };
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
function buildEscalationsTab(workbook, state, csv, allHeaders, rfqMapping, escalationsContext, autoEntries) {
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
  // Sidecar context — used to synthesize rows for above-threshold-with-stock
  // MPNs that wouldn't otherwise appear in the CSV.
  const ctxByMpn = {};
  for (const e of (escalationsContext && escalationsContext.entries) || []) {
    ctxByMpn[e.mpn] = e;
  }

  const escHeaders = ['Escalation Reason', 'Escalation Date', ...allHeaders];
  const ws = workbook.addWorksheet('Escalations');
  ws.addRow(escHeaders);
  const hdr = ws.getRow(1);
  hdr.font = { bold: true };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };

  let stockArrivedCount = 0;
  // Block 1 — manual entries (with stock-arrived synthesis when off list).
  for (const entry of state.entries) {
    const reason = entry.reason || '';
    const ctx = ctxByMpn[entry.mpn];
    let rowData = byMpn[entry.mpn];
    let renderReason = reason;

    if (!rowData) {
      // MPN not on this week's reorder CSV. Synthesize a row from the sidecar
      // context if there's stock on hand (Josh-action-pending case).
      if (ctx && ctx.stockArrived) {
        rowData = synthesizeRowFromContext(ctx, allHeaders);
        renderReason = (reason ? reason + '\n' : '') +
          `✓ Stock arrived (W111+W115: ${ctx.stock.total} pcs). Action with seller — new LAM resale still pending.`;
        stockArrivedCount++;
      } else {
        continue; // truly resolved (off list + zero stock); persistResolvedEscalations will drop
      }
    }

    const excelRowData = [renderReason, entry.date || '',
      ...rowData.map((v, idx) => parseCellForExcel(v, allHeaders[idx]))];
    const excelRow = ws.addRow(excelRowData);
    applyRowShading(excelRow, escHeaders);
    if (ctx && ctx.stockArrived) {
      // Highlight the synthesized rows so Josh can scan for them quickly.
      excelRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCE5FF' } };
    }
  }
  if (stockArrivedCount > 0) {
    log(`  Escalations tab: ${stockArrivedCount} synthesized "stock arrived" row(s) for resale-pending follow-up`);
  }

  // Block 2 — auto entries (restricted-MFR margin compression). Always live
  // ABOVE main-tab MPNs in the CSV, so byMpn lookup always succeeds for these.
  const auto = Array.isArray(autoEntries) ? autoEntries : [];
  let autoRendered = 0;
  for (const entry of auto) {
    const rowData = byMpn[entry.mpn];
    if (!rowData) continue; // defensive
    const excelRowData = [entry.reason || '', entry.date || '',
      ...rowData.map((v, idx) => parseCellForExcel(v, allHeaders[idx]))];
    const excelRow = ws.addRow(excelRowData);
    applyRowShading(excelRow, escHeaders);
    // Tint the reason cell amber so auto entries are visually distinct from
    // manual ones (manual = uncolored, stock-arrived = light blue, auto = amber).
    excelRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
    autoRendered++;
  }
  if (autoRendered > 0) {
    log(`  Escalations tab: ${autoRendered} auto entry row(s) (restricted-MFR margin compression)`);
  }

  applyColumnFormats(ws, escHeaders);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// Build the Pending Approval worksheet — shows parts from the Master Roster
// where the "Pending" column is non-empty (e.g., "Price Approval", "Removal").
// This tab surfaces contract changes that need LAM sign-off.
function buildPendingApprovalTab(workbook, pendingApprovalsPath) {
  if (!fs.existsSync(pendingApprovalsPath)) return 0;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(pendingApprovalsPath, 'utf-8'));
  } catch (err) {
    log(`  WARNING: Could not parse pending approvals sidecar: ${err.message}`);
    return 0;
  }

  const items = data.items || [];
  if (items.length === 0) return 0;

  const ws = workbook.addWorksheet('Pending Approval');

  const headers = ['MPN', 'CPC', 'Manufacturer', 'Award', 'Current Resale', 'Proposed Resale', 'Pending', 'Last Approved'];
  ws.addRow(headers);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };  // Amber for attention

  for (const item of items) {
    ws.addRow([
      item.MPN || '',
      item.CPC || '',
      item.Manufacturer || '',
      item.Award || '',
      item['Current Resale'] || '',
      item['Proposed Resale'] || '',
      item['Pending'] || '',
      item['Last Approved'] || '',
    ]);
  }

  // Column widths
  ws.getColumn(1).width = 25;  // MPN
  ws.getColumn(2).width = 20;  // CPC
  ws.getColumn(3).width = 25;  // Manufacturer
  ws.getColumn(4).width = 18;  // Award
  ws.getColumn(5).width = 14;  // Current Resale
  ws.getColumn(5).numFmt = '$#,##0.0000';
  ws.getColumn(6).width = 14;  // Proposed Resale
  ws.getColumn(6).numFmt = '$#,##0.0000';
  ws.getColumn(7).width = 18;  // Pending
  ws.getColumn(8).width = 14;  // Last Approved

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  return items.length;
}

// Build an alert-style row from a sidecar context entry — used when an
// escalation MPN is no longer on the reorder list (above threshold) but still
// has stock on hand. Mirrors the columns from ALERT_COLUMNS so the row layout
// matches the rest of the Escalations tab.
function synthesizeRowFromContext(ctx, allHeaders) {
  const stock = ctx.stock || {};
  const povCell = ctx.pov && (ctx.pov.POV_Number || ctx.pov.OT_PO_Number)
    ? `${ctx.pov.POV_Number || 'OT ' + ctx.pov.OT_PO_Number} (${ctx.pov.POV_Date || ''}, ${ctx.pov.POV_Qty || ''} pcs from ${ctx.pov.POV_Supplier || ''})`
    : '';
  const valueByHeader = {
    'RFQ Line #': '', 'Request to Purchase': '',
    'Lam P/N': ctx.lamPN || '',
    'MPN': ctx.mpn,
    'Manufacturer': ctx.mfr || '',
    'Item Description': ctx.itemDescription || '',
    'QTY ON HAND': stock.total || 0,
    'Lam Owned Inventory?': (stock.w115 > 0) ? 'YES' : 'NO',
    'Reorder Threshold': ctx.threshold || '',
    'Shortfall': '', // above threshold — no shortfall to report
    'Priority': 'STOCK ARRIVED',
    'On Order Qty': ctx.pov ? (ctx.pov.Qty_On_Order || '') : '',
    'Recent POV': povCell,
    'Last Promise Date': '',
    'Last RFQ': '',
    'Base Unit Price': ctx.basePrice || '',
    'Resale Price': ctx.resalePrice || '',
    'Historical Purchase Price': '',
    'OT Previous Supplier': ctx.historicalSupplier || '',
    'OT Buyer': '',
    'Historical Buyer': '',
    'Lead Time': ctx.leadTime || '',
    'LAM MOQ': ctx.lamMoq || '',
    'Available Stock (Other WH)': '',
    'Available Qty (Other WH)': '',
    'Sourcing Status': '', // not sourced (above threshold, skipped)
    'In Stock Supplier': '', 'In Stock Price': '', 'In Stock Qty': '', 'In Stock Margin %': '',
    'Lead Time Supplier': '', 'Lead Time Price': '', 'Lead Time (Weeks)': '', 'Lead Time Margin %': '',
  };
  return allHeaders.map(h => valueByHeader[h] !== undefined ? valueByHeader[h] : '');
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
  const escalationsContext = loadEscalationsContext(sourcedCsvPath);
  // Auto-escalation pass: restricted-MFR margin compression. These rows also
  // belong on Escalations only — pull their MPNs into the main-tab skip set.
  const dateStamp = (path.basename(sourcedCsvPath).match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
  const autoEntries = computeAutoEscalations(csv, sourcedCsvPath, escalationsState, dateStamp);
  const escalatedMPNs = new Set(
    (escalationsState && escalationsState.entries) ? escalationsState.entries.map(e => e.mpn) : []
  );
  for (const e of autoEntries) escalatedMPNs.add(e.mpn);

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

  // Escalations tab — driven by three sources:
  //   1. Manual entries in lam-escalations.json (buyer-curated)
  //   2. Stock-arrived synthesis from sidecar context (resale renegotiation
  //      still owed by Josh after PO landed)
  //   3. Auto entries: restricted-MFR margin compression detected this run
  // Render whenever any of those produce content.
  const stateForRender = (escalationsState && escalationsState.entries) ? escalationsState : { entries: [] };
  if (stateForRender.entries.length > 0 || autoEntries.length > 0) {
    buildEscalationsTab(workbook, stateForRender, csv, allHeaders, rfqMapping, escalationsContext, autoEntries);
    // Auto-resolve manual entries: drop only when off reorder list AND zero stock.
    if (stateForRender.entries.length > 0) {
      persistResolvedEscalations(escalationsState, csv, mpnIdx, escalationsContext);
    }
  }

  // Pending Approval tab — parts from Master Roster with non-empty "Pending"
  // column (e.g., "Price Approval", "Removal"). Shows contract changes
  // awaiting LAM sign-off.
  const pendingApprovalsPath = sourcedCsvPath.replace('_sourced.csv', '_pending_approvals.json');
  const pendingCount = buildPendingApprovalTab(workbook, pendingApprovalsPath);
  if (pendingCount > 0) {
    log(`  Pending Approval tab: ${pendingCount} items awaiting LAM approval`);
  }

  await workbook.xlsx.writeFile(xlsxPath);
}

async function main() {
  log('============================================================');
  log('LAM KITTING REORDER - AUTOMATED RUN');
  log('============================================================');

  const dateStr = getDateStamp();
  const inventoryFolder = path.join('/tmp', `Inventory ${dateStr}`);

  // Step 1: Find today's inventory output folder
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

  // Step 2: Verify Master Roster exists
  log('Step 2: Checking for Master Roster...');
  const masterRosterPath = path.join(SCRIPT_DIR, MASTER_ROSTER_FILE);

  if (!fs.existsSync(masterRosterPath)) {
    log(`  ERROR: ${MASTER_ROSTER_FILE} not found. Run scripts/build-lam-master-roster.js first.`);
    process.exit(1);
  }

  const excelFile = masterRosterPath;
  log(`  Using: ${MASTER_ROSTER_FILE}`);

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

  // Step 4c: Refresh customer-facing LAM Kitting Inventory market offer.
  // Powers the LAM customer BI dashboard (queries by offer type 1000025 +
  // isactive='Y'). Roster-driven from Kitting DB INVENTORY sheet — every
  // program part appears with current qty (zero-stock parts included for
  // full visibility). See lam-kitting-customer-offer.js header for details.
  // Isolated try/catch — a failure here logs + surfaces in the email body
  // but does NOT block the buyer email or fail the runner.
  let customerOfferResult = null;
  let customerOfferError = null;
  log('Step 4c: Refreshing customer-facing LAM Kitting Inventory offer...');
  try {
    const customerOfferArgs = [
      `"${path.join(SCRIPT_DIR, 'lam-kitting-customer-offer.js')}"`,
      `"${inventoryFolder}"`,
      `"${excelFile}"`,
    ];
    if (fs.existsSync(sourcedCsv)) {
      customerOfferArgs.push('--sourced-csv', `"${sourcedCsv}"`);
    } else {
      customerOfferArgs.push('--no-fresh-lt');
    }
    const result = execSync(`node ${customerOfferArgs.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 600000, // 10 min — 945 line POSTs at ~200ms each = ~3 min, plus deactivation
    });
    console.log(result);
    // Pull the sidecar JSON for status reporting in the email
    const sidecar = path.join(SCRIPT_DIR, 'output', `LAM_Customer_Offer_${dateStr}.json`);
    if (fs.existsSync(sidecar)) {
      customerOfferResult = JSON.parse(fs.readFileSync(sidecar, 'utf-8'));
    }
  } catch (err) {
    log(`  WARNING: Customer offer refresh failed: ${err.message}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    customerOfferError = err.message;
    // Continue — buyer email still goes out
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
  const pendingOrderCount = lines.filter(l => l.includes(',PENDING ORDER PLACEMENT,')).length;
  const pendingReceiptCount = lines.filter(l => l.includes(',PENDING RECEIPT,')).length;

  const partialWarning = isPartial
    ? `\n⚠️  PARTIAL SOURCING: ${sourcedCount}/${totalAlerts} items were sourced. ${notSourcedCount} items marked "SKIPPED - TIMEOUT/ERROR" in the file (highlighted red). These items were not processed due to a timeout or error — re-run manually if needed.\n`
    : '';

  const autoCount = rfqMapping && rfqMapping.autoRequests
    ? Object.keys(rfqMapping.autoRequests).length : 0;
  const rfqSection = rfqMapping && rfqMapping.rfqSearchKey
    ? `\nRFQ Created: ${rfqMapping.rfqSearchKey} (3PL/VMI)\n  ${rfqMapping.linesWritten} lines written, ${rfqMapping.vqItems} items with VQ data\n  Contact: Rob Johnson | Salesrep: Josh Syre\n  Auto-approved (margin ≥ 18% + stock ≥ LAM MOQ): ${autoCount}\n`
    : '';

  // Escalation summary — reflects state AFTER this run's auto-resolution pass.
  // Surfaces three categories: manual (curated by Jake), auto (restricted-MFR
  // margin compression detected this run), stock-arrived (manual MPN above
  // threshold but stock on hand → Josh action: confirm new LAM resale).
  let escalationSection = '';
  try {
    const escState = loadEscalationsState();
    const escContext = loadEscalationsContext(sourcedCsv);
    const manualCount = escState?.entries?.length || 0;
    const stockArrivedCount = (escContext?.entries || []).filter(e => e.stockArrived).length;

    let autoCount = 0;
    let autoMpnLines = [];
    if (fs.existsSync(sourcedCsv)) {
      try {
        const csv = readCSVFile(sourcedCsv);
        const ds = (path.basename(sourcedCsv).match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
        const auto = computeAutoEscalations(csv, sourcedCsv, escState, ds);
        autoCount = auto.length;
        // Surface up to 5 MPN-level Josh action items in the email body so he
        // doesn't have to open the xlsx to know whose resale to chase.
        autoMpnLines = auto.slice(0, 5).map(e => `    • ${e.mpn} — ${e.kind === 'no_route' ? 'no franchise route' : 'margin compressed'}`);
      } catch (_) { /* non-fatal */ }
    }

    const lines = [];
    if (manualCount > 0) lines.push(`Open Escalations: ${manualCount} manual entry(ies)`);
    if (autoCount > 0) {
      lines.push(`  + ${autoCount} auto-flagged this run (restricted-MFR margin <18% — Josh: push new LAM resale):`);
      lines.push(...autoMpnLines);
      if (autoCount > 5) lines.push(`    • ...and ${autoCount - 5} more`);
    }
    if (stockArrivedCount > 0) {
      lines.push(`  + ${stockArrivedCount} stock-arrived (above threshold, resale renegotiation still pending — see "Escalations" tab)`);
    }
    if (lines.length > 0) {
      escalationSection = `\n${lines.join('\n')}\nFull detail in the "Escalations" tab.\n`;
    }
  } catch (_) { /* non-fatal */ }

  const emailSubject = rfqWriteFailed
    ? `❌ LAM 3PL Reorder - RFQ WRITE FAILED ${dateStr}`
    : isPartial
    ? `⚠️ LAM 3PL Reorder - PARTIAL Sourced ${dateStr}`
    : `LAM 3PL Reorder - Sourced ${dateStr}`;
  const rfqFailWarning = rfqWriteFailed
    ? `\n❌ RFQ WRITE FAILED — no RFQs/VQs created in OT this run.\n   Cause: ${rfqWriteError}\n   The cron-runner will retry on the next hourly tick once OT is healthy.\n`
    : '';

  const restrictedSection = restrictedCount > 0
    ? `\nRestricted MFRs (franchise pricing hidden, manual sourcing required): ${restrictedCount}\n`
    : '';

  // Customer-facing offer status — surfaces in the email so Jake sees
  // whether the BI dashboard refresh hit OT this Monday. Single source of
  // truth for the customer-offer outcome (no separate notification).
  let customerOfferSection = '';
  if (customerOfferError) {
    customerOfferSection = `\n──────────────────────────────────────────────\nCustomer LAM Kitting Inventory offer: ❌ FAILED\n──────────────────────────────────────────────\nError: ${customerOfferError}\nState UNKNOWN — depending on where the script failed, the prior\noffer may or may not have been deactivated. Verify in OT:\n  SELECT chuboe_offer_id, value, isactive FROM adempiere.chuboe_offer\n  WHERE chuboe_offer_type_id=1000025 AND c_bpartner_id=1000730\n  AND isactive='Y';\nIf zero rows: dashboard is BLANK until next run. Reactivate the\nlast offer (PATCH IsActive='Y') or run the script manually.\n──────────────────────────────────────────────\n`;
  } else if (customerOfferResult) {
    const r = customerOfferResult;
    const s = r.stats || {};
    const deactList = Array.isArray(r.deactivatedOfferKeys) && r.deactivatedOfferKeys.length > 0
      ? r.deactivatedOfferKeys.join(', ')
      : '(none)';
    // Offer-type safety check — confirms the offer landed on the customer-
    // visible type (1000025 LAM Kitting Inventory) and not on a staging /
    // wrong type. r.isStaging is true whenever offerTypeId !== 1000025.
    const typeOk = r.offerTypeId === 1000025 && !r.isStaging;
    const typeLine = typeOk
      ? `Offer type:           ${r.offerTypeId} — LAM Kitting Inventory ✅ (customer-visible)`
      : `Offer type:           ${r.offerTypeId} — ⚠️  NOT 1000025 — dashboard will NOT see this offer (likely a staging run)`;
    const headline = typeOk
      ? 'Customer LAM Kitting Inventory offer: ✅ REFRESHED'
      : 'Customer LAM Kitting Inventory offer: ⚠️  WROTE TO WRONG TYPE';
    customerOfferSection = `\n──────────────────────────────────────────────\n${headline}\n──────────────────────────────────────────────\n${typeLine}\nNew offer search key: ${r.searchKey}\nLines written:        ${r.linesWritten} / ${r.lineCount}${r.errorCount ? ` (${r.errorCount} line errors — review sidecar JSON)` : ''}\nIn-stock parts:       ${(r.lineCount || 0) - (s.zeroStock || 0)}\nZero-stock parts:     ${s.zeroStock || 0}  (visible on dashboard with qty=0)\nLead-time refreshes:  ${s.refreshed || 0}  (from this week's franchise sourcing)\nManual codes kept:    ${s.preservedManual || 0}  (LTB / Obsolete / EOL / etc.)\nDeactivated prior:    ${r.deactivatedPriorOffers || 0} offer(s) — search keys: ${deactList}\nDescription:          "${r.description}"\n──────────────────────────────────────────────\n`;
  }

  const emailBody = `LAM 3PL Reorder - Sourced Report ${dateStr}
${rfqFailWarning}${partialWarning}${rfqSection}${escalationSection}${restrictedSection}${customerOfferSection}
${totalAlerts} items below threshold:
- CRITICAL (zero stock, no recent PO): ${critCount}
- HIGH: ${highCount}
- MEDIUM: ${medCount}
- LOW: ${lowCount}
- PENDING ORDER PLACEMENT (no POV stamp yet — chase the PO): ${pendingOrderCount}
- PENDING RECEIPT (POV stamped, waiting on vendor): ${pendingReceiptCount}

Attached: ${attachmentLabel}
Inventory source: Inventory ${dateStr}
Kitting DB: ${path.basename(excelFile)}`;

  await sendEmail(
    NOTIFY_EMAIL,
    emailSubject,
    emailBody,
    [attachment]
  );

  // Step 6: Wrong warehouse check (runs after reorder email, non-blocking)
  // Identifies roster parts in non-LAM warehouses and emails separately if misplaced items found
  log('');
  log('Step 6: Running wrong warehouse check...');
  try {
    const wwcResult = execSync(
      `node "${path.join(SCRIPT_DIR, 'lam-wrong-warehouse-check.js')}" "${inventoryFolder}"`,
      { encoding: 'utf-8', timeout: 120000 }
    );
    console.log(wwcResult);
    log('  Wrong warehouse check complete');
  } catch (err) {
    log(`  WARNING: Wrong warehouse check failed: ${err.message}`);
    // Non-fatal - reorder already sent
  }

  // NOTE: Pending orders check (lam-pending-orders-check.js) is available but run manually
  // until automated PO report is available from Infor. Run with:
  //   node lam-pending-orders-check.js [--dry-run]

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
  loadEscalationsContext,
  persistResolvedEscalations,
  computeAutoEscalations,
  applyRowShading,
  applyColumnFormats,
  parseCellForExcel,
};
