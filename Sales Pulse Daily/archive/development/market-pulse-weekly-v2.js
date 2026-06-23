#!/usr/bin/env node
/**
 * Market Pulse Weekly - Standalone Market Intelligence Report
 *
 * On-demand manual report with 30-day rolling window market analysis
 *
 * Usage:
 *   node market-pulse-weekly-v2.js              # Generate report files
 *   node market-pulse-weekly-v2.js --email      # Generate and email report
 *
 * Sections:
 * 1. Temperature Gauge - Overall market status with constraint signals
 * 2. Constraint Indicators - Early warning signals
 * 3. Trending Manufacturers - Top 10 by activity
 * 4. Trending Parts - Top 10 parts by RFQ count
 * 5. Manufacturer Exposure - Pipeline concentration risk
 * 6. Regional Demand Divergence - APAC concentration signals
 * 7. Response Time Trends - Supply chain stress indicators
 * 8. New Entrants - Emerging hotspots
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SEND_EMAIL = process.argv.includes('--email');

// Sales team mapping (corrected from employee roster)
const SALES_TEAM_MAP = {
  // Jeff Wallace → USA
  'aaromend': 'USA',
  'danireis': 'USA',
  'jakemcal': 'USA',
  'jamediaz': 'USA',
  'joshsyre': 'USA',
  'justgood': 'USA',
  'melissab': 'USA',
  'michstif': 'USA',
  'thomhayn': 'USA',
  'willrobi': 'USA',

  // Joel Marquez → MEX
  'alejpadi': 'MEX',
  'alexpart': 'MEX',
  'alfrmart': 'MEX',
  'carlmore': 'MEX',
  'carohine': 'MEX',
  'joelflor': 'MEX',
  'juanbote': 'MEX',
  'ricamora': 'MEX',
  'salvhorn': 'MEX',

  // Laurel Kee → APAC - Laurel
  'ivychew': 'APAC - Laurel',
  'jaspkee': 'APAC - Laurel',
  'laurekee': 'APAC - Laurel',
  'rayng': 'APAC - Laurel',

  // Lavanya Manohar → APAC - Lavanya
  'lavamano': 'APAC - Lavanya',
  'manika': 'APAC - Lavanya',
  'meenaksh': 'APAC - Lavanya',

  // Kris Munoz/Silvia Wong → APAC - Silvia
  'jamexu': 'APAC - Silvia',
  'silvmuno': 'APAC - Silvia',
  'springtu': 'APAC - Silvia',
  'wingzhan': 'APAC - Silvia',
  'winnlee': 'APAC - Silvia',

  // Edyna Lee → APAC - Edyna
  'clemchen': 'APAC - Edyna',
  'edynlee': 'APAC - Edyna',
  'erinlee': 'APAC - Edyna',
  'madifisc': 'APAC - Edyna',
  'serenzha': 'APAC - Edyna',

  // Directors/VP
  'jeffwall': 'USA',
  'joelmarq': 'MEX',
  'joshpucc': 'USA',
  'laurelke': 'APAC - Laurel',
  'lavanyam': 'APAC - Lavanya',

  // Other/Unassigned
  'julicard': 'Other',
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
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
 * Get 30-day rolling window dates
 */
function get30DayWindow() {
  const today = new Date();
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - 30);

  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0]
  };
}

/**
 * Section 2: Constraint Indicators
 * Early warning signals for allocation
 */
async function collectConstraintIndicators() {
  console.log('Collecting Constraint Indicators...');

  // 2.1: Multi-Customer Parts (5+ customers)
  const multiCustomerQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
             CURRENT_DATE as end_date
    )
    SELECT
      rfqm.chuboe_mpn as mpn,
      m.name as manufacturer,
      COUNT(DISTINCT rfq.c_bpartner_id) as customer_count,
      COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
      COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count
    FROM adempiere.chuboe_rfq_line_mpn rfqm
    CROSS JOIN current_window
    JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
    JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
    WHERE rfqm.isactive = 'Y'
      AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
    GROUP BY rfqm.chuboe_mpn, m.name
    HAVING COUNT(DISTINCT rfq.c_bpartner_id) >= 5
    ORDER BY COUNT(DISTINCT rfq.c_bpartner_id) DESC
    LIMIT 10;
  `;

  const multiCustomerParts = parseRows(
    execQuery(multiCustomerQuery),
    ['mpn', 'manufacturer', 'customer_count', 'rfq_count', 'quoted_count']
  );

  // 2.2: Conversion Drop-Off (>10pts decline)
  const conversionDropQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    ),
    prior_window AS (
      SELECT CURRENT_DATE - INTERVAL '60 days' as start_date, CURRENT_DATE - INTERVAL '30 days' as end_date
    ),
    current_period AS (
      SELECT
        m.name as manufacturer, m.chuboe_mfr_id,
        COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
        COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
        CASE WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
        THEN ROUND((COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END)::numeric / COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric) * 100, 1)
        ELSE 0 END as conversion_rate
      FROM adempiere.chuboe_mfr m
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      GROUP BY m.name, m.chuboe_mfr_id
      HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10
    ),
    prior_period AS (
      SELECT
        m.chuboe_mfr_id,
        COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
        COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
        CASE WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
        THEN ROUND((COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END)::numeric / COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric) * 100, 1)
        ELSE 0 END as conversion_rate
      FROM adempiere.chuboe_mfr m
      CROSS JOIN prior_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
      GROUP BY m.chuboe_mfr_id
      HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10
    )
    SELECT
      cp.manufacturer,
      cp.quoted_count as current_quoted,
      cp.sold_count as current_sold,
      cp.conversion_rate as current_conversion_pct,
      pp.conversion_rate as prior_conversion_pct,
      (cp.conversion_rate - pp.conversion_rate) as conversion_change_pts
    FROM current_period cp
    JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
    WHERE (cp.conversion_rate - pp.conversion_rate) < -10
    ORDER BY (cp.conversion_rate - pp.conversion_rate) ASC
    LIMIT 10;
  `;

  const conversionDropOff = parseRows(
    execQuery(conversionDropQuery),
    ['manufacturer', 'current_quoted', 'current_sold', 'current_conversion_pct', 'prior_conversion_pct', 'conversion_change_pts']
  );

  // 2.3: Velocity Spike (top 3 always)
  const velocitySpikeQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    ),
    prior_window AS (
      SELECT CURRENT_DATE - INTERVAL '60 days' as start_date, CURRENT_DATE - INTERVAL '30 days' as end_date
    ),
    current_period AS (
      SELECT m.name as manufacturer, m.chuboe_mfr_id, COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
      FROM adempiere.chuboe_mfr m
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      GROUP BY m.name, m.chuboe_mfr_id
    ),
    prior_period AS (
      SELECT m.chuboe_mfr_id, COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
      FROM adempiere.chuboe_mfr m
      CROSS JOIN prior_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
      GROUP BY m.chuboe_mfr_id
    )
    SELECT
      cp.manufacturer,
      cp.rfq_count as current_rfqs,
      COALESCE(pp.rfq_count, 0) as prior_rfqs,
      (cp.rfq_count - COALESCE(pp.rfq_count, 0)) as rfq_change,
      CASE WHEN COALESCE(pp.rfq_count, 0) > 0
      THEN ROUND(((cp.rfq_count::numeric - pp.rfq_count::numeric) / pp.rfq_count::numeric) * 100, 1)
      WHEN cp.rfq_count > 0 THEN 100.0 ELSE 0 END as velocity_change_pct
    FROM current_period cp
    LEFT JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
    ORDER BY (cp.rfq_count - COALESCE(pp.rfq_count, 0)) DESC
    LIMIT 3;
  `;

  const velocitySpike = parseRows(
    execQuery(velocitySpikeQuery),
    ['manufacturer', 'current_rfqs', 'prior_rfqs', 'rfq_change', 'velocity_change_pct']
  );

  return {
    multiCustomerParts,
    conversionDropOff,
    velocitySpike
  };
}

/**
 * Section 3: Trending Manufacturers
 */
async function collectTrendingManufacturers() {
  console.log('Collecting Trending Manufacturers...');

  const query = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    ),
    prior_window AS (
      SELECT CURRENT_DATE - INTERVAL '60 days' as start_date, CURRENT_DATE - INTERVAL '30 days' as end_date
    ),
    current_period AS (
      SELECT
        m.name as manufacturer, m.chuboe_mfr_id,
        COUNT(DISTINCT rfq.c_bpartner_id) as customers,
        COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
        COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
        COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
        SUM(CASE WHEN cq.issold = 'Y' THEN cq.priceentered * cq.qty ELSE 0 END) as booked_sales
      FROM adempiere.chuboe_mfr m
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
      LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      GROUP BY m.name, m.chuboe_mfr_id
    ),
    prior_period AS (
      SELECT m.chuboe_mfr_id, COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
      FROM adempiere.chuboe_mfr m
      CROSS JOIN prior_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
      GROUP BY m.chuboe_mfr_id
    )
    SELECT
      cp.manufacturer, cp.customers, cp.rfq_count, cp.quoted_count, cp.sold_count,
      CASE WHEN cp.quoted_count > 0 THEN ROUND((cp.sold_count::numeric / cp.quoted_count::numeric) * 100, 1) ELSE 0 END as win_pct,
      COALESCE(cp.booked_sales, 0) as booked_sales_30d,
      CASE WHEN COALESCE(pp.rfq_count, 0) > 0
      THEN ROUND(((cp.rfq_count::numeric - pp.rfq_count::numeric) / pp.rfq_count::numeric) * 100, 1)
      WHEN cp.rfq_count > 0 THEN 100.0 ELSE 0 END as wow_velocity_pct
    FROM current_period cp
    LEFT JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
    ORDER BY cp.sold_count DESC, cp.rfq_count DESC
    LIMIT 10;
  `;

  return parseRows(
    execQuery(query),
    ['manufacturer', 'customers', 'rfq_count', 'quoted_count', 'sold_count', 'win_pct', 'booked_sales_30d', 'wow_velocity_pct']
  );
}

