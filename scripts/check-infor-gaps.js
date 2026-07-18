#!/usr/bin/env node
/**
 * Find Infor W111 POVs that have no OT tracking (no c_orderline record)
 */

const XLSX = require('xlsx');
const { Pool } = require('pg');

const pool = new Pool({
  host: '/var/run/postgresql',
  database: 'idempiere_replica',
  user: 'analytics_user',
});

async function findInforWithoutTracking() {
  // Load Infor W111 data
  const wb = XLSX.readFile('/home/analytics_user/workspace/file-drop/W103 OPEN POVs.xlsx', { raw: true });
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true });

  // Filter to W111 and get unique POVs
  const w111 = data.filter(r => r['Warehouse'] === 'W111');
  const povSet = new Set(w111.map(r => r['PO Number'].toString().trim()));
  const povList = [...povSet];

  console.log('W111 POVs in Infor:', povList.length);

  // Find which POVs exist in OT
  const result = await pool.query(`
    SELECT DISTINCT ol.chuboe_po_string as pov
    FROM adempiere.c_order o
    JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
    WHERE o.issotrx = 'N'
      AND o.docstatus IN ('CO', 'CL', 'IP')
      AND ol.chuboe_po_string = ANY($1)
  `, [povList]);

  const otPOVs = new Set(result.rows.map(r => r.pov));
  console.log('POVs found in OT:', otPOVs.size);

  // Find POVs NOT in OT
  const missingPOVs = povList.filter(pov => !otPOVs.has(pov));
  console.log('POVs WITHOUT OT RECORD (no tracking):', missingPOVs.length);
  console.log('');

  if (missingPOVs.length > 0) {
    console.log('=== INFOR POVs WITHOUT OT TRACKING ===');
    console.log('These need OT PO records created for delivery tracking.');
    console.log('');

    // Group lines by POV
    const missingByPOV = {};
    for (const row of w111) {
      const pov = row['PO Number'].toString().trim();
      if (missingPOVs.includes(pov)) {
        if (!missingByPOV[pov]) {
          missingByPOV[pov] = {
            vendor: row['Vendor Name'] || '',
            lines: []
          };
        }
        missingByPOV[pov].lines.push({
          mpn: row['Item'] || '',
          qtyOrdered: row['PO Quantity Ordered'] || 0,
          qtyReceived: row['PO Quantity Received'] || 0,
          qtyOpen: (row['PO Quantity Ordered'] || 0) - (row['PO Quantity Received'] || 0),
          dueDate: row['PO Due Date'] || ''
        });
      }
    }

    for (const pov of Object.keys(missingByPOV).sort()) {
      const data = missingByPOV[pov];
      const openLines = data.lines.filter(l => l.qtyOpen > 0);
      console.log(`${pov} | ${data.vendor}`);
      console.log(`  Lines: ${data.lines.length} total, ${openLines.length} still open`);
      for (const line of data.lines.slice(0, 15)) {
        const status = line.qtyOpen <= 0 ? '[RECEIVED]' : '';
        console.log(`  - ${line.mpn} | Ord: ${line.qtyOrdered} | Open: ${line.qtyOpen} ${status}`);
      }
      if (data.lines.length > 15) console.log(`  ... and ${data.lines.length - 15} more lines`);
      console.log('');
    }
  }

  await pool.end();
}

findInforWithoutTracking().catch(e => { console.error(e); process.exit(1); });
