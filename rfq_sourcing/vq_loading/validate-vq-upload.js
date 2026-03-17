const fs = require('fs');

// Valid values for lookup fields in iDempiere (from database)
const VALID = {
  Packaging: ['REEL', 'TRAY', 'BULK', 'CUT TAPE', 'AMMO', 'BOX', 'F-REEL', 'F-TRAY', 'F-TUBE', 'OTHER', ''],
  RoHS: ['Yes', 'No', 'Not Applicable', ''],
  Currency: ['GBP', 'EUR', 'USD', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'HKD', 'SGD', 'TWD', 'KRW', 'INR', 'MXN', 'THB', 'MYR', 'PHP', ''],
  // Full country names from adempiere.c_country (commonly used in VQs)
  COO: [
    '', // blank is valid
    'China', 'Taiwan', 'Malaysia', 'United States', 'Japan', 'Korea Republic of', 'Germany', 'Mexico',
    'Thailand', 'Philippines', 'Singapore', 'Hong Kong', 'India', 'Indonesia', 'Viet Nam', 'Israel',
    'Costa Rica', 'Portugal', 'United Kingdom', 'France', 'Italy', 'Netherlands', 'Belgium', 'Switzerland',
    'Austria', 'Czech Republic', 'Hungary', 'Poland', 'Romania', 'Ireland', 'Spain', 'Sweden', 'Denmark',
    'Finland', 'Norway', 'Canada', 'Brazil', 'Australia', 'New Zealand', 'South Africa', 'Turkey',
    'United Arab Emirates', 'Saudi Arabia', 'Egypt', 'Morocco', 'Tunisia', 'Pakistan', 'Bangladesh',
    'Sri Lanka', 'Cambodia', 'Laos', 'Myanmar'
  ]
};

// Common ISO codes that should be converted to full names
const ISO_TO_COUNTRY = {
  'CN': 'China', 'TW': 'Taiwan', 'MY': 'Malaysia', 'US': 'United States', 'USA': 'United States',
  'JP': 'Japan', 'KR': 'Korea Republic of', 'DE': 'Germany', 'MX': 'Mexico', 'TH': 'Thailand',
  'PH': 'Philippines', 'SG': 'Singapore', 'HK': 'Hong Kong', 'IN': 'India', 'ID': 'Indonesia',
  'VN': 'Viet Nam', 'IL': 'Israel', 'CR': 'Costa Rica', 'PT': 'Portugal', 'GB': 'United Kingdom',
  'UK': 'United Kingdom', 'FR': 'France', 'IT': 'Italy', 'NL': 'Netherlands', 'BE': 'Belgium',
  'CH': 'Switzerland', 'AT': 'Austria', 'CZ': 'Czech Republic', 'HU': 'Hungary', 'PL': 'Poland',
  'RO': 'Romania', 'IE': 'Ireland', 'ES': 'Spain', 'SE': 'Sweden', 'DK': 'Denmark'
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
  const cooIdx = header.indexOf('COO');

  const errors = [];
  const stats = { Packaging: {}, RoHS: {}, Currency: {}, COO: {} };

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

    // COO validation - check for ISO codes and invalid values
    const coo = cooIdx >= 0 ? (parts[cooIdx] || '') : '';
    stats.COO[coo] = (stats.COO[coo] || 0) + 1;
    if (ISO_TO_COUNTRY[coo.toUpperCase()]) {
      // It's an ISO code - should be full name
      errors.push({ row: i + 2, mpn, field: 'COO', value: coo, hint: `use "${ISO_TO_COUNTRY[coo.toUpperCase()]}"` });
    } else if (coo && !VALID.COO.includes(coo)) {
      errors.push({ row: i + 2, mpn, field: 'COO', value: coo });
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
  console.log('COO values:');
  Object.entries(result.stats.COO).sort((a, b) => b[1] - a[1]).forEach(([v, c]) => {
    const isIsoCode = ISO_TO_COUNTRY[v.toUpperCase()];
    const valid = !isIsoCode && (v === '' || VALID.COO.includes(v));
    const hint = isIsoCode ? ` → use "${ISO_TO_COUNTRY[v.toUpperCase()]}"` : '';
    console.log(`  ${valid ? '✓' : '✗'} ${v || '(blank)'}: ${c}${hint}`);
  });

  console.log('');
  if (result.errors.length === 0) {
    console.log('✓ PASS - All lookup fields valid');
  } else {
    console.log(`✗ FAIL - ${result.errors.length} invalid values:`);
    result.errors.slice(0, 15).forEach(e => {
      const hint = e.hint ? ` (${e.hint})` : '';
      console.log(`  Row ${e.row}: ${e.mpn} | ${e.field} = "${e.value}"${hint}`);
    });
    if (result.errors.length > 15) {
      console.log(`  ... and ${result.errors.length - 15} more`);
    }
  }
  console.log('');
});
