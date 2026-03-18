#!/usr/bin/env node
/**
 * LAM Kitting Customer Dashboard Generator
 *
 * Generates a self-contained HTML dashboard showing LAM's full kitting inventory.
 * Columns: CPC | MPN | Manufacturer | Description | Price | Qty on Hand | Factory Lead Time | Delivery Date | LOI
 *
 * Data sources:
 *   - Kitting DB Excel (all items)
 *   - W111 + W115 Chuboe CSVs (actual inventory)
 *   - ERP open POs (delivery dates)
 *
 * Usage:
 *   node lam-kitting-dashboard.js <inventory-folder> <excel-file> [output-file]
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');
const { readCSVFile } = require('../../shared/csv-utils');

// Configuration
const W111_FILENAME = 'LAM_3PL_chuboe.csv';
const W115_FILENAME = 'LAM_Dead_Inventory_chuboe.csv';
const CHUBOE_MPN_COL = 'Chuboe_MPN';
const CHUBOE_QTY_COL = 'Qty';

const EXCEL = {
  CPC: 0, MPN: 1, MANUFACTURER: 2, DESCRIPTION: 3,
  LEAD_TIME: 4, QTY_ON_HAND: 5, BASE_PRICE: 6,
  RESALE_PRICE: 7, MIN_QTY: 8, MOQ: 10
};

// ─────────────────────────────────────────────────────────────────────────────
// Data Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadChuboeInventory(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`  WARNING: ${filePath} not found`);
    return {};
  }
  const csv = readCSVFile(filePath);
  const mpnIdx = csv.headers.indexOf(CHUBOE_MPN_COL);
  const qtyIdx = csv.headers.indexOf(CHUBOE_QTY_COL);
  if (mpnIdx === -1 || qtyIdx === -1) return {};

  const inv = {};
  for (const row of csv.rows) {
    const mpn = (row[mpnIdx] || '').trim();
    const qty = parseFloat(row[qtyIdx]) || 0;
    if (!mpn) continue;
    inv[mpn] = (inv[mpn] || 0) + qty;
  }
  console.log(`  ${label}: ${Object.keys(inv).length} unique MPNs`);
  return inv;
}

function loadExcelData(excelPath) {
  const workbook = XLSX.readFile(excelPath);
  const sheet = workbook.Sheets['INVENTORY'];
  if (!sheet) { console.error('INVENTORY sheet not found'); return []; }

  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const items = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    const mpn = (row[EXCEL.MPN] || '').toString().trim();
    if (!mpn) continue;

    items.push({
      cpc: (row[EXCEL.CPC] || '').toString().trim(),
      mpn,
      manufacturer: (row[EXCEL.MANUFACTURER] || '').toString().trim(),
      description: (row[EXCEL.DESCRIPTION] || '').toString().trim(),
      leadTime: (row[EXCEL.LEAD_TIME] || '').toString().trim(),
      resalePrice: parseFloat(row[EXCEL.RESALE_PRICE]) || 0,
      minQty: parseFloat(row[EXCEL.MIN_QTY]) || 0,
      moq: parseFloat(row[EXCEL.MOQ]) || 0
    });
  }
  return items;
}

function loadOpenPODeliveryDates() {
  // Query open POs for LAM-related warehouses to get expected delivery dates
  const sql = `
    SELECT
      ol.chuboe_mpn,
      o.dateordered::date as order_date,
      COALESCE(ol.datepromised, o.datepromised)::date as promised_date,
      ol.qtyordered - ol.qtydelivered as qty_open,
      bp.name as supplier_name,
      o.documentno
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    WHERE o.issotrx = 'N'
      AND o.isactive = 'Y'
      AND o.docstatus IN ('CO', 'IP')
      AND ol.chuboe_mpn IS NOT NULL
      AND ol.chuboe_mpn != ''
      AND (ol.qtyordered - ol.qtydelivered) > 0
    ORDER BY ol.chuboe_mpn, COALESCE(ol.datepromised, o.datepromised) ASC;
  `;

  try {
    const result = execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });

    // Group by MPN — take the earliest promised date
    const deliveryDates = {};
    const lines = result.trim().split('\n').filter(l => l.trim());

    for (const line of lines) {
      const [mpn, orderDate, promisedDate, qtyOpen, supplier, docNo] = line.split('|');
      const mpnClean = (mpn || '').trim();
      if (!mpnClean) continue;

      if (!deliveryDates[mpnClean]) {
        deliveryDates[mpnClean] = {
          deliveryDate: promisedDate || orderDate || '',
          qtyOpen: parseFloat(qtyOpen) || 0,
          supplier: (supplier || '').trim(),
          poNumber: (docNo || '').trim()
        };
      } else {
        // Accumulate open qty across multiple POs
        deliveryDates[mpnClean].qtyOpen += parseFloat(qtyOpen) || 0;
      }
    }

    console.log(`  Open PO delivery dates found: ${Object.keys(deliveryDates).length} MPNs`);
    return deliveryDates;
  } catch (err) {
    console.error(`  WARNING: Could not load open PO data: ${err.message}`);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Generation
// ─────────────────────────────────────────────────────────────────────────────

function generateHTML(items, inventoryDate, excelDate) {
  const totalItems = items.length;
  const inStock = items.filter(i => i.qtyOnHand > 0).length;
  const belowMin = items.filter(i => i.minQty > 0 && i.qtyOnHand < i.minQty).length;
  const withOpenPO = items.filter(i => i.deliveryDate).length;

  // Escape for JSON embedding
  const itemsJSON = JSON.stringify(items).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LAM Research — Kitting Inventory Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f5f6fa; color: #333; }

  .header {
    background: linear-gradient(135deg, #1a237e, #283593);
    color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center;
  }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header .subtitle { font-size: 13px; opacity: 0.8; margin-top: 4px; }
  .header .logo-area { font-size: 14px; opacity: 0.7; text-align: right; }

  .stats-bar {
    display: flex; gap: 16px; padding: 16px 30px; background: white;
    border-bottom: 1px solid #e0e0e0; flex-wrap: wrap;
  }
  .stat-card {
    flex: 1; min-width: 140px; padding: 12px 16px; border-radius: 8px;
    background: #f8f9ff; border: 1px solid #e8eaf6;
  }
  .stat-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-card .value { font-size: 22px; font-weight: 700; margin-top: 2px; color: #1a237e; }
  .stat-card.green { background: #f1f8e9; border-color: #c5e1a5; }
  .stat-card.green .value { color: #2e7d32; }
  .stat-card.amber { background: #fff8e1; border-color: #ffe082; }
  .stat-card.amber .value { color: #f57f17; }
  .stat-card.blue { background: #e3f2fd; border-color: #90caf9; }
  .stat-card.blue .value { color: #1565c0; }

  .controls {
    padding: 12px 30px; background: white; border-bottom: 1px solid #e0e0e0;
    display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  }
  .controls label { font-size: 13px; font-weight: 600; }
  .controls input, .controls select {
    padding: 7px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px;
  }
  .controls input { width: 220px; }
  .controls button {
    padding: 7px 16px; border: 1px solid #1565c0; background: #1565c0;
    color: white; border-radius: 4px; cursor: pointer; font-size: 13px;
  }
  .controls button:hover { background: #0d47a1; }
  .controls button.secondary { background: white; color: #1565c0; }
  .controls button.secondary:hover { background: #e8eaf6; }
  .controls .result-count { font-size: 13px; color: #666; margin-left: auto; }

  .table-container {
    padding: 0 30px 30px; margin-top: 16px; overflow-x: auto;
  }
  table {
    width: 100%; border-collapse: collapse; font-size: 12px; background: white;
    border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  th {
    background: #1a237e; color: white; padding: 10px 12px; text-align: left;
    position: sticky; top: 0; cursor: pointer; white-space: nowrap; user-select: none;
  }
  th:hover { background: #283593; }
  th .sort-arrow { margin-left: 4px; font-size: 10px; }
  td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
  tr:hover td { background: #f5f7ff; }
  tr.below-min td { background: #fff8e1; }
  tr.zero-stock td { background: #ffebee; }

  .status-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 600;
  }
  .status-ok { background: #e8f5e9; color: #2e7d32; }
  .status-low { background: #fff3e0; color: #e65100; }
  .status-out { background: #ffebee; color: #c62828; }
  .status-po { background: #e3f2fd; color: #1565c0; }

  .price-col { text-align: right; font-family: 'Courier New', monospace; }
  .qty-col { text-align: right; font-weight: 600; }
  .highlight { background: #fff59d; }

  .footer {
    padding: 12px 30px; text-align: center; font-size: 11px; color: #999;
    border-top: 1px solid #e0e0e0; background: white;
  }

  @media print {
    .controls { display: none; }
    th { background: #333 !important; -webkit-print-color-adjust: exact; }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>LAM Research — Kitting Inventory</h1>
    <div class="subtitle">Inventory as of ${inventoryDate} | Kitting DB updated ${excelDate} | ${totalItems} items</div>
  </div>
  <div class="logo-area">Astute Electronics</div>
</div>

<div class="stats-bar">
  <div class="stat-card">
    <div class="label">Total Items</div>
    <div class="value">${totalItems}</div>
  </div>
  <div class="stat-card green">
    <div class="label">In Stock</div>
    <div class="value">${inStock}</div>
  </div>
  <div class="stat-card amber">
    <div class="label">Below Min Qty</div>
    <div class="value">${belowMin}</div>
  </div>
  <div class="stat-card blue">
    <div class="label">Open PO (On Order)</div>
    <div class="value">${withOpenPO}</div>
  </div>
</div>

<div class="controls">
  <label>Search:</label>
  <input type="text" id="searchBox" placeholder="Filter by CPC, MPN, or Mfr..." autofocus>
  <label>Status:</label>
  <select id="statusFilter">
    <option value="">All</option>
    <option value="in-stock">In Stock</option>
    <option value="below-min">Below Min Qty</option>
    <option value="out-of-stock">Out of Stock</option>
    <option value="on-order">On Order (Open PO)</option>
  </select>
  <button class="secondary" onclick="clearFilters()">Clear</button>
  <button onclick="exportCSV()">Export CSV</button>
  <span class="result-count" id="resultCount"></span>
</div>

<div class="table-container">
  <table>
    <thead>
      <tr>
        <th onclick="sortBy(0)">CPC <span class="sort-arrow" id="sa0"></span></th>
        <th onclick="sortBy(1)">MPN <span class="sort-arrow" id="sa1"></span></th>
        <th onclick="sortBy(2)">Manufacturer <span class="sort-arrow" id="sa2"></span></th>
        <th onclick="sortBy(3)">Description <span class="sort-arrow" id="sa3"></span></th>
        <th onclick="sortBy(4)">Price <span class="sort-arrow" id="sa4"></span></th>
        <th onclick="sortBy(5)">Qty on Hand <span class="sort-arrow" id="sa5"></span></th>
        <th onclick="sortBy(6)">Factory Lead Time <span class="sort-arrow" id="sa6"></span></th>
        <th onclick="sortBy(7)">Delivery Date <span class="sort-arrow" id="sa7"></span></th>
        <th onclick="sortBy(8)">LOI <span class="sort-arrow" id="sa8"></span></th>
      </tr>
    </thead>
    <tbody id="tableBody"></tbody>
  </table>
</div>

<div class="footer">
  Generated ${new Date().toISOString().split('T')[0]} | Data subject to change | Contact your Astute representative for current availability
</div>

<script>
const ALL_ITEMS = ${itemsJSON};

let currentSort = { col: 0, asc: true };
let filteredItems = [...ALL_ITEMS];

function getRowClass(item) {
  if (item.qtyOnHand === 0 && item.minQty > 0) return 'zero-stock';
  if (item.minQty > 0 && item.qtyOnHand < item.minQty) return 'below-min';
  return '';
}

function getStatusBadge(item) {
  if (item.deliveryDate) return '<span class="status-badge status-po">On Order</span>';
  if (item.qtyOnHand === 0 && item.minQty > 0) return '<span class="status-badge status-out">Out</span>';
  if (item.minQty > 0 && item.qtyOnHand < item.minQty) return '<span class="status-badge status-low">Low</span>';
  if (item.qtyOnHand > 0) return '<span class="status-badge status-ok">OK</span>';
  return '';
}

function formatPrice(p) {
  if (!p || p === 0) return '';
  return '$' + p.toFixed(2);
}

function formatQty(q) {
  if (q === null || q === undefined) return '';
  return q.toLocaleString();
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  const search = document.getElementById('searchBox').value.toLowerCase().trim();
  const status = document.getElementById('statusFilter').value;

  filteredItems = ALL_ITEMS.filter(item => {
    // Text search
    if (search) {
      const haystack = (item.cpc + ' ' + item.mpn + ' ' + item.manufacturer + ' ' + item.description).toLowerCase();
      // Support multiple search terms (space-separated, all must match)
      const terms = search.split(/\\s+/);
      if (!terms.every(t => haystack.includes(t))) return false;
    }
    // Status filter
    if (status === 'in-stock' && item.qtyOnHand <= 0) return false;
    if (status === 'below-min' && !(item.minQty > 0 && item.qtyOnHand < item.minQty)) return false;
    if (status === 'out-of-stock' && !(item.qtyOnHand === 0 && item.minQty > 0)) return false;
    if (status === 'on-order' && !item.deliveryDate) return false;
    return true;
  });

  // Sort
  const col = currentSort.col;
  const asc = currentSort.asc;
  const keys = ['cpc','mpn','manufacturer','description','resalePrice','qtyOnHand','leadTime','deliveryDate','loi'];
  const key = keys[col];
  const numeric = col === 4 || col === 5;

  filteredItems.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (numeric) {
      va = va || 0; vb = vb || 0;
      return asc ? va - vb : vb - va;
    }
    va = (va || '').toString().toLowerCase();
    vb = (vb || '').toString().toLowerCase();
    return asc ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  // Update sort arrows
  for (let i = 0; i <= 8; i++) {
    const el = document.getElementById('sa' + i);
    if (el) el.textContent = i === col ? (asc ? '▲' : '▼') : '';
  }

  // Render rows
  let html = '';
  for (const item of filteredItems) {
    const cls = getRowClass(item);
    html += '<tr class="' + cls + '">';
    html += '<td>' + esc(item.cpc) + '</td>';
    html += '<td><strong>' + esc(item.mpn) + '</strong></td>';
    html += '<td>' + esc(item.manufacturer) + '</td>';
    html += '<td>' + esc(item.description) + '</td>';
    html += '<td class="price-col">' + formatPrice(item.resalePrice) + '</td>';
    html += '<td class="qty-col">' + formatQty(item.qtyOnHand) + '</td>';
    html += '<td>' + esc(item.leadTime) + '</td>';
    html += '<td>' + esc(item.deliveryDate) + '</td>';
    html += '<td>' + esc(item.loi || '') + '</td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;

  document.getElementById('resultCount').textContent =
    filteredItems.length === ALL_ITEMS.length
      ? ALL_ITEMS.length + ' items'
      : filteredItems.length + ' of ' + ALL_ITEMS.length + ' items';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sortBy(col) {
  if (currentSort.col === col) {
    currentSort.asc = !currentSort.asc;
  } else {
    currentSort.col = col;
    currentSort.asc = true;
  }
  renderTable();
}

function clearFilters() {
  document.getElementById('searchBox').value = '';
  document.getElementById('statusFilter').value = '';
  renderTable();
}

function exportCSV() {
  const headers = ['CPC','MPN','Manufacturer','Description','Price','Qty on Hand','Factory Lead Time','Delivery Date','LOI'];
  const rows = filteredItems.map(i => [
    i.cpc, i.mpn, i.manufacturer, i.description,
    i.resalePrice || '', i.qtyOnHand, i.leadTime, i.deliveryDate || '', i.loi || ''
  ]);
  let csv = headers.join(',') + '\\n';
  for (const r of rows) {
    csv += r.map(v => {
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\\n')) ? '"' + s.replace(/"/g,'""') + '"' : s;
    }).join(',') + '\\n';
  }
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'LAM_Kitting_Inventory_${new Date().toISOString().split('T')[0]}.csv';
  a.click();
}

// URL parameter support (like Metabase: ?mpn=xxx&cpc=yyy)
const params = new URLSearchParams(window.location.search);
if (params.get('mpn')) document.getElementById('searchBox').value = params.get('mpn');
if (params.get('cpc')) document.getElementById('searchBox').value = params.get('cpc');

document.getElementById('searchBox').addEventListener('input', renderTable);
document.getElementById('statusFilter').addEventListener('change', renderTable);

renderTable();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node lam-kitting-dashboard.js <inventory-folder> <excel-file> [output-file]');
    process.exit(1);
  }

  const inventoryFolder = args[0];
  const excelFile = args[1];
  const scriptDir = path.dirname(__filename);
  const outputDir = path.join(scriptDir, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = args[2] || path.join(outputDir, `LAM_Kitting_Dashboard_${getDateStamp()}.html`);

  console.log('LAM Kitting Customer Dashboard');
  console.log('==============================');

  // Step 1: Load inventory
  console.log('\nStep 1: Loading inventory files...');
  const w111 = loadChuboeInventory(path.join(inventoryFolder, W111_FILENAME), 'W111 (LAM 3PL)');
  const w115 = loadChuboeInventory(path.join(inventoryFolder, W115_FILENAME), 'W115 (LAM Dead)');

  // Step 2: Load Excel (all items)
  console.log('\nStep 2: Loading kitting DB...');
  const excelItems = loadExcelData(excelFile);
  console.log(`  Excel items loaded: ${excelItems.length}`);

  // Step 3: Query open POs
  console.log('\nStep 3: Querying open PO delivery dates...');
  const openPOs = loadOpenPODeliveryDates();

  // Step 4: Join data
  console.log('\nStep 4: Joining data...');
  const dashboardItems = excelItems.map(item => {
    const w111Qty = w111[item.mpn] || 0;
    const w115Qty = w115[item.mpn] || 0;
    const totalQty = w111Qty + w115Qty;
    const po = openPOs[item.mpn];

    return {
      cpc: item.cpc,
      mpn: item.mpn,
      manufacturer: item.manufacturer,
      description: item.description,
      resalePrice: item.resalePrice,
      qtyOnHand: totalQty,
      leadTime: item.leadTime,
      deliveryDate: po ? po.deliveryDate : '',
      loi: '', // blank for now
      minQty: item.minQty  // used for status coloring, not displayed
    };
  });

  console.log(`  Dashboard items: ${dashboardItems.length}`);
  console.log(`  With inventory: ${dashboardItems.filter(i => i.qtyOnHand > 0).length}`);
  console.log(`  With open PO: ${dashboardItems.filter(i => i.deliveryDate).length}`);

  // Extract dates from filenames for subtitle
  const invDateMatch = inventoryFolder.match(/(\d{4}-\d{2}-\d{2})/);
  const inventoryDate = invDateMatch ? invDateMatch[1] : 'unknown';
  const excelDateMatch = excelFile.match(/(\d{8})/);
  const excelDate = excelDateMatch
    ? excelDateMatch[1].replace(/(\d{2})(\d{2})(\d{4})/, '$1/$2/$3')
    : 'unknown';

  // Step 5: Generate HTML
  console.log('\nStep 5: Generating HTML dashboard...');
  const html = generateHTML(dashboardItems, inventoryDate, excelDate);
  fs.writeFileSync(outputFile, html);
  console.log(`  Output: ${outputFile}`);
  console.log(`  Size: ${(fs.statSync(outputFile).size / 1024).toFixed(0)} KB`);

  console.log('\nDone!');
}

function getDateStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
