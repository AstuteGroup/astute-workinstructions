#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();

  // All invoice line data with tracking
  const allLines = [
    // Invoice 89497435 - Tracking 518989245440
    { invoice: '89497435', pov: 'POV0075257', shipDate: 'Mar 26, 2026', tracking: '518989245440', mfgPn: '42819-5223', desc: 'Molex MiniFit Sr Hdr Vert', qtyShip: 25, unitPrice: 11.94, ext: 298.50, tariff: 59.75 },
    { invoice: '89497435', pov: 'POV0075257', shipDate: 'Mar 26, 2026', tracking: '518989245440', mfgPn: 'SL-120-G-10', desc: 'Samtec .100 Low Profile Sin', qtyShip: 35, unitPrice: 8.75, ext: 306.25, tariff: 39.90 },
    { invoice: '89497435', pov: 'POV0075257', shipDate: 'Mar 26, 2026', tracking: '518989245440', mfgPn: 'SCT3022ALGC11', desc: 'ROHM Semiconductor N-Ch 650V SiC', qtyShip: 50, unitPrice: 40.29, ext: 2014.50, tariff: 0 },
    { invoice: '89497435', pov: 'POV0075257', shipDate: 'Mar 26, 2026', tracking: '518989245440', mfgPn: 'RA73F1J200RBTDF', desc: 'TE Connectivity Thin Film Resistors', qtyShip: 165, unitPrice: 1.46, ext: 240.90, tariff: 0 },
    { invoice: '89497435', pov: 'POV0075257', shipDate: 'Mar 26, 2026', tracking: '518989245440', mfgPn: 'IP5-04-05.0-L-S-1-L-TR', desc: 'Samtec 4.00 mm IsoRate 50 O', qtyShip: 50, unitPrice: 9.86, ext: 493.00, tariff: 0 },

    // Invoice 89519101 - Tracking 518989428660
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'RG2012P-2742-B-T5', desc: 'Susumu 1/8W 27.4K Ohm 0.1%', qtyShip: 561, unitPrice: 0.073, ext: 40.95, tariff: 0 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: '0505012.MXP', desc: 'Littelfuse 450V 3AB 12A Fuses', qtyShip: 160, unitPrice: 3.08, ext: 492.80, tariff: 39.36 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'IXFY26N30X3', desc: 'IXYS TO252 300V 26A N-CH MOSFETs', qtyShip: 70, unitPrice: 2.49, ext: 174.30, tariff: 0 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'SRU2013-2R2Y', desc: 'Bourns 2.2uH 30% SMD Inductors', qtyShip: 350, unitPrice: 0.518, ext: 181.30, tariff: 14.35 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'TNPW120690K9BEEA', desc: 'Vishay 90.9Kohms .1% Resistors', qtyShip: 650, unitPrice: 0.272, ext: 176.80, tariff: 0 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'C0805C102JBRACTU', desc: 'KEMET 630V 1000pF X7R MLCC', qtyShip: 1000, unitPrice: 0.137, ext: 137.00, tariff: 0 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'RG2012P-1071-B-T5', desc: 'Susumu 1/8W 1.07K Ohms Resistors', qtyShip: 3000, unitPrice: 0.069, ext: 207.00, tariff: 0 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'RG2012P-2101-B-T5', desc: 'Susumu 1/8W 2.1K Ohms Resistors', qtyShip: 3000, unitPrice: 0.069, ext: 207.00, tariff: 24.00 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'C1812C224J1RACTU', desc: 'KEMET 100V 0.22uF X7R MLCC', qtyShip: 300, unitPrice: 0.649, ext: 194.70, tariff: 0 },
    { invoice: '89519101', pov: 'POV0075257', shipDate: 'Mar 27, 2026', tracking: '518989428660', mfgPn: 'RG2012P-1961-B-T5', desc: 'Susumu 1/8W 1.96K Ohms Resistors', qtyShip: 477, unitPrice: 0.098, ext: 46.75, tariff: 16.70 },

    // Invoice 89568193 - Tracking 519883511560
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: 'SHV24-1A85-78D3K', desc: 'MEDER High Voltage Reed Relays', qtyShip: 431, unitPrice: 9.54, ext: 4111.74, tariff: 577.54 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: 'SMCJ1.5KE30A-TP', desc: 'MCC 41.4V 1500W ESD Protection', qtyShip: 630, unitPrice: 0.293, ext: 184.59, tariff: 129.15 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: '10139781-122402LF', desc: 'Amphenol FCI Mezzanine Connectors', qtyShip: 105, unitPrice: 5.29, ext: 555.45, tariff: 55.55 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: 'ECS-TXO-3225MV-160-TR', desc: 'ECS TCXO 16.000 Oscillators', qtyShip: 150, unitPrice: 1.59, ext: 238.50, tariff: 0 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: 'TNPW08051K91BEEN', desc: 'Vishay 1.91Kohms .1% Resistors', qtyShip: 625, unitPrice: 0.388, ext: 242.50, tariff: 0 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: 'TNPW0402249RBYEP', desc: 'Vishay 249ohms 0.1% Resistors', qtyShip: 650, unitPrice: 0.333, ext: 216.45, tariff: 0 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: 'H11N1SR2M', desc: 'onsemi Optocouplers', qtyShip: 200, unitPrice: 1.08, ext: 216.00, tariff: 0 },
    { invoice: '89568193', pov: 'POV0075257', shipDate: 'Mar 30, 2026', tracking: '519883511560', mfgPn: '0216.200MXP', desc: 'Littelfuse 250V .2A Fast Fuses', qtyShip: 140, unitPrice: 1.19, ext: 166.60, tariff: 16.66 },

    // Invoice 89765460 - Tracking 520858061244
    { invoice: '89765460', pov: 'POV0075257', shipDate: 'Apr 13, 2026', tracking: '520858061244', mfgPn: 'SSW-104-06-G-S', desc: 'Samtec Tiger Buy Socket Str', qtyShip: 75, unitPrice: 1.21, ext: 90.75, tariff: 7.28 },

    // Invoice 89821186 - Tracking 520858359297
    { invoice: '89821186', pov: 'POV0075563', shipDate: 'Apr 14, 2026', tracking: '520858359297', mfgPn: 'CRCW201020K0FKTF', desc: 'Vishay 3/4watt 20Kohms Resistors', qtyShip: 800, unitPrice: 0.151, ext: 120.80, tariff: 0 },
    { invoice: '89821186', pov: 'POV0075563', shipDate: 'Apr 14, 2026', tracking: '520858359297', mfgPn: '172043-0302', desc: 'Molex Super-Sabre R/A Hdr', qtyShip: 55, unitPrice: 3.38, ext: 185.90, tariff: 14.85 },
    { invoice: '89821186', pov: 'POV0075563', shipDate: 'Apr 14, 2026', tracking: '520858359297', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P Connectors', qtyShip: 256, unitPrice: 2.25, ext: 576.00, tariff: 40.45 },

    // Invoice 90172966 - Tracking 523364610799
    { invoice: '90172966', pov: 'POV0075563', shipDate: 'May 05, 2026', tracking: '523364610799', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P Connectors', qtyShip: 78, unitPrice: 2.25, ext: 175.50, tariff: 12.32 },

    // Invoice 90302299 - Tracking 524979566100
    { invoice: '90302299', pov: 'POV0075563', shipDate: 'May 13, 2026', tracking: '524979566100', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P Connectors', qtyShip: 150, unitPrice: 1.75, ext: 262.50, tariff: 18.45 },

    // Invoice 90441161 - Tracking 525458371932
    { invoice: '90441161', pov: 'POV0075257', shipDate: 'May 20, 2026', tracking: '525458371932', mfgPn: 'RG2012P-1961-B-T5', desc: 'Susumu 1/8W 1.96K Ohms Resistors', qtyShip: 39, unitPrice: 0.098, ext: 3.82, tariff: 0.31 },

    // Invoice 90893594 - Tracking 528978984900
    { invoice: '90893594', pov: 'POV0075563', shipDate: 'Jun 16, 2026', tracking: '528978984900', mfgPn: 'DLS4XS4AA35X', desc: 'Amphenol CONEC 37P Connectors', qtyShip: 21, unitPrice: 2.25, ext: 47.25, tariff: 3.32 },
    { invoice: '90893594', pov: 'POV0075563', shipDate: 'Jun 16, 2026', tracking: '528978984900', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P Connectors', qtyShip: 200, unitPrice: 1.75, ext: 350.00, tariff: 24.60 },

    // Invoice 90945447 - Tracking 528979396433
    { invoice: '90945447', pov: 'POV0075563', shipDate: 'Jun 18, 2026', tracking: '528979396433', mfgPn: 'DLS3XS4AA35X', desc: 'Amphenol CONEC 25P Connectors', qtyShip: 400, unitPrice: 1.75, ext: 700.00, tariff: 49.20 },

    // Invoice 90969889 - Tracking 528979457439
    { invoice: '90969889', pov: 'POV0075856', shipDate: 'Jun 18, 2026', tracking: '528979457439', mfgPn: 'HFBR-1531ETZ', desc: 'Broadcom Fibre Optic Transmitters', qtyShip: 15, unitPrice: 17.68, ext: 265.20, tariff: 0 },

    // Invoice 91087894 - Tracking 530072037687
    { invoice: '91087894', pov: 'POV0076829', shipDate: 'Jun 25, 2026', tracking: '530072037687', mfgPn: 'KFS2-256', desc: 'PEM NUT Mounting Fixings', qtyShip: 400, unitPrice: 0.392, ext: 156.80, tariff: 0 },
    { invoice: '91087894', pov: 'POV0076829', shipDate: 'Jun 25, 2026', tracking: '530072037687', mfgPn: '0216010.HXP', desc: 'Littelfuse 250V 10A Fuses', qtyShip: 125, unitPrice: 1.19, ext: 148.75, tariff: 11.88 },
    { invoice: '91087894', pov: 'POV0076829', shipDate: 'Jun 25, 2026', tracking: '530072037687', mfgPn: 'C1206C102K5RAC', desc: 'KEMET 50V 1000pF X7R MLCC', qtyShip: 2030, unitPrice: 0.025, ext: 50.75, tariff: 0 },
    { invoice: '91087894', pov: 'POV0076829', shipDate: 'Jun 25, 2026', tracking: '530072037687', mfgPn: 'RC0805JR-07100RL', desc: 'YAGEO Thick Film Resistors', qtyShip: 5000, unitPrice: 0.004, ext: 20.00, tariff: 0 },
    { invoice: '91087894', pov: 'POV0076829', shipDate: 'Jun 25, 2026', tracking: '530072037687', mfgPn: 'RC0805JR-0791KL', desc: 'YAGEO Thick Film Resistors', qtyShip: 2500, unitPrice: 0.009, ext: 22.50, tariff: 2.50 },
  ];

  // Single sheet with all details per line
  const sheet = workbook.addWorksheet('Receiving Detail');
  sheet.columns = [
    { header: 'Invoice', key: 'invoice', width: 12 },
    { header: 'POV', key: 'pov', width: 14 },
    { header: 'Ship Date', key: 'shipDate', width: 14 },
    { header: 'Tracking', key: 'tracking', width: 16 },
    { header: 'MFG P/N', key: 'mfgPn', width: 24 },
    { header: 'Description', key: 'desc', width: 36 },
    { header: 'Qty Shipped', key: 'qtyShip', width: 12 },
    { header: 'Unit Price', key: 'unitPrice', width: 12 },
    { header: 'Extended', key: 'ext', width: 12 },
    { header: 'Tariff', key: 'tariff', width: 10 },
    { header: 'Line Total', key: 'lineTotal', width: 12 },
  ];

  for (const line of allLines) {
    sheet.addRow({
      ...line,
      lineTotal: line.ext + line.tariff,
    });
  }

  // Add totals
  let totalExt = 0, totalTariff = 0;
  for (const line of allLines) {
    totalExt += line.ext;
    totalTariff += line.tariff;
  }

  sheet.addRow({});
  const totalRow = sheet.addRow({
    mfgPn: 'TOTAL',
    qtyShip: allLines.reduce((sum, l) => sum + l.qtyShip, 0),
    ext: totalExt,
    tariff: totalTariff,
    lineTotal: totalExt + totalTariff,
  });
  totalRow.font = { bold: true };

  sheet.getRow(1).font = { bold: true };
  sheet.getColumn('unitPrice').numFmt = '$#,##0.000';
  sheet.getColumn('ext').numFmt = '$#,##0.00';
  sheet.getColumn('tariff').numFmt = '$#,##0.00';
  sheet.getColumn('lineTotal').numFmt = '$#,##0.00';

  // Save
  const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_Receiving_Detail.xlsx';
  await workbook.xlsx.writeFile(outputPath);
  console.log(`Excel written to: ${outputPath}`);
  console.log(`${allLines.length} lines, Total: $${(totalExt + totalTariff).toFixed(2)}`);
}

main().catch(console.error);
