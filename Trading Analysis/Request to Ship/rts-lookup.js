#!/usr/bin/env node
/**
 * RTS (Request to Ship) Lookup
 *
 * Assembles all fields needed for the Power Apps "Request to Ship" form
 * by pulling from:
 *   1. R_Request (approval text, lastresult) — order details, COV#
 *   2. c_bpartner_location — Infor customer code (CXXXXX)
 *   3. chuboe_infor_order — COV line number
 *   4. Infor AST Item Lots Report (inventory_cleaned CSV) — lot#, bin, warehouse
 *
 * Usage:
 *   node rts-lookup.js 1155861          # by R_Request documentno
 *   node rts-lookup.js SO506724         # by OT Sales Order number
 *   node rts-lookup.js COV0021568       # by Infor COV number
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COST SOURCING — READ BEFORE USING INVENTORY LOT COST
 * ═══════════════════════════════════════════════════════════════════════════
 * W111 (LAM 3PL) and W115 (LAM Dead Stock) use LAM SIPOC contractual pricing,
 * NOT the inventory file's lot cost. Look up contract price in order:
 *   1. Lam_Kitting_DB_*.xlsx → INVENTORY → "Base Unit Price"
 *   2. Lam_EPG_SIPOC.xlsx → Sheet1 → "Base Unit Price"
 *   3. Astute_New Part ADDS_*.xlsx → latest "Astute action list" tab
 *
 * Other warehouses (W104, W102, W108, etc.) use inventory lot cost as normal.
 * See rts-lookup.md for full cost sourcing rules.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readCSVFile } = require('../../shared/csv-utils');

// ─── helpers ───────────────────────────────────────────────────────────────────

function psql(sql) {
  const out = execSync(`psql -t -A -F'\t' -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    timeout: 15000,
  });
  return out.trim();
}

function psqlRows(sql) {
  const raw = psql(sql);
  if (!raw) return [];
  return raw.split('\n').map(line => line.split('\t'));
}

/** For queries returning a single row with large text columns, use JSON output */
function psqlJson(sql) {
  const wrapped = `SELECT row_to_json(t) FROM (${sql}) t`;
  const out = psql(wrapped);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

// ─── Step 0: Resolve input to R_Request documentno ─────────────────────────────

function resolveInput(input) {
  input = input.trim();

  // Direct request number (all digits)
  if (/^\d+$/.test(input)) {
    return { type: 'request', value: input };
  }

  // SO number
  if (/^SO\d+$/i.test(input)) {
    return { type: 'so', value: input.toUpperCase() };
  }

  // COV number
  if (/^COV\d+$/i.test(input)) {
    return { type: 'cov', value: input.toUpperCase() };
  }

  // Anything else: treat as MPN
  return { type: 'mpn', value: input.trim() };
}

function findRequestBySOorCOV(ref) {
  // Search lastresult for SO or COV reference to find the parent request
  const pattern = ref.replace(/'/g, "''");
  const rows = psqlRows(`
    SELECT documentno
    FROM adempiere.r_request
    WHERE isactive = 'Y'
      AND lastresult ILIKE '%${pattern}%'
    ORDER BY updated DESC
    LIMIT 1
  `);
  if (rows.length === 0) return null;
  return rows[0][0];
}

// ─── Step 1: Pull R_Request data ───────────────────────────────────────────────

function getRequestData(docNo) {
  const data = psqlJson(`
    SELECT r_request_id, documentno, summary,
           chuboe_approval_text, lastresult, result,
           c_bpartner_id
    FROM adempiere.r_request
    WHERE documentno = '${docNo}' AND isactive = 'Y'
    LIMIT 1
  `);
  if (!data) return null;

  return {
    r_request_id: data.r_request_id,
    documentno: data.documentno,
    summary: data.summary,
    approval_text: data.chuboe_approval_text,
    lastresult: data.lastresult,
    result: data.result,
    c_bpartner_id: data.c_bpartner_id,
  };
}

// ─── Step 2: Parse approval text ───────────────────────────────────────────────

function parseApprovalText(text) {
  if (!text) return {};

  const extract = (label) => {
    const re = new RegExp(`${label}:\\s*(.+?)\\s*$`, 'mi');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  // Parse Customer Quote section
  const mpn = extract('MPN');
  const qty = extract('Quantity');
  const salePrice = extract('Sale Price');
  const customerPO = extract('Customer PO#');
  const cpc = extract('Customer Part Code');
  const shipFrom = extract('Ship-From Warehouse') || extract('Ship-To Warehouse');
  const customer = extract('Customer');
  const shipper = extract('Shipper');
  const incoTerm = extract('Inco Term');
  const dateCode = extract('Date Code');

  // Parse Vendor Quote section for cost
  const costMatch = text.match(/Vendor Quote[\s\S]*?Cost:\s*(.+?)\s*$/m);
  const cost = costMatch ? costMatch[1].trim() : null;

  return { mpn, qty, salePrice, customerPO, cpc, shipFrom, customer, shipper, incoTerm, dateCode, cost };
}

// ─── Step 3: Parse COV from lastresult ─────────────────────────────────────────

function parseCOVFromResult(lastresult) {
  if (!lastresult) return { cov: null, so: null };
  const covMatch = lastresult.match(/COV\d+/);
  const soMatch = lastresult.match(/SO\d+/);
  return {
    cov: covMatch ? covMatch[0] : null,
    so: soMatch ? soMatch[0] : null,
  };
}

// ─── Step 4: Get Infor customer code from BP location ──────────────────────────

function getInforCustomerCode(bpartnerId) {
  if (!bpartnerId) return null;

  // Use JSON to avoid tab-split issues with empty columns
  const sql = `
    SELECT chuboe_infor_custcode, name
    FROM adempiere.c_bpartner_location
    WHERE c_bpartner_id = ${bpartnerId}
      AND isactive = 'Y'
    ORDER BY isshipto DESC
  `;
  const raw = psql(`SELECT json_agg(t) FROM (${sql}) t`);
  if (!raw) return null;

  let rows;
  try { rows = JSON.parse(raw); } catch { return null; }
  if (!rows) return null;

  // Prefer dedicated field if populated
  for (const row of rows) {
    const code = (row.chuboe_infor_custcode || '').trim();
    if (code) return code;
  }
  // Fallback: parse CXXXXX from address name
  // Handles: "C006328-Shipping", "V007903, C006325 - Connect Electronics", etc.
  for (const row of rows) {
    const nameMatch = (row.name || '').match(/\b(C\d{4,})\b/i);
    if (nameMatch) return nameMatch[1].toUpperCase();
  }

  return null;
}

// ─── Step 5: Get COV line from chuboe_infor_order ──────────────────────────────

function getCOVLine(covNo, mpn) {
  if (!covNo || !mpn) return null;

  const rows = psqlRows(`
    SELECT line_no, item, poqtyoutstanding, unit_price
    FROM adempiere.chuboe_infor_order
    WHERE isactive = 'Y'
      AND orderno = '${covNo.replace(/'/g, "''")}'
      AND item ILIKE '%${mpn.replace(/'/g, "''").replace(/%/g, '')}%'
    ORDER BY line_no
    LIMIT 5
  `);

  if (rows.length === 0) return null;
  return rows.map(([line_no, item, qtyOut, price]) => ({
    line_no, item, qtyOutstanding: qtyOut, unitPrice: price,
  }));
}

// ─── Step 5b: Infer COV line from SO line position ─────────────────────────────
// OT SO lines use line=10,20,30... The COV line is the ordinal position (1,2,3...)

function inferCOVLineFromSO(soNo, mpn) {
  if (!soNo) return null;

  const raw = psql(`SELECT json_agg(t ORDER BY t.line) FROM (
    SELECT ol.line, p.value as product, ol.qtyordered, ol.priceentered
    FROM adempiere.c_order o
    JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
    LEFT JOIN adempiere.m_product p ON ol.m_product_id = p.m_product_id
    WHERE o.documentno = '${soNo.replace(/'/g, "''")}' AND o.isactive='Y' AND ol.isactive='Y'
  ) t`);

  if (!raw) return null;
  let lines;
  try { lines = JSON.parse(raw); } catch { return null; }
  if (!lines) return null;

  // Find the position of the MPN in the SO line list → that's the COV line #
  const mpnClean = (mpn || '').trim().toUpperCase();
  const totalLines = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const prod = (lines[i].product || '').trim().toUpperCase();
    if (prod === mpnClean || prod.includes(mpnClean) || mpnClean.includes(prod)) {
      return { covLine: i + 1, soLine: lines[i].line, totalLines, allLines: lines };
    }
  }

  // If only one line, it's line 1 regardless of MPN match
  if (totalLines === 1) {
    return { covLine: 1, soLine: lines[0].line, totalLines, allLines: lines };
  }

  return { covLine: null, totalLines, allLines: lines };
}

// ─── Step 5c: MPN-only lookup via chuboe_infor_order ───────────────────────────
// For stock/broker sales RTS: order is within 3 days. Widen only if needed.

function findInforOrderByMPN(mpn) {
  const mpnEsc = mpn.replace(/'/g, "''");

  // First pass: 3-day window, outstanding qty > 0
  let raw = psql(`SELECT json_agg(t ORDER BY t.order_date DESC) FROM (
    SELECT orderno, customer, item, line_no, poqtyoutstanding, unit_price,
           warehousename, updated::date as order_date
    FROM adempiere.chuboe_infor_order
    WHERE isactive = 'Y'
      AND item = '${mpnEsc}'
      AND poqtyoutstanding > 0
      AND updated >= now() - interval '3 days'
  ) t`);

  let rows;
  try { rows = JSON.parse(raw); } catch { rows = null; }

  if (rows && rows.length > 0) {
    return { orders: rows, window: '3-day' };
  }

  // Second pass: widen to all open orders for this MPN
  raw = psql(`SELECT json_agg(t ORDER BY t.order_date DESC) FROM (
    SELECT orderno, customer, item, line_no, poqtyoutstanding, unit_price,
           warehousename, updated::date as order_date
    FROM adempiere.chuboe_infor_order
    WHERE isactive = 'Y'
      AND item = '${mpnEsc}'
      AND poqtyoutstanding > 0
  ) t`);

  try { rows = JSON.parse(raw); } catch { rows = null; }

  if (rows && rows.length > 0) {
    return { orders: rows, window: 'all-open' };
  }

  return { orders: [], window: 'none' };
}

// Check R_Requests for this MPN (red flag: SO exists but no Infor COV)
function findRequestByMPN(mpn) {
  const mpnEsc = mpn.replace(/'/g, "''");
  const rows = psqlRows(`
    SELECT documentno, summary, updated::date
    FROM adempiere.r_request
    WHERE isactive = 'Y'
      AND chuboe_approval_text ILIKE '%MPN: ${mpnEsc}%'
      AND updated >= now() - interval '7 days'
    ORDER BY updated DESC
    LIMIT 5
  `);
  return rows.filter(r => r[0]).map(([docno, summary, dt]) => ({ docno, summary, date: dt }));
}

// ─── Step 6: Find lots in inventory file ───────────────────────────────────────

function findLatestInventoryFile() {
  // Look for /tmp/Inventory YYYY-MM-DD/ directories, pick newest
  const tmpFiles = execSync('ls -d /tmp/Inventory\\ 20* 2>/dev/null || true', {
    encoding: 'utf8',
  }).trim();

  if (!tmpFiles) return null;

  const dirs = tmpFiles.split('\n').filter(Boolean).sort();
  const latestDir = dirs[dirs.length - 1];

  // Find the inventory_cleaned file
  const files = execSync(`ls "${latestDir}"/inventory_cleaned_* 2>/dev/null || true`, {
    encoding: 'utf8',
  }).trim();

  if (!files) return null;
  return files.split('\n')[0];
}

function findLotsForMPN(inventoryFile, mpn) {
  if (!inventoryFile || !mpn) return [];

  const csv = readCSVFile(inventoryFile);
  const itemIdx = csv.headers.indexOf('Item');
  const lotIdx = csv.headers.indexOf('Lot');
  const locationIdx = csv.headers.indexOf('Location');
  const lotQtyIdx = csv.headers.indexOf('Lot Quantity');
  const warehouseIdx = csv.headers.indexOf('Warehouse');
  const whNameIdx = csv.headers.indexOf('Warehouse Name');
  const dateCodeIdx = csv.headers.indexOf('Date Code');
  const lotCostIdx = csv.headers.indexOf('Lot Cost');
  const lotUnitCostIdx = csv.headers.indexOf('Lot Unit Cost');

  const mpnClean = mpn.trim().toUpperCase();

  return csv.rows
    .filter(row => {
      const item = (row[itemIdx] || '').trim().toUpperCase();
      return item === mpnClean;
    })
    .map(row => ({
      item: row[itemIdx],
      lot: row[lotIdx],
      location: row[locationIdx],
      lotQty: row[lotQtyIdx],
      warehouse: row[warehouseIdx],
      warehouseName: row[whNameIdx],
      dateCode: row[dateCodeIdx],
      lotCost: row[lotCostIdx],
      lotUnitCost: row[lotUnitCostIdx],
    }));
}

// ─── Step 7: Get customer name ─────────────────────────────────────────────────

function getCustomerName(bpartnerId) {
  if (!bpartnerId) return null;
  const rows = psqlRows(`
    SELECT name FROM adempiere.c_bpartner
    WHERE c_bpartner_id = ${bpartnerId} AND isactive = 'Y'
  `);
  return rows.length > 0 ? rows[0][0] : null;
}

// ─── MPN-only path ─────────────────────────────────────────────────────────────

function runMPNLookup(mpn) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RTS LOOKUP — MPN: ${mpn}`);
  console.log(`${'='.repeat(70)}`);

  // Step 1: Find Infor orders for this MPN
  const { orders, window } = findInforOrderByMPN(mpn);

  if (orders.length === 0) {
    // Red flag check: does an R_Request exist?
    const reqs = findRequestByMPN(mpn);
    if (reqs.length > 0) {
      console.log(`\n  *** RED FLAG: No Infor COV found for ${mpn}, but R_Request(s) exist: ***`);
      for (const r of reqs) {
        console.log(`    Request ${r.docno} (${r.date}) — ${r.summary}`);
      }
      console.log(`\n  SO may be approved but COV not yet entered in Infor. Check with support.`);
    } else {
      console.log(`\n  No open orders found for MPN: ${mpn}`);
    }
    // Still show inventory
    const inventoryFile = findLatestInventoryFile();
    const lots = findLotsForMPN(inventoryFile, mpn);
    if (lots.length > 0) {
      printLots(lots, inventoryFile);
    }
    return;
  }

  // Multiple orders? Show them all if outside 3-day window
  if (orders.length > 1) {
    console.log(`\n  *** Multiple open COVs for ${mpn} (${window} window) — pick one: ***`);
    console.log(`  ${'#'.padEnd(4)} ${'COV'.padEnd(12)} ${'Customer'.padEnd(10)} ${'Line'.padEnd(6)} ${'Qty Out'.padEnd(10)} ${'Price'.padEnd(10)} ${'Date'.padEnd(12)}`);
    console.log(`  ${'-'.repeat(4)} ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(12)}`);
    orders.forEach((o, i) => {
      console.log(`  ${String(i + 1).padEnd(4)} ${(o.orderno || '').padEnd(12)} ${(o.customer || '').padEnd(10)} ${String(o.line_no || '').padEnd(6)} ${String(o.poqtyoutstanding || '').padEnd(10)} ${String(o.unit_price || '').padEnd(10)} ${(o.order_date || '').padEnd(12)}`);
    });

    // Show inventory for reference
    const inventoryFile = findLatestInventoryFile();
    const lots = findLotsForMPN(inventoryFile, mpn);
    if (lots.length > 0) {
      printLots(lots, inventoryFile);
    }
    console.log(`\n  Specify COV# to get full RTS: node rts-lookup.js COV0XXXXX`);
    return;
  }

  // Single order — full RTS output
  const order = orders[0];
  const inventoryFile = findLatestInventoryFile();
  const lots = findLotsForMPN(inventoryFile, mpn);

  console.log(`\n--- ORDER DETAILS (from Infor, ${window} window) ---`);
  console.log(`  Customer #:     ${order.customer}`);
  console.log(`  COV #:          ${order.orderno}`);
  console.log(`  MPN:            ${order.item}`);
  console.log(`  COV Line:       ${order.line_no}`);
  console.log(`  Qty to Ship:    ${order.poqtyoutstanding}`);
  console.log(`  Resale Price:   ${order.unit_price}`);
  console.log(`  Warehouse:      ${order.warehousename || '?'}`);
  console.log(`  Order Date:     ${order.order_date}`);

  printLots(lots, inventoryFile);

  console.log(`\n--- FORM FIELDS (copy to Power Apps) ---`);
  console.log(`  Customer/Customer #:  ${order.customer}`);
  console.log(`  COV #:                ${order.orderno}`);
  console.log(`  MPN:                  ${order.item}`);
  console.log(`  COV Line:             ${order.line_no}`);
  console.log(`  Qty to Ship:          ${order.poqtyoutstanding}`);
  console.log(`  Lot #:                ${lots.length === 1 ? lots[0].lot : lots.length > 1 ? '<pick from list above>' : '?'}`);
  console.log(`  Location:             ${lots.length === 1 ? lots[0].location : lots.length > 1 ? '<pick from list above>' : '?'}`);
  console.log(`  Warehouse:            ${lots.length === 1 ? lots[0].warehouse : lots.length > 1 ? '<pick from list above>' : '?'}`);
  console.log(`  Resale Price:         ${order.unit_price}`);
  console.log('');
}

// ─── COV direct lookup (no R_Request) ──────────────────────────────────────────

function runCOVDirectLookup(covNo) {
  const covEsc = covNo.replace(/'/g, "''");
  const raw = psql(`SELECT json_agg(t ORDER BY t.line_no) FROM (
    SELECT orderno, customer, item, line_no, poqtyoutstanding, unit_price, warehousename
    FROM adempiere.chuboe_infor_order
    WHERE isactive = 'Y' AND orderno = '${covEsc}'
  ) t`);

  let lines;
  try { lines = JSON.parse(raw); } catch { lines = null; }

  if (!lines || lines.length === 0) {
    console.error(`COV ${covNo} not found in Infor order sync or R_Requests`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RTS LOOKUP — ${covNo} (direct Infor lookup)`);
  console.log(`${'='.repeat(70)}`);

  const inventoryFile = findLatestInventoryFile();

  for (const line of lines) {
    if (parseFloat(line.poqtyoutstanding) <= 0) continue;

    const lots = findLotsForMPN(inventoryFile, line.item);

    console.log(`\n--- LINE ${line.line_no}: ${line.item} ---`);
    console.log(`  Customer #:     ${line.customer}`);
    console.log(`  COV #:          ${line.orderno}`);
    console.log(`  COV Line:       ${line.line_no}`);
    console.log(`  Qty to Ship:    ${line.poqtyoutstanding}`);
    console.log(`  Resale Price:   ${line.unit_price}`);

    printLots(lots, inventoryFile);

    console.log(`\n  FORM FIELDS:`);
    console.log(`  Customer/Customer #:  ${line.customer}`);
    console.log(`  COV #:                ${line.orderno}`);
    console.log(`  MPN:                  ${line.item}`);
    console.log(`  COV Line:             ${line.line_no}`);
    console.log(`  Qty to Ship:          ${line.poqtyoutstanding}`);
    console.log(`  Lot #:                ${lots.length === 1 ? lots[0].lot : lots.length > 1 ? '<pick from list above>' : '?'}`);
    console.log(`  Location:             ${lots.length === 1 ? lots[0].location : lots.length > 1 ? '<pick from list above>' : '?'}`);
    console.log(`  Warehouse:            ${lots.length === 1 ? lots[0].warehouse : lots.length > 1 ? '<pick from list above>' : '?'}`);
    console.log(`  Resale Price:         ${line.unit_price}`);
  }
  console.log('');
}

// ─── Shared output helpers ─────────────────────────────────────────────────────

function printLots(lots, inventoryFile) {
  console.log(`\n--- AVAILABLE LOTS (from Infor inventory ${inventoryFile ? path.basename(path.dirname(inventoryFile)) : 'NOT FOUND'}) ---`);
  if (lots.length === 0) {
    console.log(`  No lots found in inventory file`);
    return;
  }
  console.log(`  ${'#'.padEnd(4)} ${'Lot'.padEnd(22)} ${'Qty'.padEnd(8)} ${'Location'.padEnd(12)} ${'Warehouse'.padEnd(8)} ${'WH Name'.padEnd(35)} ${'Date Code'.padEnd(10)} ${'Unit Cost'.padEnd(10)}`);
  console.log(`  ${'-'.repeat(4)} ${'-'.repeat(22)} ${'-'.repeat(8)} ${'-'.repeat(12)} ${'-'.repeat(8)} ${'-'.repeat(35)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
  lots.forEach((lot, i) => {
    console.log(`  ${String(i + 1).padEnd(4)} ${(lot.lot || '').padEnd(22)} ${(lot.lotQty || '').padEnd(8)} ${(lot.location || '').padEnd(12)} ${(lot.warehouse || '').padEnd(8)} ${(lot.warehouseName || '').padEnd(35)} ${(lot.dateCode || '').padEnd(10)} ${(lot.lotUnitCost || '').padEnd(10)}`);
  });
  console.log(`\n  Total lot qty: ${lots.reduce((sum, l) => sum + (parseFloat(l.lotQty) || 0), 0).toLocaleString()}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node rts-lookup.js <request#|SO#|COV#|MPN>');
    process.exit(1);
  }

  const resolved = resolveInput(input);

  // ─── MPN-only path ───────────────────────────────────────────────────────
  if (resolved.type === 'mpn') {
    return runMPNLookup(resolved.value);
  }

  // ─── Request / SO / COV path ─────────────────────────────────────────────
  let requestDocNo;

  if (resolved.type === 'request') {
    requestDocNo = resolved.value;
  } else {
    console.log(`\nLooking up R_Request for ${resolved.value}...`);
    requestDocNo = findRequestBySOorCOV(resolved.value);
    if (!requestDocNo) {
      // For COV type, try direct Infor lookup before giving up
      if (resolved.type === 'cov') {
        console.log(`  No R_Request found — trying direct Infor lookup...`);
        return runCOVDirectLookup(resolved.value);
      }
      console.error(`No R_Request found referencing ${resolved.value}`);
      process.exit(1);
    }
    console.log(`  Found request: ${requestDocNo}`);
  }

  // Step 1: Get request data
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RTS LOOKUP — Request ${requestDocNo}`);
  console.log(`${'='.repeat(70)}`);

  const req = getRequestData(requestDocNo);
  if (!req) {
    console.error(`R_Request ${requestDocNo} not found`);
    process.exit(1);
  }

  // Step 2: Parse approval text
  const parsed = parseApprovalText(req.approval_text);

  // Step 3: Parse COV/SO from lastresult
  const { cov, so } = parseCOVFromResult(req.lastresult);

  // Step 4: Infor customer code
  const inforCustCode = getInforCustomerCode(req.c_bpartner_id);
  const customerName = parsed.customer || getCustomerName(req.c_bpartner_id);

  // Step 5: COV line lookup (Infor sync first, then infer from SO)
  let covLines = null;
  let inferredCOVLine = null;
  if (cov && parsed.mpn) {
    covLines = getCOVLine(cov, parsed.mpn);
  }
  if (!covLines && so) {
    inferredCOVLine = inferCOVLineFromSO(so, parsed.mpn);
  }

  // Step 6: Inventory lots
  const inventoryFile = findLatestInventoryFile();
  let lots = [];
  if (parsed.mpn) {
    lots = findLotsForMPN(inventoryFile, parsed.mpn);
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  console.log(`\n--- ORDER DETAILS ---`);
  console.log(`  Customer:       ${customerName || '?'}`);
  console.log(`  Customer #:     ${inforCustCode || '? (not found in BP locations)'}`);
  console.log(`  COV #:          ${cov || '? (not yet in lastresult — check request updates)'}`);
  console.log(`  SO #:           ${so || '? (not found in lastresult)'}`);
  console.log(`  MPN:            ${parsed.mpn || '?'}`);
  console.log(`  Qty to Ship:    ${parsed.qty || '?'}`);
  console.log(`  Resale Price:   ${parsed.salePrice || '?'}`);
  console.log(`  Customer PO:    ${parsed.customerPO || '?'}`);
  console.log(`  Ship From:      ${parsed.shipFrom || '?'}`);
  console.log(`  Shipper:        ${parsed.shipper || '?'}`);

  if (covLines && covLines.length > 0) {
    console.log(`\n--- COV LINE (from Infor sync) ---`);
    for (const cl of covLines) {
      console.log(`  COV Line #:     ${cl.line_no}`);
      console.log(`  Item:           ${cl.item}`);
      console.log(`  Qty Outstanding:${cl.qtyOutstanding}`);
      console.log(`  Unit Price:     ${cl.unitPrice}`);
    }
  } else if (inferredCOVLine) {
    console.log(`\n--- COV LINE (inferred from ${so}, ${inferredCOVLine.totalLines} line(s) on SO) ---`);
    if (inferredCOVLine.covLine) {
      console.log(`  COV Line #:     ${inferredCOVLine.covLine} (SO line ${inferredCOVLine.soLine})`);
    } else {
      console.log(`  Could not match MPN to SO lines. SO has ${inferredCOVLine.totalLines} lines:`);
      for (const l of inferredCOVLine.allLines) {
        console.log(`    Line ${l.line}: ${l.product || '?'}  qty=${l.qtyordered}  price=${l.priceentered}`);
      }
    }
  } else if (cov) {
    console.log(`\n--- COV LINE ---`);
    console.log(`  COV ${cov} not in Infor sync and no SO found to infer from`);
  }

  // Inventory lots
  console.log(`\n--- AVAILABLE LOTS (from Infor inventory ${inventoryFile ? path.basename(path.dirname(inventoryFile)) : 'NOT FOUND'}) ---`);
  if (lots.length === 0) {
    console.log(`  No lots found for MPN: ${parsed.mpn || '?'}`);
    console.log(`  (Check if MPN exists in inventory or if inventory file is current)`);
  } else {
    console.log(`  ${'#'.padEnd(4)} ${'Lot'.padEnd(22)} ${'Qty'.padEnd(8)} ${'Location'.padEnd(12)} ${'Warehouse'.padEnd(8)} ${'WH Name'.padEnd(35)} ${'Date Code'.padEnd(10)} ${'Unit Cost'.padEnd(10)}`);
    console.log(`  ${'-'.repeat(4)} ${'-'.repeat(22)} ${'-'.repeat(8)} ${'-'.repeat(12)} ${'-'.repeat(8)} ${'-'.repeat(35)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
    lots.forEach((lot, i) => {
      console.log(`  ${String(i + 1).padEnd(4)} ${(lot.lot || '').padEnd(22)} ${(lot.lotQty || '').padEnd(8)} ${(lot.location || '').padEnd(12)} ${(lot.warehouse || '').padEnd(8)} ${(lot.warehouseName || '').padEnd(35)} ${(lot.dateCode || '').padEnd(10)} ${(lot.lotUnitCost || '').padEnd(10)}`);
    });
    console.log(`\n  Total lot qty: ${lots.reduce((sum, l) => sum + (parseFloat(l.lotQty) || 0), 0).toLocaleString()}`);
    if (parsed.qty) {
      const needed = parseFloat(parsed.qty) || 0;
      const available = lots.reduce((sum, l) => sum + (parseFloat(l.lotQty) || 0), 0);
      if (available < needed) {
        console.log(`  *** WARNING: Available qty (${available.toLocaleString()}) < Order qty (${needed.toLocaleString()}) ***`);
      }
    }
  }

  console.log(`\n--- FORM FIELDS (copy to Power Apps) ---`);
  console.log(`  Customer/Customer #:  ${inforCustCode || '?'}`);
  console.log(`  COV #:                ${cov || '?'}`);
  console.log(`  MPN:                  ${parsed.mpn || '?'}`);
  const covLineNo = covLines && covLines.length > 0
    ? covLines[0].line_no
    : inferredCOVLine && inferredCOVLine.covLine
      ? inferredCOVLine.covLine
      : '?';
  console.log(`  COV Line:             ${covLineNo}`);
  console.log(`  Qty to Ship:          ${parsed.qty || '?'}`);
  console.log(`  Lot #:                ${lots.length === 1 ? lots[0].lot : lots.length > 1 ? '<pick from list above>' : '?'}`);
  console.log(`  Location:             ${lots.length === 1 ? lots[0].location : lots.length > 1 ? '<pick from list above>' : '?'}`);
  console.log(`  Warehouse:            ${lots.length === 1 ? lots[0].warehouse : lots.length > 1 ? '<pick from list above>' : '?'}`);
  console.log(`  Resale Price:         ${parsed.salePrice || '?'}`);
  console.log('');
}

main();
