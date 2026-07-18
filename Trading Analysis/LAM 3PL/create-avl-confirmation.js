#!/usr/bin/env node
/**
 * Create AVL confirmation request for LAM
 */

const XLSX = require('xlsx');
const path = require('path');

const FILE_DROP = '/home/analytics_user/workspace/file-drop';

// Load validation report
const valWb = XLSX.readFile(path.join(FILE_DROP, 'LAM_AVL_Validation_Report.xlsx'));
const valData = XLSX.utils.sheet_to_json(valWb.Sheets['Validation']);

// KITTING_ONLY - need full AVL from LAM
const kittingOnly = valData.filter(r => r.Status === 'KITTING_ONLY');

// KITTING_HAS_EXTRAS - need to confirm if extras are valid
const extras = valData.filter(r => r.Status === 'KITTING_HAS_EXTRAS');

console.log('=== AVL Confirmation Request ===');
console.log('NOT IN LAM AVL:', kittingOnly.length);
console.log('EXTRA MPNs:', extras.length);
console.log('Total needing confirmation:', kittingOnly.length + extras.length);

// Write request file
const wb = XLSX.utils.book_new();

// Sheet 1: Summary
const summaryRows = [
  { Metric: 'CPCs Validated', Value: valData.length },
  { Metric: 'Fully Confirmed (OK)', Value: valData.filter(r => r.Status === 'OK').length },
  { Metric: 'LAM AVL Only (OK)', Value: valData.filter(r => r.Status === 'LAM_AVL_ONLY').length },
  { Metric: '', Value: '' },
  { Metric: 'Needing Confirmation:', Value: '' },
  { Metric: '  NOT in LAM AVL', Value: kittingOnly.length },
  { Metric: '  Extra MPNs in Kitting', Value: extras.length },
  { Metric: 'Total Needs Review', Value: kittingOnly.length + extras.length }
];
const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

// Sheet 2: Not in LAM AVL
const notInLamRows = kittingOnly.map(r => ({
  CPC: r.CPC,
  'Roster MPN': r['Roster MPN'],
  'Kitting MPNs': r['Kitting MPNs'],
  'Approved MPN 1': '',
  'Approved MFR 1': '',
  'Approved MPN 2': '',
  'Approved MFR 2': ''
}));
const notInLamWs = XLSX.utils.json_to_sheet(notInLamRows);
XLSX.utils.book_append_sheet(wb, notInLamWs, 'Not in LAM AVL');

// Sheet 3: Extra MPNs
const extraRows = extras.map(r => {
  const lamMpns = (r['LAM AVL MPNs'] || '').split(' | ');
  const lamSet = new Set(lamMpns);
  const kittingMpns = (r['Kitting MPNs'] || '').split(' | ');
  const extraMpns = kittingMpns.filter(m => !lamSet.has(m));
  return {
    CPC: r.CPC,
    'LAM AVL MPNs': r['LAM AVL MPNs'],
    'Kitting Extra MPNs': extraMpns.join(' | '),
    'Are Extras Approved?': ''
  };
});
const extraWs = XLSX.utils.json_to_sheet(extraRows);
XLSX.utils.book_append_sheet(wb, extraWs, 'Extra MPNs to Verify');

const outPath = path.join(FILE_DROP, 'LAM_AVL_Confirmation_Request.xlsx');
XLSX.writeFile(wb, outPath);
console.log('Wrote:', outPath);
