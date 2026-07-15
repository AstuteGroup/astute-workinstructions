#!/usr/bin/env node
/**
 * LAM Delivery Alerts
 *
 * Analyze open POs to flag delivery status:
 * - PAST DUE: Promise date has passed, qty still open
 * - DUE THIS WEEK: Due within 7 days
 * - DUE NEXT WEEK: Due 8-14 days out
 * - ON TRACK: Due 15+ days out
 *
 * DATA SOURCES:
 * - OT (source of truth): Due dates from chuboe_orderline.datepromised
 *   (easily updated in OT; Infor requires support tickets)
 * - Infor PO Report (optional): Confirms PO existence and receipt status
 *
 * Usage:
 *   # Query OT for due dates (default, preferred)
 *   node lam-delivery-alerts.js
 *
 *   # Cross-reference with Infor for receipt confirmation
 *   node lam-delivery-alerts.js --infor="/path/to/W103 OPEN POVs.xlsx"
 *
 *   # Export to Excel
 *   node lam-delivery-alerts.js --excel
 *
 * Email for LAM workflows: lamkitting@orangetsunami.com
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { Pool } = require('pg');

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

const FILE_DROP = '/home/analytics_user/workspace/file-drop';
const OUTPUT_DIR = path.join(__dirname, '../Trading Analysis/LAM 3PL');
const INVENTORY_STORAGE = '/home/analytics_user/workspace/.inventory-storage';

// Lam Research customer ID
const LAM_RESEARCH_BP_ID = 1000730;

/**
 * Find the latest inventory folder
 */
function findLatestInventoryFolder() {
  if (fs.existsSync(INVENTORY_STORAGE)) {
    const folders = fs.readdirSync(INVENTORY_STORAGE)
      .filter(f => f.match(/^Inventory \d{4}-\d{2}-\d{2}$/))
      .sort()
      .reverse();
    if (folders.length > 0) {
      return path.join(INVENTORY_STORAGE, folders[0]);
    }
  }
  return null;
}

/**
 * Load inventory from W111/W115 CSVs to check receipt status
 */
function loadInventoryData(inventoryFolder) {
  if (!inventoryFolder) return null;

  let readCSVFile;
  try {
    readCSVFile = require('./csv-utils').readCSVFile;
  } catch (e) {
    console.warn('  csv-utils not available, skipping inventory check');
    return null;
  }

  const byMPN = new Map();
  const csvFiles = ['W111_LAM_3PL.csv', 'W115_LAM_Dead_Inventory.csv'];

  for (const csvFile of csvFiles) {
    const csvPath = path.join(inventoryFolder, csvFile);
    if (!fs.existsSync(csvPath)) continue;

    try {
      const rows = readCSVFile(csvPath);
      if (!rows || !Array.isArray(rows)) continue;

      for (const row of rows) {
        const mpn = (row['Chuboe_MPN'] || row['Item'] || '').toString().trim();
        if (!mpn) continue;

        const mpnKey = mpn.toUpperCase();
        const qty = parseFloat(row['Qty'] || row['Lot Quantity'] || 0);
        const warehouse = csvFile.includes('W111') ? 'W111' : 'W115';

        if (byMPN.has(mpnKey)) {
          byMPN.get(mpnKey).qty += qty;
        } else {
          byMPN.set(mpnKey, { mpn, qty, warehouse });
        }
      }
    } catch (e) {
      console.warn(`  Error reading ${csvFile}: ${e.message}`);
    }
  }

  return byMPN;
}

/**
 * Query OT for LAM POs with due dates
 * This is the SOURCE OF TRUTH for delivery dates
 *
 * Queries c_orderline (actual POs) filtered to specific POVs.
 * chuboe_po_string contains the POV number.
 * datepromised is the delivery date (easy to update in OT).
 *
 * @param {string[]} povList - List of POV numbers to query (from Infor W111)
 */
