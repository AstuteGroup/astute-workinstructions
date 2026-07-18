#!/usr/bin/env node
const XLSX = require('xlsx');
const wb = XLSX.readFile('/home/analytics_user/workspace/file-drop/W103 OPEN POVs.xlsx', { raw: true });
const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true });

// Get all lines from the 5 missing POVs
const missing = ['POV0074419', 'POV0075259', 'POV0075301', 'POV0075400', 'POV0076388'];
const lines = data.filter(r => missing.includes(r['PO Number']));

console.log('=== ALL LINES FROM 5 INFOR POVs WITHOUT OT TRACKING ===');
console.log('Total: ' + lines.length + ' lines');
console.log('');

for (const pov of missing) {
  const povLines = lines.filter(r => r['PO Number'] === pov);
  const vendor = povLines[0] ? povLines[0]['Vendor Name'] : '';
  console.log(pov + ' | ' + vendor + ' (' + povLines.length + ' lines)');
  for (const row of povLines) {
    const open = (row['PO Quantity Ordered'] || 0) - (row['PO Quantity Received'] || 0);
    console.log('  ' + row['Item'] + ' | Ord: ' + row['PO Quantity Ordered'] + ' | Open: ' + open);
  }
  console.log('');
}
