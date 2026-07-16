const XLSX = require('xlsx');

// Extracted data from FedEx PDFs with database lookups
const entries = [
  // FedEx 1 - POV0076521 + POV0076442 MERGED ($3,733.08 - keep populated)
  {
    entryNo: '1FX56744907',
    entryDate: '2026-06-12',
    duty: 3699.50,
    mpf: 33.58,
    oversized: 0,
    totalFees: 3733.08,
    shipper: 'ASTUTE ELECTRONICS HK LIMITED',
    tracking: '872986093855',
    invoice: '2-572-71886',
    source: 'POV0076521, POV0076442',
    mpn: 'SDINBDA4-256G, MPQ79500FSGQE-010C-AEC1-Z',
    qty: '50, 24',
    cov: 'COV0022230, COV0022174',
    buyer: 'Elaine Liang',
    salesperson: 'James Diaz'
  },
  // FedEx 1 - POV0076746 (part of 1FX56744907 entry totaling $3,733.08 - keep populated)
  {
    entryNo: '1FX56744907',
    entryDate: '2026-06-12',
    duty: 0,
    mpf: 0,
    oversized: 0,
    totalFees: 0,
    shipper: 'ASTUTE ELECTRONICS HK LIMITED',
    tracking: '872986093855',
    invoice: '2-572-71886',
    source: 'POV0076746',
    mpn: 'LTC6994IS6-1#TRMPBF',
    qty: 250,
    cov: 'COV0022391',
    buyer: 'Betty Song',
    salesperson: 'Ricardo Morales'
  },
  // FedEx 2+3 - POV0073302 ($4,801.90 - keep populated)
  {
    entryNo: '1FX66454349',
    entryDate: '2026-06-19',
    duty: 2079.60,
    mpf: 72.04,
    oversized: 2650.26,
    totalFees: 4801.90,
    shipper: 'AEROLUX LTD',
    tracking: '873245570535',
    invoice: '2-576-93169, 2-577-44572',
    source: 'POV0073302',
    mpn: 'AL-OU50-2000-032ER-20-3',
    qty: 12,
    cov: 'COV0019857',
    buyer: 'Stephanie Hill',
    salesperson: 'Aaron Mendoza'
  },
  // FedEx 4 - Entry 1 ($574.78 - over $250, no match found)
  {
    entryNo: '1FX62952114',
    entryDate: '2026-06-17',
    duty: 0.00,
    mpf: 574.78,
    oversized: 0,
    totalFees: 574.78,
    shipper: 'E-KEY COMPONENTS GMBH',
    tracking: '872892678556',
    invoice: '2-580-49624',
    source: '',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 4 - Entry 2 CNLINKO ($1,780.16 - over $250, no match found)
  {
    entryNo: '1FX73613416',
    entryDate: '2026-06-26',
    duty: 1716.50,
    mpf: 63.66,
    oversized: 0,
    totalFees: 1780.16,
    shipper: 'CNLINKO',
    tracking: '873058354744',
    invoice: '2-580-49624',
    source: '',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 4 - Entry 3 WINLINK ($33.58 - under $250, clear detail columns)
  {
    entryNo: '1FX71344592',
    entryDate: '2026-06-24',
    duty: 0.00,
    mpf: 33.58,
    oversized: 0,
    totalFees: 33.58,
    shipper: 'WINLINK INDUSTRY HK CO., LTD',
    tracking: '521400648596',
    invoice: '2-580-49624',
    source: 'POV0076732',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 4 - POV0076690 ($279.19 - over $250, keep populated)
  {
    entryNo: '1FX72246861',
    entryDate: '2026-06-25',
    duty: 0.00,
    mpf: 279.19,
    oversized: 0,
    totalFees: 279.19,
    shipper: 'HK FIRSTTOP TECHNOLOGY CO., LIMITED',
    tracking: '873484029147',
    invoice: '2-580-49624',
    source: 'POV0076690',
    mpn: '5CSXFC5D6F31I7N',
    qty: 515,
    cov: 'COV0022359',
    buyer: 'Molly Huang',
    salesperson: 'Joel Flores'
  },
  // FedEx 4 - Entry 5 VERY CHIP ($119.92 - under $250, clear detail columns)
  {
    entryNo: '1FX73547747',
    entryDate: '2026-06-26',
    duty: 0.00,
    mpf: 119.92,
    oversized: 0,
    totalFees: 119.92,
    shipper: 'VERY CHIP CO., LIMITED',
    tracking: '873420059789',
    invoice: '2-580-49624',
    source: 'POV0076760',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 4 - Entry 6 ASTUTE STEVENAGE ($1,038.99 - over $250, no match found)
  {
    entryNo: '1FX74423955',
    entryDate: '2026-06-26',
    duty: 1004.20,
    mpf: 34.79,
    oversized: 0,
    totalFees: 1038.99,
    shipper: 'ASTUTE ELECTRONICS (Stevenage)',
    tracking: '873595473832',
    invoice: '2-580-49624',
    source: '',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 5 - Entry 1 YUHUA ($1,473.58 - over $250, keep populated)
  {
    entryNo: '1FX71356414',
    entryDate: '2026-06-24',
    duty: 1440.00,
    mpf: 33.58,
    oversized: 0,
    totalFees: 1473.58,
    shipper: 'YUHUA IMPORT EXPORT (HK) LTD',
    tracking: '873356058173',
    invoice: '2-581-12284',
    source: 'POV0076697',
    mpn: 'TPS7A8500RGRR',
    qty: 3000,
    cov: 'COV0022365',
    buyer: 'Molly Huang',
    salesperson: 'Joel Flores'
  },
  // FedEx 5 - Entry 2 INSIGHT ($33.58 - under $250, clear detail columns)
  {
    entryNo: '1FX71623599',
    entryDate: '2026-06-25',
    duty: 0.00,
    mpf: 33.58,
    oversized: 0,
    totalFees: 33.58,
    shipper: 'INSIGHT(HK)ELECTRONIC CO.,LTD',
    tracking: '873483386010',
    invoice: '2-581-12284',
    source: 'POV0076795',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 6 - Entry 1 CNLINKO ($127.75 - under $250, no match anyway)
  {
    entryNo: '1FX73607947',
    entryDate: '2026-06-26',
    duty: 127.75,
    mpf: 0,
    oversized: 0,
    totalFees: 127.75,
    shipper: 'CNLINKO',
    tracking: '873484155802',
    invoice: '2-581-65592',
    source: '',
    mpn: '',
    qty: '',
    cov: '',
    buyer: '',
    salesperson: ''
  },
  // FedEx 6 - POV0075162 ($1,263.84 - over $250, keep populated)
  {
    entryNo: '1FX76683333',
    entryDate: '2026-06-29',
    duty: 1230.26,
    mpf: 33.58,
    oversized: 0,
    totalFees: 1263.84,
    shipper: 'DMG SPA',
    tracking: '873469192873',
    invoice: '2-581-65592',
    source: 'POV0075162',
    mpn: 'BSFYF0000.WD',
    qty: 250,
    cov: 'COV0021302',
    buyer: 'Juan Botero',
    salesperson: 'Alejandro Padilla'
  }
];

// Create workbook
const wb = XLSX.utils.book_new();

// Template columns per workflow doc
const headers = [
  'Customs Control Number',
  'Entry Date',
  'Duties/Taxes',
  'MPF',
  'Oversized Charges',
  'Total Fees',
  'Shipper',
  'TR#/Reference Number',
  'Invoice',
  'SOURCE',
  'MPN',
  'QTY',
  'COV/Job',
  'Buyer',
  'Salesperson'
];

const rows = entries.map(e => [
  e.entryNo,
  e.entryDate,
  e.duty || 0,
  e.mpf || 0,
  e.oversized || 0,
  e.totalFees || 0,
  e.shipper,
  e.tracking,
  e.invoice,
  e.source,
  e.mpn,
  e.qty,
  e.cov,
  e.buyer,
  e.salesperson
]);

// Add data with headers
const wsData = [headers, ...rows];
const ws = XLSX.utils.aoa_to_sheet(wsData);

// Set column widths
ws['!cols'] = [
  { wch: 16 },  // Entry No
  { wch: 12 },  // Entry Date
  { wch: 12 },  // Duties
  { wch: 10 },  // MPF
  { wch: 14 },  // Oversized
  { wch: 12 },  // Total Fees
  { wch: 30 },  // Shipper
  { wch: 14 },  // TR#
  { wch: 26 },  // Invoice
  { wch: 26 },  // SOURCE
  { wch: 50 },  // MPN
  { wch: 10 },  // QTY
  { wch: 26 },  // COV
  { wch: 16 },  // Buyer
  { wch: 16 }   // Salesperson
];

// Apply number formats for currency columns (C, D, E, F)
for (let r = 1; r <= rows.length; r++) {
  ['C', 'D', 'E', 'F'].forEach(col => {
    const cell = ws[`${col}${r + 1}`];
    if (cell && typeof cell.v === 'number') {
      cell.z = '$#,##0.00';
    }
  });
}

XLSX.utils.book_append_sheet(wb, ws, 'Tariff Tracker');

// Write file
const outputPath = '/home/justin.oberhofer/workspace/uploaded files/tariff_tracker_claude_2026-07-16.xlsx';
XLSX.writeFile(wb, outputPath);

console.log('Tariff tracker created:', outputPath);
console.log('Total entries:', entries.length);
console.log('Entries >= $250 with OT data:', entries.filter(e => e.totalFees >= 250 && e.mpn).length);
console.log('Entries < $250 (details cleared):', entries.filter(e => e.totalFees < 250).length);
console.log('Entries >= $250 unmatched:', entries.filter(e => e.totalFees >= 250 && !e.mpn).length);