async function queryOTDeliveryStatus(povList = null) {
  let whereClause = `
    WHERE o.issotrx = 'N'  -- Purchase orders
      AND o.docstatus IN ('CO', 'CL', 'IP')  -- Completed/Closed/In Progress
      AND ol.chuboe_po_string IS NOT NULL
      AND ol.chuboe_po_string LIKE 'POV%'
      AND ol.chuboe_mpn IS NOT NULL
      AND ol.chuboe_mpn <> ''
  `;

  // Filter to specific POVs if provided (LAM W111 focus)
  if (povList && povList.length > 0) {
    whereClause += ` AND ol.chuboe_po_string = ANY($1)`;
  }

  const query = `
    SELECT
      UPPER(TRIM(ol.chuboe_mpn)) as mpn,
      ol.chuboe_po_string as pov_number,
      o.documentno as po_number,
      o.dateordered,
      ol.datepromised,
      ol.qtyordered,
      ol.qtydelivered,
      ol.qtyordered - ol.qtydelivered as qty_open,
      bp.name as vendor,
      wh.value as warehouse_code,
      CASE
        WHEN ol.qtydelivered >= ol.qtyordered THEN 'RECEIVED'
        WHEN ol.datepromised IS NULL THEN 'NO DATE'
        WHEN ol.datepromised < CURRENT_DATE THEN 'PAST DUE'
        WHEN ol.datepromised <= CURRENT_DATE + 7 THEN 'DUE THIS WEEK'
        WHEN ol.datepromised <= CURRENT_DATE + 14 THEN 'DUE NEXT WEEK'
        ELSE 'ON TRACK'
      END as status,
      CASE
        WHEN ol.datepromised IS NULL THEN NULL
        ELSE ol.datepromised::date - CURRENT_DATE
      END as days_out
    FROM adempiere.c_order o
    JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.m_warehouse wh ON ol.m_warehouse_id = wh.m_warehouse_id
    ${whereClause}
    ORDER BY
      CASE
        WHEN ol.qtydelivered >= ol.qtyordered THEN 5
        WHEN ol.datepromised IS NULL THEN 0
        WHEN ol.datepromised < CURRENT_DATE THEN 1
        WHEN ol.datepromised <= CURRENT_DATE + 7 THEN 2
        WHEN ol.datepromised <= CURRENT_DATE + 14 THEN 3
        ELSE 4
      END,
      ol.datepromised NULLS LAST
  `;

  const params = povList && povList.length > 0 ? [povList] : [];
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Load Infor PO data for cross-reference (receipt confirmation)
 * Filters to W111 warehouse (LAM 3PL)
 */
function loadInforPOData(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const wb = XLSX.readFile(filePath, { raw: true, cellDates: true });
  const sheetName = wb.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { raw: true, cellDates: true });

  // Filter to W111 warehouse
  const w111Data = data.filter(row => row['Warehouse'] === 'W111');

  // Build lookup by POV|MPN key
  const byKey = new Map();
  const allW111 = [];  // Keep all W111 rows for reverse lookup

  for (const row of w111Data) {
    const pov = (row['PO Number'] || row['POV'] || '').toString().trim();
    const mpn = (row['Item'] || row['MPN'] || '').toString().trim().toUpperCase();
    const vendor = row['Vendor Name'] || '';
    const qtyOrdered = parseFloat(row['PO Quantity Ordered'] || row['Qty Ordered'] || 0);
    const qtyReceived = parseFloat(row['PO Quantity Received'] || row['Qty Received'] || 0);
    const dueDate = row['PO Due Date'] || row['Due Date'] || null;

    if (!pov) continue;

    const key = `${pov}|${mpn}`;
    const record = {
      pov,
      mpn: row['Item'] || '',
      vendor,
      qtyOrdered,
      qtyReceived,
      qtyOpen: qtyOrdered - qtyReceived,
      inforDueDate: dueDate,
    };

    byKey.set(key, record);
    allW111.push(record);
  }

  return { byKey, allW111, totalW111: w111Data.length };
}

/**
 * Categorize and format alerts
 */
