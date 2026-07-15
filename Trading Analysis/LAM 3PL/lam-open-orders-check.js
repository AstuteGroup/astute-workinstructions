#!/usr/bin/env node
/**
 * LAM Open Orders Check
 *
 * Cross-references Infor Open POV report against:
 * 1. OT order data (for tracking numbers)
 * 2. Current reorder alerts (to flag items that shouldn't be on reorder list)
 *
 * Source of truth: Infor Open POV report
 * Enrichment: OT tracking/promise dates
 *
 * Usage:
 *   node lam-open-orders-check.js <infor-pov-report.xlsx> [reorder-alerts.csv]
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readCSVFile } = require('../../shared/csv-utils');

const SCRIPT_DIR = __dirname;

// Excel serial date to JS Date
function excelToDate(serial) {
  if (!serial || typeof serial !== 'number') return null;
  return new Date((serial - 25569) * 86400 * 1000);
}

function formatDate(date) {
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

// Load OT tracking data for all open LAM POs
function loadOTTracking() {
  const sql = `
    SELECT
      ol.chuboe_po_string AS pov,
      TRIM(ol.chuboe_mpn) AS mpn,
      o.documentno AS ot_po,
      COALESCE(ol.chuboe_trackingnumbers, '') AS tracking,
      ol.datepromised::date AS ot_promise_date,
      ol.qtyordered,
      ol.qtydelivered
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    WHERE ol.chuboe_po_string LIKE 'POV%'
      AND o.issotrx = 'N'
      AND ol.isactive = 'Y'
      AND ol.qtyordered > ol.qtydelivered
    ORDER BY ol.chuboe_po_string;
  `;

  const tmpSql = '/tmp/ot_tracking.sql';
  const tmpOut = '/tmp/ot_tracking.out';
  fs.writeFileSync(tmpSql, sql);

  try {
    execSync(`psql -U analytics_user -d idempiere_replica -t -A -F '|' -f ${tmpSql} -o ${tmpOut}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
      console.error('  WARNING: Could not load OT tracking data');
      return {};
    }
  }

  const result = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
  const byPovMpn = {};

  for (const line of result.trim().split('\n').filter(l => l.includes('|'))) {
    const parts = line.split('|');
    const [pov, mpn, otPo, tracking, promiseDate, qtyOrd, qtyDel] = parts;
    const key = `${(pov || '').trim()}|${(mpn || '').trim()}`;
    byPovMpn[key] = {
      otPo: (otPo || '').trim(),
      tracking: (tracking || '').trim(),
      otPromiseDate: (promiseDate || '').trim(),
      qtyOrdered: parseFloat(qtyOrd) || 0,
      qtyDelivered: parseFloat(qtyDel) || 0
    };
  }

  return byPovMpn;
}

// Load reorder alerts to cross-reference
function loadReorderAlerts(alertsPath) {
  if (!alertsPath || !fs.existsSync(alertsPath)) return new Set();

  const csv = readCSVFile(alertsPath);
  const mpnIdx = csv.headers.indexOf('MPN');
  const cpcIdx = csv.headers.indexOf('Lam P/N');

  const mpns = new Set();
  for (const row of csv.rows) {
    if (row[mpnIdx]) mpns.add(row[mpnIdx].trim().toUpperCase());
    if (row[cpcIdx]) mpns.add(row[cpcIdx].trim().toUpperCase());
  }
  return mpns;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: node lam-open-orders-check.js <infor-pov-report.xlsx> [reorder-alerts.csv]');
    console.log('');
    console.log('Example:');
    console.log('  node lam-open-orders-check.js "../../file-drop/W103 OPEN POVs.xlsx"');
    process.exit(1);
  }

  const inforPath = args[0];
  const alertsPath = args[1] || null;
  const today = new Date();

  console.log('LAM Open Orders Check');
  console.log('=====================');
  console.log(`Infor Report: ${inforPath}`);
  console.log(`Today: ${formatDate(today)}`);
  console.log('');

  // Load Infor Open POV report
  console.log('Step 1: Loading Infor Open POV report...');
  const wb = XLSX.readFile(inforPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const inforData = XLSX.utils.sheet_to_json(ws);
  console.log(`  Total rows: ${inforData.length}`);

  // Filter for W111 (LAM 3PL)
  const lamOrders = inforData.filter(r => {
    const wh = r['PO Line Warehouse'] || r['Warehouse'] || '';
    return wh.includes('W111');
  });
  console.log(`  W111 (LAM) orders: ${lamOrders.length}`);

  // Load OT tracking data
  console.log('');
  console.log('Step 2: Loading OT tracking data...');
  const otTracking = loadOTTracking();
  console.log(`  OT records loaded: ${Object.keys(otTracking).length}`);

  // Load reorder alerts if provided
  let reorderMpns = new Set();
  if (alertsPath) {
    console.log('');
    console.log('Step 3: Loading reorder alerts for cross-reference...');
    reorderMpns = loadReorderAlerts(alertsPath);
    console.log(`  Reorder MPNs: ${reorderMpns.size}`);
  }

  // Process and categorize orders
  console.log('');
  console.log('Step 4: Analyzing orders...');

  const overdue = [];
  const onTrack = [];
  const onReorderList = [];

  for (const row of lamOrders) {
    const pov = row['PO Number'] || '';
    const mpn = row['Item'] || '';
    const vendor = row['Vendor Name'] || '';
    const qtyOrdered = row['PO Quantity Ordered'] || 0;
    const qtyReceived = row['PO Quantity Received'] || 0;
    const qtyOpen = qtyOrdered - qtyReceived;

    if (qtyOpen <= 0) continue; // Fully received

    const promiseSerial = row['PO Promised Date'] || row['PO Due Date'];
    const promiseDate = excelToDate(promiseSerial);
    const daysOverdue = promiseDate ? daysBetween(promiseDate, today) : null;

    // Get OT enrichment
    const otKey = `${pov}|${mpn}`;
    const ot = otTracking[otKey] || {};

    const record = {
      pov,
      mpn,
      vendor,
      qtyOrdered,
      qtyReceived,
      qtyOpen,
      promiseDate: formatDate(promiseDate),
      daysOverdue: daysOverdue || 0,
      otPo: ot.otPo || '',
      tracking: ot.tracking || '',
      onReorderList: reorderMpns.has(mpn.toUpperCase())
    };

    if (record.onReorderList) {
      onReorderList.push(record);
    }

    if (daysOverdue > 0) {
      overdue.push(record);
    } else {
      onTrack.push(record);
    }
  }

  // Sort overdue by days overdue descending
  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  console.log(`  Overdue orders: ${overdue.length}`);
  console.log(`  On track orders: ${onTrack.length}`);
  console.log(`  On reorder list (should drop off): ${onReorderList.length}`);

  // Output results
  console.log('');
  console.log('=== OVERDUE ORDERS (need follow-up) ===');
  console.log('');

  // Group by vendor
  const byVendor = {};
  for (const r of overdue) {
    if (!byVendor[r.vendor]) byVendor[r.vendor] = [];
    byVendor[r.vendor].push(r);
  }

  for (const [vendor, orders] of Object.entries(byVendor).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${vendor} (${orders.length} overdue):`);
    for (const r of orders.slice(0, 10)) {
      const trackingNote = r.tracking ? ` [TRACKING: ${r.tracking}]` : '';
      const reorderNote = r.onReorderList ? ' *** ON REORDER LIST ***' : '';
      console.log(`  ${r.pov} | ${r.mpn} | ${r.qtyOpen} pcs | Due: ${r.promiseDate} | ${r.daysOverdue}d overdue${trackingNote}${reorderNote}`);
    }
    if (orders.length > 10) {
      console.log(`  ... and ${orders.length - 10} more`);
    }
    console.log('');
  }

  // Highlight items on reorder list that shouldn't be
  if (onReorderList.length > 0) {
    console.log('');
    console.log('=== ITEMS ON REORDER LIST THAT ARE ALREADY ON ORDER ===');
    console.log('(These should show as PENDING RECEIPT, not need new orders)');
    console.log('');
    for (const r of onReorderList) {
      const trackingNote = r.tracking ? ` [TRACKING: ${r.tracking}]` : '';
      console.log(`  ${r.pov} | ${r.mpn} | ${r.qtyOpen} pcs | Due: ${r.promiseDate} | ${r.daysOverdue}d overdue${trackingNote}`);
    }
  }

  // Write Excel output
  const outputPath = path.join(SCRIPT_DIR, 'output', `LAM_Open_Orders_${formatDate(today)}.xlsx`);

  const wbOut = XLSX.utils.book_new();

  // Overdue sheet
  const overdueWs = XLSX.utils.json_to_sheet(overdue.map(r => ({
    'POV': r.pov,
    'MPN': r.mpn,
    'Vendor': r.vendor,
    'Qty Open': r.qtyOpen,
    'Promise Date': r.promiseDate,
    'Days Overdue': r.daysOverdue,
    'OT PO': r.otPo,
    'Tracking': r.tracking,
    'On Reorder List': r.onReorderList ? 'YES - SHOULD DROP' : ''
  })));
  XLSX.utils.book_append_sheet(wbOut, overdueWs, 'Overdue');

  // On Track sheet
  const onTrackWs = XLSX.utils.json_to_sheet(onTrack.map(r => ({
    'POV': r.pov,
    'MPN': r.mpn,
    'Vendor': r.vendor,
    'Qty Open': r.qtyOpen,
    'Promise Date': r.promiseDate,
    'OT PO': r.otPo,
    'Tracking': r.tracking
  })));
  XLSX.utils.book_append_sheet(wbOut, onTrackWs, 'On Track');

  XLSX.writeFile(wbOut, outputPath);
  console.log('');
  console.log(`Output written to: ${outputPath}`);

  return { overdue, onTrack, onReorderList };
}

main();
