#!/usr/bin/env node
const XLSX = require('xlsx');

// POV0075563 data
const pov0075563 = [
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'DLS3XS4AA35X', qty: 150, tracking: '524979566100', invoice: '90302299', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'DLS3XS4AA35X', qty: 600, tracking: '528978984900, 528979396433', invoice: '90893594, 90945447', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'DLS4XS4AA35X', qty: 256, tracking: '520858359297', invoice: '89821186', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'DLS4XS4AA35X', qty: 99, tracking: '523364610799, 528978984900', invoice: '90172966, 90893594', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: '172043-0302', qty: 55, tracking: '520858359297', invoice: '89821186', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'CRCW201020K0FKTF', qty: 800, tracking: '520858359297', invoice: '89821186', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'K202XHT-E9S-N', qty: 85, tracking: '', invoice: 'on invoices', status: 'BACKORDER', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'TNPW1206198RBEEA', qty: 275, tracking: '', invoice: 'on invoices', status: 'BACKORDER', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: '4922R-32L', qty: 60, tracking: '', invoice: 'on invoices', status: 'BACKORDER', received: 'N', also_appears: '' },
  { ot_po: 'PO809626', pov: 'POV0075563', mpn: 'XEL6060-821MEC', qty: 85, tracking: '', invoice: 'NONE', status: 'MISSING FROM INVOICES', received: 'N', also_appears: '' },
];

// POV0075856 data
const pov0075856 = [
  { ot_po: 'PO809925', pov: 'POV0075856', mpn: 'HFBR-1531ETZ', qty: 15, tracking: '528979457439', invoice: '90969889', status: 'SHIPPED', received: 'N', also_appears: '' },
];

// POV0076829 data
const pov0076829 = [
  { ot_po: 'PO810910', pov: 'POV0076829', mpn: 'RC0805JR-07100RL', qty: 5000, tracking: '530072037687', invoice: '91087894', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO810910', pov: 'POV0076829', mpn: 'KFS2-256', qty: 400, tracking: '530072037687', invoice: '91087894', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO810910', pov: 'POV0076829', mpn: '0216010.HXP', qty: 125, tracking: '530072037687', invoice: '91087894', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO810910', pov: 'POV0076829', mpn: 'C1206C102K5RAC', qty: 2030, tracking: '530072037687', invoice: '91087894', status: 'SHIPPED', received: 'N', also_appears: '' },
  { ot_po: 'PO810910', pov: 'POV0076829', mpn: 'RC0805JR-0791KL', qty: 2500, tracking: '530072037687', invoice: '91087894', status: 'SHIPPED', received: 'N', also_appears: '' },
];

// POV0075257 - Mismatched data
const pov0075257 = [
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: '42819-5223', qty: 25, tracking: '518989245440', invoice: '89497435', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SSW-104-06-G-S', qty: 75, tracking: '518989245440', invoice: '89497435', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SL-120-G-10', qty: 35, tracking: '518989245440', invoice: '89497435', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SCT3022ALGC11', qty: 50, tracking: '518989245440', invoice: '89497435', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'RA73F1J200RBTDF', qty: 165, tracking: '518989245440', invoice: '89497435', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'IP5-04-05.0-L-S-1-L-TR', qty: 50, tracking: '518989245440', invoice: '89497435', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'RG2012P-2742-B-T5', qty: 561, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: 'POV0075252 (Digi-Key) - diff supplier' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: '0505012.MXP', qty: 160, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'IXFY26N30X3', qty: 70, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SRU2013-2R2Y', qty: 350, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'TNPW120690K9BEEA', qty: 650, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'C0805C102JBRACTU', qty: 1000, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'RG2012P-1071-B-T5', qty: 3000, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'RG2012P-2101-B-T5', qty: 3000, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'C1812C224J1RACTU', qty: 300, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'RG2012P-1961-B-T5', qty: 516, tracking: '518989428660', invoice: '89519101', status: 'NOT IN OT', received: '?', also_appears: '+39 on inv 90441161' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SHV24-1A85-78D3K', qty: 431, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: 'POV0075252 (Digi-Key), POV0075254 (Arrow) - diff suppliers' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SMCJ1.5KE30A-TP', qty: 630, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: '10139781-122402LF', qty: 105, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'ECS-TXO-3225MV-160-TR', qty: 150, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'TNPW08051K91BEEN', qty: 625, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'TNPW0402249RBYEP', qty: 650, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'H11N1SR2M', qty: 200, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: '' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: '0216.200MXP', qty: 140, tracking: '519883511560', invoice: '89568193', status: 'NOT IN OT', received: '?', also_appears: 'POV0075254 (Arrow) - diff supplier' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'SSW-104-06-G-S', qty: 75, tracking: '520858061244', invoice: '89765460', status: 'NOT IN OT', received: '?', also_appears: 'Backorder from 89497435' },
  { ot_po: 'NOT FOUND', pov: 'POV0075257', mpn: 'RG2012P-1961-B-T5', qty: 39, tracking: '525458371932', invoice: '90441161', status: 'NOT IN OT', received: '?', also_appears: 'Partial of 516 from 89519101' },
];