/**
 * Section 4: Trending Parts
 */
async function collectTrendingParts() {
  console.log('Collecting Trending Parts...');

  const query = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    )
    SELECT
      rfqm.chuboe_mpn as mpn, m.name as manufacturer,
      COUNT(DISTINCT rfq.c_bpartner_id) as customers,
      COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
      COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
      COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
      CASE WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
      THEN ROUND((COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END)::numeric / COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric) * 100, 1)
      ELSE 0 END as win_pct,
      MIN(rfq.created::date) as first_seen,
      CASE WHEN COUNT(DISTINCT rfq.c_bpartner_id) >= 5 THEN 'Multi-Customer' ELSE '' END as scarcity_signal
    FROM adempiere.chuboe_rfq_line_mpn rfqm
    CROSS JOIN current_window
    JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
    JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
    WHERE rfqm.isactive = 'Y' AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
    GROUP BY rfqm.chuboe_mpn, m.name
    ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC
    LIMIT 10;
  `;

  return parseRows(
    execQuery(query),
    ['mpn', 'manufacturer', 'customers', 'rfq_count', 'quoted_count', 'sold_count', 'win_pct', 'first_seen', 'scarcity_signal']
  );
}

/**
 * Section 5: Manufacturer Exposure
 */
async function collectManufacturerExposure() {
  console.log('Collecting Manufacturer Exposure...');

  const query = `
    WITH open_rfqs AS (
      SELECT m.name as manufacturer, m.chuboe_mfr_id,
        SUM(rfqm.priceentered * rfqm.qty) as open_rfq_value
      FROM adempiere.chuboe_mfr m
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      GROUP BY m.name, m.chuboe_mfr_id
    ),
    open_cqs AS (
      SELECT m.chuboe_mfr_id, SUM(cq.priceentered * cq.qty) as open_cq_value
      FROM adempiere.chuboe_mfr m
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
      WHERE cq.issold = 'N' AND cq.r_status_id = 1000027
      GROUP BY m.chuboe_mfr_id
    ),
    total_pipeline AS (
      SELECT SUM(rfqm.priceentered * rfqm.qty) as total_value
      FROM adempiere.chuboe_rfq_line_mpn rfqm
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      WHERE rfqm.isactive = 'Y'
    )
    SELECT
      orq.manufacturer,
      COALESCE(orq.open_rfq_value, 0) as open_rfq_value,
      COALESCE(ocq.open_cq_value, 0) as open_cq_value,
      (COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) as total_exposure,
      CASE WHEN tp.total_value > 0
      THEN ROUND(((COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) / tp.total_value) * 100, 1)
      ELSE 0 END as pct_of_pipeline,
      CASE WHEN ((COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) / NULLIF(tp.total_value, 0)) > 0.15 THEN 'High'
      WHEN ((COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) / NULLIF(tp.total_value, 0)) > 0.10 THEN 'Medium'
      ELSE 'Low' END as risk_level
    FROM open_rfqs orq
    LEFT JOIN open_cqs ocq ON orq.chuboe_mfr_id = ocq.chuboe_mfr_id
    CROSS JOIN total_pipeline tp
    ORDER BY (COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) DESC
    LIMIT 10;
  `;

  return parseRows(
    execQuery(query),
    ['manufacturer', 'open_rfq_value', 'open_cq_value', 'total_exposure', 'pct_of_pipeline', 'risk_level']
  );
}

/**
 * Section 6: Regional Demand Divergence
 */
async function collectRegionalDemand() {
  console.log('Collecting Regional Demand Divergence...');

  const query = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    )
    SELECT
      m.name as manufacturer,
      COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as total_rfqs,
      ROUND((COUNT(DISTINCT CASE WHEN c.countrycode IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as apac_pct,
      ROUND((COUNT(DISTINCT CASE WHEN c.countrycode = 'US' THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as usa_pct,
      ROUND((COUNT(DISTINCT CASE WHEN c.countrycode = 'MX' THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as mex_pct,
      CASE WHEN (COUNT(DISTINCT CASE WHEN c.countrycode IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) > 0.70
      THEN 'APAC Concentration' ELSE '' END as signal
    FROM adempiere.chuboe_mfr m
    CROSS JOIN current_window
    JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
    JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
    JOIN adempiere.c_bpartner bp ON rfq.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
    LEFT JOIN adempiere.c_bpartner_location bpl ON bp.c_bpartner_id = bpl.c_bpartner_id AND bpl.isactive = 'Y'
    LEFT JOIN adempiere.c_location loc ON bpl.c_location_id = loc.c_location_id
    LEFT JOIN adempiere.c_country c ON loc.c_country_id = c.c_country_id
    WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
    GROUP BY m.name
    HAVING COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) >= 10
    ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC
    LIMIT 15;
  `;

  return parseRows(
    execQuery(query),
    ['manufacturer', 'total_rfqs', 'apac_pct', 'usa_pct', 'mex_pct', 'signal']
  );
}

