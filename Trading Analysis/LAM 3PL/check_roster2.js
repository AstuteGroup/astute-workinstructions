const XLSX = require('xlsx');
const wb = XLSX.readFile('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const ws = wb.Sheets['Master Roster'];
const data = XLSX.utils.sheet_to_json(ws);

// Parts WITH threshold but missing resale - these are the concerning ones
const noResale = data.filter(r => !r['Resale Price'] && r['Resale Price'] !== 0);
const hasThresholdNoResale = noResale.filter(r => r['Reorder Threshold'] || r['Reorder Threshold'] === 0);

console.log('=== 37 PARTS WITH THRESHOLD BUT NO RESALE ===');
console.log('These are from original Kitting DB and should have resale prices');
console.log('');

hasThresholdNoResale.forEach((r, i) => {
  console.log((i+1) + '. ' + r.MPN);
  console.log('   CPC: ' + r.CPC);
  console.log('   Threshold: ' + r['Reorder Threshold'] + ' | MOQ: ' + r.MOQ);
  console.log('   Base: $' + (r['Base Unit Price'] || 'N/A'));
  console.log('   Award: ' + (r.Award || 'N/A'));
  console.log('');
});