// Tariff lines from invoices
const tariffs = [
  { pov: 'POV0075257', invoice: '89497435', ship_date: '2026-03-26', tariff_amount: 99.65, items_with_tariff: '42819-5223, SL-120-G-10' },
  { pov: 'POV0075257', invoice: '89519101', ship_date: '2026-03-27', tariff_amount: 94.41, items_with_tariff: '0505012.MXP, SRU2013-2R2Y, RG2012P-2101-B-T5, RG2012P-1961-B-T5' },
  { pov: 'POV0075257', invoice: '89568193', ship_date: '2026-03-30', tariff_amount: 778.90, items_with_tariff: 'SHV24-1A85-78D3K, SMCJ1.5KE30A-TP, 10139781-122402LF, 0216.200MXP' },
  { pov: 'POV0075257', invoice: '89765460', ship_date: '2026-04-13', tariff_amount: 7.28, items_with_tariff: 'SSW-104-06-G-S' },
  { pov: 'POV0075563', invoice: '89821186', ship_date: '2026-04-14', tariff_amount: 55.30, items_with_tariff: '172043-0302, DLS4XS4AA35X, DLS3XS4AA35X' },
  { pov: 'POV0075563', invoice: '90172966', ship_date: '2026-05-05', tariff_amount: 12.32, items_with_tariff: 'DLS4XS4AA35X' },
  { pov: 'POV0075563', invoice: '90302299', ship_date: '2026-05-13', tariff_amount: 18.45, items_with_tariff: 'DLS3XS4AA35X' },
  { pov: 'POV0075257', invoice: '90441161', ship_date: '2026-05-20', tariff_amount: 0.31, items_with_tariff: 'RG2012P-1961-B-T5' },
  { pov: 'POV0075563', invoice: '90893594', ship_date: '2026-06-16', tariff_amount: 27.92, items_with_tariff: 'DLS4XS4AA35X, DLS3XS4AA35X' },
  { pov: 'POV0075563', invoice: '90945447', ship_date: '2026-06-18', tariff_amount: 49.20, items_with_tariff: 'DLS3XS4AA35X' },
  { pov: 'POV0076829', invoice: '91087894', ship_date: '2026-06-25', tariff_amount: 14.38, items_with_tariff: '0216010.HXP, RC0805JR-07100RL, RC0805JR-0791KL' },
];

// Combine all matched data
const allMatched = [...pov0075563, ...pov0075856, ...pov0076829];

// Create workbook
const wb = XLSX.utils.book_new();

// Sheet 1: All Matched
const ws1 = XLSX.utils.json_to_sheet(allMatched.map(r => ({
  'OT PO': r.ot_po,
  'Infor POV': r.pov,
  'MPN': r.mpn,
  'Qty': r.qty,
  'Tracking': r.tracking,
  'Invoice': r.invoice,
  'Status': r.status,
  'Received': r.received,
  'Also Appears': r.also_appears
})));
XLSX.utils.book_append_sheet(wb, ws1, 'Matched Lines');

// Sheet 2: POV0075257 Mismatches
const ws2 = XLSX.utils.json_to_sheet(pov0075257.map(r => ({
  'OT PO': r.ot_po,
  'Invoice POV': r.pov,
  'MPN': r.mpn,
  'Qty': r.qty,
  'Tracking': r.tracking,
  'Invoice': r.invoice,
  'Status': r.status,
  'Received': r.received,
  'Also Appears In OT': r.also_appears
})));
XLSX.utils.book_append_sheet(wb, ws2, 'POV0075257 Mismatches');

// Sheet 3: Tariff Lines
const ws3 = XLSX.utils.json_to_sheet(tariffs.map(r => ({
  'Infor POV': r.pov,
  'Invoice': r.invoice,
  'Ship Date': r.ship_date,
  'Tariff Amount': r.tariff_amount,
  'Items with Tariff': r.items_with_tariff
})));
XLSX.utils.book_append_sheet(wb, ws3, 'Tariff Lines');

// Sheet 4: Summary
const summary = [
  { Category: 'SHIPPED (tracking updated)', Count: 12, Notes: 'POV0075563 (6), POV0075856 (1), POV0076829 (5)' },
  { Category: 'BACKORDER at Mouser', Count: 3, Notes: 'K202XHT-E9S-N, TNPW1206198RBEEA, 4922R-32L' },
  { Category: 'MISSING from invoices', Count: 1, Notes: 'XEL6060-821MEC - check with Mouser' },
  { Category: 'POV0075257 NOT IN OT', Count: 26, Notes: '5 invoices - MPNs not in OT under ANY PO' },
  { Category: 'Total Tariff Charges', Count: 11, Notes: '$1,158.12 total across all invoices' },
  { Category: 'All items Received?', Count: 0, Notes: 'None received yet - logistics action needed' },
];
const ws4 = XLSX.utils.json_to_sheet(summary);
XLSX.utils.book_append_sheet(wb, ws4, 'Summary');

// Write file
const outPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_Invoice_Reconciliation_2026-07-14.xlsx';
XLSX.writeFile(wb, outPath);
console.log('Excel file created:', outPath);
