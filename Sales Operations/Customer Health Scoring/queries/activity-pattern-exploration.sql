-- Activity Pattern Exploration
-- Purpose: Understand healthy vs concerning activity patterns for customer health scoring
-- Date: 2026-06-26

-- ==============================================
-- 1. Customer Activity Summary (Last 6 Months)
-- ==============================================
-- Shows activity counts and conversion for recent customers

WITH recent_activity AS (
  SELECT
    bp.c_bpartner_id,
    bp.name as customer_name,

    -- RFQ activity
    COUNT(DISTINCT CASE WHEN rfq.created >= CURRENT_DATE - INTERVAL '6 months' THEN rfq.chuboe_rfq_id END) as rfq_count_6m,
    COUNT(DISTINCT CASE WHEN rfq.created >= CURRENT_DATE - INTERVAL '3 months' THEN rfq.chuboe_rfq_id END) as rfq_count_3m,
    COUNT(DISTINCT CASE WHEN rfq.created >= CURRENT_DATE - INTERVAL '1 month' THEN rfq.chuboe_rfq_id END) as rfq_count_1m,
    MAX(rfq.created) as last_rfq_date,

    -- CQ activity (quotes sent)
    COUNT(DISTINCT CASE WHEN cql.created >= CURRENT_DATE - INTERVAL '6 months' THEN cql.chuboe_cq_line_id END) as cq_count_6m,
    COUNT(DISTINCT CASE WHEN cql.created >= CURRENT_DATE - INTERVAL '3 months' THEN cql.chuboe_cq_line_id END) as cq_count_3m,
    MAX(cql.created) as last_cq_date,

    -- SO activity (orders won)
    COUNT(DISTINCT CASE WHEN so.created >= CURRENT_DATE - INTERVAL '6 months' THEN so.c_order_id END) as so_count_6m,
    COUNT(DISTINCT CASE WHEN so.created >= CURRENT_DATE - INTERVAL '3 months' THEN so.c_order_id END) as so_count_3m,
    MAX(so.created) as last_so_date,

    -- Revenue
    SUM(CASE WHEN so.created >= CURRENT_DATE - INTERVAL '6 months' THEN ol.linenetamt ELSE 0 END) as revenue_6m,
    SUM(CASE WHEN so.created >= CURRENT_DATE - INTERVAL '3 months' THEN ol.linenetamt ELSE 0 END) as revenue_3m

  FROM adempiere.c_bpartner bp
  LEFT JOIN adempiere.chuboe_rfq rfq ON bp.c_bpartner_id = rfq.c_bpartner_id AND rfq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_cq_line cql ON bp.c_bpartner_id = cql.c_bpartner_id AND cql.isactive = 'Y'
  LEFT JOIN adempiere.c_order so ON bp.c_bpartner_id = so.c_bpartner_id AND so.isactive = 'Y' AND so.issotrx = 'Y'
  LEFT JOIN adempiere.c_orderline ol ON so.c_order_id = ol.c_order_id AND ol.isactive = 'Y'

  WHERE bp.isactive = 'Y'
    AND bp.iscustomer = 'Y'
    AND bp.c_bpartner_id NOT IN (1000000, 1000001) -- Exclude Standard/default customers

  GROUP BY bp.c_bpartner_id, bp.name
)

SELECT
  customer_name,
  rfq_count_6m,
  cq_count_6m,
  so_count_6m,
  ROUND(revenue_6m::numeric, 0) as revenue_6m,

  -- Days since last activity
  CURRENT_DATE - last_rfq_date::date as days_since_rfq,
  CURRENT_DATE - last_cq_date::date as days_since_cq,
  CURRENT_DATE - last_so_date::date as days_since_so,

  -- Conversion rate (CQ to SO)
  CASE
    WHEN cq_count_6m > 0 THEN ROUND(100.0 * so_count_6m / cq_count_6m, 1)
    ELSE NULL
  END as conversion_pct

FROM recent_activity

WHERE rfq_count_6m > 0 OR cq_count_6m > 0 OR so_count_6m > 0 -- Active in last 6 months

ORDER BY revenue_6m DESC NULLS LAST

LIMIT 100;


-- ==============================================
-- 2. Activity Cadence Distribution
-- ==============================================
-- Shows how frequently customers engage with us

WITH customer_cadence AS (
  SELECT
    bp.c_bpartner_id,
    bp.name,

    -- RFQ cadence (days between RFQs)
    CASE
      WHEN COUNT(rfq.chuboe_rfq_id) >= 2 THEN
        (MAX(rfq.created)::date - MIN(rfq.created)::date)::float / NULLIF(COUNT(rfq.chuboe_rfq_id) - 1, 0)
      ELSE NULL
    END as avg_days_between_rfqs,

    COUNT(rfq.chuboe_rfq_id) as total_rfqs,
    COUNT(DISTINCT so.c_order_id) as total_orders

  FROM adempiere.c_bpartner bp
  LEFT JOIN adempiere.chuboe_rfq rfq ON bp.c_bpartner_id = rfq.c_bpartner_id
    AND rfq.isactive = 'Y'
    AND rfq.created >= CURRENT_DATE - INTERVAL '1 year'
  LEFT JOIN adempiere.c_order so ON bp.c_bpartner_id = so.c_bpartner_id
    AND so.isactive = 'Y'
    AND so.issotrx = 'Y'
    AND so.created >= CURRENT_DATE - INTERVAL '1 year'

  WHERE bp.isactive = 'Y'
    AND bp.iscustomer = 'Y'

  GROUP BY bp.c_bpartner_id, bp.name
)