function processAlerts(otRows, inforData = null, inventoryData = null) {
  const alerts = [];
  const matchedInforKeys = new Set();

  for (const row of otRows) {
    const alert = {
      mpn: row.mpn,
      povNumber: row.pov_number,
      poNumber: row.po_number,
      vendor: row.vendor,
      warehouseCode: row.warehouse_code,
      qtyOrdered: parseFloat(row.qtyordered),
      qtyDelivered: parseFloat(row.qtydelivered),
      qtyOpen: parseFloat(row.qty_open),
      dueDate: row.datepromised ? new Date(row.datepromised).toISOString().split('T')[0] : null,
      daysOut: row.days_out,
      status: row.status,
      dateOrdered: row.dateordered ? new Date(row.dateordered).toISOString().split('T')[0] : null,
      source: 'OT',
    };

    // Check inventory for receipt status
    if (inventoryData) {
      const inv = inventoryData.get(row.mpn);
      if (inv && inv.qty > 0) {
        alert.qtyOnHand = inv.qty;
        alert.inInventory = true;
      }
    }

    // Cross-reference with Infor PO report
    if (inforData) {
      const key = `${row.pov_number}|${row.mpn}`;
      const infor = inforData.byKey.get(key);
      if (infor) {
        matchedInforKeys.add(key);
        alert.inforQtyOrdered = infor.qtyOrdered;
        alert.inforQtyReceived = infor.qtyReceived;
        alert.inforQtyOpen = infor.qtyOpen;
        alert.inforDueDate = infor.inforDueDate;
      } else {
        alert.notInInfor = true;
      }
    }

    // Refine status based on all data sources
    // OT qtydelivered already tells us if received in OT
    // Cross-check with inventory and Infor for discrepancies
    if (alert.qtyOpen <= 0) {
      alert.status = 'RECEIVED';
    } else if (alert.notInInfor && alert.inInventory) {
      // Not on Infor PO report but in inventory = received
      alert.status = 'RECEIVED';
    } else if (alert.notInInfor && !alert.inInventory) {
      // Not on Infor PO report, not in inventory = in transit
      alert.status = 'IN TRANSIT';
    }
    // Otherwise keep status from OT query (PAST DUE, DUE THIS WEEK, etc.)

    alerts.push(alert);
  }

  // Find Infor W111 items NOT in OT (no VQ record - can only use Infor dates)
  const inforOnly = [];
  if (inforData) {
    for (const row of inforData.allW111) {
      const key = `${row.pov}|${row.mpn.toUpperCase()}`;
      if (!matchedInforKeys.has(key) && row.qtyOpen > 0) {
        const alert = {
          mpn: row.mpn,
          povNumber: row.pov,
          vendor: row.vendor,
          qty: row.qtyOrdered,
          qtyOpen: row.qtyOpen,
          dueDate: parseInforDate(row.inforDueDate),
          status: 'NO OT RECORD',
          source: 'INFOR ONLY',
          note: 'No VQ in OT - due date from Infor (requires support to update)',
        };

        // Check inventory for this MPN too
        if (inventoryData) {
          const inv = inventoryData.get(row.mpn.toUpperCase());
          if (inv && inv.qty > 0) {
            alert.qtyOnHand = inv.qty;
          }
        }

        inforOnly.push(alert);
      }
    }
  }

  return { alerts, inforOnly };
}

/**
 * Parse Infor date (Excel serial or string)
 */
function parseInforDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + val * 24 * 60 * 60 * 1000);
    return date.toISOString().split('T')[0];
  }
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return val.toString();
}

/**
 * Format alerts as console table
 */
function formatTable(alerts) {
  const lines = [];
  lines.push('');
  lines.push('MPN | POV | Vendor | Open | Due Date (OT) | Days | Status');
  lines.push('--- | --- | ------ | ---- | ------------- | ---- | ------');

  for (const a of alerts) {
    const daysStr = a.daysOut !== null ? a.daysOut.toString() : '-';
    const qty = a.qtyOpen !== undefined ? a.qtyOpen : a.qty;
    lines.push(`${a.mpn} | ${a.povNumber} | ${a.vendor} | ${qty} | ${a.dueDate || '-'} | ${daysStr} | ${a.status}`);
  }

  return lines.join('\n');
}

/**
 * Export alerts to Excel
 */
