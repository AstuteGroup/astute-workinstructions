#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();

  // Part Lines data
  const partLines = [
    { vqId: 2228037, mpn: '0216.200MXP', qty: 140, cost: 1.19, total: 166.60 },
    { vqId: 2228021, mpn: '0505012.MXP', qty: 160, cost: 3.08, total: 492.80 },
    { vqId: 2228032, mpn: '10139781-122402LF', qty: 105, cost: 5.29, total: 555.45 },
    { vqId: 2228014, mpn: '42819-5223', qty: 25, cost: 11.94, total: 298.50 },
    { vqId: 2228025, mpn: 'C0805C102JBRACTU', qty: 1000, cost: 0.137, total: 137.00 },
    { vqId: 2228028, mpn: 'C1812C224J1RACTU', qty: 300, cost: 0.649, total: 194.70 },
    { vqId: 2228033, mpn: 'ECS-TXO-3225MV-160-TR', qty: 150, cost: 1.59, total: 238.50 },
    { vqId: 2228036, mpn: 'H11N1SR2M', qty: 200, cost: 1.08, total: 216.00 },
    { vqId: 2228019, mpn: 'IP5-04-05.0-L-S-1-L-TR', qty: 50, cost: 9.86, total: 493.00 },
    { vqId: 2228022, mpn: 'IXFY26N30X3', qty: 70, cost: 2.49, total: 174.30 },
    { vqId: 2228018, mpn: 'RA73F1J200RBTDF', qty: 165, cost: 1.46, total: 240.90 },
    { vqId: 2228026, mpn: 'RG2012P-1071-B-T5', qty: 3000, cost: 0.069, total: 207.00 },
    { vqId: 2228029, mpn: 'RG2012P-1961-B-T5', qty: 555, cost: 0.098, total: 54.39 },
    { vqId: 2228027, mpn: 'RG2012P-2101-B-T5', qty: 3000, cost: 0.069, total: 207.00 },
    { vqId: 2228020, mpn: 'RG2012P-2742-B-T5', qty: 561, cost: 0.073, total: 40.95 },
    { vqId: 2228017, mpn: 'SCT3022ALGC11', qty: 50, cost: 40.29, total: 2014.50 },
    { vqId: 2228030, mpn: 'SHV24-1A85-78D3K', qty: 431, cost: 9.54, total: 4111.74 },
    { vqId: 2228016, mpn: 'SL-120-G-10', qty: 35, cost: 8.75, total: 306.25 },
    { vqId: 2228031, mpn: 'SMCJ1.5KE30A-TP', qty: 630, cost: 0.293, total: 184.59 },
    { vqId: 2228023, mpn: 'SRU2013-2R2Y', qty: 350, cost: 0.518, total: 181.30 },
    { vqId: 2228015, mpn: 'SSW-104-06-G-S', qty: 150, cost: 1.21, total: 181.50 },
    { vqId: 2228035, mpn: 'TNPW0402249RBYEP', qty: 650, cost: 0.333, total: 216.45 },
    { vqId: 2228034, mpn: 'TNPW08051K91BEEN', qty: 625, cost: 0.388, total: 242.50 },
    { vqId: 2228024, mpn: 'TNPW120690K9BEEA', qty: 650, cost: 0.272, total: 176.80 },
  ];

  // Tariff Lines data
  const tariffLines = [
    { vqId: 2228067, invoice: '89497435', amount: 99.65 },
    { vqId: 2228068, invoice: '89519101', amount: 94.41 },
    { vqId: 2228069, invoice: '89568193', amount: 778.90 },
    { vqId: 2228070, invoice: '89765460', amount: 7.28 },
    { vqId: 2228071, invoice: '90441161', amount: 0.31 },
  ];

  const partsTotal = partLines.reduce((sum, p) => sum + p.total, 0);
  const tariffTotal = tariffLines.reduce((sum, t) => sum + t.amount, 0);

  // Sheet 1: Part Lines
  const partsSheet = workbook.addWorksheet('Part Lines');
  partsSheet.columns = [
    { header: 'VQ ID', key: 'vqId', width: 10 },
    { header: 'MPN', key: 'mpn', width: 28 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Unit Cost', key: 'cost', width: 12 },
    { header: 'Line Total', key: 'total', width: 14 },
  ];

  for (const p of partLines) {
    partsSheet.addRow(p);
  }
  partsSheet.addRow({});
  partsSheet.addRow({ mpn: 'PARTS SUBTOTAL', total: partsTotal });

  partsSheet.getRow(1).font = { bold: true };
  partsSheet.getColumn('cost').numFmt = '$#,##0.000';
  partsSheet.getColumn('total').numFmt = '$#,##0.00';

  // Sheet 2: Tariff Lines
  const tariffSheet = workbook.addWorksheet('Tariff Lines');
  tariffSheet.columns = [
    { header: 'VQ ID', key: 'vqId', width: 10 },
    { header: 'Invoice', key: 'invoice', width: 14 },
    { header: 'Tariff Amount', key: 'amount', width: 14 },
  ];

  for (const t of tariffLines) {
    tariffSheet.addRow(t);
  }
  tariffSheet.addRow({});
  tariffSheet.addRow({ invoice: 'TARIFF SUBTOTAL', amount: tariffTotal });

  tariffSheet.getRow(1).font = { bold: true };
  tariffSheet.getColumn('amount').numFmt = '$#,##0.00';

  // Sheet 3: Summary
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Category', key: 'cat', width: 20 },
    { header: 'Count', key: 'count', width: 10 },
    { header: 'Amount', key: 'amount', width: 14 },
  ];

  summarySheet.addRow({ cat: 'Part Lines', count: partLines.length, amount: partsTotal });
  summarySheet.addRow({ cat: 'Tariff Lines', count: tariffLines.length, amount: tariffTotal });
  summarySheet.addRow({});
  summarySheet.addRow({ cat: 'GRAND TOTAL', count: partLines.length + tariffLines.length, amount: partsTotal + tariffTotal });

  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getRow(4).font = { bold: true };
  summarySheet.getColumn('amount').numFmt = '$#,##0.00';

  // Save
  const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_POV0075257_Reconciliation.xlsx';
  await workbook.xlsx.writeFile(outputPath);
  console.log(`Excel written to: ${outputPath}`);
  console.log(`\nSummary:`);
  console.log(`  Parts: ${partLines.length} lines, $${partsTotal.toFixed(2)}`);
  console.log(`  Tariffs: ${tariffLines.length} lines, $${tariffTotal.toFixed(2)}`);
  console.log(`  Total: $${(partsTotal + tariffTotal).toFixed(2)}`);
}

main().catch(console.error);
