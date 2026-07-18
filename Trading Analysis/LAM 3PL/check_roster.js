const XLSX = require('xlsx');
const wb = XLSX.readFile('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const ws = wb.Sheets['Master Roster'];
const data = XLSX.utils.sheet_to_json(ws);

// Parts missing thresholds
const noThreshold = data.filter(r => !r['Reorder Threshold'] && r['Reorder Threshold'] !== 0);

// Parts missing resale
const noResale = data.filter(r => !r['Resale Price'] && r['Resale Price'] !== 0);

// Parts missing base price
const noBase = data.filter(r => !r['Base Unit Price'] && r['Base Unit Price'] !== 0);

console.log('=== PARTS MISSING THRESHOLDS (250) ===');
console.log('');
console.log('Sample (first 20):');
noThreshold.slice(0, 20).forEach(r => {
  console.log('  ' + r.MPN + ' | Award: ' + (r.Award || 'N/A') + ' | Base: $' + (r['Base Unit Price'] || 'N/A') + ' | Resale: $' + (r['Resale Price'] || 'N/A'));
});

console.log('');
console.log('=== PARTS MISSING RESALE PRICE (81) ===');
noResale.slice(0, 15).forEach(r => {
  console.log('  ' + r.MPN + ' | Base: $' + (r['Base Unit Price'] || 'N/A') + ' | Status: ' + (r.Status || 'N/A'));
});
if (noResale.length > 15) console.log('  ... and ' + (noResale.length - 15) + ' more');

console.log('');
console.log('=== PARTS MISSING BASE PRICE (13) ===');
noBase.forEach(r => {
  console.log('  ' + r.MPN + ' | Resale: $' + (r['Resale Price'] || 'N/A') + ' | Status: ' + (r.Status || 'N/A'));
});

console.log('');
console.log('=== OVERLAP ANALYSIS ===');

// How many parts missing threshold are also missing resale?
const bothMissing = noThreshold.filter(r => !r['Resale Price'] && r['Resale Price'] !== 0);
console.log('Parts missing BOTH threshold AND resale:', bothMissing.length);

// Parts with threshold but missing resale
const hasThresholdNoResale = noResale.filter(r => r['Reorder Threshold'] || r['Reorder Threshold'] === 0);
console.log('Parts WITH threshold but missing resale:', hasThresholdNoResale.length);
if (hasThresholdNoResale.length > 0) {
  console.log('  These need attention:');
  hasThresholdNoResale.slice(0, 10).forEach(r => {
    console.log('    ' + r.MPN + ' | Threshold: ' + r['Reorder Threshold'] + ' | Base: $' + (r['Base Unit Price'] || 'N/A'));
  });
}

console.log('');
console.log('=== PRICING TERMINOLOGY ===');
console.log('Base Unit Price = Contract buy price (what Astute pays franchise/supplier)');
console.log('Resale Price = Contract resale (what LAM pays Astute)');
console.log('Historical Purchase Price (ERP) = Actual price paid on past POs');
