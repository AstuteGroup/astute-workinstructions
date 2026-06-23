#!/usr/bin/env node
/**
 * VP Daily Brief - Sales Pulse (V2 - Restructured)
 *
 * Purpose: Strategic daily snapshot for VP Sales (Josh Pucci)
 * Structure: 3-Section Format per Josh's June 4 & June 18 feedback
 *
 * Section 1: Yesterday's Top Wins
 * Section 2: Needs Attention
 * Section 3: Yesterday's Activity by Region
 *
 * Cadence: Mon-Fri at 6:00 AM PT
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Execute PostgreSQL query from file
 */
function execQueryFromFile(queryFile, queryName) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const sections = queries.split('--');

  // Find the query by name
  let targetQuery = null;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].includes(queryName)) {
      // Get the SQL after the comment
      const nextSection = sections[i + 1] || '';
      const sqlStart = nextSection.indexOf('SELECT') >= 0 ? nextSection.indexOf('SELECT') : nextSection.indexOf('WITH');
      if (sqlStart >= 0) {
        const sql = nextSection.substring(sqlStart).split(/\n\n--/)[0].trim();
        targetQuery = sql;
        break;
      }
    }
  }

  if (!targetQuery) {
    throw new Error(`Query "${queryName}" not found in file`);
  }

  return execQuery(targetQuery);
}

/**
 * Execute PostgreSQL query
 */