/**
 * Section 7: Response Time Trends
 */
async function collectResponseTimeTrends() {
  console.log('Collecting Response Time Trends...');

  const query = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    ),
    prior_window AS (
      SELECT CURRENT_DATE - INTERVAL '60 days' as start_date, CURRENT_DATE - INTERVAL '30 days' as end_date
    ),
    current_period AS (
      SELECT m.name as manufacturer, m.chuboe_mfr_id,
        AVG(EXTRACT(EPOCH FROM (vq.created - rfq.created)) / 86400) as avg_response_days,
        COUNT(DISTINCT vq.chuboe_vq_line_id) as sample_size
      FROM adempiere.chuboe_mfr m
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      GROUP BY m.name, m.chuboe_mfr_id
      HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10
    ),
    prior_period AS (
      SELECT m.chuboe_mfr_id, AVG(EXTRACT(EPOCH FROM (vq.created - rfq.created)) / 86400) as avg_response_days
      FROM adempiere.chuboe_mfr m
      CROSS JOIN prior_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
      WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
      GROUP BY m.chuboe_mfr_id
      HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10
    )
    SELECT
      cp.manufacturer,
      ROUND(cp.avg_response_days, 1) as current_avg_response_days,
      ROUND(pp.avg_response_days, 1) as prior_avg_response_days,
      CASE WHEN pp.avg_response_days > 0
      THEN ROUND(((cp.avg_response_days - pp.avg_response_days) / pp.avg_response_days) * 100, 1)
      ELSE 0 END as change_pct,
      cp.sample_size,
      CASE WHEN ((cp.avg_response_days - pp.avg_response_days) / NULLIF(pp.avg_response_days, 0)) > 0.20
      THEN 'Response Time Increase' ELSE '' END as signal
    FROM current_period cp
    JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
    ORDER BY ((cp.avg_response_days - pp.avg_response_days) / NULLIF(pp.avg_response_days, 0)) DESC
    LIMIT 10;
  `;

  return parseRows(
    execQuery(query),
    ['manufacturer', 'current_avg_response_days', 'prior_avg_response_days', 'change_pct', 'sample_size', 'signal']
  );
}

/**
 * Section 8: New Entrants
 */
async function collectNewEntrants() {
  console.log('Collecting New Entrants...');

  const query = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date, CURRENT_DATE as end_date
    ),
    prior_window AS (
      SELECT CURRENT_DATE - INTERVAL '60 days' as start_date, CURRENT_DATE - INTERVAL '30 days' as end_date
    ),
    current_top AS (
      SELECT rfqm.chuboe_mpn as mpn, m.name as manufacturer, m.chuboe_mfr_id,
        COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
        ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC) as rank
      FROM adempiere.chuboe_rfq_line_mpn rfqm
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
      WHERE rfqm.isactive = 'Y' AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      GROUP BY rfqm.chuboe_mpn, m.name, m.chuboe_mfr_id
    ),
    prior_top AS (
      SELECT rfqm.chuboe_mpn as mpn, m.chuboe_mfr_id,
        COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
        ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC) as rank
      FROM adempiere.chuboe_rfq_line_mpn rfqm
      CROSS JOIN prior_window
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
      WHERE rfqm.isactive = 'Y' AND rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
      GROUP BY rfqm.chuboe_mpn, m.chuboe_mfr_id
    )
    SELECT
      ct.mpn, ct.manufacturer,
      ct.rfq_count as current_rfqs,
      COALESCE(pt.rfq_count, 0) as prior_rfqs,
      ct.rank as current_rank,
      COALESCE(pt.rank, 999) as prior_rank,
      CASE WHEN pt.mpn IS NULL THEN 'New to Top 20'
      WHEN pt.rank > 20 THEN 'Jumped into Top 20'
      ELSE 'Rising' END as status
    FROM current_top ct
    LEFT JOIN prior_top pt ON ct.mpn = pt.mpn AND ct.chuboe_mfr_id = pt.chuboe_mfr_id
    WHERE ct.rank <= 20 AND (pt.mpn IS NULL OR pt.rank > 20)
    ORDER BY ct.rank ASC
    LIMIT 10;
  `;

  return parseRows(
    execQuery(query),
    ['mpn', 'manufacturer', 'current_rfqs', 'prior_rfqs', 'current_rank', 'prior_rank', 'status']
  );
}

/**
 * Performance Snapshot: Bookings vs Billings
 * Source: Infor exports (Post-Sales actuals)
 * Both metrics from Infor ERP system of record
 */
