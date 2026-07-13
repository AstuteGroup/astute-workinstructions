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
 * Section 1.1: Top 15 Orders Won (5 visible + 10 collapsible)
 */
function getTop5Orders(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const top5Query = queries.split('1.1 TOP 15 ORDERS WON')[1]
    .split('1.2 NEW CUSTOMERS SOLD')[0]
    .trim();

  const sqlMatch = top5Query.match(/WITH[\s\S]+?LIMIT 15;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'seller_name', 'region', 'customer_name', 'order_number', 'revenue', 'gp', 'part_numbers'
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
    'seller_name', 'region', 'customer_name', 'c_bpartner_id', 'order_number', 'total_revenue', 'total_gp',
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
  // Hybrid: Location-level for OEMs, Customer-level for others, 30-day minimum
  const queries = fs.readFileSync(queryFile, 'utf8');
  const reactivatedQuery = queries.split('1.4 CUSTOMERS REACTIVATED YESTERDAY')[1]
    .split('SECTION 2: NEEDS ATTENTION')[0]
    .trim();

  const sqlMatch = reactivatedQuery.match(/WITH[\s\S]+?LIMIT 5;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'customer_name', 'facility_location', 'tracked_at_location_level', 'first_order_date',
    'last_order_date', 'days_gap', 'yesterday_orders', 'yesterday_revenue', 'yesterday_gp',
    'seller_name', 'region', 'lifetime_orders', 'lifetime_revenue', 'typical_cycle_days',
    'gap_multiplier', 'reactivation_type', 'significance_score'
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
    'customer_name', 'sales_order', 'line_number', 'ise_name', 'region', 'promise_date', 'days_late', 'qty_unshipped', 'line_revenue', 'line_gp', 'mpn', 'color_code'
  ]);
}

/**
 * Section 2.2B: Top 15 Scheduled to Ship This Month (by GP) - 5 visible + 10 collapsible
 */
