const XLSX = require('xlsx');
const wb = XLSX.readFile('/tmp/Positronic orders.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws);

// Group by Internal Salesperson
const bySalesperson = {};
data.forEach(row => {
  const sp = row['Internal Salesperson'] || 'unknown';
  if (!bySalesperson[sp]) {
    bySalesperson[sp] = { customers: new Set(), parts: new Set(), rows: 0 };
  }
  bySalesperson[sp].customers.add(row.Customer);
  bySalesperson[sp].parts.add(row.Item);
  bySalesperson[sp].rows++;
});

console.log('=== SELLERS TO NOTIFY ===\n');
Object.entries(bySalesperson)
  .sort((a, b) => b[1].rows - a[1].rows)
  .forEach(([sp, info]) => {
    console.log(`${sp}:`);
    console.log(`  Customers: ${[...info.customers].join(', ')}`);
    console.log(`  Parts: ${[...info.parts].slice(0, 5).join(', ')}${info.parts.size > 5 ? ` + ${info.parts.size - 5} more` : ''}`);
    console.log(`  Order lines: ${info.rows}\n`);
  });

// Also get unique parts affected
const allParts = new Set(data.map(r => r.Item));
console.log('\n=== ALL AFFECTED PART NUMBERS ===');
[...allParts].sort().forEach(p => console.log(p));
