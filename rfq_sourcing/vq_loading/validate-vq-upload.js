const fs = require('fs');

// Valid values for lookup fields in iDempiere
const VALID = {
  Packaging: ['Reel', 'Tube', 'Tray', 'Bulk', 'Cut Tape', ''],
  RoHS: ['Yes', 'No', 'Not Applicable', ''],
  Currency: ['GBP', 'EUR', 'USD', 'JPY', 'CNY', '']
};

// Proper CSV line parser that handles quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function validate(file) {
  const csv = fs.readFileSync(file, 'utf8');
  const lines = csv.trim().split('\n');
  const header = parseCSVLine(lines[0]);

  const pkgIdx = header.indexOf('Packaging');
  const rohsIdx = header.indexOf('RoHS');
  const currIdx = header.indexOf('Currency');

  const errors = [];
  const stats = { Packaging: {}, RoHS: {}, Currency: {} };

  lines.slice(1).forEach((line, i) => {
    const parts = parseCSVLine(line);
    const mpn = parts[4];

    const pkg = parts[pkgIdx] || '';
    stats.Packaging[pkg] = (stats.Packaging[pkg] || 0) + 1;
    if (!VALID.Packaging.includes(pkg)) {
      errors.push({ row: i + 2, mpn, field: 'Packaging', value: pkg });
    }

    const rohs = parts[rohsIdx] || '';
    stats.RoHS[rohs] = (stats.RoHS[rohs] || 0) + 1;
    if (!VALID.RoHS.includes(rohs)) {
      errors.push({ row: i + 2, mpn, field: 'RoHS', value: rohs });
    }

    const curr = parts[currIdx] || '';
    stats.Currency[curr] = (stats.Currency[curr] || 0) + 1;
    if (!VALID.Currency.includes(curr)) {
      errors.push({ row: i + 2, mpn, field: 'Currency', value: curr });
    }
  });

  return { errors, stats, total: lines.length - 1 };
}

// Validate files
const files = process.argv.slice(2);
if (files.length === 0) {
  files.push('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM EPG Award/lam-vq-ohq-filtered.csv');
  files.push('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM EPG Award/lam-vq-bpa-filtered.csv');
}

files.forEach(file => {
  console.log('='.repeat(60));
  console.log('VALIDATING:', file.split('/').pop());
  console.log('='.repeat(60));

  const result = validate(file);

  console.log(`Total records: ${result.total}`);
  console.log('');

  // Show stats
  console.log('Packaging values:');
  Object.entries(result.stats.Packaging).sort((a, b) => b[1] - a[1]).forEach(([v, c]) => {
    const valid = VALID.Packaging.includes(v) ? '✓' : '✗';
    console.log(`  ${valid} ${v || '(blank)'}: ${c}`);
  });

  console.log('');
  console.log('Currency values:');
  Object.entries(result.stats.Currency).sort((a, b) => b[1] - a[1]).forEach(([v, c]) => {
    const valid = VALID.Currency.includes(v) ? '✓' : '✗';
    console.log(`  ${valid} ${v || '(blank)'}: ${c}`);
  });

  console.log('');
  if (result.errors.length === 0) {
    console.log('✓ PASS - All lookup fields valid');
  } else {
    console.log(`✗ FAIL - ${result.errors.length} invalid values:`);
    result.errors.slice(0, 15).forEach(e => {
      console.log(`  Row ${e.row}: ${e.mpn} | ${e.field} = "${e.value}"`);
    });
    if (result.errors.length > 15) {
      console.log(`  ... and ${result.errors.length - 15} more`);
    }
  }
  console.log('');
});
