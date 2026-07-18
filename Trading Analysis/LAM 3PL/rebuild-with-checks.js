#!/usr/bin/env node
const ExcelJS = require('exceljs');
const { readCSVFile } = require('../../shared/csv-utils');
const fs = require('fs');
const path = require('path');

async function main() {
  const baseDir = __dirname;

  // Load the base alerts CSV
  const csv = readCSVFile(path.join(baseDir, 'output/LAM_Reorder_Alerts_2026-07-13.csv'));
  const cpcIdx = csv.headers.indexOf('Lam P/N');

  // Load check data
  const wrongWarehouseData = JSON.parse(fs.readFileSync(path.join(baseDir, 'output/LAM_Wrong_Warehouse_2026-07-13.json'), 'utf-8'));
  const pendingOrdersData = JSON.parse(fs.readFileSync(path.join(baseDir, 'output/LAM_Pending_Orders_2026-07-13.json'), 'utf-8'));

  // Add check columns to headers
  const allHeaders = [...csv.headers, 'Check: Wrong WH', 'Check: Pending Order'];

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Reorder Alerts');

  // Header row
  ws.addRow(allHeaders);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  let wwCount = 0, poCount = 0;
  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const cpc = (row[cpcIdx] || '').trim();

    // Check columns - lookup by CPC
    let wrongWhFlag = '';
    let pendingOrderFlag = '';
    if (wrongWarehouseData[cpc]) {
      const wwInfo = wrongWarehouseData[cpc];
      const misplaced = wwInfo.filter(w => w.isLAMLoc);
      if (misplaced.length > 0) {
        wrongWhFlag = 'MISPLACED - ' + misplaced.map(w => w.wh).join(', ');
      } else {
        wrongWhFlag = 'Review - ' + wwInfo.map(w => w.wh + ' (' + w.status + ')').join('; ');
      }
      wwCount++;
    }
    if (pendingOrdersData[cpc]) {
      const poInfo = pendingOrdersData[cpc];
      pendingOrderFlag = poInfo.map(p => p.status + ' - ' + p.supplier + ' (' + p.days_stuck + ' days)').join('; ');
      poCount++;
    }

    const rowData = [...row, wrongWhFlag, pendingOrderFlag];
    ws.addRow(rowData);
  }

  // Format columns
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const outPath = path.join(baseDir, 'output/LAM_Reorder_Alerts_2026-07-13_with_checks.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('Excel generated:', outPath);
  console.log('  ' + wwCount + ' parts flagged in wrong warehouse');
  console.log('  ' + poCount + ' parts with pending orders');
}

main().catch(err => { console.error(err); process.exit(1); });
