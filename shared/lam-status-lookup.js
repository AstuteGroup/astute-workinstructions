#!/usr/bin/env node
/**
 * LAM Status Lookup
 *
 * Query status for a list of LAM MPNs by combining:
 * 1. Master Roster (contract data: threshold, pricing, MOQ)
 * 2. Weekly Infor CSVs (inventory levels: W111 + W115)
 * 3. OT (POs, delivery dates, tracking, recent activity)
 *
 * Usage:
 *   // As module
 *   const { lookupLAMStatus } = require('./lam-status-lookup');
 *   const results = await lookupLAMStatus(['MPN1', 'MPN2', ...]);
 *
 *   // CLI
 *   node lam-status-lookup.js MPN1 MPN2 MPN3
 *   node lam-status-lookup.js --file mpn-list.txt
 *   node lam-status-lookup.js --cpc 668-A51501-015
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { readCSVFile } = require('./csv-utils');

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

const BASE_DIR = path.join(__dirname, '..');
const LAM_DIR = path.join(BASE_DIR, 'Trading Analysis/LAM 3PL');
const INVENTORY_STORAGE = '/home/analytics_user/workspace/.inventory-storage';

/**
 * Find the latest inventory folder
 */
function findLatestInventoryFolder() {
  // Check .inventory-storage first
  if (fs.existsSync(INVENTORY_STORAGE)) {
    const folders = fs.readdirSync(INVENTORY_STORAGE)
      .filter(f => f.match(/^Inventory \d{4}-\d{2}-\d{2}$/))
      .sort()
      .reverse();
    if (folders.length > 0) {
      return path.join(INVENTORY_STORAGE, folders[0]);
    }
  }

  // Check LAM 3PL output folder
  const invCleanupDir = path.join(BASE_DIR, 'Trading Analysis/Inventory File Cleanup');
  if (fs.existsSync(invCleanupDir)) {
    const folders = fs.readdirSync(invCleanupDir)
      .filter(f => f.match(/^Inventory \d{4}-\d{2}-\d{2}$/))
      .sort()
      .reverse();
    if (folders.length > 0) {
      return path.join(invCleanupDir, folders[0]);
    }
  }

  return null;
}

/**
 * Load Master Roster
 */
function loadMasterRoster() {
  const rosterPath = path.join(LAM_DIR, 'LAM_Master_Roster.xlsx');
  if (!fs.existsSync(rosterPath)) {
    throw new Error('LAM_Master_Roster.xlsx not found. Run build-lam-master-roster.js first.');
  }

  const wb = XLSX.readFile(rosterPath, { raw: true });
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Master Roster'], { raw: true });

  const byMPN = new Map();
  const byCPC = new Map();

  for (const row of data) {
    const mpn = (row['MPN'] || '').toString().trim();
    const cpc = (row['CPC'] || '').toString().trim();

    const record = {
      mpn,
      cpc,
      mfr: row['Manufacturer'] || '',
      description: row['Description'] || '',
      leadTime: row['Contractual Lead Time'] || '',
      basePrice: row['Base Unit Price'],
      resalePrice: row['Resale Price'],
      threshold: row['Reorder Threshold'],
      moq: row['MOQ'],
      buyer: row['Buyer'] || '',
      award: row['Award'] || '',
      hasThreshold: row['Reorder Threshold'] !== undefined && row['Reorder Threshold'] !== '',
    };

    if (mpn) byMPN.set(mpn.toUpperCase(), record);
    if (cpc) byCPC.set(cpc.toUpperCase(), record);
  }

  return { byMPN, byCPC, count: data.length };
}

/**
 * Load inventory from weekly Infor CSVs
 */
function loadInventoryFromCSVs(inventoryFolder) {
  const byMPN = new Map();

  const csvFiles = ['W111_LAM_3PL.csv', 'W115_LAM_Dead_Inventory.csv'];

  for (const csvFile of csvFiles) {
    const csvPath = path.join(inventoryFolder, csvFile);
    if (!fs.existsSync(csvPath)) continue;

    const rows = readCSVFile(csvPath);
    for (const row of rows) {
      const mpn = (row['Chuboe_MPN'] || row['Item'] || '').toString().trim();
      if (!mpn) continue;

      const mpnKey = mpn.toUpperCase();
      const qty = parseFloat(row['Qty'] || row['Lot Quantity'] || 0);
      const warehouse = csvFile.includes('W111') ? 'W111' : 'W115';

      if (byMPN.has(mpnKey)) {
        const existing = byMPN.get(mpnKey);
        existing.totalQty += qty;
        existing.lots.push({ warehouse, qty, lot: row['Chuboe_Package_Desc'] || row['Lot'] });
      } else {
        byMPN.set(mpnKey, {
          mpn,
          totalQty: qty,
          lots: [{ warehouse, qty, lot: row['Chuboe_Package_Desc'] || row['Lot'] }]
        });
      }
    }
  }

  return byMPN;
}