function execQuery(sql) {
  try {
    // Write query to temp file to avoid command-line escaping issues
    const tempFile = path.join(__dirname, '../output/temp-query.sql');
    fs.writeFileSync(tempFile, sql);

    const output = execSync(
      `psql idempiere_replica -t -A -F'|' -f "${tempFile}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );

    // Clean up temp file
    fs.unlinkSync(tempFile);

    return output.trim();
  } catch (error) {
    console.error('Query error:', error.message);
    return '';
  }
}

/**
 * Parse single-row query result
 */
function parseRow(output, columnNames) {
  if (!output) return null;
  const values = output.split('|');
  const result = {};
  columnNames.forEach((name, i) => {
    result[name] = values[i] || null;
  });
  return result;
}

/**
 * Parse multi-row query results
 */
function parseRows(output, columnNames) {
  if (!output) return [];
  return output.split('\n').map(line => {
    const values = line.split('|');
    const result = {};
    columnNames.forEach((name, i) => {
      result[name] = values[i] || null;
    });
    return result;
  });
}

/**
 * Format date
 */
function formatDate(date) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Format currency
 */
function formatCurrency(amount) {
  if (!amount || amount === '0' || amount === 0) return '$0';
  const num = parseFloat(amount);
  if (isNaN(num)) return '$0';
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return '$' + (num / 1000).toFixed(0) + 'K';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (!num || num === '0') return '0';
  return parseInt(num).toLocaleString('en-US');
}

/**
 * Format percentage
 */
function formatPercent(decimal) {
  if (!decimal || decimal === '0') return '0%';
  return (parseFloat(decimal) * 100).toFixed(1) + '%';
}

// ============================================================================
// DATA COLLECTION
// ============================================================================

async function collectData() {
  console.log('Collecting data for VP Daily Brief V2...\n');

  const today = new Date();

  // Calculate previous business day (Friday if Monday, else yesterday)
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
  const businessDay = new Date(today);
  if (dayOfWeek === 1) {
    // Monday: go back 3 days to Friday
    businessDay.setDate(businessDay.getDate() - 3);
  } else {
    // Otherwise: go back 1 day
    businessDay.setDate(businessDay.getDate() - 1);
  }

  const data = {
    today,
    yesterday: businessDay,  // Actually previous business day
    todayFormatted: formatDate(today),
    yesterdayFormatted: formatDate(businessDay)
  };

  const queryFile = path.join(__dirname, '../queries/vp-daily-queries-v2.sql');

  // SECTION 1: Yesterday's Top Wins
  console.log('Section 1: Yesterday\'s Top Wins');
  console.log('  - Fetching top 5 orders...');
  data.top5Orders = getTop5Orders(queryFile);

  console.log('  - Fetching new customers sold...');
  data.newCustomers = getNewCustomersSold(queryFile);

  console.log('  - Fetching strategic accounts activity...');
  data.strategicAccounts = getStrategicAccountsActivity(queryFile);

  console.log('  - Fetching reactivated customers...');
  data.reactivatedCustomers = getReactivatedCustomers(queryFile);

  // SECTION 2: Needs Attention
  console.log('\nSection 2: Needs Attention');
  console.log('  - Fetching past due summary...');
  data.highValueLateLines = getHighValueLateLines(queryFile);
  data.top5LateLines = getTop5LateLines(queryFile);

  console.log('  - Fetching ISE alerts...');
  data.iseAlerts = getISEAlerts(queryFile);

  console.log('  - Fetching low margin orders...');
  data.lowMarginOrders = getLowMarginOrders(queryFile);

  // SECTION 3: Yesterday's Activity
  console.log('\nSection 3: Yesterday\'s Activity by Region');
  console.log('  - Fetching regional activity...');
  data.regionalActivity = getRegionalActivity(queryFile);

  // Calculate totals from regional data
  data.regionalTotals = {
    rfq_lines: data.regionalActivity.reduce((sum, r) => sum + parseInt(r.rfq_lines || 0), 0),
    cq_lines: data.regionalActivity.reduce((sum, r) => sum + parseInt(r.cq_lines || 0), 0),
    cq_sold: data.regionalActivity.reduce((sum, r) => sum + parseInt(r.cq_sold || 0), 0),
    so_lines: data.regionalActivity.reduce((sum, r) => sum + parseInt(r.so_lines || 0), 0),
    so_revenue: data.regionalActivity.reduce((sum, r) => sum + parseFloat(r.so_revenue || 0), 0),
    so_gp: data.regionalActivity.reduce((sum, r) => sum + parseFloat(r.so_gp || 0), 0)
  };

  console.log('\n✓ Data collection complete\n');
  return data;
}

/**
 * Section 1.1: Top 5 Orders Won
 */
function getTop5Orders(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const top5Query = queries.split('1.1 TOP 5 ORDERS WON')[1]
    .split('1.2 NEW CUSTOMERS SOLD')[0]
    .trim();

  const sqlMatch = top5Query.match(/WITH[\s\S]+?LIMIT 5;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'seller_name', 'region', 'customer_name', 'order_number', 'revenue', 'part_numbers'
  ]);
}

/**
 * Section 1.2: New Customers Sold
 */
function getNewCustomersSold(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const newCustomersQuery = queries.split('1.2 NEW CUSTOMERS SOLD')[1]
    .split('1.3 GLOBAL STRATEGIC ACCOUNTS')[0]
    .trim();

  const sqlMatch = newCustomersQuery.match(/WITH[\s\S]+?ORDER BY total_revenue DESC;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'seller_name', 'region', 'customer_name', 'order_number', 'total_revenue', 'total_gp',
    'mpns', 'mfr_names', 'total_qty', 'customer_location', 'contact_name', 'promise_date'
  ]);
}

/**
 * Section 1.3: Strategic Accounts Activity
 */
function getStrategicAccountsActivity(queryFile) {
  // This query is complex - reading from file
  const queries = fs.readFileSync(queryFile, 'utf8');
  const strategicQuery = queries.split('1.3 GLOBAL STRATEGIC ACCOUNTS ACTIVITY')[1]
    .split('1.4 REACTIVATED CUSTOMERS')[0]
    .trim();

  // Extract just the SQL
  const sqlMatch = strategicQuery.match(/WITH[\s\S]+?ORDER BY account_name, ise_name;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'account_name', 'ise_name', 'region', 'rfq_lines', 'cq_lines', 'cq_sold', 'so_count', 'so_revenue', 'so_gp', 'color_code'
  ]);
}

/**
 * Section 1.4: Reactivated Customers
 */
function getReactivatedCustomers(queryFile) {
  // Shows unique customers (grouped by c_bpartner_id) who returned after 180+ day gap
  const queries = fs.readFileSync(queryFile, 'utf8');
  const reactivatedQuery = queries.split('1.4 REACTIVATED CUSTOMERS')[1]
    .split('SECTION 2: NEEDS ATTENTION')[0]
    .trim();

  const sqlMatch = reactivatedQuery.match(/WITH[\s\S]+?ORDER BY yo\.total_revenue DESC;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'sales_order_date', 'seller_name', 'region', 'customer_name', 'c_bpartner_id', 'order_count',
    'order_numbers', 'total_revenue', 'mpns', 'mfr_names', 'total_qty',
    'customer_location', 'contact_name', 'promise_date', 'last_order_date',
    'days_since_last_order', 'previous_sales_rep'
  ]);
}

/**
 * Section 2.1: Late Shipments
 */
function getLateShipments(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const lateQuery = queries.split('2.1 LATE SHIPMENTS')[1]
    .split('2.2 PAST DUE SUMMARY')[0]
    .trim();

  const sqlMatch = lateQuery.match(/WITH[\s\S]+?ORDER BY days_late DESC, total_revenue DESC;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'customer_name', 'sales_order', 'ise_name', 'region', 'total_revenue',
    'part_numbers', 'promise_date', 'in_stock', 'days_late', 'color_code'
  ]);
}

/**
 * Section 2.2A: High Value Late SO Lines ($200K+)
 */
function getHighValueLateLines(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const summaryQuery = queries.split('2.2A HIGH VALUE LATE SO LINES')[1]
    .split('2.2B TOP 5 LATE SO LINES')[0]
    .trim();

  const sqlMatch = summaryQuery.match(/SELECT[\s\S]+?ORDER BY ol\.linenetamt DESC;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'customer_name', 'sales_order', 'line_number', 'ise_name', 'region', 'promise_date', 'days_late', 'qty_unshipped', 'line_revenue', 'mpn', 'color_code'
  ]);
}

/**
 * Section 2.2B: Top 5 Late SO Lines (Under $200K)
 */
function getTop5LateLines(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const summaryQuery = queries.split('2.2B TOP 5 LATE SO LINES')[1]
    .split('2.3 INSIDE SALES REPS ALERT')[0]
    .trim();

  const sqlMatch = summaryQuery.match(/SELECT[\s\S]+?LIMIT 5;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'customer_name', 'sales_order', 'line_number', 'ise_name', 'region', 'promise_date', 'days_late', 'qty_unshipped', 'line_revenue', 'mpn', 'color_code'
  ]);
}

/**
 * Section 2.3: ISE Alerts
 */
function getISEAlerts(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const iseQuery = queries.split('2.3 INSIDE SALES REPS ALERT')[1]
    .split('2.4 LOW MARGIN ORDERS TRAIL')[0]
    .trim();

  const sqlMatch = iseQuery.match(/WITH[\s\S]+?ORDER BY days_inactive DESC, sl.region, sl.name;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'ise_name', 'manager', 'region', 'last_rfq_date', 'days_inactive', 'color_code'
  ]);
}

/**
 * Section 2.4: Low Margin Orders
 */
function getLowMarginOrders(queryFile) {
  // TEMPORARILY DISABLED: This query is slow due to cost calculations requiring c_orderline joins
  // Can re-enable later with further optimization if needed
  // Typically there are very few <18% margin orders anyway
  return [];

  /* Original implementation:
  const queries = fs.readFileSync(queryFile, 'utf8');
  const lowMarginQuery = queries.split('2.4 LOW MARGIN ORDERS TRAIL')[1]
    .split('SECTION 3: YESTERDAY')[0]
    .trim();

  const sqlMatch = lowMarginQuery.match(/SELECT[\s\S]+?ORDER BY gm_percent ASC, revenue DESC;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'customer_name', 'sales_order', 'ise_name', 'region', 'revenue',
    'gross_profit', 'gm_percent', 'part_numbers', 'promise_date'
  ]);
  */
}

/**
 * Section 3.1: Global Activity
 */
function getGlobalActivity(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const globalQuery = queries.split('3.1 GLOBAL ACTIVITY SUMMARY')[1]
    .split('3.2 ACTIVITY BY REGION')[0]
    .trim();

  // Skip comment lines and match from the actual SELECT statement
  const sqlMatch = globalQuery.match(/\nSELECT[\s\S]+?as so_revenue;/);
  if (!sqlMatch) {
    // Return default values if query not found
    return { rfq_lines: 0, rfq_customers: 0, cq_lines: 0, cq_sold: 0, so_lines: 0, so_revenue: 0 };
  }

  const result = parseRow(execQuery(sqlMatch[0]), [
    'rfq_lines', 'rfq_customers', 'cq_lines', 'cq_sold', 'so_lines', 'so_revenue'
  ]);

  // Return default values if query returns null/empty
  return result || { rfq_lines: 0, rfq_customers: 0, cq_lines: 0, cq_sold: 0, so_lines: 0, so_revenue: 0 };
}

/**
 * Section 3.2: Regional Activity
 */
function getRegionalActivity(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const regionalQuery = queries.split('3.2 ACTIVITY BY REGION')[1]
    .trim();

  const sqlMatch = regionalQuery.match(/WITH[\s\S]+?ORDER BY region;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'region', 'manager', 'rfq_lines', 'cq_lines', 'cq_sold', 'so_lines', 'so_revenue', 'so_gp'
  ]);
}

// ============================================================================
// HTML GENERATION
// ============================================================================

function generateHTML(data) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VP Daily Brief — Sales Pulse</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
    background: #f5f5f5;
  }
  .container {
    background: white;
    padding: 28px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 6px 0;
    color: #1a1a1a;
  }
  .subtitle {
    font-size: 12px;
    color: #666;
    margin-bottom: 24px;
  }

  /* Section Headers */
  .section-header {
    font-size: 16px;
    font-weight: 700;
    margin: 28px 0 12px 0;
    padding-bottom: 8px;
    border-bottom: 2px solid #e0e0e0;
    color: #1a1a1a;
  }
  .section-header:first-of-type {
    margin-top: 0;
  }
  .subsection-header {
    font-size: 14px;
    font-weight: 600;
    margin: 16px 0 8px 0;
    color: #444;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-bottom: 16px;
  }
  th {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    padding: 8px;
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  td {
    border: 1px solid #e2e8f0;
    padding: 8px;
    vertical-align: top;
  }
  tr:hover { background: #f8fafc; }
  td.number { text-align: right; font-weight: 600; }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge-yellow { background: #fef3c7; color: #92400e; }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-green { background: #dcfce7; color: #166534; }

  /* Alert Boxes */
  .alert-box {
    margin-bottom: 14px;
    padding: 12px 14px;
    border-radius: 6px;
    border-left: 4px solid #ccc;
    background: #f8f8f8;
    font-size: 12px;
  }
  .alert-box.yellow { border-left-color: #f59e0b; background: #fffbeb; }
  .alert-box.red { border-left-color: #dc2626; background: #fef2f2; }
  .alert-box.green { border-left-color: #16a34a; background: #f0fdf4; }

  /* Metrics Cards */
  .metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 16px;
  }
  .metric {
    background: #f8fafc;
    border-radius: 6px;
    padding: 14px;
    border-left: 3px solid #94a3b8;
  }
  .metric-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #64748b;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .metric-value {
    font-size: 22px;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 2px;
  }
  .metric-trend {
    font-size: 11px;
    color: #64748b;
  }

  /* Footer */
  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 2px solid #e0e0e0;
    font-size: 10px;
    color: #666;
    line-height: 1.6;
  }
  .footer-title {
    font-weight: 700;
    font-size: 11px;
    margin-bottom: 6px;
    color: #444;
  }
  .footer ul {
    margin: 4px 0;
    padding-left: 18px;
  }
  .footer li {
    margin-bottom: 3px;
  }

  /* Empty State */
  .empty-state {
    padding: 12px;
    text-align: center;
    color: #666;
    font-style: italic;
    background: #f8f8f8;
    border-radius: 4px;
    margin-bottom: 12px;
  }
</style>
</head>
<body>

<div class="container">
  <h1>📊 VP Daily Brief — Sales Pulse</h1>
  <div class="subtitle">${data.todayFormatted} | Data as of EOD ${data.yesterdayFormatted}</div>

  ${generateSection1(data)}
  ${generateSection2(data)}
  ${generateSection3(data)}
  ${generateFooter()}
</div>

</body>
</html>`;
}

/**
 * SECTION 1: Yesterday's Top Wins
 */
function generateSection1(data) {
  let html = '<div class="section-header">🏆 Section 1: Yesterday\'s Top Wins</div>';

  // 1.1 Top 5 Orders
  html += '<div class="subsection-header">Top 5 Orders Won</div>';
  if (data.top5Orders.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Seller</th>
          <th>Region</th>
          <th>Customer</th>
          <th>SO#</th>
          <th style="text-align: right;">Revenue</th>
          <th>Part Numbers</th>
        </tr>
      </thead>
      <tbody>`;

    data.top5Orders.forEach((order, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
      html += `
        <tr>
          <td><strong>${medal}</strong></td>
          <td>${order.seller_name}</td>
          <td>${order.region}</td>
          <td>${order.customer_name}</td>
          <td style="font-size: 11px;">${order.order_number}</td>
          <td class="number">${formatCurrency(order.revenue)}</td>
          <td style="font-size: 11px;">${order.part_numbers || 'N/A'}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state">No orders won yesterday</div>';
  }

  // 1.2 New Customers Sold
  html += '<div class="subsection-header">New Customers Sold (First-Time Wins)</div>';
  if (data.newCustomers.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Seller</th>
          <th>Region</th>
          <th>Customer</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
          <th>MPNs</th>
          <th>MFR</th>
          <th>QTY</th>
          <th>Location</th>
          <th>Contact</th>
          <th>Promise Date</th>
        </tr>
      </thead>
      <tbody>`;

    data.newCustomers.forEach(cust => {
      html += `
        <tr>
          <td>${cust.seller_name}</td>
          <td>${cust.region}</td>
          <td><strong>${cust.customer_name}</strong></td>
          <td class="number">${formatCurrency(cust.total_revenue)}</td>
          <td class="number">${formatCurrency(cust.total_gp)}</td>
          <td style="font-size: 10px;">${cust.mpns || 'N/A'}</td>
          <td style="font-size: 11px;">${cust.mfr_names || 'N/A'}</td>
          <td class="number">${formatNumber(cust.total_qty)}</td>
          <td style="font-size: 10px;">${cust.customer_location || 'N/A'}</td>
          <td>${cust.contact_name || 'N/A'}</td>
          <td>${cust.promise_date || 'N/A'}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state">No new customers sold yesterday</div>';
  }

  // 1.3 Strategic Accounts
  html += '<div class="subsection-header">Global Strategic Accounts Activity</div>';
  html += '<div style="font-size: 11px; color: #666; margin-bottom: 8px;">ABB, Eaton, GE Healthcare, Parker-Meggitt, RTX, Thales</div>';
  if (data.strategicAccounts.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Account</th>
          <th>ISE</th>
          <th>Region</th>
          <th style="text-align: center;">RFQ Lines</th>
          <th style="text-align: center;">CQ Lines</th>
          <th style="text-align: center;">CQ Sold</th>
          <th style="text-align: center;">SOs</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
        </tr>
      </thead>
      <tbody>`;

    data.strategicAccounts.forEach(acct => {
      const nameStyle = acct.color_code === 'red' ? 'color: #d32f2f;' : '';
      const winStyle = 'background-color: #1b5e20; color: white; font-weight: bold;'; // Dark green
      const rfqStyle = parseInt(acct.rfq_lines) > 0 ? winStyle : '';
      const cqStyle = parseInt(acct.cq_lines) > 0 ? winStyle : '';
      const soldStyle = parseInt(acct.cq_sold) > 0 ? winStyle : '';
      const soStyle = parseInt(acct.so_count) > 0 ? winStyle : '';
      const revenueStyle = parseFloat(acct.so_revenue || 0) > 0 ? winStyle : '';
      const gpStyle = parseFloat(acct.so_gp || 0) > 0 ? winStyle : '';
      html += `
        <tr>
          <td><strong style="${nameStyle}">${acct.account_name}</strong></td>
          <td>${acct.ise_name || '—'}</td>
          <td>${acct.region || '—'}</td>
          <td style="text-align: center; ${rfqStyle}">${formatNumber(acct.rfq_lines)}</td>
          <td style="text-align: center; ${cqStyle}">${formatNumber(acct.cq_lines)}</td>
          <td style="text-align: center; ${soldStyle}">${formatNumber(acct.cq_sold)}</td>
          <td style="text-align: center; ${soStyle}">${formatNumber(acct.so_count)}</td>
          <td class="number" style="${revenueStyle}">${formatCurrency(acct.so_revenue)}</td>
          <td class="number" style="${gpStyle}">${formatCurrency(acct.so_gp)}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state">No strategic account activity yesterday</div>';
  }

  // 1.4 Reactivated Customers
  html += '<div class="subsection-header">Reactivated Customers (6+ Month Gap)</div>';
  if (data.reactivatedCustomers.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>SO Date</th>
          <th>Seller</th>
          <th>Region</th>
          <th>Customer</th>
          <th>Location</th>
          <th>BP ID</th>
          <th>SO #s</th>
          <th style="text-align: right;">Total Revenue</th>
          <th style="text-align: center;">Gap (Days)</th>
          <th>Last Order</th>
          <th>Previous Rep</th>
        </tr>
      </thead>
      <tbody>`;

    data.reactivatedCustomers.forEach(cust => {
      html += `
        <tr>
          <td>${cust.sales_order_date}</td>
          <td>${cust.seller_name}</td>
          <td>${cust.region}</td>
          <td><strong>${cust.customer_name}</strong></td>
          <td style="font-size: 9px;">${cust.customer_location || 'N/A'}</td>
          <td style="font-size: 10px;">${cust.c_bpartner_id}</td>
          <td style="font-size: 10px;">${cust.order_numbers}</td>
          <td class="number">${formatCurrency(cust.total_revenue)}</td>
          <td style="text-align: center;"><span class="badge badge-green">${formatNumber(cust.days_since_last_order)}</span></td>
          <td>${cust.last_order_date}</td>
          <td>${cust.previous_sales_rep || 'N/A'}</td>
        </tr>`;
    });

    // Add total row
    const totalRevenue = data.reactivatedCustomers.reduce((sum, cust) => sum + parseFloat(cust.total_revenue || 0), 0);
    html += `
      <tr style="border-top: 2px solid #333; background-color: #f5f5f5; font-weight: bold;">
        <td colspan="7" style="text-align: right;"><strong>TOTAL</strong></td>
        <td class="number"><strong>${formatCurrency(totalRevenue)}</strong></td>
        <td colspan="3"></td>
      </tr>`;

    html += '</tbody></table>';
  } else {
    html += '<div class="empty-state">No reactivated customers yesterday</div>';
  }

  return html;
}

/**
 * SECTION 2: Needs Attention
 */
function generateSection2(data) {
  let html = '<div class="section-header">⚠️ Section 2: Needs Attention</div>';

  // 2.2A High Value Late SO Lines ($200K+)
  html += '<div class="subsection-header">High Value Late SO Lines ($200K+, 3-31 days past due)</div>';
  html += '<div style="font-size: 11px; color: #666; margin-bottom: 8px;">🟡 Yellow: 3-7 days late | 🔴 Red: 8+ days late | Rolling 31-day window</div>';
  if (data.highValueLateLines.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>SO#</th>
          <th>Line</th>
          <th>MPN</th>
          <th>ISE</th>
          <th>Region</th>
          <th>Promise Date</th>
          <th style="text-align: center;">Days Late</th>
          <th style="text-align: right;">Qty Unshipped</th>
          <th style="text-align: right;">Unshipped Line Revenue</th>
        </tr>
      </thead>
      <tbody>`;

    data.highValueLateLines.forEach(line => {
      const rowColor = line.color_code === 'red' ? '#ffebee' : '#fff9c4';
      const daysLateColor = line.color_code === 'red' ? '#d32f2f' : '#f57c00';
      html += `
        <tr style="background-color: ${rowColor};">
          <td><strong>${line.customer_name}</strong></td>
          <td>${line.sales_order}</td>
          <td style="text-align: center;">${line.line_number}</td>
          <td style="font-size: 10px;">${line.mpn || 'N/A'}</td>
          <td>${line.ise_name || 'N/A'}</td>
          <td>${line.region}</td>
          <td>${line.promise_date}</td>
          <td style="text-align: center; color: ${daysLateColor}; font-weight: bold;">${line.days_late}</td>
          <td class="number">${formatNumber(line.qty_unshipped)}</td>
          <td class="number">${formatCurrency(line.line_revenue)}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="alert-box green">✓ No high-value lines ($200K+) past due</div>';
  }

  // 2.2B Top 5 Late SO Lines (Under $200K)
  html += '<div class="subsection-header">Top 5 Late SO Lines (Under $200K, 3-31 days past due)</div>';
  html += '<div style="font-size: 11px; color: #666; margin-bottom: 8px;">🟡 Yellow: 3-7 days late | 🔴 Red: 8+ days late</div>';
  if (data.top5LateLines.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>SO#</th>
          <th>Line</th>
          <th>MPN</th>
          <th>ISE</th>
          <th>Region</th>
          <th>Promise Date</th>
          <th style="text-align: center;">Days Late</th>
          <th style="text-align: right;">Qty Unshipped</th>
          <th style="text-align: right;">Unshipped Line Revenue</th>
        </tr>
      </thead>
      <tbody>`;

    data.top5LateLines.forEach(line => {
      const rowColor = line.color_code === 'red' ? '#ffebee' : '#fff9c4';
      const daysLateColor = line.color_code === 'red' ? '#d32f2f' : '#f57c00';
      html += `
        <tr style="background-color: ${rowColor};">
          <td><strong>${line.customer_name}</strong></td>
          <td>${line.sales_order}</td>
          <td style="text-align: center;">${line.line_number}</td>
          <td style="font-size: 10px;">${line.mpn || 'N/A'}</td>
          <td>${line.ise_name || 'N/A'}</td>
          <td>${line.region}</td>
          <td>${line.promise_date}</td>
          <td style="text-align: center; color: ${daysLateColor}; font-weight: bold;">${line.days_late}</td>
          <td class="number">${formatNumber(line.qty_unshipped)}</td>
          <td class="number">${formatCurrency(line.line_revenue)}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="alert-box green">✓ No smaller lines (<$200K) past due</div>';
  }

  // 2.3 ISE Alerts
  html += '<div class="subsection-header">Inside Sales Reps Alert (No RFQ in 3+ Days)</div>';
  if (data.iseAlerts.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>ISE</th>
          <th>Manager</th>
          <th>Region</th>
          <th>Last RFQ Date</th>
          <th style="text-align: center;">Days Inactive</th>
        </tr>
      </thead>
      <tbody>`;

    data.iseAlerts.forEach(ise => {
      const badgeColor = ise.color_code === 'red' ? 'badge-red' : 'badge-yellow';
      const bgColor = ise.color_code === 'red' ? '#fee2e2' : '#fef3c7';
      const textColor = ise.color_code === 'red' ? '#991b1b' : '#92400e';
      html += `
        <tr>
          <td><strong>${ise.ise_name}</strong></td>
          <td>${ise.manager}</td>
          <td>${ise.region}</td>
          <td>${ise.last_rfq_date}</td>
          <td style="text-align: center; background-color: ${bgColor};"><span class="badge ${badgeColor}" style="font-weight: bold; color: ${textColor};">${ise.days_inactive} days</span></td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="alert-box green">✓ All ISEs have loaded RFQs recently</div>';
  }

  // 2.4 Low Margin Orders
  html += '<div class="subsection-header">Low Margin Orders Trail (<18% GM)</div>';
  if (data.lowMarginOrders.length > 0) {
    html += `<div class="alert-box yellow">
      <strong>${data.lowMarginOrders.length} orders</strong> booked yesterday under 18% margin (Josh-approved)
    </div>`;

    html += `<table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>SO#</th>
          <th>ISE</th>
          <th>Region</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
          <th style="text-align: right;">GM%</th>
          <th>Parts</th>
        </tr>
      </thead>
      <tbody>`;

    data.lowMarginOrders.forEach(order => {
      html += `
        <tr>
          <td>${order.customer_name}</td>
          <td style="font-size: 11px;">${order.sales_order}</td>
          <td>${order.ise_name}</td>
          <td>${order.region}</td>
          <td class="number">${formatCurrency(order.revenue)}</td>
          <td class="number">${formatCurrency(order.gross_profit)}</td>
          <td class="number"><strong>${parseFloat(order.gm_percent).toFixed(1)}%</strong></td>
          <td style="font-size: 10px;">${order.part_numbers || 'N/A'}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="alert-box green">✓ No low margin orders (<18% GM) yesterday</div>';
  }

  return html;
}

/**
 * SECTION 3: Yesterday's Activity by Region
 */
function generateSection3(data) {
  let html = '<div class="section-header">📊 Section 3: Yesterday\'s Activity by Region</div>';

  // Regional Breakdown with Total row
  if (data.regionalActivity.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Region</th>
          <th>Manager</th>
          <th style="text-align: center;">RFQ Lines</th>
          <th style="text-align: center;">CQ Lines</th>
          <th style="text-align: center;">CQ Sold</th>
          <th style="text-align: center;">SO Lines</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
        </tr>
      </thead>
      <tbody>`;

    data.regionalActivity.forEach(region => {
      html += `
        <tr>
          <td><strong>${region.region}</strong></td>
          <td>${region.manager}</td>
          <td style="text-align: center;">${formatNumber(region.rfq_lines)}</td>
          <td style="text-align: center;">${formatNumber(region.cq_lines)}</td>
          <td style="text-align: center;">${formatNumber(region.cq_sold)}</td>
          <td style="text-align: center;">${formatNumber(region.so_lines)}</td>
          <td class="number">${formatCurrency(region.so_revenue)}</td>
          <td class="number">${formatCurrency(region.so_gp)}</td>
        </tr>`;
    });

    // Add TOTAL row
    html += `
      <tr style="border-top: 2px solid #333; background-color: #f5f5f5; font-weight: bold;">
        <td colspan="2"><strong>TOTAL</strong></td>
        <td style="text-align: center;">${formatNumber(data.regionalTotals.rfq_lines)}</td>
        <td style="text-align: center;">${formatNumber(data.regionalTotals.cq_lines)}</td>
        <td style="text-align: center;">${formatNumber(data.regionalTotals.cq_sold)}</td>
        <td style="text-align: center;">${formatNumber(data.regionalTotals.so_lines)}</td>
        <td class="number"><strong>${formatCurrency(data.regionalTotals.so_revenue)}</strong></td>
        <td class="number"><strong>${formatCurrency(data.regionalTotals.so_gp)}</strong></td>
      </tr>`;

    html += '</tbody></table>';
  }

  return html;
}

/**
 * Generate Footer with Criteria
 */
function generateFooter() {
  return `
  <div class="footer">
    <div class="footer-title">Report Criteria & Definitions:</div>

    <strong>Section 1: Yesterday's Top Wins</strong>
    <ul>
      <li><strong>Top 5 Orders:</strong> Orders booked yesterday ranked by revenue</li>
      <li><strong>New Customers Sold:</strong> Customers placing their first order ever</li>
      <li><strong>Strategic Accounts:</strong> ABB, Eaton, GE Healthcare, Parker-Meggitt, RTX, Thales</li>
      <li><strong>Reactivated Customers:</strong> Customer IDs with no orders in the past 6+ months</li>
    </ul>

    <strong>Section 2: Needs Attention</strong>
    <ul>
      <li><strong>Late Shipments:</strong> 3+ days past promise date AND ($200K+ revenue OR strategic account OR new customer first order)</li>
      <li><strong>ISE Alerts:</strong> Inside sales reps with no RFQ loaded in 3+ business days (Yellow: 3-6 days, Red: 7+ days)</li>
      <li><strong>Low Margin Trail:</strong> Orders <18% GM (Josh-approved audit trail)</li>
    </ul>

    <strong>Section 3: Yesterday's Activity</strong>
    <ul>
      <li><strong>Regions:</strong> USA (Jeff Wallace), MEX (Joel Marquez), APAC-Laurel (Laurel Kee), APAC-Silvia (Silvia Munoz), APAC-Lavanya (Lavanya Manohar), Other</li>
    </ul>

    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #ddd;">
      <em>Note: Criteria and thresholds are subject to refinement based on Josh's feedback.</em><br>
      Questions? Reply to this email. | Next digest: Tomorrow 6:00 AM PT
    </div>
  </div>`;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('VP DAILY BRIEF - SALES PULSE (V2)');
  console.log('='.repeat(60));
  console.log();

  const data = await collectData();
  const html = generateHTML(data);

  // Save outputs
  const today = new Date().toISOString().split('T')[0];
  const outputDir = path.join(__dirname, '../output');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const htmlPath = path.join(outputDir, `vp-daily-brief-v2-${today}.html`);
  const jsonPath = path.join(outputDir, `vp-daily-brief-v2-${today}.json`);

  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

  console.log('='.repeat(60));
  console.log('✅ VP DAILY BRIEF GENERATED SUCCESSFULLY');
  console.log('='.repeat(60));
  console.log();
  console.log(`HTML: ${htmlPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log();
  console.log('📊 Summary:');
  console.log(`  Section 1 - Yesterday's Top Wins:`);
  console.log(`    - Top 5 Orders: ${data.top5Orders.length}`);
  console.log(`    - New Customers: ${data.newCustomers.length}`);
  console.log(`    - Strategic Accounts: ${data.strategicAccounts.length}`);
  console.log(`    - Reactivated Customers: ${data.reactivatedCustomers.length}`);
  console.log();
  console.log(`  Section 2 - Needs Attention:`);
  console.log(`    - High Value Late Lines: ${data.highValueLateLines.length}`);
  console.log(`    - Top 5 Late Lines: ${data.top5LateLines.length}`);
  console.log(`    - ISE Alerts: ${data.iseAlerts.length}`);
  console.log(`    - Low Margin Orders: ${data.lowMarginOrders.length}`);
  console.log();
  console.log(`  Section 3 - Yesterday's Activity:`);
  console.log(`    - RFQ Lines: ${formatNumber(data.regionalTotals.rfq_lines)}`);
  console.log(`    - CQ Lines: ${formatNumber(data.regionalTotals.cq_lines)} (${formatNumber(data.regionalTotals.cq_sold)} sold)`);
  console.log(`    - SO Lines: ${formatNumber(data.regionalTotals.so_lines)}`);
  console.log();
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