async function collectPerformanceSnapshot() {
  console.log('Collecting Performance Snapshot...');

  const salesPulseDir = path.join(__dirname, '..');
  const bookingsPath = path.join(salesPulseDir, 'Infor Booked Sales by Line YTD - 6.19.26.xlsx');
  const billingsPath = path.join(salesPulseDir, 'Invoiced Sales 2026 by Line - 6.19.26.csv');

  try {
    // Read Bookings (XLSX)
    const bookingsWB = XLSX.readFile(bookingsPath);
    const bookingsData = XLSX.utils.sheet_to_json(bookingsWB.Sheets[bookingsWB.SheetNames[0]]);

    // Read Billings (CSV) - parse manually with proper quote handling
    const csvContent = fs.readFileSync(billingsPath, 'utf8');
    const lines = csvContent.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

    const billingsData = lines.slice(1).map(line => {
      // Handle quoted fields with commas
      const values = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());

      const row = {};
      headers.forEach((header, i) => {
        row[header] = values[i] || '';
      });
      return row;
    });

    // Aggregate Bookings by week (YTD file structure)
    function aggregateBookings(weekNum, excludeKLA = false) {
      let weekData = bookingsData.filter(row => row['Week Number'] === weekNum);

      // Filter out KLA if requested
      if (excludeKLA) {
        weekData = weekData.filter(row => {
          const customer = row['Customer Name'] || '';
          return !customer.toUpperCase().includes('KLA');
        });
      }

      const byTeam = {};
      weekData.forEach(row => {
        const salesperson = row['CO Internal Salesperson'];
        let team = SALES_TEAM_MAP[salesperson] || 'Other';

        if (!byTeam[team]) {
          byTeam[team] = { revenue: 0, gp: 0, orders: new Set(), customers: new Set() };
        }

        byTeam[team].revenue += row['Booked Revenue'] || 0;
        byTeam[team].gp += row['Booked GP'] || 0;
        if (row['CO Number']) byTeam[team].orders.add(row['CO Number']);
        if (row['Customer Name']) byTeam[team].customers.add(row['Customer Name']);
      });

      // Convert to counts
      Object.keys(byTeam).forEach(team => {
        byTeam[team].orders = byTeam[team].orders.size;
        byTeam[team].customers = byTeam[team].customers.size;
        byTeam[team].gm = byTeam[team].revenue > 0 ? (byTeam[team].gp / byTeam[team].revenue) : 0;
      });

      // Consolidate APAC sub-teams into APAC total
      const apacTeams = Object.keys(byTeam).filter(t => t.startsWith('APAC'));
      const apacTotal = { revenue: 0, gp: 0, orders: 0, customers: 0 };
      apacTeams.forEach(team => {
        apacTotal.revenue += byTeam[team].revenue;
        apacTotal.gp += byTeam[team].gp;
        apacTotal.orders += byTeam[team].orders;
        apacTotal.customers += byTeam[team].customers;
      });
      apacTotal.gm = apacTotal.revenue > 0 ? (apacTotal.gp / apacTotal.revenue) : 0;

      // Calculate total
      const total = { revenue: 0, gp: 0, orders: 0, customers: 0 };
      Object.values(byTeam).forEach(t => {
        total.revenue += t.revenue;
        total.gp += t.gp;
        total.orders += t.orders;
        total.customers += t.customers;
      });
      total.gm = total.revenue > 0 ? (total.gp / total.revenue) : 0;

      return { byTeam, apacTotal, total };
    }

    // Aggregate Billings by week (CSV line-item data)
    function aggregateBillings(weekNum, excludeKLA = false) {
      let weekData = billingsData.filter(row => parseInt(row['Week Number']) === weekNum);

      // Filter out KLA if requested
      if (excludeKLA) {
        weekData = weekData.filter(row => {
          const customer = row['Customer Name'] || '';
          return !customer.toUpperCase().includes('KLA');
        });
      }

      const byTeam = {};
      weekData.forEach(row => {
        const salesperson = row['Internal Salesperson'];
        let team = SALES_TEAM_MAP[salesperson] || 'Other';

        if (!byTeam[team]) {
          byTeam[team] = { revenue: 0, gp: 0, orders: new Set(), customers: new Set() };
        }

        // Parse currency fields (format: "$307200.00")
        const revenueStr = (row['Invoice Revenue'] || '$0').replace(/[$,]/g, '');
        const gpStr = (row['Invoice GP'] || '$0').replace(/[$,]/g, '');

        byTeam[team].revenue += parseFloat(revenueStr) || 0;
        byTeam[team].gp += parseFloat(gpStr) || 0;
        if (row['CO Number']) byTeam[team].orders.add(row['CO Number']);
        if (row['Customer Name']) byTeam[team].customers.add(row['Customer Name']);
      });

      // Convert Sets to counts
      Object.keys(byTeam).forEach(team => {
        byTeam[team].orders = byTeam[team].orders.size;
        byTeam[team].customers = byTeam[team].customers.size;
        byTeam[team].gm = byTeam[team].revenue > 0 ? (byTeam[team].gp / byTeam[team].revenue) : 0;
      });

      // Consolidate APAC
      const apacTeams = Object.keys(byTeam).filter(t => t.startsWith('APAC'));
      const apacTotal = { revenue: 0, gp: 0, orders: 0, customers: 0 };
      apacTeams.forEach(team => {
        apacTotal.revenue += byTeam[team].revenue;
        apacTotal.gp += byTeam[team].gp;
        apacTotal.orders += byTeam[team].orders;
        apacTotal.customers += byTeam[team].customers;
      });
      apacTotal.gm = apacTotal.revenue > 0 ? (apacTotal.gp / apacTotal.revenue) : 0;

      // Total
      const total = { revenue: 0, gp: 0, orders: 0, customers: 0 };
      Object.values(byTeam).forEach(t => {
        total.revenue += t.revenue;
        total.gp += t.gp;
        total.orders += t.orders;
        total.customers += t.customers;
      });
      total.gm = total.revenue > 0 ? (total.gp / total.revenue) : 0;

      return { byTeam, apacTotal, total };
    }

    // Get current and prior weeks (use completed weeks only - skip most recent)
    const weeks = [...new Set(bookingsData.map(row => row['Week Number']))].sort((a, b) => b - a);
    const currentWeek = weeks[1];  // Most recent COMPLETED week
    const priorWeek = weeks[2];    // Week before that

    const bookingsCurrent = aggregateBookings(currentWeek);
    const bookingsPrior = aggregateBookings(priorWeek);
    const billingsCurrent = aggregateBillings(currentWeek);
    const billingsPrior = aggregateBillings(priorWeek);

    // Calculate Ex-KLA metrics (filter out KLA customer)
    const bookingsCurrentExKLA = aggregateBookings(currentWeek, true);
    const bookingsPriorExKLA = aggregateBookings(priorWeek, true);
    const billingsCurrentExKLA = aggregateBillings(currentWeek, true);
    const billingsPriorExKLA = aggregateBillings(priorWeek, true);

    // Calculate KLA-only metrics
    const klaBookingsCurrent = {
      revenue: bookingsCurrent.total.revenue - bookingsCurrentExKLA.total.revenue,
      gp: bookingsCurrent.total.gp - bookingsCurrentExKLA.total.gp
    };
    const klaBillingsCurrent = {
      revenue: billingsCurrent.total.revenue - billingsCurrentExKLA.total.revenue,
      gp: billingsCurrent.total.gp - billingsCurrentExKLA.total.gp
    };

    return {
      currentWeek,
      priorWeek,
      bookings: { current: bookingsCurrent, prior: bookingsPrior },
      billings: { current: billingsCurrent, prior: billingsPrior },
      bookingsExKLA: { current: bookingsCurrentExKLA, prior: bookingsPriorExKLA },
      billingsExKLA: { current: billingsCurrentExKLA, prior: billingsPriorExKLA },
      kla: { bookings: klaBookingsCurrent, billings: klaBillingsCurrent }
    };

  } catch (error) {
    console.error('⚠️  Performance Snapshot unavailable:', error.message);
    return null;
  }
}