/**
 * Query OT for PO/delivery data for a list of MPNs
 */
async function queryOTStatus(mpns) {
  if (mpns.length === 0) return new Map();

  // Build MPN list for SQL
  const mpnList = mpns.map(m => m.toUpperCase());

  const query = `
    WITH lam_orders AS (
      SELECT
        UPPER(TRIM(olm.chuboe_mpn)) as mpn,
        o.documentno as po_number,
        ol.chuboe_po_string as pov_number,
        o.dateordered,
        ol.datepromised,
        ol.qtyordered,
        ol.qtydelivered,
        ol.qtyordered - ol.qtydelivered as qty_open,
        bp.name as vendor,
        CASE
          WHEN ol.qtydelivered >= ol.qtyordered THEN 'DELIVERED'
          WHEN ol.datepromised < CURRENT_DATE THEN 'PAST DUE'
          WHEN ol.datepromised <= CURRENT_DATE + 7 THEN 'DUE THIS WEEK'
          ELSE 'ON ORDER'
        END as status
      FROM adempiere.c_order o
      JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
      JOIN adempiere.chuboe_orderline_mpn olm ON ol.c_orderline_id = olm.c_orderline_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      WHERE o.issotrx = 'N'  -- Purchase orders only
        AND o.docstatus IN ('CO', 'CL')  -- Completed/Closed
        AND UPPER(TRIM(olm.chuboe_mpn)) = ANY($1)
        AND (
          ol.qtydelivered < ol.qtyordered  -- Still open
          OR o.dateordered > CURRENT_DATE - 90  -- Or recent (last 90 days)
        )
    )
    SELECT * FROM lam_orders
    ORDER BY mpn, dateordered DESC
  `;

  try {
    const result = await pool.query(query, [mpnList]);

    const byMPN = new Map();
    for (const row of result.rows) {
      const mpn = row.mpn;
      if (!byMPN.has(mpn)) {
        byMPN.set(mpn, { orders: [], totalOnOrder: 0 });
      }
      const entry = byMPN.get(mpn);
      entry.orders.push({
        poNumber: row.po_number,
        povNumber: row.pov_number,
        dateOrdered: row.dateordered,
        datePromised: row.datepromised,
        qtyOrdered: parseFloat(row.qtyordered),
        qtyDelivered: parseFloat(row.qtydelivered),
        qtyOpen: parseFloat(row.qty_open),
        vendor: row.vendor,
        status: row.status,
      });
      if (row.qty_open > 0) {
        entry.totalOnOrder += parseFloat(row.qty_open);
      }
    }

    return byMPN;
  } catch (err) {
    console.error('OT query error:', err.message);
    return new Map();
  }
}

/**
 * Lookup status for a list of MPNs (or CPCs)
 *
 * @param {string[]} identifiers - MPNs or CPCs to look up
 * @param {Object} options
 * @param {boolean} options.byCPC - Treat identifiers as CPCs instead of MPNs
 * @param {string} options.inventoryFolder - Override inventory folder path
 * @returns {Promise<Array>} Status records
 */
async function lookupLAMStatus(identifiers, options = {}) {
  const { byCPC = false, inventoryFolder = null } = options;

  // Load data sources
  const roster = loadMasterRoster();
  const invFolder = inventoryFolder || findLatestInventoryFolder();
  const inventory = invFolder ? loadInventoryFromCSVs(invFolder) : new Map();

  // Resolve identifiers to MPNs
  const lookupMap = byCPC ? roster.byCPC : roster.byMPN;
  const mpnsToQuery = [];
  const results = [];

  for (const id of identifiers) {
    const key = id.toString().trim().toUpperCase();
    const contractData = lookupMap.get(key);

    if (!contractData) {
      results.push({
        input: id,
        found: false,
        error: byCPC ? 'CPC not found in roster' : 'MPN not found in roster',
      });
      continue;
    }

    mpnsToQuery.push(contractData.mpn.toUpperCase());
    results.push({
      input: id,
      found: true,
      ...contractData,
    });
  }

  // Query OT for all MPNs at once
  const otData = await queryOTStatus(mpnsToQuery);

  // Combine all data
  for (const result of results) {
    if (!result.found) continue;

    const mpnKey = result.mpn.toUpperCase();

    // Add inventory
    const inv = inventory.get(mpnKey);
    result.qtyOnHand = inv ? inv.totalQty : 0;
    result.lots = inv ? inv.lots : [];

    // Add OT data
    const ot = otData.get(mpnKey);
    result.onOrder = ot ? ot.totalOnOrder : 0;
    result.orders = ot ? ot.orders : [];

    // Compute status
    const threshold = parseFloat(result.threshold) || 0;
    const available = result.qtyOnHand + result.onOrder;

    if (!result.hasThreshold) {
      result.status = 'NO THRESHOLD';
    } else if (result.qtyOnHand === 0 && result.onOrder === 0) {
      result.status = 'CRITICAL - ZERO STOCK';
    } else if (result.qtyOnHand < threshold && result.onOrder === 0) {
      result.status = 'BELOW THRESHOLD - NEEDS REORDER';
    } else if (result.qtyOnHand < threshold && result.onOrder > 0) {
      result.status = 'BELOW THRESHOLD - ON ORDER';
    } else {
      result.status = 'OK';
    }

    // Next delivery (soonest promise date with open qty)
    const openOrders = (result.orders || []).filter(o => o.qtyOpen > 0);
    if (openOrders.length > 0) {
      openOrders.sort((a, b) => new Date(a.datePromised) - new Date(b.datePromised));
      result.nextDelivery = {
        date: openOrders[0].datePromised,
        qty: openOrders[0].qtyOpen,
        vendor: openOrders[0].vendor,
        pov: openOrders[0].povNumber,
      };
    }
  }

  return results;
}

