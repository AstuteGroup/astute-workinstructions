const XLSX = require('xlsx');
const wb = XLSX.readFile('/tmp/ASTItemLotsReportInputs_USS_4916434.xlsx');
const ws = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames[0]];

// Find header row
const allData = XLSX.utils.sheet_to_json(ws, { header: 1 });
let headerRowIndex = 7;
for (let i = 0; i < 15; i++) {
  if (allData[i] && allData[i][0] === 'Item') {
    headerRowIndex = i;
    console.log('Found header at row', i, '(0-indexed)');
    console.log('Headers:', allData[i].filter(Boolean));
    break;
  }
}

console.log('');
const data = XLSX.utils.sheet_to_json(ws, { range: headerRowIndex });
console.log('Loaded', data.length, 'rows');
console.log('Column names:', Object.keys(data[0] || {}));

console.log('');
console.log('=== Sample rows ===');
data.slice(0, 3).forEach((r, i) => {
  console.log(i, {
    Item: r.Item,
    Warehouse: r.Warehouse,
    Location: r.Location,
    Lot: r.Lot,
    'Lot Quantity': r['Lot Quantity'],
  });
});

console.log('');
console.log('=== W111 rows ===');
const w111 = data.filter(r => r.Warehouse === 'W111');
console.log('Count:', w111.length);
if (w111.length > 0) {
  console.log('Sample:', {
    Item: w111[0].Item,
    Warehouse: w111[0].Warehouse,
    Location: w111[0].Location,
    Lot: w111[0].Lot,
    'Lot Quantity': w111[0]['Lot Quantity'],
  });
}

console.log('');
console.log('=== All warehouses ===');
const whs = [...new Set(data.map(r => r.Warehouse).filter(Boolean))];
console.log(whs.sort());
