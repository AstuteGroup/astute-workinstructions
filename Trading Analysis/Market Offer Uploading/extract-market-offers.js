const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// MFR abbreviation to canonical name mapping
const MFR_MAP = {
  // Major semiconductors
  'TI': 'Texas Instruments',
  'VISH': 'Vishay',
  'NXP': 'NXP Semiconductor',
  'NXPSEM': 'NXP Semiconductor',
  'ANALOG': 'Analog Devices Inc',
  'ADI': 'Analog Devices Inc',
  'TYCO': 'TE Connectivity',
  'TE': 'TE Connectivity',
  'OS': 'On Semiconductor',
  'ONSEMI': 'On Semiconductor',
  'MCHP': 'Microchip Technology Inc',
  'MICROCHIP': 'Microchip Technology Inc',
  'STME': 'STMicroelectronics',
  'STM': 'STMicroelectronics',
  'ST': 'STMicroelectronics',
  'INFINE': 'Infineon',
  'INFINEON': 'Infineon',
  'IFX': 'Infineon',

  // Passives
  'KEMET': 'Kemet Electronics Corp',
  'YAGO': 'Yageo',
  'YAGEO': 'Yageo',
  'AVX': 'Avx Corp',
  'TDK': 'TDK Corp',
  'MURATA': 'Murata',
  'WURTH': 'Wuerth Elektronik',
  'PAN': 'Panasonic',
  'PANASONIC': 'Panasonic',
  'WALSIN': 'Walsin Technology Corp',
  'KOA': 'Koa Speer',
  'TAIYOY': 'Taiyo Yuden',
  'TAIYO': 'Taiyo Yuden',

  // Connectors
  'JSTC': 'Jst',
  'JST': 'Jst',
  'SAMTEC': 'Samtec Inc',
  'FCI': 'Amphenol Fci',
  'MULCON': 'Molex LLC',
  'MOLEX': 'Molex LLC',
  'HIROSE': 'Hirose Electric',
  'AMPHE': 'Amphenol',
  'AMP': 'Amphenol',

  // Memory & Processing
  'MICRON': 'Micron',
  'ISSI': 'Issi',
  'SAM': 'Samsung',
  'SAMSUNG': 'Samsung',
  'ALTERA': 'Altera',
  'INTEL': 'Intel Corp',
  'AMD': 'Amd',
  'BROC': 'Broadcom',
  'BROADCOM': 'Broadcom',
  'RENE': 'Renesas',
  'RENESAS': 'Renesas',

  // Discretes & Power
  'DIODES': 'Diodes Inc',
  'LFI': 'Littelfuse Inc',
  'LITTELFUSE': 'Littelfuse Inc',
  'SKYW': 'Skyworks',
  'SKYWORKS': 'Skyworks',
  'NEXPERIA': 'Nexperia',
  'NEX': 'Nexperia',

  // Timing & Oscillators
  'ABRACN': 'Abracon',
  'ABRACON': 'Abracon',
  'JAUCH': 'Jauch',
  'EPSON': 'Seiko Epson',
  'IQD': 'Iqd',

  // Other common
  'BORCIR': 'Bourns Inc',
  'BOURNS': 'Bourns Inc',
  'PUL': 'Pulse Electronics',
  'PULSE': 'Pulse Electronics',
  'MLX': 'Melexis',
  'OSRAM': 'Osram',
  'ROHM': 'Rohm',
  'EVERLI': 'Everlight',
  'COI': 'Coilcraft Inc',
  'COILCRAFT': 'Coilcraft Inc',
  'FTDI': 'Ftdi',
  'CINCH': 'Cinch Connectivity Solutions',
  'GRAYH': 'Grayhill',
  'MAXIM': 'Maxim Integrated',
  'XILINX': 'Xilinx',
  'LAT': 'Lattice Semiconductor',
  'CYPRESS': 'Cypress Semiconductor Corp',
  'CYP': 'Cypress Semiconductor Corp',
  'WINBOND': 'Winbond',
  'ALLY': 'Alliance Memory',
  'ALLIANCE': 'Alliance Memory',
};

// Output directory
const OUTPUT_DIR = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Market Offer Uploading/output';

// CSV header (template format)
const HEADER = 'Chuboe_Offer_ID[Value],Chuboe_MPN,Chuboe_MFR_ID[Value],Chuboe_MFR_Text,Qty,Chuboe_Lead_Time,Chuboe_Package_Desc,C_Country_ID[Name],Chuboe_Date_Code,C_Currency_ID[ISO_Code],Description,IsActive,Chuboe_MPN_Clean,Chuboe_CPC,PriceEntered,Chuboe_MOQ,Chuboe_SPQ';

