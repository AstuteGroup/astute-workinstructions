-- Market Pulse Weekly - SQL Queries
-- Created: 2026-06-19
-- Purpose: Market intelligence report with 30-day rolling window
-- Structure: 8 sections providing market constraint signals and trends

-- ============================================================================
-- HELPER: Date Windows
-- ============================================================================
-- Current 30-day window: use CURRENT_DATE - 30 to CURRENT_DATE
-- Prior 30-day window: use CURRENT_DATE - 60 to CURRENT_DATE - 30
-- These are used throughout for trend comparison

-- ============================================================================
-- SECTION 3: TRENDING MANUFACTURERS (Top 10)
-- ============================================================================
-- Metrics: Customers, RFQ Count, Quoted (VQ count), Sold (SO count), Win %,
--          Booked Sales (30d), WoW Velocity, Signals
-- Ranking: By Sold count (per Josh feedback)
-- Window: 30 days

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
),
prior_window AS (
  SELECT CURRENT_DATE - INTERVAL '60 days' as start_date,
         CURRENT_DATE - INTERVAL '30 days' as end_date
),
current_period AS (
  SELECT
    m.name as manufacturer,
    m.chuboe_mfr_id,
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
  SELECT
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
  FROM adempiere.chuboe_mfr m
  CROSS JOIN prior_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
  GROUP BY m.chuboe_mfr_id
)
SELECT
  cp.manufacturer,
  cp.customers,
  cp.rfq_count,
  cp.quoted_count,
  cp.sold_count,
  CASE
    WHEN cp.quoted_count > 0 THEN ROUND((cp.sold_count::numeric / cp.quoted_count::numeric) * 100, 1)
    ELSE 0
  END as win_pct,
  COALESCE(cp.booked_sales, 0) as booked_sales_30d,
  CASE
    WHEN COALESCE(pp.rfq_count, 0) > 0
    THEN ROUND(((cp.rfq_count::numeric - pp.rfq_count::numeric) / pp.rfq_count::numeric) * 100, 1)
    WHEN cp.rfq_count > 0 THEN 100.0
    ELSE 0
  END as wow_velocity_pct,
  -- Signals: placeholder for now, will be populated by constraint indicator queries
  '' as signals
FROM current_period cp
LEFT JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
ORDER BY cp.sold_count DESC, cp.rfq_count DESC
LIMIT 10;


-- ============================================================================
-- SECTION 4: TRENDING PARTS (Top 10)
-- ============================================================================
-- Metrics: MPN, Manufacturer, Customers, RFQ Count, Quoted, Sold, Win %,
--          First Seen, Scarcity Signal
-- Window: 30 days

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
)
SELECT
  rfqm.chuboe_mpn as mpn,
  m.name as manufacturer,
  COUNT(DISTINCT rfq.c_bpartner_id) as customers,
  COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
  COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
  COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
  CASE
    WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
    THEN ROUND((COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END)::numeric /
                COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric) * 100, 1)
    ELSE 0
  END as win_pct,
  MIN(rfq.created::date) as first_seen,
  CASE
    WHEN COUNT(DISTINCT rfq.c_bpartner_id) >= 5 THEN '🔴 Multi-Customer (5+)'
    ELSE ''
  END as scarcity_signal
FROM adempiere.chuboe_rfq_line_mpn rfqm
CROSS JOIN current_window
JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
WHERE rfqm.isactive = 'Y'
  AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
GROUP BY rfqm.chuboe_mpn, m.name
ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC
LIMIT 10;


-- ============================================================================
-- SECTION 2.1: CONSTRAINT INDICATOR - Multi-Customer Parts (5+ customers)
-- ============================================================================
-- Scarcity signal: When the same part is requested by 5+ distinct customers
-- Window: 30 days

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
)
SELECT
  rfqm.chuboe_mpn as mpn,
  m.name as manufacturer,
  COUNT(DISTINCT rfq.c_bpartner_id) as customer_count,
  COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
  COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
  CASE
    WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
    THEN ROUND((COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric /
                COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id)::numeric) * 100, 1)
    ELSE 0
  END as quote_rate_pct
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