/**
 * Section 1: Temperature Gauge
 * Aggregates signal counts from constraint indicators
 */
async function collectTemperatureGauge(constraints, regional, responseTimes) {
  console.log('Calculating Temperature Gauge...');

  const signals = {
    conversion_drop: constraints.conversionDropOff.length,
    multi_customer_parts: constraints.multiCustomerParts.length,
    velocity_spike: constraints.velocitySpike.length,
    apac_concentration: regional.filter(r => r.signal).length,
    response_time_increase: responseTimes.filter(r => r.signal).length
  };

  const activeSignals = Object.values(signals).reduce((sum, count) => sum + count, 0);

  let status, statusIndicator, description;
  if (activeSignals === 0 || activeSignals === 1) {
    status = 'NORMAL MARKET';
    statusIndicator = '🟢';
    description = 'No significant constraint signals detected. Market operating normally.';
  } else if (activeSignals === 2 || activeSignals === 3) {
    status = 'HEATING UP';
    statusIndicator = '🟡';
    description = 'Market transitioning. Early constraint signals detected — monitor closely.';
  } else if (activeSignals === 4 || activeSignals === 5) {
    status = 'CONSTRAINED';
    statusIndicator = '🔴';
    description = 'Multiple constraint signals active. Allocation risk within 2-4 weeks.';
  } else {
    status = 'CRITICAL';
    statusIndicator = '🔴';
    description = 'Market under severe stress. Allocation likely imminent or active.';
  }

  // Build key watch items narrative
  const watchItems = [];
  if (constraints.multiCustomerParts.length > 0) {
    const top = constraints.multiCustomerParts[0];
    watchItems.push(`${top.mpn} (${top.customer_count} customers)`);
  }
  if (regional.filter(r => r.signal).length > 0) {
    const top = regional.filter(r => r.signal)[0];
    watchItems.push(`${top.manufacturer} (APAC ${top.apac_pct}% concentration)`);
  }
  if (responseTimes.filter(r => r.signal).length > 0) {
    const top = responseTimes.filter(r => r.signal)[0];
    watchItems.push(`${top.manufacturer} (response time +${top.change_pct}%)`);
  }

  const keyWatchItems = watchItems.length > 0
    ? watchItems.join(', ') + '.'
    : 'No critical watch items at this time.';

  return {
    status,
    statusIndicator,
    activeSignals,
    description,
    signals,
    keyWatchItems
  };
}

/**
 * Build HTML email
 */
function buildEmail(tempGauge, constraints, trendingMfrs, trendingParts, exposure, regional, responseTimes, newEntrants, performanceSnapshot) {
  const today = new Date();
  const window = get30DayWindow();
  const windowStart = new Date(window.start);
  const windowEnd = new Date(window.end);

  // Helper to calculate WoW change
  const calcChange = (curr, prev) => {
    if (!prev || prev === 0) return 'N/A';
    const chg = ((curr - prev) / Math.abs(prev)) * 100;
    return (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%';
  };

  // Helper to build table rows
  const buildTableRows = (data, columns) => {
    if (!data || data.length === 0) {
      return '<tr><td colspan="' + columns.length + '" style="text-align: center; color: #999; font-style: italic;">No data available</td></tr>';
    }
    return data.map(row => {
      return '<tr>' + columns.map(col => {
        let value = row[col.key];
        if (col.format === 'currency') value = formatCurrency(value);
        else if (col.format === 'percent') value = value + '%';
        else if (col.format === 'badge') {
          if (value === 'High') value = '<span class="badge badge-red">High</span>';
          else if (value === 'Medium') value = '<span class="badge badge-yellow">Medium</span>';
          else if (value === 'Low') value = '<span class="badge badge-green">Low</span>';
          else if (value) value = '<span class="badge badge-gray">' + value + '</span>';
        } else if (col.format === 'signal') {
          if (value) value = '<span class="badge badge-red">🔥 ' + value + '</span>';
        }
        return '<td>' + (value || '') + '</td>';
      }).join('') + '</tr>';
    }).join('');
  };

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Market Pulse — 30-Day Rolling View</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
    max-width: 1100px;
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
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 4px 0;
    color: #1a1a1a;
  }
  .subtitle {
    font-size: 12px;
    color: #666;
    margin-bottom: 20px;
  }
  .section {
    margin-bottom: 28px;
    padding-bottom: 28px;
    border-bottom: 2px solid #e0e0e0;
  }
  .section:last-child {
    border-bottom: none;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
    color: #1a1a1a;
  }
  .section-subtitle {
    font-size: 11px;
    color: #666;
    margin-bottom: 12px;
    font-style: italic;
  }

  /* Temperature Gauge */
  .temp-gauge {
    background: linear-gradient(135deg, ${tempGauge.statusIndicator === '🟢' ? '#d1fae5 0%, #ecfdf5 100%' : tempGauge.statusIndicator === '🟡' ? '#fef3c7 0%, #fef9e7 100%' : '#fee2e2 0%, #fef2f2 100%'});
    border: 2px solid ${tempGauge.statusIndicator === '🟢' ? '#10b981' : tempGauge.statusIndicator === '🟡' ? '#f59e0b' : '#dc2626'};
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 24px;
  }
  .temp-gauge h2 {
    margin: 0 0 12px 0;
    font-size: 16px;
    font-weight: 700;
    color: ${tempGauge.statusIndicator === '🟢' ? '#064e3b' : tempGauge.statusIndicator === '🟡' ? '#92400e' : '#991b1b'};
  }
  .gauge-status {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .gauge-indicator {
    font-size: 48px;
    line-height: 1;
  }
  .gauge-text {
    flex: 1;
  }
  .gauge-title {
    font-size: 18px;
    font-weight: 700;
    color: #1a1a1a;
    margin-bottom: 4px;
  }
  .gauge-detail {
    font-size: 12px;
    color: #666;
  }
  .signal-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 12px;
  }
  .signal-card {
    background: white;
    padding: 12px;
    border-radius: 6px;
    border-left: 3px solid #94a3b8;
  }
  .signal-card.active {
    border-left-color: #dc2626;
    background: #fef2f2;
  }
  .signal-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #64748b;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .signal-value {
    font-size: 18px;
    font-weight: 700;
    color: #1e293b;
  }
  .signal-card.active .signal-value {
    color: #dc2626;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-top: 8px;
  }
  th {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    padding: 8px;
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    color: #475569;
  }
  td {
    border: 1px solid #e2e8f0;
    padding: 8px;
  }
  tr:hover {
    background: #fafafa;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-yellow { background: #fef3c7; color: #92400e; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-gray { background: #f1f5f9; color: #475569; }

  .alert-box {
    background: ${tempGauge.statusIndicator === '🟢' ? '#f0fdf4' : tempGauge.statusIndicator === '🟡' ? '#fffbeb' : '#fef2f2'};
    border-left: 4px solid ${tempGauge.statusIndicator === '🟢' ? '#10b981' : tempGauge.statusIndicator === '🟡' ? '#f59e0b' : '#dc2626'};
    padding: 12px;
    margin-top: 16px;
    border-radius: 4px;
    font-size: 12px;
  }
  .alert-box strong {
    color: ${tempGauge.statusIndicator === '🟢' ? '#064e3b' : tempGauge.statusIndicator === '🟡' ? '#92400e' : '#991b1b'};
  }

  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #e0e0e0;
    font-size: 11px;
    color: #666;
  }
