#!/usr/bin/env node
/**
 * VP Daily Brief - Sales Pulse
 *
 * Purpose: Strategic 1-page daily snapshot for VP Sales (Josh Pucci)
 * Cadence: Mon-Fri at 6:00 AM PT
 *
 * Features (per June 4, 2026 feedback):
 * 1. Blended VP Daily Brief + Action-First layout
 * 2. New Customers Sold (first-time wins)
 * 3. Late Shipments (3+ days, $250K+)
 * 4. Inactive ISEs (no RFQ/CQ in 3 days)
 * 5. Week-to-Date section (Monday only)
 * 6. Market Pulse removed (separate weekly report)
 *
 * Key Differences from Comprehensive:
 * - Strategic actions vs operational metrics
 * - Priority-driven layout (what matters most first)
 * - Cleaner, more scannable format
 * - VP-level thresholds ($250K vs $10K)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Regional seller mapping
const SELLER_REGIONS = {
  'USA': [1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017],
  'MEX': [1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224],
  'APAC-Laurel': [1041139, 1023803, 1016958],
  'APAC-Kris': [1039414, 1009866, 1013042, 1009528, 1009478, 1009210],
  'APAC-Lavanya': [1024444, 1023478, 1017011]
};

/**
 * Execute PostgreSQL query
 */
