const XLSX = require('xlsx');
const wb = XLSX.readFile('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const ws = wb.Sheets['Master Roster'];
const data = XLSX.utils.sheet_to_json(ws);

// Phase 2 parts without thresholds
const phase2NoThreshold = data.filter(r =>
  (!r['Reorder Threshold'] && r['Reorder Threshold'] !== 0) &&
  r.Award && r.Award.toString().includes('Phase 2')
);

console.log('=== 5 PHASE 2 PARTS FOR THRESHOLD LOOKUP ===');
console.log('');

// Pick 5 diverse ones (different price ranges)
const samples = phase2NoThreshold.slice(0, 5);

samples.forEach((r, i) => {
  console.log((i+1) + '. MPN: ' + r.MPN);
  console.log('   CPC: ' + r.CPC);
  console.log('   Manufacturer: ' + r.Manufacturer);
  console.log('   Base: $' + (r['Base Unit Price'] || 'N/A'));
  console.log('   Award: ' + r.Award);
  console.log('');
});
