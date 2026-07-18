#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();

  // All invoice data extracted from PDFs
  const invoices = [
    // POV0075257
    {
      invoice: '89497435', pov: 'POV0075257', date: '26-MAR-26', shipDate: 'Mar 26, 2026',
      tracking: '518989245440', weight: '7.00 lb',
      merchandise: 3353.15, tariff: 99.65, total: 3452.80,
      lines: [
        { line: 1, mouserPn: '538-42819-5223', mfgPn: '42819-5223', desc: 'Molex MiniFit Sr Hdr Vert', qtyOrd: 25, qtyShip: 25, price: 11.94, ext: 298.50, tariff: 59.75 },
        { line: 2, mouserPn: '200-SSW10406GS', mfgPn: 'SSW-104-06-G-S', desc: 'Samtec Tiger Buy Socket Str', qtyOrd: 75, qtyShip: 0, price: 1.21, ext: 0, tariff: 0 },
        { line: 3, mouserPn: '200-SL120G10', mfgPn: 'SL-120-G-10', desc: 'Samtec .100 Low Profile Sin', qtyOrd: 35, qtyShip: 35, price: 8.75, ext: 306.25, tariff: 39.90 },
        { line: 4, mouserPn: '755-SCT3022ALGC11', mfgPn: 'SCT3022ALGC11', desc: 'ROHM Semiconductor N-Ch 650V SiC', qtyOrd: 50, qtyShip: 50, price: 40.29, ext: 2014.50, tariff: 0 },
        { line: 5, mouserPn: '279-RA73F1J200RBTDF', mfgPn: 'RA73F1J200RBTDF', desc: 'TE Connectivity Thin Film Resistors', qtyOrd: 165, qtyShip: 165, price: 1.46, ext: 240.90, tariff: 0 },
        { line: 6, mouserPn: '200-IP504050LS1LTR', mfgPn: 'IP5-04-05.0-L-S-1-L-TR', desc: 'Samtec 4.00 mm IsoRate 50 O', qtyOrd: 50, qtyShip: 50, price: 9.86, ext: 493.00, tariff: 0 },
      ]
    },
    {
      invoice: '89519101', pov: 'POV0075257', date: '27-MAR-26', shipDate: 'Mar 27, 2026',
      tracking: '518989428660', weight: '7.00 lb',
      merchandise: 1858.60, tariff: 94.41, total: 1953.01,
      lines: [
        { line: 1, mouserPn: '754-RG2012P-2742-BT5', mfgPn: 'RG2012P-2742-B-T5', desc: 'Susumu 1/8W 27.4K Ohm 0.1%', qtyOrd: 561, qtyShip: 561, price: 0.073, ext: 40.95, tariff: 0 },
        { line: 2, mouserPn: '576-0505012.MXP', mfgPn: '0505012.MXP', desc: 'Littelfuse 450V 3AB 12A Cartridge Fuses', qtyOrd: 160, qtyShip: 160, price: 3.08, ext: 492.80, tariff: 39.36 },
        { line: 3, mouserPn: '747-IXFY26N30X3', mfgPn: 'IXFY26N30X3', desc: 'IXYS TO252 300V 26A N-CH MOSFETs', qtyOrd: 70, qtyShip: 70, price: 2.49, ext: 174.30, tariff: 0 },
        { line: 4, mouserPn: '652-SRU2013-2R2Y', mfgPn: 'SRU2013-2R2Y', desc: 'Bourns 2.2uH 30% SMD 2013 Inductors', qtyOrd: 350, qtyShip: 350, price: 0.518, ext: 181.30, tariff: 14.35 },
        { line: 5, mouserPn: '71-TNPW120690K9BEEA', mfgPn: 'TNPW120690K9BEEA', desc: 'Vishay 90.9Kohms .1% 25ppm Resistors', qtyOrd: 650, qtyShip: 650, price: 0.272, ext: 176.80, tariff: 0 },
        { line: 6, mouserPn: '80-C0805C102JBR', mfgPn: 'C0805C102JBRACTU', desc: 'KEMET 630V 1000pF X7R 0805 MLCC', qtyOrd: 1000, qtyShip: 1000, price: 0.137, ext: 137.00, tariff: 0 },
        { line: 7, mouserPn: '754-RG2012P-1071-BT5', mfgPn: 'RG2012P-1071-B-T5', desc: 'Susumu 1/8W 1.07K Ohms 0.1% Resistors', qtyOrd: 3000, qtyShip: 3000, price: 0.069, ext: 207.00, tariff: 0 },
        { line: 8, mouserPn: '754-RG2012P-2101-BT5', mfgPn: 'RG2012P-2101-B-T5', desc: 'Susumu 1/8W 2.1K Ohms 0.1% Resistors', qtyOrd: 3000, qtyShip: 3000, price: 0.069, ext: 207.00, tariff: 24.00 },
        { line: 9, mouserPn: '80-C1812C224J1R', mfgPn: 'C1812C224J1RACTU', desc: 'KEMET 100volts 0.22uF X7R MLCC', qtyOrd: 300, qtyShip: 300, price: 0.649, ext: 194.70, tariff: 0 },
        { line: 10, mouserPn: '754-RG2012P-1961-BT5', mfgPn: 'RG2012P-1961-B-T5', desc: 'Susumu 1/8W 1.96K Ohms 0.1% Resistors', qtyOrd: 516, qtyShip: 477, price: 0.098, ext: 46.75, tariff: 16.70 },
      ]
    },
    {
      invoice: '89568193', pov: 'POV0075257', date: '30-MAR-26', shipDate: 'Mar 30, 2026',
      tracking: '519883511560', weight: '11.00 lb',
      merchandise: 5931.83, tariff: 778.90, total: 6710.73,
      lines: [
        { line: 1, mouserPn: '876-SHV24-1A85-78D3K', mfgPn: 'SHV24-1A85-78D3K', desc: 'MEDER electronic High Voltage Reed Relays', qtyOrd: 431, qtyShip: 431, price: 9.54, ext: 4111.74, tariff: 577.54 },
        { line: 2, mouserPn: '833-SMCJ1.5KE30A-TP', mfgPn: 'SMCJ1.5KE30A-TP', desc: 'MCC 41.4V 1500W 36.7A ESD Protection', qtyOrd: 630, qtyShip: 630, price: 0.293, ext: 184.59, tariff: 129.15 },
        { line: 3, mouserPn: '649-10139781122402LF', mfgPn: '10139781-122402LF', desc: 'Amphenol FCI 0.8MM B TO B Mezzanine', qtyOrd: 105, qtyShip: 105, price: 5.29, ext: 555.45, tariff: 55.55 },
        { line: 4, mouserPn: '520-TXO-3225MV-160-T', mfgPn: 'ECS-TXO-3225MV-160-TR', desc: 'ECS XTAL OSC TCXO 16.000 Oscillators', qtyOrd: 150, qtyShip: 150, price: 1.59, ext: 238.50, tariff: 0 },
        { line: 5, mouserPn: '71-TNPW08051K91BEEN', mfgPn: 'TNPW08051K91BEEN', desc: 'Vishay 1.91Kohms .1% 25ppm Resistors', qtyOrd: 625, qtyShip: 625, price: 0.388, ext: 242.50, tariff: 0 },
        { line: 6, mouserPn: '71-TNPW0402249RBYEP', mfgPn: 'TNPW0402249RBYEP', desc: 'Vishay 249ohms 0.1% AEC-Q20 Resistors', qtyOrd: 650, qtyShip: 650, price: 0.333, ext: 216.45, tariff: 0 },
        { line: 7, mouserPn: '512-H11N1SR2M', mfgPn: 'H11N1SR2M', desc: 'onsemi Optocoupler LC Schmi Optocouplers', qtyOrd: 200, qtyShip: 200, price: 1.08, ext: 216.00, tariff: 0 },
        { line: 8, mouserPn: '576-0216.200MXP', mfgPn: '0216.200MXP', desc: 'Littelfuse 250V .2A Fast Acting Fuses', qtyOrd: 140, qtyShip: 140, price: 1.19, ext: 166.60, tariff: 16.66 },
      ]
    },
    {
      invoice: '89765460', pov: 'POV0075257', date: '13-APR-26', shipDate: 'Apr 13, 2026',
      tracking: '520858061244', weight: '3.00 lb',
      merchandise: 90.75, tariff: 7.28, total: 98.03,
      lines: [
        { line: 2, mouserPn: '200-SSW10406GS', mfgPn: 'SSW-104-06-G-S', desc: 'Samtec Tiger Buy Socket Str', qtyOrd: 75, qtyShip: 75, price: 1.21, ext: 90.75, tariff: 7.28 },
      ]
    },
    {
      invoice: '90441161', pov: 'POV0075257', date: '20-MAY-26', shipDate: 'May 20, 2026',
      tracking: '525458371932', weight: '3.00 lb',
      merchandise: 3.82, tariff: 0.31, total: 4.13,
      lines: [
        { line: 10, mouserPn: '754-RG2012P-1961-BT5', mfgPn: 'RG2012P-1961-B-T5', desc: 'Susumu 1/8W 1.96K Ohms 0.1% Resistors', qtyOrd: 39, qtyShip: 39, price: 0.098, ext: 3.82, tariff: 0.31 },
      ]
    },
    // POV0075563
    {
      invoice: '89821186', pov: 'POV0075563', date: '14-APR-26', shipDate: 'Apr 14, 2026',
      tracking: '520858359297', weight: '13.00 lb',
      merchandise: 882.70, tariff: 55.30, total: 938.00,
      lines: [
        { line: 2, mouserPn: '806-K202XHT-E9S-N', mfgPn: 'K202XHT-E9S-N', desc: 'Kycon SMT D9 UL-SHT D-Sub', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 3, mouserPn: '71-CRCW2010-20K', mfgPn: 'CRCW201020K0FKTF', desc: 'Vishay 3/4watt 20Kohms 1% Resistors', qtyOrd: 800, qtyShip: 800, price: 0.151, ext: 120.80, tariff: 0 },
        { line: 4, mouserPn: '538-172043-0302', mfgPn: '172043-0302', desc: 'Molex Super-Sabre R/A Hdr Housings', qtyOrd: 55, qtyShip: 55, price: 3.38, ext: 185.90, tariff: 14.85 },
        { line: 5, mouserPn: '706-DLS4XS4AA35X', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P F PC S/F CONT RE', qtyOrd: 355, qtyShip: 256, price: 2.25, ext: 576.00, tariff: 40.45 },
        { line: 6, mouserPn: '807-4922R-32L', mfgPn: '4922R-32L', desc: 'Delevan 390 uH Power Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mouserPn: '71-TNPW1206198RBEEA', mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay TNPW1206 198R 0.1% T Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mouserPn: '706-DLS3XS4AA35X', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P F PC W/RSPCE PCB', qtyOrd: 750, qtyShip: 0, price: 1.75, ext: 0, tariff: 0 },
      ]
    },
    {
      invoice: '90172966', pov: 'POV0075563', date: '05-MAY-26', shipDate: 'May 05, 2026',
      tracking: '523364610799', weight: '9.00 lb',
      merchandise: 175.50, tariff: 12.32, total: 187.82,
      lines: [
        { line: 2, mouserPn: '806-K202XHT-E9S-N', mfgPn: 'K202XHT-E9S-N', desc: 'Kycon SMT D9 UL-SHT D-Sub', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 5, mouserPn: '706-DLS4XS4AA35X', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P F PC S/F CONT RE', qtyOrd: 99, qtyShip: 78, price: 2.25, ext: 175.50, tariff: 12.32 },
        { line: 6, mouserPn: '807-4922R-32L', mfgPn: '4922R-32L', desc: 'Delevan 390 uH Power Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mouserPn: '71-TNPW1206198RBEEA', mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay TNPW1206 198R 0.1% T Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mouserPn: '706-DLS3XS4AA35X', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P F PC W/RSPCE PCB', qtyOrd: 750, qtyShip: 0, price: 1.75, ext: 0, tariff: 0 },
      ]
    },
    {
      invoice: '90302299', pov: 'POV0075563', date: '13-MAY-26', shipDate: 'May 13, 2026',
      tracking: '524979566100', weight: '11.00 lb',
      merchandise: 262.50, tariff: 18.45, total: 280.95,
      lines: [
        { line: 2, mouserPn: '806-K202XHT-E9S-N', mfgPn: 'K202XHT-E9S-N', desc: 'Kycon SMT D9 UL-SHT D-Sub', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 5, mouserPn: '706-DLS4XS4AA35X', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P F PC S/F CONT RE', qtyOrd: 21, qtyShip: 0, price: 2.25, ext: 0, tariff: 0 },
        { line: 6, mouserPn: '807-4922R-32L', mfgPn: '4922R-32L', desc: 'Delevan 390 uH Power Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mouserPn: '71-TNPW1206198RBEEA', mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay TNPW1206 198R 0.1% T Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mouserPn: '706-DLS3XS4AA35X', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P F PC W/RSPCE PCB', qtyOrd: 750, qtyShip: 150, price: 1.75, ext: 262.50, tariff: 18.45 },
      ]
    },
    {
      invoice: '90893594', pov: 'POV0075563', date: '16-JUN-26', shipDate: 'Jun 16, 2026',
      tracking: '528978984900', weight: '10.00 lb',
      merchandise: 397.25, tariff: 27.92, total: 425.17,
      lines: [
        { line: 2, mouserPn: '806-K202XHT-E9S-N', mfgPn: 'K202XHT-E9S-N', desc: 'Kycon SMT D9 UL-SHT D-Sub', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 5, mouserPn: '706-DLS4XS4AA35X', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P F PC S/F CONT RE', qtyOrd: 21, qtyShip: 21, price: 2.25, ext: 47.25, tariff: 3.32 },
        { line: 6, mouserPn: '807-4922R-32L', mfgPn: '4922R-32L', desc: 'Delevan 390 uH Power Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mouserPn: '71-TNPW1206198RBEEA', mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay TNPW1206 198R 0.1% T Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mouserPn: '706-DLS3XS4AA35X', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P F PC W/RSPCE PCB', qtyOrd: 600, qtyShip: 200, price: 1.75, ext: 350.00, tariff: 24.60 },
      ]
    },
    {
      invoice: '90945447', pov: 'POV0075563', date: '18-JUN-26', shipDate: 'Jun 18, 2026',
      tracking: '528979396433', weight: '14.00 lb',
      merchandise: 700.00, tariff: 49.20, total: 749.20,
      lines: [
        { line: 2, mouserPn: '806-K202XHT-E9S-N', mfgPn: 'K202XHT-E9S-N', desc: 'Kycon SMT D9 UL-SHT D-Sub', qtyOrd: 85, qtyShip: 0, price: 3.07, ext: 0, tariff: 0 },
        { line: 6, mouserPn: '807-4922R-32L', mfgPn: '4922R-32L', desc: 'Delevan 390 uH Power Inductors', qtyOrd: 60, qtyShip: 0, price: 3.40, ext: 0, tariff: 0 },
        { line: 7, mouserPn: '71-TNPW1206198RBEEA', mfgPn: 'TNPW1206198RBEEA', desc: 'Vishay TNPW1206 198R 0.1% T Resistors', qtyOrd: 275, qtyShip: 0, price: 0.442, ext: 0, tariff: 0 },
        { line: 8, mouserPn: '706-DLS3XS4AA35X', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P F PC W/RSPCE PCB', qtyOrd: 400, qtyShip: 400, price: 1.75, ext: 700.00, tariff: 49.20 },
      ]
    },
    // POV0075856
    {
      invoice: '90969889', pov: 'POV0075856', date: '18-JUN-26', shipDate: 'Jun 18, 2026',
      tracking: '528979457439', weight: '4.00 lb',
      merchandise: 265.20, tariff: 0.00, total: 265.20,
      lines: [
        { line: 1, mouserPn: '630-HFBR-1531ETZ', mfgPn: 'HFBR-1531ETZ', desc: 'Broadcom/Avago Versatile Link Vert Fibre Optic', qtyOrd: 15, qtyShip: 15, price: 17.68, ext: 265.20, tariff: 0 },
      ]
    },
    // POV0076829
    {
      invoice: '91087894', pov: 'POV0076829', date: '25-JUN-26', shipDate: 'Jun 25, 2026',
      tracking: '530072037687', weight: '3.00 lb',
      merchandise: 398.80, tariff: 14.38, total: 413.18,
      lines: [
        { line: 1, mouserPn: '153-KFS2-256', mfgPn: 'KFS2-256', desc: 'PEM NUT, BROACHING, STAI Mounting Fixings', qtyOrd: 400, qtyShip: 400, price: 0.392, ext: 156.80, tariff: 0 },
        { line: 2, mouserPn: '576-0216010.HXP', mfgPn: '0216010.HXP', desc: 'Littelfuse 250V 10A Fast Acting Fuses', qtyOrd: 125, qtyShip: 125, price: 1.19, ext: 148.75, tariff: 11.88 },
        { line: 3, mouserPn: '80-C1206C102K5RAC', mfgPn: 'C1206C102K5RAC', desc: 'KEMET 50V 1000pF X7R 1206 MLCC', qtyOrd: 2030, qtyShip: 2030, price: 0.025, ext: 50.75, tariff: 0 },
        { line: 4, mouserPn: '603-RC0805JR-07100RL', mfgPn: 'RC0805JR-07100RL', desc: 'YAGEO General Purpose Chip Thick Film', qtyOrd: 5000, qtyShip: 5000, price: 0.004, ext: 20.00, tariff: 0 },
        { line: 5, mouserPn: '603-RC0805JR-0791KL', mfgPn: 'RC0805JR-0791KL', desc: 'YAGEO General Purpose Chip Thick Film', qtyOrd: 2500, qtyShip: 2500, price: 0.009, ext: 22.50, tariff: 2.50 },
      ]
    },
  ];

  // Sheet 1: All Invoice Lines (detailed)
  const linesSheet = workbook.addWorksheet('Invoice Lines');
  linesSheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 12 },
    { header: 'POV', key: 'pov', width: 14 },
    { header: 'Invoice Date', key: 'invDate', width: 12 },
    { header: 'Ship Date', key: 'shipDate', width: 14 },
    { header: 'Line', key: 'line', width: 6 },
    { header: 'Mouser P/N', key: 'mouserPn', width: 22 },
    { header: 'MFG P/N', key: 'mfgPn', width: 22 },
    { header: 'Description', key: 'desc', width: 40 },
    { header: 'Qty Ordered', key: 'qtyOrd', width: 10 },
    { header: 'Qty Shipped', key: 'qtyShip', width: 10 },
    { header: 'Unit Price', key: 'price', width: 12 },
    { header: 'Extended', key: 'ext', width: 12 },
    { header: 'Tariff', key: 'tariff', width: 10 },
    { header: 'Tracking', key: 'tracking', width: 16 },
  ];

  for (const inv of invoices) {
    for (const line of inv.lines) {
      linesSheet.addRow({
        invoice: inv.invoice,
        pov: inv.pov,
        invDate: inv.date,
        shipDate: inv.shipDate,
        line: line.line,
        mouserPn: line.mouserPn,
        mfgPn: line.mfgPn,
        desc: line.desc,
        qtyOrd: line.qtyOrd,
        qtyShip: line.qtyShip,
        price: line.price,
        ext: line.ext,
        tariff: line.tariff,
        tracking: inv.tracking,
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

  // Add POV subtotals
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
      pov: `(${data.count} invoices)`,
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
    pov: '(12 invoices)',
    merchandise: grandMerch,
    tariff: grandTariff,
    total: grandTotal,
  });
  grandRow.font = { bold: true };
  grandRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0' } };

  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getColumn('merchandise').numFmt = '$#,##0.00';
  summarySheet.getColumn('tariff').numFmt = '$#,##0.00';
  summarySheet.getColumn('total').numFmt = '$#,##0.00';

  // Sheet 3: For Receiving (shipped items only)
  const receivingSheet = workbook.addWorksheet('For Receiving');
  receivingSheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 12 },
    { header: 'POV', key: 'pov', width: 14 },
    { header: 'Ship Date', key: 'shipDate', width: 14 },
    { header: 'Tracking', key: 'tracking', width: 16 },
    { header: 'MFG P/N', key: 'mfgPn', width: 22 },
    { header: 'Qty Shipped', key: 'qtyShip', width: 12 },
    { header: 'Extended', key: 'ext', width: 12 },
  ];

  for (const inv of invoices) {
    for (const line of inv.lines) {
      if (line.qtyShip > 0) {
        receivingSheet.addRow({
          invoice: inv.invoice,
          pov: inv.pov,
          shipDate: inv.shipDate,
          tracking: inv.tracking,
          mfgPn: line.mfgPn,
          qtyShip: line.qtyShip,
          ext: line.ext,
        });
      }
    }
  }

  receivingSheet.getRow(1).font = { bold: true };
  receivingSheet.getColumn('ext').numFmt = '$#,##0.00';

  // Sheet 4: For Accounts Payable
  const apSheet = workbook.addWorksheet('For Accounts Payable');
  apSheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 12 },
    { header: 'POV', key: 'pov', width: 14 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Terms', key: 'terms', width: 10 },
    { header: 'Merchandise', key: 'merchandise', width: 14 },
    { header: 'Tariff', key: 'tariff', width: 12 },
    { header: 'Total Due', key: 'total', width: 14 },
  ];

  for (const inv of invoices) {
    apSheet.addRow({
      invoice: inv.invoice,
      pov: inv.pov,
      date: inv.date,
      terms: 'NET 30',
      merchandise: inv.merchandise,
      tariff: inv.tariff,
      total: inv.total,
    });
  }

  apSheet.addRow({});
  const apGrandRow = apSheet.addRow({
    invoice: 'TOTAL',
    merchandise: grandMerch,
    tariff: grandTariff,
    total: grandTotal,
  });
  apGrandRow.font = { bold: true };

  apSheet.getRow(1).font = { bold: true };
  apSheet.getColumn('merchandise').numFmt = '$#,##0.00';
  apSheet.getColumn('tariff').numFmt = '$#,##0.00';
  apSheet.getColumn('total').numFmt = '$#,##0.00';

  // Save
  const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_Invoice_Details_All_POVs.xlsx';
  await workbook.xlsx.writeFile(outputPath);
  console.log(`Excel written to: ${outputPath}`);
  console.log(`\nSummary:`);
  console.log(`  12 invoices across 4 POVs`);
  console.log(`  POV0075257: 5 invoices, $${povGroups['POV0075257'].total.toFixed(2)}`);
  console.log(`  POV0075563: 5 invoices, $${povGroups['POV0075563'].total.toFixed(2)}`);
  console.log(`  POV0075856: 1 invoice, $${povGroups['POV0075856'].total.toFixed(2)}`);
  console.log(`  POV0076829: 1 invoice, $${povGroups['POV0076829'].total.toFixed(2)}`);
  console.log(`  Grand Total: $${grandTotal.toFixed(2)}`);
}

main().catch(console.error);