function getTop5LateLines(queryFile) {
  const queries = fs.readFileSync(queryFile, 'utf8');
  const summaryQuery = queries.split('2.2B TOP 15 SCHEDULED TO SHIP THIS MONTH')[1]
    .split('2.3 INSIDE SALES REPS ALERT')[0]
    .trim();

  const sqlMatch = summaryQuery.match(/SELECT[\s\S]+?LIMIT 15;/);
  if (!sqlMatch) return [];

  return parseRows(execQuery(sqlMatch[0]), [
    'customer_name', 'sales_order', 'line_number', 'ise_name', 'region', 'promise_date', 'days_until_promise', 'qty_unshipped', 'line_revenue', 'line_gp', 'mpn', 'in_stock', 'action_status', 'color_code'
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

  /* Collapsible Details */
  details {
    margin-bottom: 12px;
  }
  details summary {
    cursor: pointer;
    font-weight: 600;
    color: #1a1a1a;
    padding: 8px 12px;
    background: #f8fafc;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
    transition: background 0.2s;
  }
  details summary:hover {
    background: #e2e8f0;
  }
  details[open] summary {
    margin-bottom: 8px;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
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

  // 1.1 Top 15 Orders (5 visible + 10 collapsible)
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
          <th style="text-align: right;">GP</th>
          <th>Part Numbers</th>
        </tr>
      </thead>
      <tbody>`;

    // Show first 5 orders (always visible)
    data.top5Orders.slice(0, 5).forEach((order, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
      html += `
        <tr>
          <td><strong>${medal}</strong></td>
          <td>${order.seller_name}</td>
          <td>${order.region}</td>
          <td>${order.customer_name}</td>
          <td style="font-size: 11px;">${order.order_number}</td>
          <td class="number">${formatCurrency(order.revenue)}</td>
          <td class="number">${formatCurrency(order.gp)}</td>
          <td style="font-size: 11px;">${order.part_numbers || 'N/A'}</td>
        </tr>`;
    });

    html += '</tbody></table>';

    // Add collapsible section for orders 6-15 if available
    if (data.top5Orders.length > 5) {
      html += `
        <input type="checkbox" id="toggle-orders" style="display:none;">
        <label for="toggle-orders" style="cursor: pointer; font-weight: 600; color: #1a1a1a; padding: 8px; background: #f8fafc; border-radius: 4px; border: 1px solid #e2e8f0; display: block; margin-top: 8px; user-select: none;">
          <span class="toggle-icon">▶</span> 📋 Show Next ${Math.min(data.top5Orders.length - 5, 10)} Orders (Ranks #6-${Math.min(data.top5Orders.length, 15)})
        </label>
        <div class="collapsible-content" style="display: none; margin-top: 8px;">
          <table style="margin-top: 8px;">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Seller</th>
                <th>Region</th>
                <th>Customer</th>
                <th>SO#</th>
                <th style="text-align: right;">Revenue</th>
                <th style="text-align: right;">GP</th>
                <th>Part Numbers</th>
              </tr>
            </thead>
            <tbody>`;

      // Show orders 6-15 (collapsible)
      data.top5Orders.slice(5, 15).forEach((order, i) => {
        const rank = i + 6;
        html += `
          <tr>
            <td><strong>#${rank}</strong></td>
            <td>${order.seller_name}</td>
            <td>${order.region}</td>
            <td>${order.customer_name}</td>
            <td style="font-size: 11px;">${order.order_number}</td>
            <td class="number">${formatCurrency(order.revenue)}</td>
            <td class="number">${formatCurrency(order.gp)}</td>
            <td style="font-size: 11px;">${order.part_numbers || 'N/A'}</td>
          </tr>`;
      });

      html += `
            </tbody>
          </table>
        </div>
        <style>
          #toggle-orders:checked ~ .collapsible-content { display: block !important; }
          #toggle-orders:checked ~ label .toggle-icon::before { content: "▼"; }
          .toggle-icon::before { content: "▶"; }
        </style>`;
    }
  } else {
    html += '<div class="empty-state">No orders won yesterday</div>';
  }

  // Add footer note about GP = $0
  html += '<div style="margin-top: 8px; padding: 8px; background: #fffbeb; border-left: 3px solid #f59e0b; font-size: 11px; color: #92400e;">';
  html += '<strong>Note:</strong> When GP shows $0.00, it indicates that the <code>pricecost</code> field is null in the system. ';
  html += 'This typically occurs when cost data has not yet been entered for the order line.';
  html += '</div>';

  // 1.2 New Customers Sold
  html += '<div class="subsection-header">New Customers Sold (First-Time Wins)</div>';
  if (data.newCustomers.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Seller</th>
          <th>Region</th>
          <th>Customer</th>
          <th>BP ID</th>
          <th>Location</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
          <th>MPNs</th>
          <th>MFR</th>
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
          <td style="font-size: 10px;">${cust.c_bpartner_id || 'N/A'}</td>
          <td style="font-size: 10px;">${cust.customer_location || 'N/A'}</td>
          <td class="number">${formatCurrency(cust.total_revenue)}</td>
          <td class="number">${formatCurrency(cust.total_gp)}</td>
          <td style="font-size: 10px;">${cust.mpns || 'N/A'}</td>
          <td style="font-size: 11px;">${cust.mfr_names || 'N/A'}</td>
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

  // 1.4 Customers Reactivated Yesterday
  html += '<div class="subsection-header">Customers Reactivated Yesterday</div>';
  html += '<div style="font-size: 11px; color: #666; margin-bottom: 12px;">🏆 High-Value | 📊 Anomalous Pattern | 🕐 Long Dormant | 📍 Small Customer</div>';
  html += '<div style="font-size: 10px; color: #888; margin-bottom: 12px; font-style: italic;"><strong>Customer Name + City tracking</strong> • Excludes brokers/distributors/traders/Jake Harris • 30-day minimum • CQ-linked sales only</div>';

  if (data.reactivatedCustomers.length > 0) {
    data.reactivatedCustomers.forEach((cust, index) => {
      // Determine icon and label based on reactivation type
      const icon = cust.reactivation_type === 'high_value_long' ? '🏆' :
                   cust.reactivation_type === 'anomalous_pattern' ? '📊' :
                   cust.reactivation_type === 'dormant_long' ? '🕐' :
                   cust.reactivation_type === 'small_customer_long' ? '📍' : '✓';
      const typeLabel = cust.reactivation_type === 'high_value_long' ? 'High-Value Long Gap' :
                        cust.reactivation_type === 'anomalous_pattern' ? 'Anomalous Pattern' :
                        cust.reactivation_type === 'dormant_long' ? 'Long Dormant (6+ months)' :
                        cust.reactivation_type === 'small_customer_long' ? 'Small Customer Return' : 'Reactivated';

      html += '<div style="border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px; margin-bottom: 12px; background: white;">';

      // Header line with customer name and icon
      html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">`;
      html += `<div style="font-size: 14px; font-weight: bold; color: #1a1a1a;">${index + 1}. ${cust.customer_name} ${icon} <span style="color: #666; font-size: 11px; font-weight: normal;">${typeLabel}</span></div>`;
      html += `</div>`;

      // City location + gap analysis
      html += `<div style="font-size: 11px; color: #666; margin-bottom: 10px;">`;
      if (cust.facility_location && cust.facility_location !== 'Unknown City') {
        html += `<strong>📍 ${cust.facility_location}</strong> (city-level tracking)`;
      } else {
        html += `City unknown`;
      }

      // Gap analysis
      if (parseFloat(cust.typical_cycle_days) > 0 && parseFloat(cust.gap_multiplier) > 0) {
        html += ` | Typical Cycle: ${formatNumber(cust.typical_cycle_days)} days | Actual Gap: <strong>${formatNumber(cust.days_gap)} days (${cust.gap_multiplier}x typical)</strong>`;
      } else {
        html += ` | Gap: <strong>${formatNumber(cust.days_gap)} days</strong>`;
      }
      html += `</div>`;

      // Timeline
      html += `<div style="font-size: 11px; color: #666; margin-bottom: 10px;">`;
      html += `First Order: ${cust.first_order_date} | Last Order: ${cust.last_order_date}`;
      html += `</div>`;

      // Yesterday's order details
      html += `<div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-bottom: 8px;">`;
      html += `<div style="font-size: 11px; font-weight: 600; color: #333; margin-bottom: 4px;">Yesterday's Order:</div>`;
      html += `<div style="font-size: 11px; color: #1a1a1a;">`;
      html += `${cust.yesterday_orders} | ${formatCurrency(cust.yesterday_revenue)} | GP: ${formatCurrency(cust.yesterday_gp)} | ${cust.seller_name} (${cust.region})`;
      html += `</div></div>`;

      // Lifetime metrics
      html += `<div style="font-size: 11px; color: #555;">`;
      html += `<strong>Lifetime:</strong> ${formatNumber(cust.lifetime_orders)} orders | ${formatCurrency(cust.lifetime_revenue)} revenue`;
      html += `</div>`;

      html += '</div>';
    });

    // Summary total
    const totalYesterdayRevenue = data.reactivatedCustomers.reduce((sum, cust) => sum + parseFloat(cust.yesterday_revenue || 0), 0);
    const totalLifetimeRevenue = data.reactivatedCustomers.reduce((sum, cust) => sum + parseFloat(cust.lifetime_revenue || 0), 0);
    html += '<div style="border-top: 2px solid #333; padding-top: 10px; margin-top: 10px; font-weight: bold;">';
    html += `Total Yesterday: ${formatCurrency(totalYesterdayRevenue)} | Total Lifetime: ${formatCurrency(totalLifetimeRevenue)}`;
    html += '</div>';

  } else {
    html += '<div class="empty-state">No significant reactivations detected yesterday</div>';
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
  html += '<div style="font-size: 11px; color: #666; margin-bottom: 8px;">🟡 Yellow: 3-7 days late | 🔴 Red: 8+ days late | Rolling 31-day window | Unshipped amounts shown</div>';
  if (data.highValueLateLines.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>SO#</th>
          <th style="text-align: center;">Ln</th>
          <th>MPN</th>
          <th>ISE</th>
          <th>Rgn</th>
          <th>Promise</th>
          <th style="text-align: center;">Late</th>
          <th style="text-align: right;">Qty</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
        </tr>
      </thead>
      <tbody>`;

    data.highValueLateLines.forEach(line => {
      const rowColor = line.color_code === 'red' ? '#ffebee' : '#fff9c4';
      const daysLateColor = line.color_code === 'red' ? '#d32f2f' : '#f57c00';
      html += `
        <tr style="background-color: ${rowColor};">
          <td style="font-size: 11px;"><strong>${line.customer_name}</strong></td>
          <td style="font-size: 10px;">${line.sales_order}</td>
          <td style="text-align: center; font-size: 10px;">${line.line_number}</td>
          <td style="font-size: 9px;">${line.mpn || 'N/A'}</td>
          <td style="font-size: 10px;">${line.ise_name || 'N/A'}</td>
          <td style="font-size: 10px;">${line.region}</td>
          <td style="font-size: 10px;">${line.promise_date}</td>
          <td style="text-align: center; color: ${daysLateColor}; font-weight: bold; font-size: 10px;">${line.days_late}</td>
          <td class="number" style="font-size: 10px;">${formatNumber(line.qty_unshipped)}</td>
          <td class="number" style="font-size: 11px;">${formatCurrency(line.line_revenue)}</td>
          <td class="number" style="font-size: 11px;">${formatCurrency(line.line_gp)}</td>
        </tr>`;
    });

    html += '</tbody></table>';
  } else {
    html += '<div class="alert-box green">✓ No high-value lines ($200K+) past due</div>';
  }

  // 2.2B Top 15 Scheduled to Ship This Month (by GP) - 5 visible + 10 collapsible
  html += '<div class="subsection-header">Top 5 Scheduled to Ship This Month (by GP)</div>';
  html += '<div style="font-size: 11px; color: #666; margin-bottom: 8px;">🔴 Not in stock + past due | 🟡 Not in stock OR due soon | 🟢 In stock + future</div>';
  if (data.top5LateLines.length > 0) {
    html += `<table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>SO#</th>
          <th style="text-align: center;">Ln</th>
          <th>MPN</th>
          <th style="text-align: center;">Stock</th>
          <th style="text-align: center;">Action</th>
          <th>ISE</th>
          <th>Rgn</th>
          <th>Promise</th>
          <th style="text-align: center;">Days</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: right;">GP</th>
        </tr>
      </thead>
      <tbody>`;

    // Show first 5 lines (always visible)
    data.top5LateLines.slice(0, 5).forEach(line => {
      const rowColor = line.color_code === 'red' ? '#ffebee' : line.color_code === 'yellow' ? '#fff9c4' : '#e8f5e9';
      const daysColor = line.color_code === 'red' ? '#d32f2f' : line.color_code === 'yellow' ? '#f57c00' : '#2e7d32';
      const daysText = parseInt(line.days_until_promise) >= 0 ? `+${line.days_until_promise}` : line.days_until_promise;
      const actionEmoji = line.action_status === 'red' ? '🔴' : line.action_status === 'yellow' ? '🟡' : '🟢';
      html += `
        <tr style="background-color: ${rowColor};">
          <td style="font-size: 11px;"><strong>${line.customer_name}</strong></td>
          <td style="font-size: 10px;">${line.sales_order}</td>
          <td style="text-align: center; font-size: 10px;">${line.line_number}</td>
          <td style="font-size: 9px;">${line.mpn || 'N/A'}</td>
          <td style="text-align: center; font-size: 10px;">${line.in_stock}</td>
          <td style="text-align: center; font-size: 11px;">${actionEmoji}</td>
          <td style="font-size: 10px;">${line.ise_name || 'N/A'}</td>
          <td style="font-size: 10px;">${line.region}</td>
          <td style="font-size: 10px;">${line.promise_date}</td>
          <td style="text-align: center; color: ${daysColor}; font-weight: bold; font-size: 10px;">${daysText}</td>
          <td class="number">${formatCurrency(line.line_revenue)}</td>
          <td class="number">${formatCurrency(line.line_gp)}</td>
        </tr>`;
    });

    html += '</tbody></table>';

    // Add collapsible section for lines 6-15 if available
    if (data.top5LateLines.length > 5) {
      html += `
        <input type="checkbox" id="toggle-lines" style="display:none;">
        <label for="toggle-lines" style="cursor: pointer; font-weight: 600; color: #1a1a1a; padding: 8px; background: #f8fafc; border-radius: 4px; border: 1px solid #e2e8f0; display: block; margin-top: 8px; user-select: none;">
          <span class="toggle-icon-lines">▶</span> 📋 Show Next ${Math.min(data.top5LateLines.length - 5, 10)} Lines (by GP)
        </label>
        <div class="collapsible-content-lines" style="display: none; margin-top: 8px;">
          <table style="margin-top: 8px;">
            <thead>
              <tr>
                <th>Customer</th>
                <th>SO#</th>
                <th style="text-align: center;">Ln</th>
                <th>MPN</th>
                <th style="text-align: center;">Stock</th>
                <th style="text-align: center;">Action</th>
                <th>ISE</th>
                <th>Rgn</th>
                <th>Promise</th>
                <th style="text-align: center;">Days</th>
                <th style="text-align: right;">Revenue</th>
                <th style="text-align: right;">GP</th>
              </tr>
            </thead>
            <tbody>`;

      // Show lines 6-15 (collapsible)
      data.top5LateLines.slice(5, 15).forEach(line => {
        const rowColor = line.color_code === 'red' ? '#ffebee' : line.color_code === 'yellow' ? '#fff9c4' : '#e8f5e9';
        const daysColor = line.color_code === 'red' ? '#d32f2f' : line.color_code === 'yellow' ? '#f57c00' : '#2e7d32';
        const daysText = parseInt(line.days_until_promise) >= 0 ? `+${line.days_until_promise}` : line.days_until_promise;
        const actionEmoji = line.action_status === 'red' ? '🔴' : line.action_status === 'yellow' ? '🟡' : '🟢';
        html += `
          <tr style="background-color: ${rowColor};">
            <td style="font-size: 11px;"><strong>${line.customer_name}</strong></td>
            <td style="font-size: 10px;">${line.sales_order}</td>
            <td style="text-align: center; font-size: 10px;">${line.line_number}</td>
            <td style="font-size: 9px;">${line.mpn || 'N/A'}</td>
            <td style="text-align: center; font-size: 10px;">${line.in_stock}</td>
            <td style="text-align: center; font-size: 11px;">${actionEmoji}</td>
            <td style="font-size: 10px;">${line.ise_name || 'N/A'}</td>
            <td style="font-size: 10px;">${line.region}</td>
            <td style="font-size: 10px;">${line.promise_date}</td>
            <td style="text-align: center; color: ${daysColor}; font-weight: bold; font-size: 10px;">${daysText}</td>
            <td class="number">${formatCurrency(line.line_revenue)}</td>
            <td class="number">${formatCurrency(line.line_gp)}</td>
          </tr>`;
      });

      html += `
            </tbody>
          </table>
        </div>
        <style>
          #toggle-lines:checked ~ .collapsible-content-lines { display: block !important; }
          #toggle-lines:checked ~ label .toggle-icon-lines::before { content: "▼"; }
          .toggle-icon-lines::before { content: "▶"; }
        </style>`;
    }
  } else {
    html += '<div class="alert-box green">✓ No unshipped lines scheduled this month</div>';
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
      const rfqStyle = (!region.rfq_lines || region.rfq_lines === '0' || region.rfq_lines === 0) ? 'color: #d32f2f;' : '';
      const cqStyle = (!region.cq_lines || region.cq_lines === '0' || region.cq_lines === 0) ? 'color: #d32f2f;' : '';
      const soldStyle = (!region.cq_sold || region.cq_sold === '0' || region.cq_sold === 0) ? 'color: #d32f2f;' : '';
      const soStyle = (!region.so_lines || region.so_lines === '0' || region.so_lines === 0) ? 'color: #d32f2f;' : '';
      const revStyle = (!region.so_revenue || region.so_revenue === '0' || region.so_revenue === 0 || parseFloat(region.so_revenue) === 0) ? 'color: #d32f2f;' : '';
      const gpStyle = (!region.so_gp || region.so_gp === '0' || region.so_gp === 0 || parseFloat(region.so_gp) === 0) ? 'color: #d32f2f;' : '';
      html += `
        <tr>
          <td><strong>${region.region}</strong></td>
          <td>${region.manager}</td>
          <td style="text-align: center; ${rfqStyle}">${formatNumber(region.rfq_lines)}</td>
          <td style="text-align: center; ${cqStyle}">${formatNumber(region.cq_lines)}</td>
          <td style="text-align: center; ${soldStyle}">${formatNumber(region.cq_sold)}</td>
          <td style="text-align: center; ${soStyle}">${formatNumber(region.so_lines)}</td>
          <td class="number" style="${revStyle}">${formatCurrency(region.so_revenue)}</td>
          <td class="number" style="${gpStyle}">${formatCurrency(region.so_gp)}</td>
        </tr>`;
    });

    // Add TOTAL row
    const totalRfqStyle = (!data.regionalTotals.rfq_lines || data.regionalTotals.rfq_lines === 0) ? 'color: #d32f2f;' : '';
    const totalCqStyle = (!data.regionalTotals.cq_lines || data.regionalTotals.cq_lines === 0) ? 'color: #d32f2f;' : '';
    const totalSoldStyle = (!data.regionalTotals.cq_sold || data.regionalTotals.cq_sold === 0) ? 'color: #d32f2f;' : '';
    const totalSoStyle = (!data.regionalTotals.so_lines || data.regionalTotals.so_lines === 0) ? 'color: #d32f2f;' : '';
    const totalRevStyle = (!data.regionalTotals.so_revenue || data.regionalTotals.so_revenue === 0) ? 'color: #d32f2f;' : '';
    const totalGpStyle = (!data.regionalTotals.so_gp || data.regionalTotals.so_gp === 0) ? 'color: #d32f2f;' : '';
    html += `
      <tr style="border-top: 2px solid #333; background-color: #f5f5f5; font-weight: bold;">
        <td colspan="2"><strong>TOTAL</strong></td>
        <td style="text-align: center; ${totalRfqStyle}">${formatNumber(data.regionalTotals.rfq_lines)}</td>
        <td style="text-align: center; ${totalCqStyle}">${formatNumber(data.regionalTotals.cq_lines)}</td>
        <td style="text-align: center; ${totalSoldStyle}">${formatNumber(data.regionalTotals.cq_sold)}</td>
        <td style="text-align: center; ${totalSoStyle}">${formatNumber(data.regionalTotals.so_lines)}</td>
        <td class="number" style="${totalRevStyle}"><strong>${formatCurrency(data.regionalTotals.so_revenue)}</strong></td>
        <td class="number" style="${totalGpStyle}"><strong>${formatCurrency(data.regionalTotals.so_gp)}</strong></td>
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
      <li><strong>Top 15 Orders:</strong> Orders booked yesterday ranked by revenue (top 5 visible, next 10 collapsible). *Note: When GP = $0, pricecost field is null (cost data not yet entered).</li>
      <li><strong>New Customers Sold:</strong> Customers placing their first order ever (includes BP ID for reference)</li>
      <li><strong>Strategic Accounts:</strong> ABB, Eaton, GE Healthcare, Parker-Meggitt, RTX, Thales</li>
      <li><strong>Customers Reactivated Yesterday:</strong> Hybrid tracking approach with 30-day minimum threshold. <strong>OEM/EMS customers only</strong> - excludes brokers, distributors, traders, and surplus dealers. Excludes non-component transactions (Generic Sales Product, qty=0 orders). OEMs (ABB, Eaton, GE, KLA, Marvell, Parker, Plexus, RTX, Viavi, etc.) tracked at facility level to catch dormant locations. Others tracked at customer level. Strong filters: High-value (≥$100K + 90+ days), Anomalous pattern (>3x typical cycle + 30+ days), Small customers (<10 orders + 120+ days), or Long dormant (180+ days). Limited to top 5 by significance score.</li>
    </ul>

    <strong>Section 2: Needs Attention</strong>
    <ul>
      <li><strong>Top 15 Scheduled to Ship This Month:</strong> Unshipped lines with promise date in current month, ranked by GP (top 5 visible, next 10 collapsible). Includes In Stock (Y/N) and Action status: 🔴 Red = not in stock + past due (urgent), 🟡 Yellow = not in stock OR due this week (attention needed), 🟢 Green = in stock + future (OK).</li>
      <li><strong>ISE Alerts:</strong> Inside sales reps with no RFQ loaded in 3+ business days (Yellow: 3-6 days, Red: 7+ days). Active sellers only (excludes departed India & Korea teams).</li>
      <li><strong>Low Margin Trail:</strong> Orders <18% GM (Josh-approved audit trail)</li>
    </ul>

    <strong>Section 3: Yesterday's Activity</strong>
    <ul>
      <li><strong>Regions:</strong> USA (Jeff Wallace), MEX (Joel Marquez), APAC-Laurel (Laurel Kee), APAC-Silvia (Silvia Munoz), Other</li>
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
  const outputDir = path.join(__dirname, '../output/vp-briefs');

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