</style>
</head>
<body>

<div class="container">
  <h1>📈 Market Pulse — 30-Day Rolling View</h1>
  <div class="subtitle">
    As of ${formatDate(today)} | Rolling window: ${formatDate(windowStart)} - ${formatDate(windowEnd)} (30 calendar days)
  </div>

  ${performanceSnapshot ? `
  <!-- PERFORMANCE SNAPSHOT -->
  <div class="section" style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
    <div class="section-title">💰 Performance Snapshot — Infor Weekly Summary</div>
    <div class="section-subtitle">Week ${performanceSnapshot.currentWeek} vs ${performanceSnapshot.priorWeek} (Completed weeks only) • Source: Infor ERP (Post-Sales)</div>

    <!-- CORE BUSINESS (EX-KLA) -->
    <div style="background: #ecfdf5; border: 2px solid #10b981; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
      <h3 style="font-size: 14px; font-weight: 700; margin: 0 0 12px 0; color: #065f46;">Core Business Performance (Excl. KLA)</h3>
      <table style="margin: 0;">
        <thead>
          <tr>
            <th style="width: 20%;">Metric</th>
            <th style="width: 20%;">Week ${performanceSnapshot.currentWeek}</th>
            <th style="width: 20%;">Week ${performanceSnapshot.priorWeek}</th>
            <th style="width: 15%;">WoW Change</th>
            <th style="width: 25%;">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background: #f0fdf4;">
            <td><strong>Bookings</strong></td>
            <td>${formatCurrency(performanceSnapshot.bookingsExKLA.current.total.revenue)}</td>
            <td>${formatCurrency(performanceSnapshot.bookingsExKLA.prior.total.revenue)}</td>
            <td><strong>${calcChange(performanceSnapshot.bookingsExKLA.current.total.revenue, performanceSnapshot.bookingsExKLA.prior.total.revenue)}</strong></td>
            <td style="font-size: 11px;">${(performanceSnapshot.bookingsExKLA.current.total.gm * 100).toFixed(1)}% GM</td>
          </tr>
          <tr style="background: #f0fdf4;">
            <td><strong>Billings</strong></td>
            <td>${formatCurrency(performanceSnapshot.billingsExKLA.current.total.revenue)}</td>
            <td>${formatCurrency(performanceSnapshot.billingsExKLA.prior.total.revenue)}</td>
            <td><strong>${calcChange(performanceSnapshot.billingsExKLA.current.total.revenue, performanceSnapshot.billingsExKLA.prior.total.revenue)}</strong></td>
            <td style="font-size: 11px;">${(performanceSnapshot.billingsExKLA.current.total.gm * 100).toFixed(1)}% GM</td>
          </tr>
          <tr style="background: #dcfce7;">
            <td><strong>Book-to-Bill</strong></td>
            <td colspan="3"><strong style="font-size: 16px;">${(performanceSnapshot.bookingsExKLA.current.total.revenue / performanceSnapshot.billingsExKLA.current.total.revenue).toFixed(2)}x</strong></td>
            <td style="font-size: 11px; font-weight: 600; color: ${(performanceSnapshot.bookingsExKLA.current.total.revenue / performanceSnapshot.billingsExKLA.current.total.revenue) >= 1.0 ? '#065f46' : '#dc2626'};">
              ${(performanceSnapshot.bookingsExKLA.current.total.revenue / performanceSnapshot.billingsExKLA.current.total.revenue) >= 1.0 ? '✅ Building backlog' : '⚠️ Depleting backlog'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- REGIONAL BREAKDOWN (TOTAL BUSINESS) -->
    <h3 style="font-size: 14px; font-weight: 600; margin: 20px 0 8px 0;">Regional Breakdown — Week ${performanceSnapshot.currentWeek} (Total Business)</h3>
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th>Bookings</th>
          <th>Billings</th>
          <th>B/B Ratio</th>
          <th>Bookings GM</th>
          <th>Billings GM</th>
        </tr>
      </thead>
      <tbody>
        ${[
          { name: 'USA', bookings: performanceSnapshot.bookings.current.byTeam['USA'] || {}, billings: performanceSnapshot.billings.current.byTeam['USA'] || {} },
          { name: 'MEX', bookings: performanceSnapshot.bookings.current.byTeam['MEX'] || {}, billings: performanceSnapshot.billings.current.byTeam['MEX'] || {} },
          { name: 'APAC', bookings: performanceSnapshot.bookings.current.apacTotal, billings: performanceSnapshot.billings.current.apacTotal, hasKLA: true },
          { name: 'Other', bookings: performanceSnapshot.bookings.current.byTeam['Other'] || {}, billings: performanceSnapshot.billings.current.byTeam['Other'] || {} }
        ].map(({ name, bookings, billings, hasKLA }) => {
          const bRev = bookings.revenue || 0;
          const billRev = billings.revenue || 0;
          const ratio = billRev > 0 ? (bRev / billRev).toFixed(2) : 'N/A';
          const bGM = ((bookings.gm || 0) * 100).toFixed(1) + '%';
          const billGM = ((billings.gm || 0) * 100).toFixed(1) + '%';

          return `<tr${hasKLA ? ' style="background: #fef3c7;"' : ''}>
            <td><strong>${name}${hasKLA ? ' *' : ''}</strong></td>
            <td>${formatCurrency(bRev)}</td>
            <td>${formatCurrency(billRev)}</td>
            <td><strong>${ratio}</strong></td>
            <td>${bGM}</td>
            <td>${billGM}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p style="font-size: 11px; color: #666; margin-top: 8px; font-style: italic;">
      * APAC includes KLA: ${formatCurrency(performanceSnapshot.kla.bookings.revenue)} bookings / ${formatCurrency(performanceSnapshot.kla.billings.revenue)} billings
    </p>

    <!-- TOTAL BUSINESS (INCL. KLA) -->
    <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 6px; padding: 12px; margin-top: 20px;">
      <h3 style="font-size: 13px; font-weight: 600; margin: 0 0 8px 0; color: #92400e;">Total Business (Incl. KLA)</h3>
      <div style="display: flex; gap: 24px; font-size: 12px;">
        <div><strong>Bookings:</strong> ${formatCurrency(performanceSnapshot.bookings.current.total.revenue)}</div>
        <div><strong>Billings:</strong> ${formatCurrency(performanceSnapshot.billings.current.total.revenue)}</div>
        <div><strong>B/B Ratio:</strong> ${(performanceSnapshot.bookings.current.total.revenue / performanceSnapshot.billings.current.total.revenue).toFixed(2)}x</div>
        <div style="color: #92400e; font-style: italic;">Large KLA shipment (${formatCurrency(performanceSnapshot.kla.billings.revenue)}) billed in Week ${performanceSnapshot.currentWeek}</div>
      </div>
    </div>
  </div>
  ` : ''}

  <!-- TEMPERATURE GAUGE -->
  <div class="temp-gauge">
    <h2>🌡️ Market Temperature — Overall Status</h2>

    <div class="gauge-status">
      <div class="gauge-indicator">${tempGauge.statusIndicator}</div>
      <div class="gauge-text">
        <div class="gauge-title">${tempGauge.status} — ${tempGauge.activeSignals} Constraint Signal${tempGauge.activeSignals !== 1 ? 's' : ''} Detected</div>
        <div class="gauge-detail">${tempGauge.description}</div>
      </div>
    </div>

    <div class="signal-grid">
      <div class="signal-card${tempGauge.signals.conversion_drop > 0 ? ' active' : ''}">
        <div class="signal-label">Conversion Drop</div>
        <div class="signal-value">${tempGauge.signals.conversion_drop}${tempGauge.signals.conversion_drop > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.velocity_spike > 0 ? ' active' : ''}">
        <div class="signal-label">Velocity Spike</div>
        <div class="signal-value">${tempGauge.signals.velocity_spike}${tempGauge.signals.velocity_spike > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.multi_customer_parts > 0 ? ' active' : ''}">
        <div class="signal-label">Multi-Customer Parts</div>
        <div class="signal-value">${tempGauge.signals.multi_customer_parts}${tempGauge.signals.multi_customer_parts > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.apac_concentration > 0 ? ' active' : ''}">
        <div class="signal-label">APAC Concentration</div>
        <div class="signal-value">${tempGauge.signals.apac_concentration}${tempGauge.signals.apac_concentration > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.response_time_increase > 0 ? ' active' : ''}">
        <div class="signal-label">Response Time ↑</div>
        <div class="signal-value">${tempGauge.signals.response_time_increase}${tempGauge.signals.response_time_increase > 0 ? ' 🔥' : ''}</div>
      </div>
    </div>

    <div class="alert-box">
      <strong>Key Watch Items:</strong> ${tempGauge.keyWatchItems}
    </div>
  </div>

  <!-- CONSTRAINT INDICATORS -->
  <div class="section">
    <div class="section-title">🔥 Constraint Indicators — Early Warning Signals</div>
    <div class="section-subtitle">Parts/manufacturers showing allocation risk signals</div>

    <h3 style="font-size: 14px; font-weight: 600; margin: 16px 0 8px 0;">Multi-Customer Parts (5+ Customers)</h3>
    <p style="font-size: 11px; color: #666; margin-bottom: 8px;">When the same part is requested by 5+ distinct customers = scarcity signal</p>
    <table>
      <thead>
        <tr>
          <th>MPN</th>
          <th>Manufacturer</th>
          <th>Customers</th>
          <th>RFQs</th>
          <th>Quoted</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(constraints.multiCustomerParts, [
          { key: 'mpn' },
          { key: 'manufacturer' },
          { key: 'customer_count' },
          { key: 'rfq_count' },
          { key: 'quoted_count' }
        ])}
      </tbody>
    </table>

    <h3 style="font-size: 14px; font-weight: 600; margin: 24px 0 8px 0;">Conversion Drop-Off (>10pts decline)</h3>
    <p style="font-size: 11px; color: #666; margin-bottom: 8px;">Win rate declining = supply tightening</p>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Current Conv %</th>
          <th>Prior Conv %</th>
          <th>Change (pts)</th>
          <th>Sample Size</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(constraints.conversionDropOff, [
          { key: 'manufacturer' },
          { key: 'current_conversion_pct', format: 'percent' },
          { key: 'prior_conversion_pct', format: 'percent' },
          { key: 'conversion_change_pts' },
          { key: 'current_quoted' }
        ])}
      </tbody>
    </table>

    <h3 style="font-size: 14px; font-weight: 600; margin: 24px 0 8px 0;">Velocity Spike (Top 3 by Volume Increase)</h3>
    <p style="font-size: 11px; color: #666; margin-bottom: 8px;">Demand surge = allocation risk</p>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Current RFQs</th>
          <th>Prior RFQs</th>
          <th>Change</th>
          <th>Velocity %</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(constraints.velocitySpike, [
          { key: 'manufacturer' },
          { key: 'current_rfqs' },
          { key: 'prior_rfqs' },
          { key: 'rfq_change' },
          { key: 'velocity_change_pct', format: 'percent' }
        ])}
      </tbody>
    </table>
  </div>

  <!-- TRENDING MANUFACTURERS -->
  <div class="section">
    <div class="section-title">🏭 Trending Manufacturers (Top 10)</div>
    <div class="section-subtitle">Ranked by sold count (30-day activity)</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Customers</th>
          <th>RFQs</th>
          <th>Quoted</th>
          <th>Sold</th>
          <th>Win %</th>
          <th>Booked Sales</th>
          <th>WoW Velocity %</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(trendingMfrs, [
          { key: 'manufacturer' },
          { key: 'customers' },
          { key: 'rfq_count' },
          { key: 'quoted_count' },
          { key: 'sold_count' },
          { key: 'win_pct', format: 'percent' },
          { key: 'booked_sales_30d', format: 'currency' },
          { key: 'wow_velocity_pct', format: 'percent' }
        ])}
      </tbody>
    </table>
  </div>

  <!-- TRENDING PARTS -->
  <div class="section">
    <div class="section-title">🔧 Trending Parts (Top 10)</div>
    <div class="section-subtitle">By RFQ count (30-day activity)</div>
    <table>
      <thead>
        <tr>
          <th>MPN</th>
          <th>Manufacturer</th>
          <th>Customers</th>
          <th>RFQs</th>
          <th>Quoted</th>
          <th>Sold</th>
          <th>Win %</th>
          <th>Signal</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(trendingParts, [
          { key: 'mpn' },
          { key: 'manufacturer' },
          { key: 'customers' },
          { key: 'rfq_count' },
          { key: 'quoted_count' },
          { key: 'sold_count' },
          { key: 'win_pct', format: 'percent' },
          { key: 'scarcity_signal', format: 'badge' }
        ])}
      </tbody>
    </table>
  </div>

  <!-- MANUFACTURER EXPOSURE -->
  <div class="section">
    <div class="section-title">💼 Manufacturer Exposure — Pipeline Concentration Risk</div>
    <div class="section-subtitle">Open RFQ/CQ pipeline value by manufacturer</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Open RFQ Value</th>
          <th>Open CQ Value</th>
          <th>Total Exposure</th>
          <th>% of Pipeline</th>
          <th>Risk Level</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(exposure, [
          { key: 'manufacturer' },
          { key: 'open_rfq_value', format: 'currency' },
          { key: 'open_cq_value', format: 'currency' },
          { key: 'total_exposure', format: 'currency' },
          { key: 'pct_of_pipeline', format: 'percent' },
          { key: 'risk_level', format: 'badge' }
        ])}
      </tbody>
    </table>
  </div>

  <!-- REGIONAL DEMAND -->
  <div class="section">
    <div class="section-title">🌏 Regional Demand Divergence</div>
    <div class="section-subtitle">APAC concentration signals (APAC constraint typically hits 3-4 weeks before USA)</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Total RFQs</th>
          <th>APAC %</th>
          <th>USA %</th>
          <th>MEX %</th>
          <th>Signal</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(regional, [
          { key: 'manufacturer' },
          { key: 'total_rfqs' },
          { key: 'apac_pct', format: 'percent' },
          { key: 'usa_pct', format: 'percent' },
          { key: 'mex_pct', format: 'percent' },
          { key: 'signal', format: 'signal' }
        ])}
      </tbody>
    </table>
  </div>

  <!-- RESPONSE TIME TRENDS -->
  <div class="section">
    <div class="section-title">⏱️ Response Time Trends</div>
    <div class="section-subtitle">Supply chain stress indicator (expanding response time = suppliers struggling to source)</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>Current Avg Days</th>
          <th>Prior Avg Days</th>
          <th>Change %</th>
          <th>Sample Size</th>
          <th>Signal</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(responseTimes, [
          { key: 'manufacturer' },
          { key: 'current_avg_response_days' },
          { key: 'prior_avg_response_days' },
          { key: 'change_pct', format: 'percent' },
          { key: 'sample_size' },
          { key: 'signal', format: 'signal' }
        ])}
      </tbody>
    </table>
  </div>

  <!-- NEW ENTRANTS -->
  <div class="section">
    <div class="section-title">✨ New Entrants — Emerging Hotspots</div>
    <div class="section-subtitle">Parts that weren't in top 20 last period but are trending now</div>
    <table>
      <thead>
        <tr>
          <th>MPN</th>
          <th>Manufacturer</th>
          <th>Current RFQs</th>
          <th>Current Rank</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(newEntrants, [
          { key: 'mpn' },
          { key: 'manufacturer' },
          { key: 'current_rfqs' },
          { key: 'current_rank' },
          { key: 'status', format: 'badge' }
        ])}
      </tbody>
    </table>
  </div>

  <div class="footer">
    <p><strong>Data Sources:</strong></p>
    <ul style="margin: 8px 0; padding-left: 20px; font-size: 11px;">
      <li><strong>Performance Snapshot (Bookings + Billings):</strong> Infor ERP exports (Post-Sales actuals) — Completed sales transactions and invoiced revenue. Source of truth for financial performance.</li>
      <li><strong>Market Intelligence (Sections 2-8):</strong> OT Database (Pre-Sales pipeline) — Customer RFQs, vendor quotes, and customer quotes over 30-day rolling window. Forward-looking demand signals and market trends.</li>
    </ul>
    <p style="margin-top: 12px; font-size: 11px; color: #666;">
      <strong>Report Focus:</strong> This report is primarily focused on <strong>pre-sales market intelligence</strong> to identify demand trends, constraint signals, and emerging opportunities.
      The Performance Snapshot provides context on actual sales performance (where we've been) to inform forward-looking strategy (where we're going).
    </p>
    <p style="margin-top: 12px; font-style: italic; font-size: 11px;">
      Generated with Claude Code • Market Pulse Weekly
    </p>
  </div>

</div>

</body>
</html>
  `;

  return html;
}

