const fs = require('fs');
const { execSync } = require('child_process');

function execQuery(sql) {
  try {
    const result = execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });
    return result.trim();
  } catch (err) {
    console.error('Query error:', err.message);
    return '';
  }
}

function parseRows(output, columns) {
  if (!output) return [];
  return output.split('\n')
    .filter(line => line.trim())
    .map(line => {
      const values = line.split('|');
      const row = {};
      columns.forEach((col, i) => {
        row[col] = values[i] || '';
      });
      return row;
    });
}

function formatCurrency(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return '$0';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNumber(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Read the query file
const path = require('path');
const queryFile = path.join(__dirname, '../queries/vp-daily-queries-v2.sql');
const queries = fs.readFileSync(queryFile, 'utf8');

// Extract Section 1.4 and modify for 30-day window
let reactivatedQuery = queries.split('1.4 CUSTOMERS REACTIVATED YESTERDAY')[1]
  .split('SECTION 2: NEEDS ATTENTION')[0]
  .trim();

// Find the SQL
const sqlMatch = reactivatedQuery.match(/WITH[\s\S]+?LIMIT 5;/);
if (!sqlMatch) {
  console.error('Could not find reactivation query');
  process.exit(1);
}

let sql = sqlMatch[0];

// Modify for 30-day test - change business_day CTE
sql = sql.replace(
  /WITH business_day AS[\s\S]+?\),/,
  'WITH business_day AS (SELECT CURRENT_DATE - INTERVAL \'1 day\' as report_date),'
);

// Change the yesterday_orders WHERE to include last 30 days
sql = sql.replace(
  /WHERE o\.created::date = \(SELECT report_date FROM business_day\)/g,
  'WHERE o.created::date >= CURRENT_DATE - INTERVAL \'30 days\''
);

// Increase LIMIT to see more results
sql = sql.replace(/LIMIT 5;$/, 'LIMIT 50;');

console.log('Running 30-day reactivations query...');
const results = parseRows(execQuery(sql), [
  'customer_name', 'facility_location', 'tracked_at_location_level', 'first_order_date',
  'last_order_date', 'days_gap', 'yesterday_orders', 'yesterday_revenue', 'yesterday_gp',
  'seller_name', 'region', 'lifetime_orders', 'lifetime_revenue', 'typical_cycle_days',
  'gap_multiplier', 'reactivation_type', 'significance_score'
]);

console.log(`\nFound ${results.length} reactivations in last 30 days\n`);

if (results.length === 0) {
  console.log('No reactivations found. This might indicate:');
  console.log('1. The filter is still too restrictive');
  console.log('2. There were no genuine reactivations in this period');
  console.log('3. All recent orders were from regular active customers');
  process.exit(0);
}

// Group by customer to look for handoffs
const byCustomer = {};
results.forEach(r => {
  const key = r.customer_name + (r.facility_location ? ` - ${r.facility_location}` : '');
  if (!byCustomer[key]) byCustomer[key] = [];
  byCustomer[key].push(r);
});

console.log('='.repeat(80));
console.log('SELLER HANDOFF ANALYSIS (same customer, different sellers over time)');
console.log('='.repeat(80));

let handoffFound = false;
Object.entries(byCustomer).forEach(([customer, entries]) => {
  if (entries.length > 1) {
    const sellers = [...new Set(entries.map(e => e.seller_name))];
    if (sellers.length > 1) {
      console.log(`\n${customer}:`);
      entries.forEach(e => {
        console.log(`  - ${e.seller_name} (${e.region}) - Gap: ${e.days_gap} days - Revenue: ${formatCurrency(e.yesterday_revenue)}`);
      });
      handoffFound = true;
    }
  }
});

if (!handoffFound) {
  console.log('\nNo seller handoffs detected in last 30 days.');
  console.log('This could mean:');
  console.log('- No account transitions occurred in this period');
  console.log('- Each reactivated customer only ordered once in the 30-day window');
  console.log('- The same seller handled each reactivated customer');
}

console.log('\n' + '='.repeat(80));
console.log('ALL REACTIVATIONS (Top 30 by gap)');
console.log('='.repeat(80));

results
  .sort((a, b) => parseFloat(b.days_gap) - parseFloat(a.days_gap))
  .slice(0, 30)
  .forEach((r, i) => {
    console.log(`\n${i + 1}. ${r.customer_name}`);
    if (r.facility_location && r.tracked_at_location_level === 'Y') {
      console.log(`   Location: ${r.facility_location} (facility-level)`);
    }
    console.log(`   Gap: ${r.days_gap} days | Type: ${r.reactivation_type}`);
    console.log(`   Revenue: ${formatCurrency(r.yesterday_revenue)} | GP: ${formatCurrency(r.yesterday_gp)}`);
    console.log(`   Seller: ${r.seller_name} (${r.region})`);
    console.log(`   Lifetime: ${r.lifetime_orders} orders, ${formatCurrency(r.lifetime_revenue)} revenue`);
    if (parseFloat(r.typical_cycle_days) > 0) {
      console.log(`   Typical Cycle: ${formatNumber(r.typical_cycle_days)} days | ${r.gap_multiplier}x typical`);
    }
  });

console.log('\n');
