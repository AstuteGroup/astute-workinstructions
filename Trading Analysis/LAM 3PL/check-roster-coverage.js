#!/usr/bin/env node
const XLSX = require('xlsx');
const wb = XLSX.readFile('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const ws = wb.Sheets['Master Roster'];
const data = XLSX.utils.sheet_to_json(ws);

console.log('=== Award File Coverage Check ===\n');
console.log('Total parts:', data.length);

// Check for missing thresholds
const missingThreshold = data.filter(r => {
  const val = r['Reorder Threshold'];
  return val === undefined || val === null || val === '';
});
console.log('Missing Reorder Threshold:', missingThreshold.length);

// Check for missing MOQ
const missingMOQ = data.filter(r => {
  const val = r['MOQ'];
  return val === undefined || val === null || val === '';
});
console.log('Missing MOQ:', missingMOQ.length);

// Show some examples of missing
if (missingThreshold.length > 0) {
  console.log('\nSample missing threshold:');
  for (const r of missingThreshold.slice(0, 10)) {
    console.log('  ' + r.CPC + ' | ' + r.MPN + ' | Award:', r.Award);
  }
  if (missingThreshold.length > 10) {
    console.log('  ... and ' + (missingThreshold.length - 10) + ' more');
  }
}

if (missingMOQ.length > 0) {
  console.log('\nSample missing MOQ:');
  for (const r of missingMOQ.slice(0, 10)) {
    console.log('  ' + r.CPC + ' | ' + r.MPN + ' | Award:', r.Award);
  }
  if (missingMOQ.length > 10) {
    console.log('  ... and ' + (missingMOQ.length - 10) + ' more');
  }
}

// Summary by Award
console.log('\n=== Missing by Award ===');
const missingByAward = {};
for (const r of missingThreshold) {
  const award = r.Award || 'Unknown';
  missingByAward[award] = (missingByAward[award] || 0) + 1;
}
for (const [award, count] of Object.entries(missingByAward).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + award + ': ' + count);
}
