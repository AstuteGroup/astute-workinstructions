#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { createNotifier } = require('./shared/notifier');
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Part Lines
  const partsSheet = workbook.addWorksheet('Part Lines');
  partsSheet.columns = [
    { header: 'VQ ID', key: 'vqId', width: 10 },
    { header: 'MPN', key: 'mpn', width: 28 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Unit Cost', key: 'cost', width: 12 },
    { header: 'Line Total', key: 'total', width: 14 },
  ];

  // Get VQs
  const vqResult = psqlQuery(`
    SELECT vl.chuboe_vq_line_id, vl.chuboe_mpn, vl.qty, vl.cost,
           vl.qty * vl.cost as line_total
    FROM adempiere.chuboe_vq_line vl
    JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
    WHERE rfq.value = '1139512'
      AND bp.name ILIKE '%Mouser%'
      AND vl.created::date = CURRENT_DATE
      AND vl.isactive = 'Y'
    ORDER BY vl.chuboe_mpn;
  `);

  let partsTotal = 0;
  let tariffTotal = 0;
  const tariffData = [];

  for (const line of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [id, mpn, qty, cost, total] = line.split('|').map(s => s.trim());
    if (mpn.startsWith('TARIFF')) {
      tariffData.push({
        vqId: parseInt(id),
        invoice: mpn.replace('TARIFF-INV', ''),
        amount: parseFloat(cost)
      });
      tariffTotal += parseFloat(cost);
    } else {
      partsSheet.addRow({
        vqId: parseInt(id),
        mpn: mpn,
        qty: parseInt(qty),
        cost: parseFloat(cost),
        total: parseFloat(total)
      });
      partsTotal += parseFloat(total);
    }
  }

  // Add totals row
  partsSheet.addRow({});
  partsSheet.addRow({ mpn: 'PARTS SUBTOTAL', total: partsTotal });

  // Format
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

  for (const t of tariffData) {
    tariffSheet.addRow(t);
  }
  tariffSheet.addRow({});
  tariffSheet.addRow({ invoice: 'TARIFF SUBTOTAL', amount: tariffTotal });

  tariffSheet.getRow(1).font = { bold: true };
  tariffSheet.getColumn('amount').numFmt = '$#,##0.00';

  // Sheet 3: Invoice Status
  const statusSheet = workbook.addWorksheet('Invoice Status');
  statusSheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 14 },
    { header: 'Tariff', key: 'tariff', width: 14 },
    { header: 'Status', key: 'status', width: 30 },
  ];

  const allInvoices = ['89497435', '89519101', '89568193', '89765460', '89821186', '90172966', '90302299', '90441161', '90893594', '90945447', '90969889', '91087894'];
  const tariffByInv = {};
  for (const t of tariffData) tariffByInv[t.invoice] = t.amount;

  for (const inv of allInvoices) {
    const tariff = tariffByInv[inv];
    statusSheet.addRow({
      invoice: inv,
      tariff: tariff !== undefined ? tariff : null,
      status: tariff !== undefined ? '✓ Done' : '? Verify - $0 or missing?'
    });
  }

  statusSheet.getRow(1).font = { bold: true };
  statusSheet.getColumn('tariff').numFmt = '$#,##0.00';

  // Sheet 4: Summary
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Category', key: 'cat', width: 20 },
    { header: 'Count', key: 'count', width: 10 },
    { header: 'Amount', key: 'amount', width: 14 },
  ];

  summarySheet.addRow({ cat: 'Part Lines', count: partsSheet.rowCount - 3, amount: partsTotal });
  summarySheet.addRow({ cat: 'Tariff Lines', count: tariffData.length, amount: tariffTotal });
  summarySheet.addRow({});
  summarySheet.addRow({ cat: 'GRAND TOTAL', count: partsSheet.rowCount - 3 + tariffData.length, amount: partsTotal + tariffTotal });

  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getRow(4).font = { bold: true };
  summarySheet.getColumn('amount').numFmt = '$#,##0.00';

  // Save
  const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_POV0075257_Reconciliation.xlsx';
  await workbook.xlsx.writeFile(outputPath);
  console.log(`Excel written to: ${outputPath}`);

  // Send email
  const notifier = createNotifier({
    fromEmail: 'lamkitting@orangetsunami.com',
    fromName: 'LAM Reconciliation'
  });

  await notifier.sendWithAttachment(
    'jake.harris@astutegroup.com',
    'Mouser POV0075257 Reconciliation',
    `Mouser POV0075257 Reconciliation attached.

RFQ: 1139512
Vendor: Mouser Electronics
12 Invoices processed

Summary:
- Parts: 24 lines, $${partsTotal.toFixed(2)}
- Tariffs: 5 lines, $${tariffTotal.toFixed(2)}
- Total: $${(partsTotal + tariffTotal).toFixed(2)}

7 invoices need tariff verification (marked with ? in Invoice Status tab).`,
    [{ filename: 'Mouser_POV0075257_Reconciliation.xlsx', path: outputPath }]
  );

  console.log('Email sent with attachment!');
}

main().catch(console.error);
