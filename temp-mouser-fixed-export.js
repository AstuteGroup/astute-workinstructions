#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();

  // All invoice data - tracking only applies to shipped items
  const invoices = [
    // POV0075257
    {
      invoice: '89497435', pov: 'POV0075257', date: '26-MAR-26', shipDate: 'Mar 26, 2026',
      tracking: '518989245440', weight: '7.00 lb',
      merchandise: 3353.15, tariff: 99.65, total: 3452.80,
      lines: [
        { line: 1, mfgPn: '42819-5223', desc: 'Molex MiniFit Sr Hdr Vert', qtyOrd: 25, qtyShip: 25, price: 11.94, ext: 298.50, tariff: 59.75 },
        { line: 2, mfgPn: 'SSW-104-06-G-S', desc: 'Samtec Tiger Buy Socket Str', qtyOrd: 75, qtyShip: 0, price: 1.21, ext: 0, tariff: 0 },
        { line: 3, mfgPn: 'SL-120-G-10', desc: 'Samtec .100 Low Profile Sin', qtyOrd: 35, qtyShip: 35, price: 8.75, ext: 306.25, tariff: 39.90 },
        { line: 4, mfgPn: 'SCT3022ALGC11', desc: 'ROHM N-Ch 650V SiC MOSFETs', qtyOrd: 50, qtyShip: 50, price: 40.29, ext: 2014.50, tariff: 0 },
        { line: 5, mfgPn: 'RA73F1J200RBTDF', desc: 'TE Thin Film Resistors', qtyOrd: 165, qtyShip: 165, price: 1.46, ext: 240.90, tariff: 0 },
        { line: 6, mfgPn: 'IP5-04-05.0-L-S-1-L-TR', desc: 'Samtec IsoRate Connectors', qtyOrd: 50, qtyShip: 50, price: 9.86, ext: 493.00, tariff: 0 },
      ]
    },
    {
      invoice: '89519101', pov: 'POV0075257', date: '27-MAR-26', shipDate: 'Mar 27, 2026',
      tracking: '518989428660', weight: '7.00 lb',
      merchandise: 1858.60, tariff: 94.41, total: 1953.01,
      lines: [
        { line: 1, mfgPn: 'RG2012P-2742-B-T5', desc: 'Susumu 27.4K Ohm Resistors', qtyOrd: 561, qtyShip: 561, price: 0.073, ext: 40.95, tariff: 0 },
        { line: 2, mfgPn: '0505012.MXP', desc: 'Littelfuse 12A Fuses', qtyOrd: 160, qtyShip: 160, price: 3.08, ext: 492.80, tariff: 39.36 },
        { line: 3, mfgPn: 'IXFY26N30X3', desc: 'IXYS N-CH MOSFETs', qtyOrd: 70, qtyShip: 70, price: 2.49, ext: 174.30, tariff: 0 },
        { line: 4, mfgPn: 'SRU2013-2R2Y', desc: 'Bourns 2.2uH Inductors', qtyOrd: 350, qtyShip: 350, price: 0.518, ext: 181.30, tariff: 14.35 },
        { line: 5, mfgPn: 'TNPW120690K9BEEA', desc: 'Vishay 90.9K Resistors', qtyOrd: 650, qtyShip: 650, price: 0.272, ext: 176.80, tariff: 0 },
        { line: 6, mfgPn: 'C0805C102JBRACTU', desc: 'KEMET 1000pF MLCC', qtyOrd: 1000, qtyShip: 1000, price: 0.137, ext: 137.00, tariff: 0 },
        { line: 7, mfgPn: 'RG2012P-1071-B-T5', desc: 'Susumu 1.07K Resistors', qtyOrd: 3000, qtyShip: 3000, price: 0.069, ext: 207.00, tariff: 0 },
        { line: 8, mfgPn: 'RG2012P-2101-B-T5', desc: 'Susumu 2.1K Resistors', qtyOrd: 3000, qtyShip: 3000, price: 0.069, ext: 207.00, tariff: 24.00 },
        { line: 9, mfgPn: 'C1812C224J1RACTU', desc: 'KEMET 0.22uF MLCC', qtyOrd: 300, qtyShip: 300, price: 0.649, ext: 194.70, tariff: 0 },
        { line: 10, mfgPn: 'RG2012P-1961-B-T5', desc: 'Susumu 1.96K Resistors', qtyOrd: 516, qtyShip: 477, price: 0.098, ext: 46.75, tariff: 16.70 },
      ]
    },
    {
      invoice: '89568193', pov: 'POV0075257', date: '30-MAR-26', shipDate: 'Mar 30, 2026',
      tracking: '519883511560', weight: '11.00 lb',
      merchandise: 5931.83, tariff: 778.90, total: 6710.73,
      lines: [
        { line: 1, mfgPn: 'SHV24-1A85-78D3K', desc: 'MEDER Reed Relays', qtyOrd: 431, qtyShip: 431, price: 9.54, ext: 4111.74, tariff: 577.54 },
        { line: 2, mfgPn: 'SMCJ1.5KE30A-TP', desc: 'MCC ESD Protection', qtyOrd: 630, qtyShip: 630, price: 0.293, ext: 184.59, tariff: 129.15 },
        { line: 3, mfgPn: '10139781-122402LF', desc: 'Amphenol Mezzanine', qtyOrd: 105, qtyShip: 105, price: 5.29, ext: 555.45, tariff: 55.55 },
        { line: 4, mfgPn: 'ECS-TXO-3225MV-160-TR', desc: 'ECS TCXO Oscillators', qtyOrd: 150, qtyShip: 150, price: 1.59, ext: 238.50, tariff: 0 },
        { line: 5, mfgPn: 'TNPW08051K91BEEN', desc: 'Vishay 1.91K Resistors', qtyOrd: 625, qtyShip: 625, price: 0.388, ext: 242.50, tariff: 0 },
        { line: 6, mfgPn: 'TNPW0402249RBYEP', desc: 'Vishay 249ohm Resistors', qtyOrd: 650, qtyShip: 650, price: 0.333, ext: 216.45, tariff: 0 },
        { line: 7, mfgPn: 'H11N1SR2M', desc: 'onsemi Optocouplers', qtyOrd: 200, qtyShip: 200, price: 1.08, ext: 216.00, tariff: 0 },
        { line: 8, mfgPn: '0216.200MXP', desc: 'Littelfuse .2A Fuses', qtyOrd: 140, qtyShip: 140, price: 1.19, ext: 166.60, tariff: 16.66 },
      ]
    },
    {
      invoice: '89765460', pov: 'POV0075257', date: '13-APR-26', shipDate: 'Apr 13, 2026',
      tracking: '520858061244', weight: '3.00 lb',
      merchandise: 90.75, tariff: 7.28, total: 98.03,
      lines: [
        { line: 2, mfgPn: 'SSW-104-06-G-S', desc: 'Samtec Tiger Buy Socket', qtyOrd: 75, qtyShip: 75, price: 1.21, ext: 90.75, tariff: 7.28 },
      ]
    },
    {
      invoice: '90441161', pov: 'POV0075257', date: '20-MAY-26', shipDate: 'May 20, 2026',
      tracking: '525458371932', weight: '3.00 lb',
      merchandise: 3.82, tariff: 0.31, total: 4.13,
      lines: [
        { line: 10, mfgPn: 'RG2012P-1961-B-T5', desc: 'Susumu 1.96K Resistors', qtyOrd: 39, qtyShip: 39, price: 0.098, ext: 3.82, tariff: 0.31 },
      ]
    },
    // POV0075563
    {
      invoice: '89821186', pov: 'POV0075563', date: '14-APR-26', shipDate: 'Apr 14, 2026',
      tracking: '520858359297', weight: '13.00 lb',
      merchandise: 882.70, tariff: 55.30, total: 938.00,
      lines: [
        { line: 2, mfgPn: 'K202XHT-E9S-N', desc: 'Kycon D-Sub Connectors', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 3, mfgPn: 'CRCW201020K0FKTF', desc: 'Vishay 20K Resistors', qtyOrd: 800, qtyShip: 800, price: 0.151, ext: 120.80, tariff: 0 },
        { line: 4, mfgPn: '172043-0302', desc: 'Molex Super-Sabre Hdr', qtyOrd: 55, qtyShip: 55, price: 3.38, ext: 185.90, tariff: 14.85 },
        { line: 5, mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol 37P Connectors', qtyOrd: 355, qtyShip: 256, price: 2.25, ext: 576.00, tariff: 40.45 },
        { line: 6, mfgPn: '4922R-32L', desc: 'Delevan 390uH Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay 198R Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol 25P Connectors', qtyOrd: 750, qtyShip: 0, price: 1.75, ext: 0, tariff: 0 },
      ]
    },
    {
      invoice: '90172966', pov: 'POV0075563', date: '05-MAY-26', shipDate: 'May 05, 2026',
      tracking: '523364610799', weight: '9.00 lb',
      merchandise: 175.50, tariff: 12.32, total: 187.82,
      lines: [
        { line: 2, mfgPn: 'K202XHT-E9S-N', desc: 'Kycon D-Sub Connectors', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 5, mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol 37P Connectors', qtyOrd: 99, qtyShip: 78, price: 2.25, ext: 175.50, tariff: 12.32 },
        { line: 6, mfgPn: '4922R-32L', desc: 'Delevan 390uH Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay 198R Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol 25P Connectors', qtyOrd: 750, qtyShip: 0, price: 1.75, ext: 0, tariff: 0 },
      ]
    },
    {
      invoice: '90302299', pov: 'POV0075563', date: '13-MAY-26', shipDate: 'May 13, 2026',
      tracking: '524979566100', weight: '11.00 lb',
      merchandise: 262.50, tariff: 18.45, total: 280.95,
      lines: [
        { line: 2, mfgPn: 'K202XHT-E9S-N', desc: 'Kycon D-Sub Connectors', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 5, mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol 37P Connectors', qtyOrd: 21, qtyShip: 0, price: 2.25, ext: 0, tariff: 0 },
        { line: 6, mfgPn: '4922R-32L', desc: 'Delevan 390uH Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay 198R Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol 25P Connectors', qtyOrd: 750, qtyShip: 150, price: 1.75, ext: 262.50, tariff: 18.45 },
      ]
    },
    {
      invoice: '90893594', pov: 'POV0075563', date: '16-JUN-26', shipDate: 'Jun 16, 2026',
      tracking: '528978984900', weight: '10.00 lb',
      merchandise: 397.25, tariff: 27.92, total: 425.17,
      lines: [
        { line: 2, mfgPn: 'K202XHT-E9S-N', desc: 'Kycon D-Sub Connectors', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 5, mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol 37P Connectors', qtyOrd: 21, qtyShip: 21, price: 2.25, ext: 47.25, tariff: 3.32 },
        { line: 6, mfgPn: '4922R-32L', desc: 'Delevan 390uH Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay 198R Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol 25P Connectors', qtyOrd: 600, qtyShip: 200, price: 1.75, ext: 350.00, tariff: 24.60 },
      ]
    },
    {
      invoice: '90945447', pov: 'POV0075563', date: '18-JUN-26', shipDate: 'Jun 18, 2026',
      tracking: '528979396433', weight: '14.00 lb',
      merchandise: 700.00, tariff: 49.20, total: 749.20,
      lines: [
        { line: 2, mfgPn: 'K202XHT-E9S-N', desc: 'Kycon D-Sub Connectors', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 6, mfgPn: '4922R-32L', desc: 'Delevan 390uH Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay 198R Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol 25P Connectors', qtyOrd: 400, qtyShip: 400, price: 1.75, ext: 700.00, tariff: 49.20 },
      ]
    },
    // POV0075856
    {
      invoice: '90969889', pov: 'POV0075856', date: '18-JUN-26', shipDate: 'Jun 18, 2026',
      tracking: '528979457439', weight: '4.00 lb',
      merchandise: 265.20, tariff: 0.00, total: 265.20,
      lines: [
        { line: 1, mfgPn: 'HFBR-1531ETZ', desc: 'Broadcom Fibre Optic', qtyOrd: 15, qtyShip: 15, price: 17.68, ext: 265.20, tariff: 0 },
      ]
    },
    // POV0076829
    {
      invoice: '91087894', pov: 'POV0076829', date: '25-JUN-26', shipDate: 'Jun 25, 2026',
      tracking: '530072037687', weight: '3.00 lb',
      merchandise: 398.80, tariff: 14.38, total: 413.18,
      lines: [
        { line: 1, mfgPn: 'KFS2-256', desc: 'PEM NUT Fixings', qtyOrd: 400, qtyShip: 400, price: 0.392, ext: 156.80, tariff: 0 },
        { line: 2, mfgPn: '0216010.HXP', desc: 'Littelfuse 10A Fuses', qtyOrd: 125, qtyShip: 125, price: 1.19, ext: 148.75, tariff: 11.88 },
        { line: 3, mfgPn: 'C1206C102K5RAC', desc: 'KEMET 1000pF MLCC', qtyOrd: 2030, qtyShip: 2030, price: 0.025, ext: 50.75, tariff: 0 },
        { line: 4, mfgPn: 'RC0805JR-07100RL', desc: 'YAGEO 100R Resistors', qtyOrd: 5000, qtyShip: 5000, price: 0.004, ext: 20.00, tariff: 0 },
        { line: 5, mfgPn: 'RC0805JR-0791KL', desc: 'YAGEO 91K Resistors', qtyOrd: 2500, qtyShip: 2500, price: 0.009, ext: 22.50, tariff: 2.50 },
      ]
    },
  ];

  // Sheet 1: All Lines - tracking only for shipped items
  const linesSheet = workbook.addWorksheet('All Invoice Lines');
  linesSheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 12 },
    { header: 'POV', key: 'pov', width: 14 },
    { header: 'Invoice Date', key: 'invDate', width: 12 },
    { header: 'Line', key: 'line', width: 6 },
    { header: 'MFG P/N', key: 'mfgPn', width: 24 },
    { header: 'Description', key: 'desc', width: 32 },
    { header: 'Qty Ordered', key: 'qtyOrd', width: 11 },
    { header: 'Qty Shipped', key: 'qtyShip', width: 11 },
    { header: 'Unit Price', key: 'price', width: 11 },
    { header: 'Extended', key: 'ext', width: 11 },
    { header: 'Tariff', key: 'tariff', width: 10 },
    { header: 'Ship Date', key: 'shipDate', width: 14 },
    { header: 'Tracking', key: 'tracking', width: 16 },
  ];

  for (const inv of invoices) {
    for (const line of inv.lines) {
      linesSheet.addRow({
        invoice: inv.invoice,
        pov: inv.pov,
        invDate: inv.date,
        line: line.line,
        mfgPn: line.mfgPn,
        desc: line.desc,
        qtyOrd: line.qtyOrd,
        qtyShip: line.qtyShip,
        price: line.price,
        ext: line.ext,
        tariff: line.tariff,
        // Only show ship date and tracking if something shipped
        shipDate: line.qtyShip > 0 ? inv.shipDate : '',
        tracking: line.qtyShip > 0 ? inv.tracking : '',
      });
    }
  }

  linesSheet.getRow(1).font = { bold: true };
  linesSheet.getColumn('price').numFmt = '$#,##0.000';
  linesSheet.getColumn('ext').numFmt = '$#,##0.00';
  linesSheet.getColumn('tariff').numFmt = '$#,##0.00';

  // Sheet 2: Invoice Summary
  const summarySheet = workbook.addWorksheet('Invoice Summary');
  summarySheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 12 },
    { header: 'POV', key: 'pov', width: 14 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Ship Date', key: 'shipDate', width: 14 },
    { header: 'Tracking', key: 'tracking', width: 16 },
    { header: 'Weight', key: 'weight', width: 10 },
    { header: 'Merchandise', key: 'merchandise', width: 14 },
    { header: 'Tariff', key: 'tariff', width: 12 },
    { header: 'Total', key: 'total', width: 14 },
  ];

  for (const inv of invoices) {
    summarySheet.addRow({
      invoice: inv.invoice,
      pov: inv.pov,
      date: inv.date,
      shipDate: inv.shipDate,
      tracking: inv.tracking,
      weight: inv.weight,
      merchandise: inv.merchandise,
      tariff: inv.tariff,
      total: inv.total,
    });
  }

  // POV subtotals
  const povGroups = {};
  for (const inv of invoices) {
    if (!povGroups[inv.pov]) povGroups[inv.pov] = { merchandise: 0, tariff: 0, total: 0, count: 0 };
    povGroups[inv.pov].merchandise += inv.merchandise;
    povGroups[inv.pov].tariff += inv.tariff;
    povGroups[inv.pov].total += inv.total;
    povGroups[inv.pov].count++;
  }

  summarySheet.addRow({});
  for (const [pov, data] of Object.entries(povGroups)) {
    const row = summarySheet.addRow({
      invoice: `${pov} SUBTOTAL`,
      pov: `(${data.count} inv)`,
      merchandise: data.merchandise,
      tariff: data.tariff,
      total: data.total,
    });
    row.font = { bold: true };
  }

  let grandMerch = 0, grandTariff = 0, grandTotal = 0;
  for (const inv of invoices) {
    grandMerch += inv.merchandise;
    grandTariff += inv.tariff;
    grandTotal += inv.total;
  }
  summarySheet.addRow({});
  const grandRow = summarySheet.addRow({
    invoice: 'GRAND TOTAL',
    merchandise: grandMerch,
    tariff: grandTariff,
    total: grandTotal,
  });
  grandRow.font = { bold: true };

  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getColumn('merchandise').numFmt = '$#,##0.00';
  summarySheet.getColumn('tariff').numFmt = '$#,##0.00';
  summarySheet.getColumn('total').numFmt = '$#,##0.00';

  // Save
  const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_Invoice_Details_All_POVs.xlsx';
  await workbook.xlsx.writeFile(outputPath);
  console.log(`Excel written to: ${outputPath}`);
  console.log(`Grand Total: $${grandTotal.toFixed(2)}`);
}

main().catch(console.error);