/**
 * Send email
 */
async function sendEmail(html) {
  console.log('Sending email...');

  const path = require('path');
  const { createNotifier } = require(path.resolve(__dirname, '../../astute-workinstructions/shared/notifier'));

  const notifier = createNotifier({
    fromEmail: 'salesanalytics@orangetsunami.com',
    fromName: 'Sales Analytics',
  });

  const recipients = 'josh.pucci@astutegroup.com, melissa.bojar@astutegroup.com';
  const subject = `Market Pulse Weekly — ${new Date().toISOString().split('T')[0]}`;

  const success = await notifier.sendEmail(recipients, subject, html, { html: true });

  if (success) {
    console.log(`✅ Email sent successfully to: ${recipients}`);
  } else {
    console.error('❌ Email delivery failed');
  }

  return success;
}

/**
 * Main execution
 */
async function main() {
  const startTime = Date.now();
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║            Market Pulse Weekly — Building Report...                ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  try {
    // Collect all data
    const performanceSnapshot = await collectPerformanceSnapshot();
    const constraints = await collectConstraintIndicators();
    const trendingMfrs = await collectTrendingManufacturers();
    const trendingParts = await collectTrendingParts();
    const exposure = await collectManufacturerExposure();
    const regional = await collectRegionalDemand();
    const responseTimes = await collectResponseTimeTrends();
    const newEntrants = await collectNewEntrants();
    const tempGauge = await collectTemperatureGauge(constraints, regional, responseTimes);

    // Build HTML
    const html = buildEmail(tempGauge, constraints, trendingMfrs, trendingParts, exposure, regional, responseTimes, newEntrants, performanceSnapshot);

    // Save files
    const outputDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `market-pulse-weekly-${timestamp}.html`);
    const jsonPath = path.join(outputDir, `market-pulse-weekly-${timestamp}.json`);

    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
      performanceSnapshot,
      tempGauge,
      constraints,
      trendingMfrs,
      trendingParts,
      exposure,
      regional,
      responseTimes,
      newEntrants
    }, null, 2));

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log('\n✅ Market Pulse Weekly generated successfully');
    console.log(`⏱️  Total runtime: ${duration} seconds`);
    console.log(`📄 HTML: ${htmlPath}`);
    console.log(`📊 JSON: ${jsonPath}`);

    // Send email if --email flag provided
    if (SEND_EMAIL) {
      console.log('');
      await sendEmail(html);
    } else {
      console.log('\n💡 To send via email, run: node market-pulse-weekly-v2.js --email');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
