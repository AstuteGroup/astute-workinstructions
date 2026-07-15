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

console.log('Generating 30-day Customer Name + City reactivations report...\n');

// Simplified query with Customer Name + City tracking
const sql = `
WITH excluded_customers AS (
  SELECT DISTINCT c_bpartner_id
  FROM adempiere.c_bpartner
  WHERE isactive = 'Y'
    AND (
      UPPER(name) LIKE '%BROKER%' OR
      UPPER(name) LIKE '%TRADING%' OR
      UPPER(name) LIKE '%TRADER%' OR
      UPPER(name) LIKE '%DISTRIBUTION%' OR
      UPPER(name) LIKE '%DISTRIBUTOR%' OR
      UPPER(name) LIKE '%SURPLUS%' OR
      UPPER(name) LIKE '%EXCESS%'
    )
),
yesterday_orders AS (
  SELECT
    bp.name || ' | ' || COALESCE(loc.city, 'Unknown City') as tracking_key,
    bp.name as customer_name,
    loc.city as ship_to_city,
    STRING_AGG(DISTINCT o.documentno, ', ') as order_numbers,
    SUM(o.grandtotal) as revenue,
    MAX(u.name) as seller_name,
    MAX(CASE
      WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Kris'
      ELSE 'Other'
    END) as region
  FROM adempiere.c_order o
  JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
  LEFT JOIN adempiere.c_bpartner_location bploc ON o.c_bpartner_location_id = bploc.c_bpartner_location_id
  LEFT JOIN adempiere.c_location loc ON bploc.c_location_id = loc.c_location_id
  LEFT JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
  WHERE o.created::date >= CURRENT_DATE - INTERVAL '30 days'
    AND o.isactive = 'Y' AND o.issotrx = 'Y'
    AND bp.c_bpartner_id NOT IN (SELECT c_bpartner_id FROM excluded_customers)
    AND EXISTS (
      SELECT 1 FROM adempiere.c_orderline ol
      WHERE ol.c_order_id = o.c_order_id
        AND ol.isactive = 'Y'
        AND ol.chuboe_cq_line_id IS NOT NULL
    )
  GROUP BY tracking_key, bp.name, loc.city
),
last_order_per_key AS (
  SELECT
    bp.name || ' | ' || COALESCE(loc.city, 'Unknown City') as tracking_key,
    MAX(o.created::date) as last_order_date,
    COUNT(DISTINCT o.c_order_id) as lifetime_orders,
    SUM(o.grandtotal) as lifetime_revenue,
    MIN(o.created::date) as first_order_date
  FROM adempiere.c_order o
  JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
  LEFT JOIN adempiere.c_bpartner_location bploc ON o.c_bpartner_location_id = bploc.c_bpartner_location_id
  LEFT JOIN adempiere.c_location loc ON bploc.c_location_id = loc.c_location_id
  WHERE o.created::date < CURRENT_DATE - INTERVAL '30 days'
    AND o.isactive = 'Y' AND o.issotrx = 'Y'
    AND bp.c_bpartner_id NOT IN (SELECT c_bpartner_id FROM excluded_customers)
  GROUP BY tracking_key
),
order_gaps AS (
  SELECT
    tracking_key,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_days) as median_gap
  FROM (
    SELECT
      bp.name || ' | ' || COALESCE(loc.city, 'Unknown City') as tracking_key,
      o.created::date - LAG(o.created::date) OVER (
        PARTITION BY bp.name || ' | ' || COALESCE(loc.city, 'Unknown City')
        ORDER BY o.created::date
      ) as gap_days
    FROM adempiere.c_order o
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.c_bpartner_location bploc ON o.c_bpartner_location_id = bploc.c_bpartner_location_id
    LEFT JOIN adempiere.c_location loc ON bploc.c_location_id = loc.c_location_id
    WHERE o.isactive = 'Y' AND o.issotrx = 'Y'
      AND bp.c_bpartner_id NOT IN (SELECT c_bpartner_id FROM excluded_customers)
  ) gaps
  WHERE gap_days IS NOT NULL
  GROUP BY tracking_key
)
SELECT
  yo.customer_name,
  yo.ship_to_city,
  loi.first_order_date::text,
  loi.last_order_date::text,
  (CURRENT_DATE - loi.last_order_date) as days_gap,
  yo.order_numbers,
  yo.revenue,
  yo.seller_name,
  yo.region,
  loi.lifetime_orders,
  loi.lifetime_revenue,
  COALESCE(gs.median_gap, 0) as typical_cycle_days,
  CASE
    WHEN gs.median_gap > 0 THEN ROUND((CURRENT_DATE - loi.last_order_date)::numeric / NULLIF(gs.median_gap::numeric, 0), 2)
    ELSE 0
  END as gap_multiplier,
  CASE
    WHEN yo.revenue >= 100000 AND (CURRENT_DATE - loi.last_order_date) >= 90 THEN 'high_value_long'
    WHEN gs.median_gap > 0 AND (CURRENT_DATE - loi.last_order_date) >= 3 * gs.median_gap THEN 'anomalous_pattern'
    WHEN loi.lifetime_orders < 10 AND (CURRENT_DATE - loi.last_order_date) >= 120 THEN 'small_customer_long'
    WHEN (CURRENT_DATE - loi.last_order_date) >= 180 THEN 'dormant_long'
    ELSE 'standard'
  END as reactivation_type
FROM yesterday_orders yo
JOIN last_order_per_key loi ON yo.tracking_key = loi.tracking_key
LEFT JOIN order_gaps gs ON yo.tracking_key = gs.tracking_key
WHERE (CURRENT_DATE - loi.last_order_date) >= 30
ORDER BY days_gap DESC;
`;