function getMfrName(abbrev) {
  if (!abbrev) return '';
  const upper = abbrev.toString().toUpperCase().trim();
  return MFR_MAP[upper] || '';
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function processRow(row, cpcIdx, mfrIdx, mpnIdx, qtyIdx, priceIdx, notes) {
  const cpc = row[cpcIdx] || '';
  const mfrAbbrev = row[mfrIdx] || '';
  const mpn = row[mpnIdx] || '';
  const qty = row[qtyIdx] || '';
  const price = priceIdx >= 0 && row[priceIdx] ? row[priceIdx] : '';
  const mfrName = getMfrName(mfrAbbrev);

  // Skip if no MPN
  if (!mpn) return null;

  return [
    '', // Chuboe_Offer_ID[Value]
    escapeCSV(mpn), // Chuboe_MPN
    escapeCSV(mfrName), // Chuboe_MFR_ID[Value] - mapped DB name, or blank if not found
    escapeCSV(mfrName ? '' : mfrAbbrev), // Chuboe_MFR_Text - raw text if no DB match
    qty, // Qty
    '', // Chuboe_Lead_Time
    '', // Chuboe_Package_Desc
    '', // C_Country_ID[Name]
    '', // Chuboe_Date_Code
    '', // C_Currency_ID[ISO_Code]
    '', // Description - part-specific notes only
    '', // IsActive
    '', // Chuboe_MPN_Clean
    escapeCSV(cpc), // Chuboe_CPC (customer part number)
    price, // PriceEntered
    '', // Chuboe_MOQ
    '', // Chuboe_SPQ
  ].join(',');
}

// Process Benchmark Romania Excel
function processBenchmark() {
  console.log('\n=== Processing Benchmark Romania ===');
  const wb = XLSX.readFile('/home/analytics_user/workspace/Excess list Q1 Mar sent.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, {header: 1});

  // Columns: Part, Mfgr, Mfgr PN, Suggested Qty
  // Index:   0,    1,    2,       3
  const rows = [HEADER];
  let skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const line = processRow(row, 0, 1, 2, 3, -1, 'Benchmark Romania excess. Prices on request.');
    if (line) {
      rows.push(line);
    } else {
      skipped++;
    }
  }

  const outFile = path.join(OUTPUT_DIR, 'OFFER_UPLOAD_20260317_Benchmark_Romania.csv');
  fs.writeFileSync(outFile, rows.join('\n'));
  console.log(`Written ${rows.length - 1} rows to ${outFile}`);
  console.log(`Skipped ${skipped} rows (no MPN)`);

  return rows.length - 1;
}

// Process OSI Electronics Excel
function processOSI() {
  console.log('\n=== Processing OSI Electronics ===');
  const wb = XLSX.readFile('/home/analytics_user/workspace/Resell_ Edition to Supplier - 9 Mar 2026.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, {header: 1});

  // Columns: Manufacturer Code, Mfg Part No., Qty to Sell, Unit Price
  // Index:   0,                 1,            2,           3
  const rows = [HEADER];
  let skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[1]) {
      skipped++;
      continue;
    }

    const mfrAbbrev = row[0] || '';
    const mpn = row[1] || '';
    const qty = row[2] || '';
    const price = row[3] || '';
    const mfrName = getMfrName(mfrAbbrev);

    const line = [
      '', // Chuboe_Offer_ID[Value]
      escapeCSV(mpn), // Chuboe_MPN
      escapeCSV(mfrName), // Chuboe_MFR_ID[Value] - mapped DB name, or blank if not found
      escapeCSV(mfrName ? '' : mfrAbbrev), // Chuboe_MFR_Text - raw text if no DB match
      qty, // Qty
      '', // Chuboe_Lead_Time
      '', // Chuboe_Package_Desc
      '', // C_Country_ID[Name]
      '', // Chuboe_Date_Code
      '', // C_Currency_ID[ISO_Code]
      '', // Description - part-specific notes only
      '', // IsActive
      '', // Chuboe_MPN_Clean
      '', // Chuboe_CPC
      price, // PriceEntered
      '', // Chuboe_MOQ
      '', // Chuboe_SPQ
    ].join(',');

    rows.push(line);
  }

  const outFile = path.join(OUTPUT_DIR, 'OFFER_UPLOAD_20260317_OSI_Electronics.csv');
  fs.writeFileSync(outFile, rows.join('\n'));
  console.log(`Written ${rows.length - 1} rows to ${outFile}`);
  console.log(`Skipped ${skipped} rows (no MPN)`);

  return rows.length - 1;
}

// Main
const benchmarkCount = processBenchmark();
const osiCount = processOSI();

console.log('\n=== Summary ===');
console.log(`Benchmark Romania: ${benchmarkCount} lines`);
console.log(`OSI Electronics: ${osiCount} lines`);
console.log(`Total: ${benchmarkCount + osiCount} lines`);
