-- VP Daily Brief - Additional Queries
-- Created: 2026-06-18
-- For: Josh Pucci (VP Sales)
--
-- Three new features added per June 4 feedback:
-- 1. New Customers Sold
-- 2. Late Shipments
-- 3. Inactive ISEs

-- ============================================================================
-- 1. NEW CUSTOMERS SOLD
-- ============================================================================
-- Purpose: Flag customers who placed their first order yesterday
-- Definition: SO created yesterday + no prior SOs in history
-- Output: Customer name, revenue, line count, ISE name

SELECT DISTINCT
  bp.name as customer_name,
  SUM(ol.linenetamt) as revenue,
  COUNT(ol.c_orderline_id) as line_count,
  u.name as ise_name,
  o.documentno as order_number,
  o.created::date as order_date
FROM adempiere.c_order o
JOIN adempiere.c_orderline ol
  ON o.c_order_id = ol.c_order_id
  AND ol.isactive = 'Y'
JOIN adempiere.c_bpartner bp
  ON o.c_bpartner_id = bp.c_bpartner_id
  AND bp.isactive = 'Y'
JOIN adempiere.ad_user u
  ON o.salesrep_id = u.ad_user_id
  AND u.isactive = 'Y'
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
  AND o.isactive = 'Y'
  -- Ensure this is their first order ever
  AND NOT EXISTS (
    SELECT 1
    FROM adempiere.c_order o2
    WHERE o2.c_bpartner_id = o.c_bpartner_id
      AND o2.created::date < o.created::date
      AND o2.isactive = 'Y'
  )
GROUP BY bp.name, u.name, o.documentno, o.created::date
ORDER BY revenue DESC;


-- ============================================================================
-- 2. LATE SHIPMENTS
-- ============================================================================
-- Purpose: Flag high-value orders that are overdue for shipment
-- Criteria:
--   - Promised date is 3+ days in the past
--   - Revenue >= $250,000
--   - Not yet shipped (no m_inout record)
-- Output: Customer, promised date, days late, revenue, ISE, order #

SELECT
  bp.name as customer_name,
  o.datepromised as promised_date,
  (CURRENT_DATE - o.datepromised::date) as days_late,
  SUM(ol.linenetamt) as revenue,
  u.name as ise_name,
  o.documentno as order_number,
  o.docstatus as order_status
FROM adempiere.c_order o
JOIN adempiere.c_orderline ol
  ON o.c_order_id = ol.c_order_id
  AND ol.isactive = 'Y'
JOIN adempiere.c_bpartner bp
  ON o.c_bpartner_id = bp.c_bpartner_id
  AND bp.isactive = 'Y'
JOIN adempiere.ad_user u
  ON o.salesrep_id = u.ad_user_id
  AND u.isactive = 'Y'
-- Check if order has NOT been shipped
LEFT JOIN adempiere.m_inout ship
  ON o.c_order_id = ship.c_order_id
  AND ship.isactive = 'Y'
  AND ship.docstatus IN ('CO', 'CL')  -- Completed or Closed
WHERE o.datepromised IS NOT NULL
  AND o.datepromised < CURRENT_DATE - INTERVAL '3 days'
  AND ship.m_inout_id IS NULL  -- Not yet shipped
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'  -- Sales order (not purchase order)
  AND o.docstatus IN ('CO', 'CL')  -- Completed or Closed status
GROUP BY bp.name, o.datepromised, u.name, o.documentno, o.docstatus
HAVING SUM(ol.linenetamt) >= 250000
ORDER BY days_late DESC, revenue DESC;


-- ============================================================================
-- 3. INACTIVE ISEs
-- ============================================================================
-- Purpose: Flag sellers who haven't loaded RFQs or CQs in 3+ days
-- Definition: No chuboe_rfq_line OR chuboe_cq_line created in last 3 days
-- Output: ISE name, region, last activity date, days inactive

-- Known active seller IDs from sales-pulse-comprehensive.js
WITH seller_list AS (
  SELECT ad_user_id, name
  FROM adempiere.ad_user
  WHERE ad_user_id IN (
    -- USA
    1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017,
    -- MEX
    1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224,
    -- APAC-Laurel
    1041139, 1023803, 1016958,
    -- APAC-Kris
    1039414, 1009866, 1013042, 1009528, 1009478, 1009210,
    -- APAC-Lavanya
    1024444, 1023478, 1017011
  )
  AND isactive = 'Y'
),
recent_rfq_activity AS (
  SELECT
    salesrep_id,
    MAX(created) as last_rfq_date
  FROM adempiere.chuboe_rfq
  WHERE created >= CURRENT_DATE - INTERVAL '3 days'
    AND isactive = 'Y'
  GROUP BY salesrep_id
),
recent_cq_activity AS (
  SELECT
    rfq.salesrep_id,
    MAX(cq.created) as last_cq_date
  FROM adempiere.chuboe_cq_line cq
  JOIN adempiere.chuboe_rfq rfq
    ON cq.chuboe_rfq_id = rfq.chuboe_rfq_id
    AND rfq.isactive = 'Y'
  WHERE cq.created >= CURRENT_DATE - INTERVAL '3 days'
    AND cq.isactive = 'Y'
  GROUP BY rfq.salesrep_id
),
combined_activity AS (
  SELECT
    COALESCE(rfq.salesrep_id, cq.salesrep_id) as salesrep_id,
    GREATEST(
      COALESCE(rfq.last_rfq_date, '1900-01-01'::timestamp),
      COALESCE(cq.last_cq_date, '1900-01-01'::timestamp)
    ) as last_activity_date
  FROM recent_rfq_activity rfq
  FULL OUTER JOIN recent_cq_activity cq
    ON rfq.salesrep_id = cq.salesrep_id
)
SELECT
  sl.name as ise_name,
  sl.ad_user_id,
  CASE
    WHEN sl.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN sl.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN sl.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN sl.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Kris'
    WHEN sl.ad_user_id IN (1024444, 1023478, 1017011) THEN 'APAC-Lavanya'
  END as region,
  COALESCE(ca.last_activity_date, CURRENT_DATE - INTERVAL '30 days') as last_activity_date,
  COALESCE(
    CURRENT_DATE::date - ca.last_activity_date::date,
    30
  ) as days_inactive
FROM seller_list sl
LEFT JOIN combined_activity ca
  ON sl.ad_user_id = ca.salesrep_id
WHERE COALESCE(
    CURRENT_DATE::date - ca.last_activity_date::date,
    30
  ) >= 3
ORDER BY days_inactive DESC, region, ise_name;