-- ============================================================================
-- SECTION 2.2: CONSTRAINT INDICATOR - Conversion Drop-Off (>10pts decline)
-- ============================================================================
-- Supply tightening signal: Win rate declining by >10 percentage points
-- Comparison: Current 30d vs Prior 30d
-- Formula: (VQ → Sold conversion rate) current vs prior

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
),
prior_window AS (
  SELECT CURRENT_DATE - INTERVAL '60 days' as start_date,
         CURRENT_DATE - INTERVAL '30 days' as end_date
),
current_period AS (
  SELECT
    m.name as manufacturer,
    m.chuboe_mfr_id,
    COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
    COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
    CASE
      WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
      THEN ROUND((COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END)::numeric /
                  COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric) * 100, 1)
      ELSE 0
    END as conversion_rate
  FROM adempiere.chuboe_mfr m
  CROSS JOIN current_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
  GROUP BY m.name, m.chuboe_mfr_id
  HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10  -- Minimum sample size
),
prior_period AS (
  SELECT
    m.chuboe_mfr_id,
    COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
    COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
    CASE
      WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
      THEN ROUND((COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END)::numeric /
                  COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric) * 100, 1)
      ELSE 0
    END as conversion_rate
  FROM adempiere.chuboe_mfr m
  CROSS JOIN prior_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
  GROUP BY m.chuboe_mfr_id
  HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10  -- Minimum sample size
)
SELECT
  cp.manufacturer,
  cp.quoted_count as current_quoted,
  cp.sold_count as current_sold,
  cp.conversion_rate as current_conversion_pct,
  pp.quoted_count as prior_quoted,
  pp.sold_count as prior_sold,
  pp.conversion_rate as prior_conversion_pct,
  (cp.conversion_rate - pp.conversion_rate) as conversion_change_pts
FROM current_period cp
JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
WHERE (cp.conversion_rate - pp.conversion_rate) < -10  -- Drop of >10 percentage points
ORDER BY (cp.conversion_rate - pp.conversion_rate) ASC
LIMIT 10;