const results = parseRows(execQuery(sql), [
  'customer_name', 'ship_to_city', 'first_order_date', 'last_order_date', 'days_gap',
  'order_numbers', 'revenue', 'seller_name', 'region', 'lifetime_orders',
  'lifetime_revenue', 'typical_cycle_days', 'gap_multiplier', 'reactivation_type'
]);

console.log(`Found ${results.length} reactivations\n`);

// Generate HTML
let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Reactivated Customers - Customer Name + City Method (30 Days)</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; background: #f5f5f5; }
.container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
h1 { color: #1a1a1a; border-bottom: 3px solid #2563eb; padding-bottom: 10px; margin-bottom: 10px; }
.subtitle { font-size: 12px; color: #666; margin-bottom: 20px; }
.criteria { font-size: 10px; color: #888; font-style: italic; margin-bottom: 30px; border-left: 3px solid #ddd; padding-left: 12px; }
.summary { background: #e0f2fe; border: 1px solid #0284c7; padding: 16px; border-radius: 6px; margin-bottom: 30px; }
.reactivation { border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px; margin-bottom: 12px; background: white; }
.reactivation-header { font-size: 14px; font-weight: bold; color: #1a1a1a; margin-bottom: 8px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 8px; }
.badge-high-value { background: #fef3c7; color: #92400e; }
.badge-anomalous { background: #e0e7ff; color: #3730a3; }
.badge-dormant { background: #fee2e2; color: #991b1b; }
.badge-small { background: #dbeafe; color: #1e40af; }
.badge-standard { background: #f3f4f6; color: #374151; }
.detail-line { font-size: 11px; color: #666; margin-bottom: 6px; }
.metrics { background: #f8f9fa; padding: 10px; border-radius: 4px; margin-top: 8px; font-size: 11px; }
.icon { font-size: 16px; margin-right: 4px; }
</style>
</head>
<body>
<div class="container">
<h1>🔄 Reactivated Customers - Customer Name + City Method</h1>
<div class="subtitle">Testing Period: Last 30 Days (June 1-30, 2026)</div>
<div class="criteria"><strong>New Method:</strong> Customer Name + Ship-To City concatenation • Excludes brokers/distributors/traders • 30-day minimum gap • CQ-linked sales only</div>

<div class="summary">
<strong>📊 Results Summary:</strong> Found <strong>${results.length} reactivations</strong> using Customer Name + City tracking (vs 3 with current method)<br>
<strong>Key Difference:</strong> This method tracks each customer+city combination separately, providing more granular visibility into reactivations.
</div>

<h2 style="margin-top: 30px; color: #374151; font-size: 16px;">All Reactivations (${results.length} total, sorted by gap)</h2>
`;

results.forEach((r, index) => {
  const icon = r.reactivation_type === 'high_value_long' ? '🏆' :
               r.reactivation_type === 'anomalous_pattern' ? '📊' :
               r.reactivation_type === 'dormant_long' ? '🕐' :
               r.reactivation_type === 'small_customer_long' ? '📍' : '✓';

  const typeLabel = r.reactivation_type === 'high_value_long' ? 'High-Value Long Gap' :
                    r.reactivation_type === 'anomalous_pattern' ? 'Anomalous Pattern' :
                    r.reactivation_type === 'dormant_long' ? 'Long Dormant (6+ months)' :
                    r.reactivation_type === 'small_customer_long' ? 'Small Customer Return' : 'Standard';

  const badgeClass = r.reactivation_type === 'high_value_long' ? 'badge-high-value' :
                     r.reactivation_type === 'anomalous_pattern' ? 'badge-anomalous' :
                     r.reactivation_type === 'dormant_long' ? 'badge-dormant' :
                     r.reactivation_type === 'small_customer_long' ? 'badge-small' : 'badge-standard';

  html += `
<div class="reactivation">
  <div class="reactivation-header">
    <span class="icon">${icon}</span>${index + 1}. ${r.customer_name}
    <span class="badge ${badgeClass}">${typeLabel}</span>
  </div>
  <div class="detail-line">📍 <strong>${r.ship_to_city || 'Unknown City'}</strong> (city-level tracking)</div>
  <div class="detail-line">
    Gap: <strong>${formatNumber(r.days_gap)} days</strong>`;

  if (parseFloat(r.typical_cycle_days) > 0 && parseFloat(r.gap_multiplier) > 0) {
    html += ` | Typical Cycle: ${formatNumber(r.typical_cycle_days)} days | <strong>${r.gap_multiplier}x typical</strong>`;
  }

  html += `
  </div>
  <div class="detail-line">
    First Order: ${r.first_order_date} | Last Order: ${r.last_order_date}
  </div>
  <div class="metrics">
    <strong>Order Details:</strong> ${r.order_numbers} | ${formatCurrency(r.revenue)} revenue<br>
    <strong>Seller:</strong> ${r.seller_name || 'Unknown'} (${r.region || 'Unknown'})<br>
    <strong>Lifetime:</strong> ${formatNumber(r.lifetime_orders)} orders, ${formatCurrency(r.lifetime_revenue)} total revenue
  </div>
</div>`;
});

html += `
<div style="margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb; color: #6b7280; font-size: 11px;">
<strong>Method Comparison:</strong>
<table style="width: 100%; margin-top: 10px; font-size: 11px;">
<tr style="background: #f9fafb;">
  <th style="text-align: left; padding: 8px;">Aspect</th>
  <th style="text-align: left; padding: 8px;">Current Method</th>
  <th style="text-align: left; padding: 8px;">Customer Name + City</th>
</tr>
<tr>
  <td style="padding: 8px;">Tracking Granularity</td>
  <td style="padding: 8px;">OEMs: Location ID<br>Others: Fuzzy name match</td>
  <td style="padding: 8px;"><strong>Everyone: Name + City</strong></td>
</tr>
<tr style="background: #f9fafb;">
  <td style="padding: 8px;">Results (30 days)</td>
  <td style="padding: 8px;">3 reactivations</td>
  <td style="padding: 8px;"><strong>${results.length} reactivations</strong></td>
</tr>
<tr>
  <td style="padding: 8px;">Query Complexity</td>
  <td style="padding: 8px;">Complex (OEM lists, fuzzy matching, multiple CTEs)</td>
  <td style="padding: 8px;"><strong>Simple (direct concatenation)</strong></td>
</tr>
<tr style="background: #f9fafb;">
  <td style="padding: 8px;">Human Readability</td>
  <td style="padding: 8px;">Location IDs (OEM:12345) or Base Names</td>
  <td style="padding: 8px;"><strong>Clear (KLA | Singapore)</strong></td>
</tr>
<tr>
  <td style="padding: 8px;">Maintenance</td>
  <td style="padding: 8px;">Must update OEM lists when adding new OEMs</td>
  <td style="padding: 8px;"><strong>No maintenance needed</strong></td>
</tr>
</table>

<p style="margin-top: 20px;"><strong>Recommendation:</strong> Switch to Customer Name + City method for better visibility and simpler maintenance.</p>
</div>

</div>
</body>
</html>`;

// Write HTML file
const outputPath = '/home/melissa.bojar/workspace/astute-workinstructions/Sales Pulse Daily/output/reactivations-city-concat-30days.html';
fs.writeFileSync(outputPath, html);

console.log(`HTML report generated: ${outputPath}`);
console.log(`\nFound ${results.length} reactivations (vs 3 with current method)`);