/**
 * Format results as a table
 */
function formatTable(results) {
  const lines = [];
  lines.push('');
  lines.push('MPN | CPC | Stock | Threshold | On Order | Status | Next Delivery');
  lines.push('--- | --- | ----- | --------- | -------- | ------ | -------------');

  for (const r of results) {
    if (!r.found) {
      lines.push(`${r.input} | - | - | - | - | NOT FOUND | -`);
      continue;
    }

    const nextDel = r.nextDelivery
      ? `${r.nextDelivery.date?.toISOString?.().split('T')[0] || r.nextDelivery.date} (${r.nextDelivery.qty} from ${r.nextDelivery.vendor})`
      : '-';

    lines.push(`${r.mpn} | ${r.cpc} | ${r.qtyOnHand} | ${r.threshold || '-'} | ${r.onOrder} | ${r.status} | ${nextDel}`);
  }

  return lines.join('\n');
}

/**
 * Export results to Excel
 */
function exportToExcel(results, outputPath) {
  const rows = results.map(r => ({
    'MPN': r.mpn || r.input,
    'CPC': r.cpc || '',
    'Manufacturer': r.mfr || '',
    'Description': r.description || '',
    'Qty On Hand': r.qtyOnHand ?? '',
    'Threshold': r.threshold ?? '',
    'On Order': r.onOrder ?? '',
    'Status': r.status || (r.found ? '' : 'NOT FOUND'),
    'Base Price': r.basePrice ?? '',
    'Resale Price': r.resalePrice ?? '',
    'MOQ': r.moq ?? '',
    'Buyer': r.buyer || '',
    'Award': r.award || '',
    'Next Delivery Date': r.nextDelivery?.date || '',
    'Next Delivery Qty': r.nextDelivery?.qty || '',
    'Next Delivery Vendor': r.nextDelivery?.vendor || '',
    'Next Delivery POV': r.nextDelivery?.pov || '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'LAM Status');
  XLSX.writeFile(wb, outputPath);
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  let identifiers = [];
  let byCPC = false;
  let outputFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cpc') {
      byCPC = true;
    } else if (args[i] === '--file' && args[i + 1]) {
      const content = fs.readFileSync(args[i + 1], 'utf-8');
      identifiers.push(...content.split('\n').map(l => l.trim()).filter(l => l));
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputFile = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      identifiers.push(args[i]);
    }
  }

  if (identifiers.length === 0) {
    console.log('Usage:');
    console.log('  node lam-status-lookup.js MPN1 MPN2 MPN3');
    console.log('  node lam-status-lookup.js --cpc CPC1 CPC2');
    console.log('  node lam-status-lookup.js --file mpn-list.txt');
    console.log('  node lam-status-lookup.js --file mpn-list.txt --output status.xlsx');
    process.exit(1);
  }

  console.log(`Looking up ${identifiers.length} ${byCPC ? 'CPC(s)' : 'MPN(s)'}...`);

  lookupLAMStatus(identifiers, { byCPC })
    .then(results => {
      console.log(formatTable(results));

      if (outputFile) {
        exportToExcel(results, outputFile);
        console.log(`\nExported to: ${outputFile}`);
      }

      pool.end();
    })
    .catch(err => {
      console.error('Error:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = {
  lookupLAMStatus,
  loadMasterRoster,
  loadInventoryFromCSVs,
  queryOTStatus,
  formatTable,
  exportToExcel,
  findLatestInventoryFolder,
};