function execQuery(sql) {
  try {
    const output = execSync(
      `psql idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return output.trim();
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
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
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return '$' + (num / 1000).toFixed(0) + 'K';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (!num) return '0';
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
  console.log('Collecting data for VP Daily Brief...');

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const isMonday = today.getDay() === 1;

  const data = {
    today,
    yesterday,
    isMonday,
    todayFormatted: formatDate(today),
    yesterdayFormatted: formatDate(yesterday)
  };

  // Section 1: Global Snapshot (Yesterday)
  console.log('Fetching global snapshot...');
  data.globalSnapshot = await getGlobalSnapshot();

  // Section 2: Regional Performance (Yesterday)
  console.log('Fetching regional performance...');
  data.regionalPerformance = await getRegionalPerformance();

  // Section 3: Yesterday's Wins
  console.log('Fetching yesterday\'s wins...');
  data.yesterdaysWins = await getYesterdaysWins();

  // Section 4: Needs Attention
  console.log('Fetching needs attention items...');
  data.needsAttention = {
    lateShipments: await getLateShipments(),
    inactiveISEs: await getInactiveISEs(),
    newCustomers: await getNewCustomersSold()
  };

  // Section 5: Week-to-Date (Monday only)
  if (isMonday) {
    console.log('Fetching week-to-date (Monday)...');
    data.weekToDate = await getWeekToDate();
  }

  return data;
}

/**
 * Get Global Snapshot - Yesterday's Activity
 */
async function getGlobalSnapshot() {
  const rfqQuery = `
    SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) as line_count,
           COUNT(DISTINCT r.c_bpartner_id) as customer_count
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id
    WHERE r.created::date = CURRENT_DATE - INTERVAL '1 day'
      AND r.isactive = 'Y'
      AND rl.isactive = 'Y';
  `;

  const cqQuery = `
    SELECT COUNT(*) as line_count,
           COUNT(CASE WHEN issold = 'Y' THEN 1 END) as sold_count
    FROM adempiere.chuboe_cq_line
    WHERE created::date = CURRENT_DATE - INTERVAL '1 day'
      AND isactive = 'Y';
  `;

  const soQuery = `
    SELECT COUNT(DISTINCT ol.c_orderline_id) as line_count,
           SUM(ol.linenetamt) as revenue
    FROM adempiere.c_order o
    JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
    WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
      AND o.isactive = 'Y'
      AND ol.isactive = 'Y'
      AND o.issotrx = 'Y';
  `;

  const rfqResult = parseRow(execQuery(rfqQuery), ['line_count', 'customer_count']);
  const cqResult = parseRow(execQuery(cqQuery), ['line_count', 'sold_count']);
  const soResult = parseRow(execQuery(soQuery), ['line_count', 'revenue']);

  return {
    rfqLines: parseInt(rfqResult.line_count) || 0,
    rfqCustomers: parseInt(rfqResult.customer_count) || 0,
    cqLines: parseInt(cqResult.line_count) || 0,
    cqSold: parseInt(cqResult.sold_count) || 0,
    soLines: parseInt(soResult.line_count) || 0,
    soRevenue: parseFloat(soResult.revenue) || 0,
    cqCloseRate: cqResult.line_count > 0
      ? (parseInt(cqResult.sold_count) / parseInt(cqResult.line_count))
      : 0
  };
}

/**
 * Get Regional Performance - Yesterday by Region
 */
async function getRegionalPerformance() {
  const regions = ['USA', 'MEX', 'APAC-Laurel', 'APAC-Kris', 'APAC-Lavanya'];
  const performance = [];

  for (const region of regions) {
    const sellerIds = SELLER_REGIONS[region].join(',');

    // Separate queries for better performance
    const rfqQuery = `
      SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) as rfq_lines
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id
      WHERE r.salesrep_id IN (${sellerIds})
        AND r.created::date = CURRENT_DATE - INTERVAL '1 day'
        AND r.isactive = 'Y'
        AND rl.isactive = 'Y';
    `;

    const cqQuery = `
      SELECT
        COUNT(*) as cq_lines,
        COUNT(CASE WHEN cq.issold = 'Y' THEN 1 END) as cq_sold
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE r.salesrep_id IN (${sellerIds})
        AND cq.created::date = CURRENT_DATE - INTERVAL '1 day'
        AND cq.isactive = 'Y'
        AND r.isactive = 'Y';
    `;

    const soQuery = `
      SELECT COUNT(*) as so_lines
      FROM adempiere.c_order o
      JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
      WHERE o.salesrep_id IN (${sellerIds})
        AND o.created::date = CURRENT_DATE - INTERVAL '1 day'
        AND o.isactive = 'Y'
        AND ol.isactive = 'Y'
        AND o.issotrx = 'Y';
    `;

    const rfqResult = parseRow(execQuery(rfqQuery), ['rfq_lines']);
    const cqResult = parseRow(execQuery(cqQuery), ['cq_lines', 'cq_sold']);
    const soResult = parseRow(execQuery(soQuery), ['so_lines']);

    performance.push({
      region: region.replace('APAC-', ''),
      rfqLines: parseInt(rfqResult.rfq_lines) || 0,
      cqLines: parseInt(cqResult.cq_lines) || 0,
      cqSold: parseInt(cqResult.cq_sold) || 0,
      soLines: parseInt(soResult.so_lines) || 0
    });
  }

  return performance;
}

/**
 * Get Yesterday's Wins - Top orders booked
 */
async function getYesterdaysWins() {
  const query = `
    SELECT
      bp.name as customer,
      SUM(ol.linenetamt) as revenue,
      COUNT(ol.c_orderline_id) as line_count,
      u.name as ise_name
    FROM adempiere.c_order o
    JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id AND ol.isactive = 'Y'
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
    JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
    WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
      AND o.isactive = 'Y'
      AND o.issotrx = 'Y'
    GROUP BY bp.name, u.name
    ORDER BY revenue DESC
    LIMIT 10;
  `;

  return parseRows(execQuery(query), ['customer', 'revenue', 'line_count', 'ise_name']);
}

/**
 * Get Late Shipments - 3+ days late, $250K+
 */
async function getLateShipments() {
  const queryPath = path.join(__dirname, '../queries/vp-daily-queries.sql');
  const queries = fs.readFileSync(queryPath, 'utf8');

  // Extract Late Shipments query
  const lateShipmentsQuery = queries.split('-- 2. LATE SHIPMENTS')[1].split('-- 3. INACTIVE ISEs')[0].trim();

  return parseRows(execQuery(lateShipmentsQuery), [
    'customer_name', 'promised_date', 'days_late', 'revenue', 'ise_name', 'order_number', 'order_status'
  ]);
}

/**
 * Get Inactive ISEs - No RFQ/CQ in 3 days
 */
async function getInactiveISEs() {
  const queryPath = path.join(__dirname, '../queries/vp-daily-queries.sql');
  const queries = fs.readFileSync(queryPath, 'utf8');

  // Extract Inactive ISEs query
  const inactiveISEsQuery = queries.split('-- 3. INACTIVE ISEs')[1].trim();

  return parseRows(execQuery(inactiveISEsQuery), [
    'ise_name', 'ad_user_id', 'region', 'last_activity_date', 'days_inactive'
  ]);
}

/**
 * Get New Customers Sold - First-time wins
 */
async function getNewCustomersSold() {
  const queryPath = path.join(__dirname, '../queries/vp-daily-queries.sql');
  const queries = fs.readFileSync(queryPath, 'utf8');

  // Extract New Customers Sold query
  const newCustomersQuery = queries.split('-- 1. NEW CUSTOMERS SOLD')[1].split('-- 2. LATE SHIPMENTS')[0].trim();

  return parseRows(execQuery(newCustomersQuery), [
    'customer_name', 'revenue', 'line_count', 'ise_name', 'order_number', 'order_date'
  ]);
}

/**
 * Get Week-to-Date Summary - Full prior week (Monday only)
 */
async function getWeekToDate() {
  // This section shows the full prior week (Mon-Fri) on Monday morning
  const query = `
    SELECT
      COUNT(DISTINCT CASE WHEN r.created::date >= CURRENT_DATE - INTERVAL '7 days' THEN rl.chuboe_rfq_line_id END) as rfq_lines,
      COUNT(DISTINCT CASE WHEN cq.created::date >= CURRENT_DATE - INTERVAL '7 days' THEN cq.chuboe_cq_line_id END) as cq_lines,
      COUNT(DISTINCT CASE WHEN cq.created::date >= CURRENT_DATE - INTERVAL '7 days' AND cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as cq_sold,
      COUNT(DISTINCT CASE WHEN o.created::date >= CURRENT_DATE - INTERVAL '7 days' THEN ol.c_orderline_id END) as so_lines,
      SUM(CASE WHEN o.created::date >= CURRENT_DATE - INTERVAL '7 days' THEN ol.linenetamt ELSE 0 END) as so_revenue
    FROM adempiere.chuboe_rfq r
    LEFT JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id AND rl.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_cq_line cq ON r.chuboe_rfq_id = cq.chuboe_rfq_id AND cq.isactive = 'Y'
    LEFT JOIN adempiere.c_order o ON r.salesrep_id = o.salesrep_id AND o.isactive = 'Y' AND o.issotrx = 'Y'
    LEFT JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id AND ol.isactive = 'Y'
    WHERE r.isactive = 'Y';
  `;

  const result = parseRow(execQuery(query), ['rfq_lines', 'cq_lines', 'cq_sold', 'so_lines', 'so_revenue']);

  return {
    rfqLines: parseInt(result.rfq_lines) || 0,
    cqLines: parseInt(result.cq_lines) || 0,
    cqSold: parseInt(result.cq_sold) || 0,
    soLines: parseInt(result.so_lines) || 0,
    soRevenue: parseFloat(result.so_revenue) || 0
  };
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
    max-width: 700px;
    margin: 0 auto;
    padding: 20px;
    background: #f5f5f5;
  }
  .container {
    background: white;
    padding: 24px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 4px 0;
    color: #1a1a1a;
  }
  .subtitle {
    font-size: 11px;
    color: #666;
    margin-bottom: 20px;
  }

  /* Priority Actions */
  .actions {
    background: linear-gradient(135deg, #fef3c7 0%, #fef9e7 100%);
    border: 2px solid #f59e0b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 20px;
  }
  .actions h2 {
    margin: 0 0 12px 0;
    font-size: 14px;
    font-weight: 700;
    color: #92400e;
  }
  .action {
    background: white;
    border-left: 4px solid #dc2626;
    padding: 10px;
    margin-bottom: 10px;
    border-radius: 4px;
    font-size: 12px;
  }
  .action:last-child { margin-bottom: 0; }
  .action.yellow { border-left-color: #f59e0b; }
  .action.green { border-left-color: #16a34a; }
  .action strong { color: #1a1a1a; }

  /* Metrics Grid */
  .metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .metric {
    background: #f8fafc;
    border-radius: 6px;
    padding: 12px;
    border-left: 3px solid #94a3b8;
  }
  .metric.red { border-left-color: #dc2626; background: #fef2f2; }
  .metric.yellow { border-left-color: #f59e0b; background: #fffbeb; }
  .metric.green { border-left-color: #16a34a; background: #f0fdf4; }

  .metric-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #64748b;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .metric-value {
    font-size: 20px;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 2px;
  }
  .metric-trend {
    font-size: 11px;
    color: #64748b;
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
    padding: 6px 8px;
    text-align: left;
    font-weight: 600;
    font-size: 10px;
    color: #475569;
  }
  td {
    border: 1px solid #e2e8f0;
    padding: 6px 8px;
  }
  tr:hover { background: #f8fafc; }

  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
  }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-yellow { background: #fef3c7; color: #92400e; }
  .badge-green { background: #dcfce7; color: #166534; }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    margin: 16px 0 8px 0;
    color: #1a1a1a;
  }

  .footer {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #e0e0e0;
    font-size: 10px;
    color: #666;
  }

  .alert-box {
    margin-bottom: 12px;
    padding: 12px;
    border-radius: 4px;
    border-left: 4px solid #ccc;
    background: #f8f8f8;
    font-size: 12px;
  }
  .alert-box.critical { border-left-color: #dc2626; background: #fef2f2; }
  .alert-box.warning { border-left-color: #ea580c; background: #fff7ed; }
  .alert-box.success { border-left-color: #16a34a; background: #f0fdf4; }
</style>
</head>
<body>

<div class="container">
  <h1>📊 VP Daily Brief — Sales Pulse</h1>
  <div class="subtitle">${data.todayFormatted} | Data as of EOD ${data.yesterdayFormatted}</div>

  ${generatePriorityActions(data)}
  ${generateGlobalSnapshot(data)}
  ${generateRegionalPerformance(data)}
  ${generateYesterdaysWins(data)}
  ${generateNeedsAttention(data)}
  ${data.isMonday ? generateWeekToDate(data) : ''}

  <div class="footer">
    Questions? Reply to this email.<br>
    Next digest: Tomorrow 6:00 AM PT
  </div>
</div>

</body>
</html>`;
}

function generatePriorityActions(data) {
  const actions = [];

  // Late Shipments (Red - Critical)
  if (data.needsAttention.lateShipments.length > 0) {
    const total = data.needsAttention.lateShipments.reduce((sum, s) => sum + parseFloat(s.revenue), 0);
    actions.push({
      priority: 'red',
      text: `<strong>Late Shipments →</strong> ${data.needsAttention.lateShipments.length} orders totaling ${formatCurrency(total)} are 3+ days overdue. Oldest: ${data.needsAttention.lateShipments[0].days_late} days late.`
    });
  }

  // Inactive ISEs (Yellow - Warning)
  if (data.needsAttention.inactiveISEs.length > 0) {
    const byRegion = data.needsAttention.inactiveISEs.reduce((acc, ise) => {
      acc[ise.region] = (acc[ise.region] || 0) + 1;
      return acc;
    }, {});
    const regionSummary = Object.entries(byRegion).map(([r, count]) => `${r}: ${count}`).join(', ');
    actions.push({
      priority: 'yellow',
      text: `<strong>Inactive Sellers →</strong> ${data.needsAttention.inactiveISEs.length} ISEs haven't loaded RFQs or CQs in 3+ days (${regionSummary}).`
    });
  }

  // New Customer Wins (Green - Positive)
  if (data.needsAttention.newCustomers.length > 0) {
    const total = data.needsAttention.newCustomers.reduce((sum, c) => sum + parseFloat(c.revenue), 0);
    actions.push({
      priority: 'green',
      text: `<strong>New Customer Wins →</strong> ${data.needsAttention.newCustomers.length} first-time customers placed orders (${formatCurrency(total)} total).`
    });
  }

  // CQ Close Rate (Red if <20%, Yellow if <30%, Green if >40%)
  const closeRate = data.globalSnapshot.cqCloseRate;
  if (closeRate < 0.20) {
    actions.push({
      priority: 'red',
      text: `<strong>CQ Close Rate Critical →</strong> Only ${formatPercent(closeRate)} of quotes sold yesterday. Target: 30%+.`
    });
  } else if (closeRate < 0.30) {
    actions.push({
      priority: 'yellow',
      text: `<strong>CQ Close Rate Below Target →</strong> ${formatPercent(closeRate)} of quotes sold yesterday. Target: 30%+.`
    });
  } else if (closeRate >= 0.40) {
    actions.push({
      priority: 'green',
      text: `<strong>Strong Close Rate →</strong> ${formatPercent(closeRate)} of quotes sold yesterday (target: 30%).`
    });
  }

  if (actions.length === 0) {
    actions.push({
      priority: 'green',
      text: '<strong>No Critical Actions →</strong> All metrics within normal range.'
    });
  }

  return `
  <div class="actions">
    <h2>🎯 What Matters Today</h2>
    ${actions.map(a => `<div class="action ${a.priority}">${a.text}</div>`).join('\n    ')}
  </div>`;
}

function generateGlobalSnapshot(data) {
  const gs = data.globalSnapshot;

  return `
  <div class="section-title">📈 Yesterday's Activity</div>
  <div class="metrics">
    <div class="metric">
      <div class="metric-label">RFQ Lines</div>
      <div class="metric-value">${formatNumber(gs.rfqLines)}</div>
      <div class="metric-trend">${formatNumber(gs.rfqCustomers)} customers</div>
    </div>
    <div class="metric">
      <div class="metric-label">CQ Lines</div>
      <div class="metric-value">${formatNumber(gs.cqLines)}</div>
      <div class="metric-trend">${formatNumber(gs.cqSold)} sold (${formatPercent(gs.cqCloseRate)})</div>
    </div>
    <div class="metric ${gs.soLines > 0 ? 'green' : ''}">
      <div class="metric-label">Orders Booked</div>
      <div class="metric-value">${formatNumber(gs.soLines)} lines</div>
      <div class="metric-trend">${formatCurrency(gs.soRevenue)}</div>
    </div>
  </div>`;
}

function generateRegionalPerformance(data) {
  const rows = data.regionalPerformance.map(r => `
    <tr>
      <td><strong>${r.region}</strong></td>
      <td style="text-align: center;">${formatNumber(r.rfqLines)}</td>
      <td style="text-align: center;">${formatNumber(r.cqLines)}</td>
      <td style="text-align: center;">${formatNumber(r.cqSold)}</td>
      <td style="text-align: center;">${formatNumber(r.soLines)}</td>
    </tr>
  `).join('');

  return `
  <div class="section-title">🌍 By Region (Yesterday)</div>
  <table>
    <thead>
      <tr>
        <th>Region</th>
        <th style="text-align: center;">RFQ Lines</th>
        <th style="text-align: center;">CQ Lines</th>
        <th style="text-align: center;">CQ Sold</th>
        <th style="text-align: center;">SO Lines</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function generateYesterdaysWins(data) {
  if (data.yesterdaysWins.length === 0) {
    return '<div class="section-title">🏆 Yesterday\'s Wins</div><p style="font-size: 12px; color: #666;">No orders booked yesterday.</p>';
  }

  const rows = data.yesterdaysWins.slice(0, 5).map((w, i) => `
    <tr>
      <td>${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ''} ${w.customer}</td>
      <td style="text-align: right;"><strong>${formatCurrency(w.revenue)}</strong></td>
      <td style="text-align: center;">${formatNumber(w.line_count)}</td>
      <td>${w.ise_name}</td>
    </tr>
  `).join('');

  return `
  <div class="section-title">🏆 Yesterday's Wins</div>
  <table>
    <thead>
      <tr>
        <th>Customer</th>
        <th style="text-align: right;">Revenue</th>
        <th style="text-align: center;">Lines</th>
        <th>ISE</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function generateNeedsAttention(data) {
  let html = '<div class="section-title">⚠️ Needs Attention</div>';

  // Late Shipments
  if (data.needsAttention.lateShipments.length > 0) {
    const rows = data.needsAttention.lateShipments.map(s => `
      <tr>
        <td>${s.customer_name}</td>
        <td style="text-align: center;"><span class="badge badge-red">${s.days_late} days</span></td>
        <td style="text-align: right;"><strong>${formatCurrency(s.revenue)}</strong></td>
        <td>${s.ise_name}</td>
        <td style="font-size: 11px;">${s.order_number}</td>
      </tr>
    `).join('');

    html += `
    <div class="alert-box critical">
      <strong>Late Shipments (3+ days, $250K+)</strong>
    </div>
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th style="text-align: center;">Days Late</th>
          <th style="text-align: right;">Revenue</th>
          <th>ISE</th>
          <th>Order #</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
  }

  // Inactive ISEs
  if (data.needsAttention.inactiveISEs.length > 0) {
    const rows = data.needsAttention.inactiveISEs.map(ise => `
      <tr>
        <td>${ise.ise_name}</td>
        <td>${ise.region}</td>
        <td style="text-align: center;"><span class="badge badge-${ise.days_inactive >= 7 ? 'red' : 'yellow'}">${ise.days_inactive} days</span></td>
        <td style="font-size: 11px;">${ise.last_activity_date}</td>
      </tr>
    `).join('');

    html += `
    <div class="alert-box warning">
      <strong>Inactive ISEs (No RFQ/CQ in 3+ days)</strong>
    </div>
    <table>
      <thead>
        <tr>
          <th>ISE Name</th>
          <th>Region</th>
          <th style="text-align: center;">Inactive</th>
          <th>Last Activity</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
  }

  // New Customers Sold
  if (data.needsAttention.newCustomers.length > 0) {
    const rows = data.needsAttention.newCustomers.map(c => `
      <tr>
        <td>${c.customer_name}</td>
        <td style="text-align: right;"><strong>${formatCurrency(c.revenue)}</strong></td>
        <td style="text-align: center;">${formatNumber(c.line_count)}</td>
        <td>${c.ise_name}</td>
      </tr>
    `).join('');

    html += `
    <div class="alert-box success">
      <strong>New Customers Sold (First-Time Wins)</strong>
    </div>
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th style="text-align: right;">Revenue</th>
          <th style="text-align: center;">Lines</th>
          <th>ISE</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
  }

  if (data.needsAttention.lateShipments.length === 0 &&
      data.needsAttention.inactiveISEs.length === 0 &&
      data.needsAttention.newCustomers.length === 0) {
    html += '<p style="font-size: 12px; color: #666;">No items need attention.</p>';
  }

  return html;
}

function generateWeekToDate(data) {
  const wtd = data.weekToDate;
  const closeRate = wtd.cqLines > 0 ? (wtd.cqSold / wtd.cqLines) : 0;

  return `
  <div class="section-title">📅 Prior Week Summary (Mon-Fri)</div>
  <div class="metrics">
    <div class="metric">
      <div class="metric-label">RFQ Lines</div>
      <div class="metric-value">${formatNumber(wtd.rfqLines)}</div>
    </div>
    <div class="metric">
      <div class="metric-label">CQ Lines</div>
      <div class="metric-value">${formatNumber(wtd.cqLines)}</div>
      <div class="metric-trend">${formatNumber(wtd.cqSold)} sold (${formatPercent(closeRate)})</div>
    </div>
    <div class="metric green">
      <div class="metric-label">Orders Booked</div>
      <div class="metric-value">${formatNumber(wtd.soLines)} lines</div>
      <div class="metric-trend">${formatCurrency(wtd.soRevenue)}</div>
    </div>
  </div>`;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('Starting VP Daily Brief generation...');

  const data = await collectData();
  const html = generateHTML(data);

  // Save outputs
  const today = new Date().toISOString().split('T')[0];
  const outputDir = path.join(__dirname, '../output');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const htmlPath = path.join(outputDir, `vp-daily-brief-${today}.html`);
  const jsonPath = path.join(outputDir, `vp-daily-brief-${today}.json`);

  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

  console.log(`\n✅ VP Daily Brief generated successfully!`);
  console.log(`HTML: ${htmlPath}`);
  console.log(`JSON: ${jsonPath}`);

  // Summary
  console.log(`\n📊 Summary:`);
  console.log(`- RFQ Lines: ${formatNumber(data.globalSnapshot.rfqLines)}`);
  console.log(`- CQ Lines: ${formatNumber(data.globalSnapshot.cqLines)} (${formatNumber(data.globalSnapshot.cqSold)} sold)`);
  console.log(`- SO Lines: ${formatNumber(data.globalSnapshot.soLines)} (${formatCurrency(data.globalSnapshot.soRevenue)})`);
  console.log(`- New Customers: ${data.needsAttention.newCustomers.length}`);
  console.log(`- Late Shipments: ${data.needsAttention.lateShipments.length}`);
  console.log(`- Inactive ISEs: ${data.needsAttention.inactiveISEs.length}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