function exportToExcel(alerts, outputPath, hasInforData = false) {
  const rows = alerts.map(a => {
    const row = {
      'MPN': a.mpn,
      'POV Number': a.povNumber,
      'PO Number': a.poNumber || '',
      'Vendor': a.vendor,
      'Warehouse': a.warehouseCode || '',
      'Qty Ordered': a.qtyOrdered ?? '',
      'Qty Delivered': a.qtyDelivered ?? '',
      'Qty Open': a.qtyOpen ?? '',
      'Due Date (OT)': a.dueDate || '',
      'Days Out': a.daysOut ?? '',
      'Status': a.status,
      'Date Ordered': a.dateOrdered || '',
    };

    if (hasInforData) {
      row['Infor Qty Open'] = a.inforQtyOpen ?? '';
      row['Not in Infor'] = a.notInInfor ? 'YES' : '';
    }

    row['Qty On Hand'] = a.qtyOnHand ?? '';

    return row;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths
  ws['!cols'] = [
    { wch: 25 },  // MPN
    { wch: 14 },  // POV Number
    { wch: 12 },  // PO Number
    { wch: 35 },  // Vendor
    { wch: 12 },  // Qty Ordered
    { wch: 12 },  // Qty Delivered
    { wch: 10 },  // Qty Open
    { wch: 12 },  // Due Date
    { wch: 10 },  // Days Out
    { wch: 15 },  // Status
    { wch: 12 },  // Date Ordered
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Delivery Alerts');

  // Summary sheet
  const counts = { 'PAST DUE': 0, 'DUE THIS WEEK': 0, 'DUE NEXT WEEK': 0, 'ON TRACK': 0, 'DELIVERED': 0, 'NO DATE': 0 };
  for (const a of alerts) {
    counts[a.status] = (counts[a.status] || 0) + 1;
  }

  const notInInforCount = alerts.filter(a => a.notInInfor).length;
  const receivedPerInfor = alerts.filter(a => a.status === 'RECEIVED (per Infor)').length;

  const summary = [
    { Category: 'PAST DUE', Count: counts['PAST DUE'] || 0, Description: 'Promise date passed (per OT)' },
    { Category: 'DUE THIS WEEK', Count: counts['DUE THIS WEEK'] || 0, Description: 'Due within 7 days' },
    { Category: 'DUE NEXT WEEK', Count: counts['DUE NEXT WEEK'] || 0, Description: 'Due 8-14 days out' },
    { Category: 'ON TRACK', Count: counts['ON TRACK'] || 0, Description: 'Due 15+ days out' },
    { Category: 'NO DATE', Count: counts['NO DATE'] || 0, Description: 'Missing due date in OT - needs update' },
    { Category: '', Count: '', Description: '' },
    { Category: 'Total Purchased VQs', Count: alerts.length, Description: '' },
    { Category: '', Count: '', Description: '' },
    { Category: 'DATA SOURCES', Count: '', Description: '' },
    { Category: 'Due Dates', Count: 'OT VQ datepromised', Description: 'Source of truth - easy to update' },
    { Category: 'Receipt Status', Count: 'Infor PO Report', Description: 'Cross-reference for confirmation' },
    { Category: '', Count: '', Description: '' },
    { Category: 'INFOR CROSS-REFERENCE', Count: '', Description: '' },
    { Category: 'RECEIVED (per Infor)', Count: receivedPerInfor, Description: 'Fully received in Infor' },
    { Category: 'Not in Infor PO Report', Count: notInInforCount, Description: 'May be in receiving process or received' },
    { Category: '', Count: '', Description: '' },
    { Category: 'NOTE', Count: '', Description: 'Parts drop off Infor PO report when receiving starts, before hitting inventory' },
    { Category: 'Generated', Count: new Date().toISOString(), Description: '' },
  ];
  const wsSummary = XLSX.utils.json_to_sheet(summary);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  XLSX.writeFile(wb, outputPath);
}

/**
 * Run delivery alerts analysis
 */
async function runDeliveryAlerts(options = {}) {
  const { inforFile = null, outputExcel = false } = options;

  console.log('LAM Delivery Alerts');
  console.log('===================');
  console.log('Data source: OT (datepromised is source of truth)\n');

  try {
    // Load Infor W111 data first to get POV list
    let inforData = null;
    let w111POVs = [];
    if (inforFile) {
      console.log(`Loading Infor PO report: ${path.basename(inforFile)}`);
      inforData = loadInforPOData(inforFile);
      if (inforData) {
        console.log(`  W111 lines: ${inforData.totalW111}`);
        // Extract unique POVs for OT query
        w111POVs = [...new Set(inforData.allW111.map(r => r.pov))];
        console.log(`  Unique POVs: ${w111POVs.length}`);
      }
    }

    // Query OT for LAM POs (filtered to W111 POVs)
    console.log('\nQuerying OT for LAM POs...');
    const otRows = await queryOTDeliveryStatus(w111POVs.length > 0 ? w111POVs : null);
    console.log(`  Found ${otRows.length} PO lines in OT`);

    // Load inventory data from OT (same source as threshold check)
    let inventoryData = null;
    try {
      const { getLAMInventoryByMPN } = require('./ot-inventory-reader');
      console.log('\nLoading inventory from OT...');
      const { byMPN, metadata } = await getLAMInventoryByMPN();
      inventoryData = byMPN;
      console.log(`  Offer: ${metadata.offerKey}`);
      console.log(`  Age: ${metadata.ageInDays} days`);
      console.log(`  ${inventoryData.size} MPNs with qty on hand`);
    } catch (e) {
      console.log('\nCould not load OT inventory:', e.message);
    }

    // Process alerts
    const { alerts, inforOnly } = processAlerts(otRows, inforData, inventoryData);

    // Count by status
    const counts = {};
    for (const a of alerts) {
      counts[a.status] = (counts[a.status] || 0) + 1;
    }

    console.log('\n=== SUMMARY ===');
    console.log(`  PAST DUE: ${counts['PAST DUE'] || 0}`);
    console.log(`  DUE THIS WEEK: ${counts['DUE THIS WEEK'] || 0}`);
    console.log(`  DUE NEXT WEEK: ${counts['DUE NEXT WEEK'] || 0}`);
    console.log(`  ON TRACK: ${counts['ON TRACK'] || 0}`);
    console.log(`  IN TRANSIT: ${counts['IN TRANSIT'] || 0} (off PO report, not yet in inventory)`);
    console.log(`  RECEIVED: ${counts['RECEIVED'] || 0} (confirmed in inventory)`);
    console.log(`  NO DATE: ${counts['NO DATE'] || 0}`);

    // When Infor data available, focus on items still open in Infor
    const infoAvailable = !!inforData;
    const stillOpen = infoAvailable
      ? alerts.filter(a => !a.notInInfor && a.status !== 'RECEIVED (per Infor)')
      : alerts;

    if (infoAvailable) {
      console.log(`\n=== ITEMS STILL OPEN IN INFOR (${stillOpen.length}) ===`);
    }

    // Show PAST DUE items (still open in Infor if cross-referenced)
    const pastDue = stillOpen.filter(a => a.status === 'PAST DUE');
    if (pastDue.length > 0) {
      console.log('\n=== PAST DUE (per OT datepromised) ===');
      console.log(formatTable(pastDue.slice(0, 30)));
      if (pastDue.length > 30) {
        console.log(`  ... and ${pastDue.length - 30} more`);
      }
    }

    // Show DUE THIS WEEK
    const dueThisWeek = stillOpen.filter(a => a.status === 'DUE THIS WEEK');
    if (dueThisWeek.length > 0) {
      console.log('\n=== DUE THIS WEEK ===');
      console.log(formatTable(dueThisWeek));
    }

    // Show DUE NEXT WEEK
    const dueNextWeek = stillOpen.filter(a => a.status === 'DUE NEXT WEEK');
    if (dueNextWeek.length > 0) {
      console.log('\n=== DUE NEXT WEEK ===');
      console.log(formatTable(dueNextWeek));
    }

    // Show ON TRACK
    const onTrack = stillOpen.filter(a => a.status === 'ON TRACK');
    if (onTrack.length > 0) {
      console.log('\n=== ON TRACK ===');
      console.log(formatTable(onTrack));
    }

    // Show NO DATE items (need attention)
    const noDate = stillOpen.filter(a => a.status === 'NO DATE');
    if (noDate.length > 0) {
      console.log('\n=== MISSING DUE DATE (needs update in OT) ===');
      console.log(formatTable(noDate.slice(0, 10)));
      if (noDate.length > 10) {
        console.log(`  ... and ${noDate.length - 10} more`);
      }
    }

    // Show items not in Infor (likely received or in receiving process)
    if (infoAvailable) {
      const notInInfor = alerts.filter(a => a.notInInfor);
      console.log(`\n=== NOT IN INFOR PO REPORT (${notInInfor.length}) ===`);
      console.log('  These are likely already received or in receiving process.');
      console.log('  * = timing gap between Infor PO close and inventory update');
    }

    // Export if requested
    if (outputExcel) {
      const outputPath = path.join(OUTPUT_DIR, `LAM_Delivery_Alerts_${new Date().toISOString().split('T')[0]}.xlsx`);
      exportToExcel(alerts, outputPath, !!inforData);
      console.log(`\nExported to: ${outputPath}`);
    }

    return { alerts, counts };

  } finally {
    await pool.end();
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  let inforFile = null;
  let outputExcel = false;

  for (const arg of args) {
    if (arg.startsWith('--infor=')) {
      inforFile = arg.split('=')[1];
    } else if (arg === '--excel' || arg === '--output') {
      outputExcel = true;
    }
  }

  runDeliveryAlerts({ inforFile, outputExcel })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('ERROR:', err.message);
      process.exit(1);
    });
}

module.exports = {
  runDeliveryAlerts,
  queryOTDeliveryStatus,
  loadInforPOData,
  processAlerts,
  formatTable,
  exportToExcel,
};