-- ============================================================================
-- SECTION 2.3: CONSTRAINT INDICATOR - Velocity Spike (Top 3 always)
-- ============================================================================
-- Demand surge signal: Top 3 manufacturers by RFQ volume increase
-- No threshold - always show top 3 (per Josh feedback)
-- Comparison: Current 30d vs Prior 30d

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
),
prior_window AS (
  SELECT CURRENT_DATE - INTERVAL '60 days' as start_date,
         CURRENT_DATE - INTERVAL '30 days' as end_date
),
current_period AS (
  SELECT
    m.name as manufacturer,
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
  FROM adempiere.chuboe_mfr m
  CROSS JOIN current_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
  GROUP BY m.name, m.chuboe_mfr_id
),
prior_period AS (
  SELECT
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
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
  CASE
    WHEN COALESCE(pp.rfq_count, 0) > 0
    THEN ROUND(((cp.rfq_count::numeric - pp.rfq_count::numeric) / pp.rfq_count::numeric) * 100, 1)
    WHEN cp.rfq_count > 0 THEN 100.0
    ELSE 0
  END as velocity_change_pct
FROM current_period cp
LEFT JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
ORDER BY (cp.rfq_count - COALESCE(pp.rfq_count, 0)) DESC
LIMIT 3;


-- ============================================================================
-- SECTION 5: MANUFACTURER EXPOSURE (Pipeline Concentration Risk)
-- ============================================================================
-- Metrics: Open RFQ Value, Open CQ Value, Total Exposure, % of Pipeline,
--          Largest Customer, Risk Level
-- Window: Current open quotes (no time window)

WITH open_rfqs AS (
  SELECT
    m.name as manufacturer,
    m.chuboe_mfr_id,
    SUM(rfqm.priceentered * rfqm.qty) as open_rfq_value,
    STRING_AGG(DISTINCT bp.name, ', ') as customers
  FROM adempiere.chuboe_mfr m
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  JOIN adempiere.c_bpartner bp ON rfq.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
  WHERE rfq.docstatus = 'CO'  -- Completed/Open status
  GROUP BY m.name, m.chuboe_mfr_id
),
open_cqs AS (
  SELECT
    m.chuboe_mfr_id,
    SUM(cq.priceentered * cq.qty) as open_cq_value
  FROM adempiere.chuboe_mfr m
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
  WHERE cq.issold = 'N'
    AND cq.r_status_id = 1000027  -- Open status
  GROUP BY m.chuboe_mfr_id
),
total_pipeline AS (
  SELECT SUM(rfqm.priceentered * rfqm.qty) as total_value
  FROM adempiere.chuboe_rfq_line_mpn rfqm
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  WHERE rfqm.isactive = 'Y'
    AND rfq.docstatus = 'CO'
)
SELECT
  orq.manufacturer,
  COALESCE(orq.open_rfq_value, 0) as open_rfq_value,
  COALESCE(ocq.open_cq_value, 0) as open_cq_value,
  (COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) as total_exposure,
  CASE
    WHEN tp.total_value > 0
    THEN ROUND(((COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) / tp.total_value) * 100, 1)
    ELSE 0
  END as pct_of_pipeline,
  orq.customers as largest_customers,
  CASE
    WHEN ((COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) / NULLIF(tp.total_value, 0)) > 0.15 THEN '🔴 High'
    WHEN ((COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) / NULLIF(tp.total_value, 0)) > 0.10 THEN '🟡 Medium'
    ELSE '🟢 Low'
  END as risk_level
FROM open_rfqs orq
LEFT JOIN open_cqs ocq ON orq.chuboe_mfr_id = ocq.chuboe_mfr_id
CROSS JOIN total_pipeline tp
ORDER BY (COALESCE(orq.open_rfq_value, 0) + COALESCE(ocq.open_cq_value, 0)) DESC
LIMIT 10;


-- ============================================================================
-- SECTION 6: REGIONAL DEMAND DIVERGENCE (APAC Concentration Signals)
-- ============================================================================
-- Metrics: Total RFQs, APAC %, USA %, MEX %, Other %, Signal
-- Window: 30 days
-- Regional mapping: Based on customer country

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
)
SELECT
  m.name as manufacturer,
  COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as total_rfqs,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as apac_pct,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode = 'US' THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as usa_pct,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode = 'MX' THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as mex_pct,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode NOT IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN', 'US', 'MX') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as other_pct,
  CASE
    WHEN (COUNT(DISTINCT CASE WHEN c.countrycode IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) > 0.70
    THEN '🔴 APAC Concentration (>70%)'
    ELSE ''
  END as signal
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
HAVING COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) >= 10  -- Minimum sample size
ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC
LIMIT 15;


-- ============================================================================
-- SECTION 7: RESPONSE TIME TRENDS (Supply Chain Stress Indicator)
-- ============================================================================
-- Metrics: Current Avg Response Time, vs Prior 30d, Change %, Sample Size, Signal
-- Response Time = Days between RFQ created and VQ created
-- Window: Current 30d vs Prior 30d

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
),
prior_window AS (
  SELECT CURRENT_DATE - INTERVAL '60 days' as start_date,
         CURRENT_DATE - INTERVAL '30 days' as end_date
),
current_period AS (
  SELECT
    m.name as manufacturer,
    m.chuboe_mfr_id,
    AVG(EXTRACT(EPOCH FROM (vq.created - rfq.created)) / 86400) as avg_response_days,
    COUNT(DISTINCT vq.chuboe_vq_line_id) as sample_size
  FROM adempiere.chuboe_mfr m
  CROSS JOIN current_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
  GROUP BY m.name, m.chuboe_mfr_id
  HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10  -- Minimum sample size
),
prior_period AS (
  SELECT
    m.chuboe_mfr_id,
    AVG(EXTRACT(EPOCH FROM (vq.created - rfq.created)) / 86400) as avg_response_days
  FROM adempiere.chuboe_mfr m
  CROSS JOIN prior_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
  GROUP BY m.chuboe_mfr_id
  HAVING COUNT(DISTINCT vq.chuboe_vq_line_id) >= 10  -- Minimum sample size
)
SELECT
  cp.manufacturer,
  ROUND(cp.avg_response_days, 1) as current_avg_response_days,
  ROUND(pp.avg_response_days, 1) as prior_avg_response_days,
  ROUND(cp.avg_response_days - pp.avg_response_days, 1) as change_days,
  CASE
    WHEN pp.avg_response_days > 0
    THEN ROUND(((cp.avg_response_days - pp.avg_response_days) / pp.avg_response_days) * 100, 1)
    ELSE 0
  END as change_pct,
  cp.sample_size,
  CASE
    WHEN ((cp.avg_response_days - pp.avg_response_days) / NULLIF(pp.avg_response_days, 0)) > 0.20
    THEN '🔴 Response Time Increase (>20%)'
    ELSE ''
  END as signal