SELECT
  CASE
    WHEN avg_days_between_rfqs IS NULL THEN '0. No RFQs'
    WHEN avg_days_between_rfqs < 7 THEN '1. Daily/Weekly'
    WHEN avg_days_between_rfqs < 30 THEN '2. Weekly/Monthly'
    WHEN avg_days_between_rfqs < 90 THEN '3. Monthly/Quarterly'
    ELSE '4. Quarterly+'
  END as rfq_cadence_bucket,

  COUNT(*) as customer_count,
  ROUND(AVG(avg_days_between_rfqs), 1) as avg_days_between_rfqs,
  ROUND(AVG(total_rfqs), 1) as avg_rfqs_per_year,
  ROUND(AVG(total_orders), 1) as avg_orders_per_year

FROM customer_cadence

GROUP BY
  CASE
    WHEN avg_days_between_rfqs IS NULL THEN '0. No RFQs'
    WHEN avg_days_between_rfqs < 7 THEN '1. Daily/Weekly'
    WHEN avg_days_between_rfqs < 30 THEN '2. Weekly/Monthly'
    WHEN avg_days_between_rfqs < 90 THEN '3. Monthly/Quarterly'
    ELSE '4. Quarterly+'
  END

ORDER BY rfq_cadence_bucket;


-- ==============================================
-- 3. Silence Period Analysis
-- ==============================================
-- How long do customers typically go silent before coming back?

WITH customer_gaps AS (
  SELECT
    bp.c_bpartner_id,
    bp.name,
    rfq.created as rfq_date,
    LAG(rfq.created) OVER (PARTITION BY bp.c_bpartner_id ORDER BY rfq.created) as prev_rfq_date,
    rfq.created::date - LAG(rfq.created)::date OVER (PARTITION BY bp.c_bpartner_id ORDER BY rfq.created) as days_gap

  FROM adempiere.c_bpartner bp
  JOIN adempiere.chuboe_rfq rfq ON bp.c_bpartner_id = rfq.c_bpartner_id
    AND rfq.isactive = 'Y'
    AND rfq.created >= CURRENT_DATE - INTERVAL '2 years'

  WHERE bp.isactive = 'Y'
    AND bp.iscustomer = 'Y'
)

SELECT
  CASE
    WHEN days_gap < 30 THEN '1. < 30 days'
    WHEN days_gap < 60 THEN '2. 30-60 days'
    WHEN days_gap < 90 THEN '3. 60-90 days'
    WHEN days_gap < 180 THEN '4. 90-180 days'
    ELSE '5. 180+ days'
  END as gap_bucket,

  COUNT(*) as occurrence_count,
  ROUND(AVG(days_gap), 1) as avg_days_gap,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_gap), 1) as median_days_gap

FROM customer_gaps

WHERE days_gap IS NOT NULL

GROUP BY
  CASE
    WHEN days_gap < 30 THEN '1. < 30 days'
    WHEN days_gap < 60 THEN '2. 30-60 days'
    WHEN days_gap < 90 THEN '3. 60-90 days'
    WHEN days_gap < 180 THEN '4. 90-180 days'
    ELSE '5. 180+ days'
  END

ORDER BY gap_bucket;


-- ==============================================
-- 4. Strategic Account Activity
-- ==============================================
-- Check activity for known strategic accounts

SELECT
  bp.name as customer_name,
  COUNT(DISTINCT CASE WHEN rfq.created >= CURRENT_DATE - INTERVAL '3 months' THEN rfq.chuboe_rfq_id END) as rfq_count_3m,
  COUNT(DISTINCT CASE WHEN cql.created >= CURRENT_DATE - INTERVAL '3 months' THEN cql.chuboe_cq_line_id END) as cq_count_3m,
  COUNT(DISTINCT CASE WHEN so.created >= CURRENT_DATE - INTERVAL '3 months' THEN so.c_order_id END) as so_count_3m,
  ROUND(SUM(CASE WHEN so.created >= CURRENT_DATE - INTERVAL '3 months' THEN ol.linenetamt ELSE 0 END)::numeric, 0) as revenue_3m,
  MAX(rfq.created)::date as last_rfq_date,
  MAX(so.created)::date as last_so_date

FROM adempiere.c_bpartner bp
LEFT JOIN adempiere.chuboe_rfq rfq ON bp.c_bpartner_id = rfq.c_bpartner_id AND rfq.isactive = 'Y'
LEFT JOIN adempiere.chuboe_cq_line cql ON bp.c_bpartner_id = cql.c_bpartner_id AND cql.isactive = 'Y'
LEFT JOIN adempiere.c_order so ON bp.c_bpartner_id = so.c_bpartner_id AND so.isactive = 'Y' AND so.issotrx = 'Y'
LEFT JOIN adempiere.c_orderline ol ON so.c_order_id = ol.c_order_id AND ol.isactive = 'Y'

WHERE bp.isactive = 'Y'
  AND bp.iscustomer = 'Y'
  AND (
    bp.name ILIKE '%Eaton%' OR
    bp.name ILIKE '%ABB%' OR
    bp.name ILIKE '%RTX%' OR
    bp.name ILIKE '%Raytheon%' OR
    bp.name ILIKE '%Thales%' OR
    bp.name ILIKE '%Parker%' OR
    bp.name ILIKE '%Meggitt%' OR
    bp.name ILIKE '%GE Healthcare%'
  )

GROUP BY bp.c_bpartner_id, bp.name

ORDER BY revenue_3m DESC NULLS LAST;
