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

// Simplified query using Customer Name + City concatenation
const sql = `
WITH business_day AS (
  SELECT CURRENT_DATE - INTERVAL '1 day' as report_date
),
-- Exclude brokers/distributors/traders
excluded_customers AS (
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
      UPPER(name) LIKE '%EXCESS%' OR
      (UPPER(name) LIKE '%SUPPLY%' OR UPPER(name) LIKE '%SUPPLIER%')
      AND NOT (UPPER(name) LIKE '%POWER SUPPLY%' OR UPPER(name) LIKE '%SUPPLY CHAIN%')
    )
),
-- Yesterday's orders with Customer Name + City tracking
yesterday_orders AS (
  SELECT
    bp.name || ' | ' || COALESCE(loc.city, 'Unknown City') as tracking_key,
    bp.name as customer_name,
    loc.city as ship_to_city,
    STRING_AGG(o.documentno, ', ' ORDER BY o.grandtotal DESC) as order_numbers,
    SUM(o.grandtotal) as yesterday_revenue,
    COALESCE((SELECT SUM(bi.s_order_line_gp)
     FROM adempiere.bi_order_line_v bi
     WHERE bi.order_id IN (
       SELECT o2.c_order_id
       FROM adempiere.c_order o2
       JOIN adempiere.c_bpartner bp2 ON o2.c_bpartner_id = bp2.c_bpartner_id
       LEFT JOIN adempiere.c_bpartner_location bploc2 ON o2.c_bpartner_location_id = bploc2.c_bpartner_location_id
       LEFT JOIN adempiere.c_location loc2 ON bploc2.c_location_id = loc2.c_location_id
       WHERE bp2.name = bp.name
         AND COALESCE(loc2.city, 'Unknown City') = COALESCE(loc.city, 'Unknown City')
         AND o2.created::date >= CURRENT_DATE - INTERVAL '30 days'
         AND o2.isactive = 'Y' AND o2.issotrx = 'Y'
     )), 0) as yesterday_gp,
    (ARRAY_AGG(u.name ORDER BY o.grandtotal DESC))[1] as seller_name,
    (ARRAY_AGG(CASE
      WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Kris'
      ELSE 'Other'
    END ORDER BY o.grandtotal DESC))[1] as region
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
-- Last order date per tracking key (Customer Name + City)
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
-- Calculate order frequency statistics per tracking key
order_gaps AS (
  SELECT
    tracking_key,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_days) as median_gap,
    AVG(gap_days) as avg_gap,
    COUNT(*) as total_gaps
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
  yo.yesterday_revenue,
  yo.yesterday_gp,
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
    WHEN yo.yesterday_revenue >= 100000 AND (CURRENT_DATE - loi.last_order_date) >= 90 THEN 'high_value_long'
    WHEN gs.median_gap > 0 AND (CURRENT_DATE - loi.last_order_date) >= 3 * gs.median_gap THEN 'anomalous_pattern'
    WHEN loi.lifetime_orders < 10 AND (CURRENT_DATE - loi.last_order_date) >= 120 THEN 'small_customer_long'
    WHEN (CURRENT_DATE - loi.last_order_date) >= 180 THEN 'dormant_long'
    ELSE 'standard'
  END as reactivation_type
FROM yesterday_orders yo
JOIN last_order_per_key loi ON yo.tracking_key = loi.tracking_key
LEFT JOIN order_gaps gs ON yo.tracking_key = gs.tracking_key
WHERE (CURRENT_DATE - loi.last_order_date) >= 30
ORDER BY days_gap DESC
LIMIT 50;
`;

console.log('Running Customer Name + City concatenation test...\n');
const results = parseRows(execQuery(sql), [
  'customer_name', 'ship_to_city', 'first_order_date', 'last_order_date', 'days_gap',
  'order_numbers', 'yesterday_revenue', 'yesterday_gp', 'seller_name', 'region',
  'lifetime_orders', 'lifetime_revenue', 'typical_cycle_days', 'gap_multiplier',
  'reactivation_type'
]);

console.log(`Found ${results.length} reactivations using Customer Name + City tracking\n`);
console.log('='.repeat(100));
console.log('COMPARISON: Current Method vs Customer Name + City Method');
console.log('='.repeat(100));

if (results.length === 0) {
  console.log('No results found with this method.');
  process.exit(0);
}

// Show all results
results.forEach((r, i) => {
  console.log(`\n${i + 1}. ${r.customer_name} | ${r.ship_to_city}`);
  console.log(`   Tracking Key: "${r.customer_name} | ${r.ship_to_city}"`);
  console.log(`   Gap: ${r.days_gap} days | Type: ${r.reactivation_type}`);
  console.log(`   Revenue: ${formatCurrency(r.yesterday_revenue)} | GP: ${formatCurrency(r.yesterday_gp)}`);
  console.log(`   Seller: ${r.seller_name} (${r.region})`);
  console.log(`   Lifetime: ${r.lifetime_orders} orders, ${formatCurrency(r.lifetime_revenue)} revenue`);
  if (parseFloat(r.typical_cycle_days) > 0) {
    console.log(`   Typical Cycle: ${parseFloat(r.typical_cycle_days).toFixed(0)} days | ${r.gap_multiplier}x typical`);
  }
});

console.log('\n');
console.log('='.repeat(100));
console.log('KEY DIFFERENCES FROM CURRENT METHOD:');
console.log('='.repeat(100));
console.log('✓ Simpler logic - no OEM vs non-OEM split');
console.log('✓ No fuzzy name matching (no Inc/Corp/Ltd removal)');
console.log('✓ Same granularity for all customers (city-level)');
console.log('✓ Human-readable tracking keys');
console.log('✓ Exact customer name preserved');
console.log('\n');
