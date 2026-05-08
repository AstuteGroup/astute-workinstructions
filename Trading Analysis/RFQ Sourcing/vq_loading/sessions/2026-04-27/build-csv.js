// One-off: Reconcile email 8370 extractions → VQ Mass Upload CSV.
const fs = require('fs');
const path = require('path');

const SESSION = path.join(__dirname);
const extractions = JSON.parse(fs.readFileSync(path.join(SESSION, '8370-extractions.json'), 'utf8'));

// Resolved 2026-04-27 via DB lookup. All active vendors.
const VENDOR_MAP = {
  'howeher':         '1007571',
  'wafer':           '1003688',
  'pgc':             '1003648',
  'fixchip':         '1002391',
  'onway':           '1003643',
  'ruifan':          '1003803',
  'valley':          '1011368', // Valley Electronics(HK) — APAC context (Dutch Valley = MX)
  'ssf':             '1007351',
  'macroquest':      '1002407',
  'hanglung waiyip': '1003610', // HANG LUNG TENDA TECHNOLOGY (sales@hanglungwaiyip.com)
  'topray':          '1004485',
  'mto':             '1005363',
  'corerine':        '1006037',
  'saviliter':       '1002629',
  'cmarch':          '1008484',
  'archermind':      '1002301',
};

const COLUMNS = [
  'RFQ Search Key','Buyer','Business Partner Search Key','Contact','MPN','MFR Text',
  'Quoted Quantity','Cost','Currency','Date Code','MOQ','SPQ','Packaging','Lead Time',
  'COO','RoHS','Vendor Notes',
];

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const rows = [COLUMNS.join(',')];
const unresolvedVendors = new Set();

for (const r of extractions.records) {
  const vendorKey = VENDOR_MAP[r.vendorShortname.toLowerCase()];
  if (!vendorKey) {
    unresolvedVendors.add(r.vendorShortname);
  }
  const row = {
    'RFQ Search Key':              extractions.rfqSearchKey,
    'Buyer':                       extractions.buyer,
    'Business Partner Search Key': vendorKey || `[NEEDS_VENDOR: ${r.vendorShortname}]`,
    'Contact':                     '',
    'MPN':                         r.rfqMpn,
    'MFR Text':                    r.mfrText || '',
    'Quoted Quantity':             r.qty,
    'Cost':                        r.cost,
    'Currency':                    r.currency || '',
    'Date Code':                   r.dateCode || '',
    'MOQ':                         r.moq != null ? r.moq : '',
    'SPQ':                         r.spq != null ? r.spq : '',
    'Packaging':                   r.packaging || '',
    'Lead Time':                   r.leadTime || '',
    'COO':                         r.coo || '',
    'RoHS':                        r.rohs || '',
    'Vendor Notes':                r.vendorNotes || '',
  };
  rows.push(COLUMNS.map((c) => csvEscape(row[c])).join(','));
}

const outPath = path.join(SESSION, '2026-04-27-rfq1132932-upload-ready.csv');
fs.writeFileSync(outPath, rows.join('\n') + '\n');

console.log(`Wrote ${extractions.records.length} rows → ${outPath}`);
if (unresolvedVendors.size) {
  console.log(`Unresolved vendors: ${[...unresolvedVendors].join(', ')}`);
} else {
  console.log('All vendors resolved.');
}

// Quick stats
const byVendor = {};
const byLine = {};
for (const r of extractions.records) {
  byVendor[r.vendorShortname] = (byVendor[r.vendorShortname] || 0) + 1;
  byLine[r.rfqLine] = (byLine[r.rfqLine] || 0) + 1;
}
console.log('\nQuotes per broker:');
Object.entries(byVendor).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log('\nQuotes per RFQ line:');
Object.entries(byLine).sort((a, b) => +a[0] - +b[0]).forEach(([k, v]) => console.log(`  Line ${k}: ${v}`));
