#!/usr/bin/env node

/**
 * VP Daily Brief - Detailed On-Demand Report
 *
 * Includes part details (MPNs, quantities) - slower queries (30-60s)
 * Use for manual drill-down when full details needed
 *
 * Usage:
 *   node generate-detailed-report.js
 *   node generate-detailed-report.js --email josh.pucci@astutegroup.com
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const emailTo = args.find(arg => arg.startsWith('--email'))?.split('=')[1];

console.log('============================================================');
console.log('VP DAILY BRIEF - DETAILED REPORT (On-Demand)');
console.log('============================================================\n');
console.log('⚠️  Including part details - this may take 30-60 seconds...\n');

const queryFile = path.join(__dirname, '../queries/vp-daily-queries-detailed.sql');
const standardQueryFile = path.join(__dirname, '../queries/vp-daily-queries-v2.sql');

function execQuery(sql) {
  try {
    const tempFile = path.join(__dirname, '../output/temp-detailed-query.sql');
    fs.writeFileSync(tempFile, sql);
    const output = execSync(
      `psql idempiere_replica -t -A -F'|' -f "${tempFile}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    fs.unlinkSync(tempFile);
    return output.trim();
  } catch (error) {
    console.error('Query error:', error.message);
    return '';
  }
}

function parseRow(line, columns) {
  if (!line) return null;
  const values = line.split('|');
  const row = {};
  columns.forEach((col, i) => {
    row[col] = values[i] === '' || values[i] === 'null' ? null : values[i];
  });
  return row;
}

function parseRows(output, columns) {
  if (!output) return [];
  return output.split('\n')
    .filter(line => line.trim())
    .map(line => parseRow(line, columns))
    .filter(row => row !== null);
}

try {
  console.log('📊 Fetching data...\n');

  // Get Top 5 Orders with parts
  console.log('  - Top 5 Orders (with parts)...');
  const queries = fs.readFileSync(queryFile, 'utf8');
  const top5Query = queries.split('1.1 TOP 5 ORDERS')[1]
    .split('1.4 REACTIVATED CUSTOMERS')[0]
    .trim();
  const top5Match = top5Query.match(/SELECT[\s\S]+?LIMIT 5;/);
  const top5Orders = top5Match ? parseRows(execQuery(top5Match[0]), [
    'seller_name', 'region', 'customer_name', 'order_number', 'revenue', 'part_numbers'
  ]) : [];

  // Get Reactivated Customers with parts
  console.log('  - Reactivated Customers (with parts)...');
  const reactivatedQuery = queries.split('1.4 REACTIVATED CUSTOMERS')[1].trim();
  const reactivatedMatch = reactivatedQuery.match(/WITH[\s\S]+?ORDER BY yo\.total_revenue DESC;/);
  const reactivatedCustomers = reactivatedMatch ? parseRows(execQuery(reactivatedMatch[0]), [
    'seller_name', 'region', 'customer_name', 'c_bpartner_id', 'order_count',
    'order_numbers', 'total_revenue', 'mpns', 'mfr_names', 'total_qty',
    'customer_location', 'contact_name', 'promise_date', 'last_order_date',
    'days_since_last_order', 'previous_sales_rep'
  ]) : [];

  // Get standard sections (without parts) for the rest
  console.log('  - Other sections (standard queries)...');
  const standardQueries = fs.readFileSync(standardQueryFile, 'utf8');

  // ... (Would continue with other sections)
  // For now, let's create a simple HTML output

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const htmlOutput = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VP Daily Brief - DETAILED</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1200px; margin: 20px auto; padding: 20px; }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #3498db; color: white; padding: 12px; text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #ddd; }
    .part-numbers { font-size: 11px; color: #666; max-width: 400px; }
    .highlight { background: #fff3cd; }
  </style>
</head>
<body>
  <h1>VP Daily Brief - DETAILED REPORT</h1>
  <p><strong>Data for:</strong> ${yesterday.toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}</p>
  <p><em>⚠️ This detailed version includes part numbers (slower to generate)</em></p>

  <h2>Top 5 Orders Won</h2>
  <table>
    <tr>
      <th>Seller</th>
      <th>Region</th>
      <th>Customer</th>
      <th>Order #</th>
      <th>Revenue</th>
      <th>Part Numbers</th>
    </tr>
    ${top5Orders.map(order => `
    <tr>
      <td>${order.seller_name}</td>
      <td>${order.region}</td>
      <td><strong>${order.customer_name}</strong></td>
      <td>${order.order_number}</td>
      <td>$${parseFloat(order.revenue).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
      <td class="part-numbers">${order.part_numbers || 'N/A'}</td>
    </tr>
    `).join('')}
  </table>

  <h2>Reactivated Customers (6+ Month Gap)</h2>
  <table>
    <tr>
      <th>Seller</th>
      <th>Customer</th>
      <th>BP ID</th>
      <th>Orders</th>
      <th>Revenue</th>
      <th>Gap (days)</th>
      <th>Part Numbers</th>
      <th>Qty</th>
    </tr>
    ${reactivatedCustomers.map(cust => `
    <tr>
      <td>${cust.seller_name}</td>
      <td><strong>${cust.customer_name}</strong></td>
      <td>${cust.c_bpartner_id}</td>
      <td>${cust.order_count}</td>
      <td>$${parseFloat(cust.total_revenue).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
      <td>${cust.days_since_last_order}</td>
      <td class="part-numbers">${cust.mpns || 'N/A'}</td>
      <td>${cust.total_qty || 0}</td>
    </tr>
    `).join('')}
  </table>

  <hr>
  <p style="text-align: center; color: #666; font-size: 12px;">
    Generated: ${new Date().toLocaleString()}<br>
    Report Type: DETAILED (includes part details)
  </p>
</body>
</html>`;

  const outputDate = today.toISOString().split('T')[0];
  const htmlPath = path.join(__dirname, '../output', `vp-daily-brief-detailed-${outputDate}.html`);
  fs.writeFileSync(htmlPath, htmlOutput);

  console.log('\n✅ Detailed report generated!\n');
  console.log(`📄 HTML: ${htmlPath}\n`);
  console.log(`📊 Summary:`);
  console.log(`  - Top 5 Orders: ${top5Orders.length}`);
  console.log(`  - Reactivated Customers: ${reactivatedCustomers.length}\n`);

  // Email if requested
  if (emailTo) {
    (async () => {
      const { createNotifier } = require(path.resolve(__dirname, '../../astute-workinstructions/shared/notifier'));
      const notifier = createNotifier({
        fromEmail: 'salesanalytics@orangetsunami.com',
        fromName: 'Sales Analytics',
      });

      const subject = `VP Daily Brief - DETAILED (${yesterday.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'})})`;

      console.log(`📧 Sending to ${emailTo}...`);
      const success = await notifier.sendEmail(emailTo, subject, htmlOutput, { html: true });

      if (success) {
        console.log(`✅ Email sent successfully!\n`);
      } else {
        console.log(`❌ Email failed\n`);
      }
    })();
  }

  console.log('============================================================');

} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