FROM current_period cp
JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
ORDER BY ((cp.avg_response_days - pp.avg_response_days) / NULLIF(pp.avg_response_days, 0)) DESC
LIMIT 10;


-- ============================================================================
-- SECTION 8: NEW ENTRANTS (Emerging Hotspots)
-- ============================================================================
-- Parts/manufacturers that weren't in top 20 last period but are trending now
-- Window: Current 30d vs Prior 30d

WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
),
prior_window AS (
  SELECT CURRENT_DATE - INTERVAL '60 days' as start_date,
         CURRENT_DATE - INTERVAL '30 days' as end_date
),
current_top AS (
  SELECT
    rfqm.chuboe_mpn as mpn,
    m.name as manufacturer,
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC) as rank
  FROM adempiere.chuboe_rfq_line_mpn rfqm
  CROSS JOIN current_window
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
  WHERE rfqm.isactive = 'Y'
    AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
  GROUP BY rfqm.chuboe_mpn, m.name, m.chuboe_mfr_id
),
prior_top AS (
  SELECT
    rfqm.chuboe_mpn as mpn,
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC) as rank
  FROM adempiere.chuboe_rfq_line_mpn rfqm
  CROSS JOIN prior_window
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
  WHERE rfqm.isactive = 'Y'
    AND rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
  GROUP BY rfqm.chuboe_mpn, m.chuboe_mfr_id
)
SELECT
  ct.mpn,
  ct.manufacturer,
  ct.rfq_count as current_rfqs,
  COALESCE(pt.rfq_count, 0) as prior_rfqs,
  ct.rank as current_rank,
  COALESCE(pt.rank, 999) as prior_rank,
  CASE
    WHEN pt.mpn IS NULL THEN 'New to Top 20'
    WHEN pt.rank > 20 THEN 'Jumped into Top 20'
    ELSE 'Rising'
  END as status
FROM current_top ct
LEFT JOIN prior_top pt ON ct.mpn = pt.mpn AND ct.chuboe_mfr_id = pt.chuboe_mfr_id
WHERE ct.rank <= 20
  AND (pt.mpn IS NULL OR pt.rank > 20)
ORDER BY ct.rank ASC
LIMIT 10;


-- ============================================================================
-- SECTION 1: TEMPERATURE GAUGE (Summary Metrics)
-- ============================================================================
-- Overall market status with constraint signal counts
-- Aggregates signals from other sections
-- NOTE: This query should be run AFTER the constraint indicator queries
--       to get accurate signal counts

-- This is a placeholder structure. The actual temperature gauge metrics
-- will be computed in JavaScript by:
-- 1. Running all constraint indicator queries
-- 2. Counting manufacturers/parts that trigger each signal
-- 3. Calculating overall market status based on total signal count

-- Signal count thresholds:
-- 0-1 signals = 🟢 Normal Market
-- 2-3 signals = 🟡 Heating Up
-- 4-5 signals = 🔴 Constrained
-- 6+ signals = 🔴 Critical

-- Temperature Gauge will show:
-- - Overall status (Normal/Heating Up/Constrained/Critical)
-- - Total active signal count
-- - Individual signal counts (conversion_drop, multi_customer_parts, velocity_spike, apac_concentration, response_time_increase)
-- - Key watch items (narrative summary)
