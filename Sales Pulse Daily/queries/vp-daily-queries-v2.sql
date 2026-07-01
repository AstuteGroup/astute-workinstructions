-- VP Daily Brief - Queries V2 (Restructured per Josh feedback)
-- Created: 2026-06-18
-- Updated: 2026-06-19 - Added weekend-aware business day logic
-- Structure: Section 1 (Wins) → Section 2 (Needs Attention) → Section 3 (Regional Activity)

-- BUSINESS DAY LOGIC:
-- All queries use "last business day" instead of literal "yesterday"
-- - If Monday: report_date = Friday (3 days ago)
-- - Otherwise: report_date = yesterday (1 day ago)
-- This ensures Monday reports show Friday's data, not Sunday's

-- ============================================================================
-- SECTION 1: YESTERDAY'S TOP WINS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 TOP 15 ORDERS WON (by revenue)
-- ----------------------------------------------------------------------------
-- Fields: Seller name, Region, Customer name, Revenue, Part number (MPN)
-- OPTIMIZED: Use grandtotal from c_order instead of aggregating c_orderline
-- Display: Top 5 visible, next 10 collapsible

WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
),
order_parts AS (
  SELECT
    ol.c_order_id,
    STRING_AGG(DISTINCT ol.chuboe_mpn, ', ' ORDER BY ol.chuboe_mpn) as part_numbers
  FROM adempiere.c_orderline ol
  WHERE ol.isactive = 'Y'
    AND ol.chuboe_mpn IS NOT NULL
  GROUP BY ol.c_order_id
)
SELECT
  u.name as seller_name,
  CASE
    WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  bp.name as customer_name,
  o.documentno as order_number,
  o.grandtotal as revenue,
  (SELECT COALESCE(SUM(bi.s_order_line_gp), 0)
   FROM adempiere.bi_order_line_v bi
   WHERE bi.order_id = o.c_order_id) as gp,
  COALESCE(op.part_numbers, 'N/A') as part_numbers
FROM adempiere.c_order o
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
LEFT JOIN order_parts op ON o.c_order_id = op.c_order_id
CROSS JOIN business_day
WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
ORDER BY o.grandtotal DESC
LIMIT 15;


-- ----------------------------------------------------------------------------
-- 1.2 NEW CUSTOMERS SOLD (first-time orders)
-- ----------------------------------------------------------------------------
-- Fields: Seller, Region, Customer, Revenue, MPN, MFR, QTY,
--         Customer Location/Address, Contact Name, Promise Date

WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
)
SELECT
  u.name as seller_name,
  CASE
    WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  bp.name as customer_name,
  bp.c_bpartner_id,
  o.documentno as order_number,
  o.grandtotal as total_revenue,
  (SELECT COALESCE(SUM(bi.s_order_line_gp), 0)
   FROM adempiere.bi_order_line_v bi
   WHERE bi.order_id = o.c_order_id) as total_gp,
  (SELECT STRING_AGG(DISTINCT ol.chuboe_mpn, ', ' ORDER BY ol.chuboe_mpn)
   FROM adempiere.c_orderline ol
   WHERE ol.c_order_id = o.c_order_id
     AND ol.isactive = 'Y'
     AND ol.chuboe_mpn IS NOT NULL) as mpns,
  (SELECT STRING_AGG(DISTINCT mfr.name, ', ' ORDER BY mfr.name)
   FROM adempiere.c_orderline ol
   LEFT JOIN adempiere.chuboe_mfr mfr ON ol.chuboe_mfr_id = mfr.chuboe_mfr_id AND mfr.isactive = 'Y'
   WHERE ol.c_order_id = o.c_order_id
     AND ol.isactive = 'Y'
     AND mfr.name IS NOT NULL) as mfr_names,
  (SELECT COALESCE(SUM(ol.qtyordered), 0)
   FROM adempiere.c_orderline ol
   WHERE ol.c_order_id = o.c_order_id
     AND ol.isactive = 'Y') as total_qty,
  loc.address1 || COALESCE(', ' || loc.address2, '') || ', ' ||
    loc.city || ', ' || COALESCE(loc.regionname, '') || ' ' ||
    COALESCE(loc.postal, '') || ', ' || c.name as customer_location,
  contact.name as contact_name,
  o.datepromised::date as promise_date
FROM adempiere.c_order o
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
LEFT JOIN adempiere.c_bpartner_location bploc ON o.c_bpartner_location_id = bploc.c_bpartner_location_id AND bploc.isactive = 'Y'
LEFT JOIN adempiere.c_location loc ON bploc.c_location_id = loc.c_location_id
LEFT JOIN adempiere.c_country c ON loc.c_country_id = c.c_country_id
LEFT JOIN adempiere.ad_user contact ON o.ad_user_id = contact.ad_user_id AND contact.isactive = 'Y'
CROSS JOIN business_day
WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
  -- Ensure this is their first order ever
  AND NOT EXISTS (
    SELECT 1 FROM adempiere.c_order o2
    WHERE o2.c_bpartner_id = o.c_bpartner_id
      AND o2.created::date < o.created::date
      AND o2.isactive = 'Y'
  )
ORDER BY total_revenue DESC;


-- ----------------------------------------------------------------------------
-- 1.3 GLOBAL STRATEGIC ACCOUNTS ACTIVITY
-- ----------------------------------------------------------------------------
-- Accounts: ABB, Eaton, GE Healthcare (GE Medical/Healthcare), Parker-Meggitt, RTX, Thales
-- Show: RFQs, CQs, CQ Sold, SOs created with ISE and Region

WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
),
strategic_accounts AS (
  SELECT
    c_bpartner_id,
    name,
    -- Map to parent company for rollup
    CASE
      WHEN UPPER(name) LIKE '%ABB%' AND UPPER(name) NOT LIKE '%ABBOTT%' THEN 'ABB'
      WHEN UPPER(name) LIKE '%EATON%' THEN 'Eaton'
      WHEN UPPER(name) LIKE '%GE HEALTHCARE%' OR UPPER(name) LIKE '%GE MEDICAL%' THEN 'GE Healthcare'
      WHEN UPPER(name) LIKE '%PARKER%' OR UPPER(name) LIKE '%MEGGITT%' THEN 'Parker-Meggitt'
      WHEN UPPER(name) LIKE '%RTX%' OR UPPER(name) LIKE '%RAYTHEON%' THEN 'RTX'
      WHEN UPPER(name) LIKE '%THALES%' THEN 'Thales'
    END as parent_company
  FROM adempiere.c_bpartner
  WHERE isactive = 'Y'
    AND (
      (UPPER(name) LIKE '%ABB%' AND UPPER(name) NOT LIKE '%ABBOTT%')
      OR UPPER(name) LIKE '%EATON%'
      OR UPPER(name) LIKE '%GE HEALTHCARE%'
      OR UPPER(name) LIKE '%GE MEDICAL%'
      OR UPPER(name) LIKE '%PARKER%'
      OR UPPER(name) LIKE '%MEGGITT%'
      OR UPPER(name) LIKE '%RTX%'
      OR UPPER(name) LIKE '%RAYTHEON%'
      OR UPPER(name) LIKE '%THALES%'
    )
),
rfq_activity AS (
  SELECT
    sa.name as account_name,
    u.name as ise_name,
    CASE
      WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
      ELSE 'Other'
    END as region,
    COUNT(DISTINCT r.chuboe_rfq_id) as rfq_count,
    COUNT(DISTINCT rl.chuboe_rfq_line_id) as rfq_line_count
  FROM strategic_accounts sa
  JOIN adempiere.chuboe_rfq r ON sa.c_bpartner_id = r.c_bpartner_id
  JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id
  JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
  WHERE r.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
    AND r.isactive = 'Y'
    AND rl.isactive = 'Y'
    AND u.isactive = 'Y'
  GROUP BY sa.name, u.name, u.ad_user_id
),
cq_activity AS (
  SELECT
    sa.name as account_name,
    u.name as ise_name,
    CASE
      WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
      ELSE 'Other'
    END as region,
    COUNT(*) as cq_count,
    COUNT(CASE WHEN cq.issold = 'Y' THEN 1 END) as cq_sold_count
  FROM strategic_accounts sa
  JOIN adempiere.chuboe_rfq r ON sa.c_bpartner_id = r.c_bpartner_id
  JOIN adempiere.chuboe_cq_line cq ON r.chuboe_rfq_id = cq.chuboe_rfq_id
  JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
  WHERE cq.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
    AND cq.isactive = 'Y'
    AND r.isactive = 'Y'
    AND u.isactive = 'Y'
  GROUP BY sa.name, u.name, u.ad_user_id
),
so_activity AS (
  SELECT
    sa.name as account_name,
    u.name as ise_name,
    CASE
      WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
      ELSE 'Other'
    END as region,
    COUNT(DISTINCT o.c_order_id) as so_count,
    SUM(o.grandtotal) as so_revenue,
    COALESCE(SUM(bi.s_order_line_gp), 0) as so_gp
  FROM strategic_accounts sa
  JOIN adempiere.c_order o ON sa.c_bpartner_id = o.c_bpartner_id
  JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id
  LEFT JOIN adempiere.bi_order_line_v bi ON o.c_order_id = bi.order_id
  WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
    AND o.isactive = 'Y'
    AND o.issotrx = 'Y'
    AND u.isactive = 'Y'
  GROUP BY sa.name, u.name, u.ad_user_id
),
all_activity_detailed AS (
  -- Activity with specific account details (for accounts WITH activity)
  SELECT
    sa.parent_company,
    sa.name as account_name,
    COALESCE(rfq.ise_name, cq.ise_name, so.ise_name) as ise_name,
    COALESCE(rfq.region, cq.region, so.region) as region,
    COALESCE(rfq.rfq_line_count, 0) as rfq_lines,
    COALESCE(cq.cq_count, 0) as cq_lines,
    COALESCE(cq.cq_sold_count, 0) as cq_sold,
    COALESCE(so.so_count, 0) as so_count,
    COALESCE(so.so_revenue, 0) as so_revenue,
    COALESCE(so.so_gp, 0) as so_gp
  FROM strategic_accounts sa
  LEFT JOIN rfq_activity rfq ON sa.name = rfq.account_name
  LEFT JOIN cq_activity cq ON sa.name = cq.account_name AND COALESCE(rfq.ise_name, cq.ise_name) = cq.ise_name
  LEFT JOIN so_activity so ON sa.name = so.account_name AND COALESCE(rfq.ise_name, cq.ise_name, so.ise_name) = so.ise_name
  WHERE COALESCE(rfq.rfq_line_count, 0) > 0
     OR COALESCE(cq.cq_count, 0) > 0
     OR COALESCE(so.so_count, 0) > 0
),
parent_totals AS (
  -- Total activity per parent company
  SELECT
    parent_company,
    SUM(rfq_lines) as total_rfq,
    SUM(cq_lines) as total_cq,
    SUM(so_count) as total_so
  FROM all_activity_detailed
  GROUP BY parent_company
),
all_parents AS (
  -- List of all parent companies
  SELECT DISTINCT parent_company FROM strategic_accounts
)
-- Combine: show detailed rows for active accounts, or parent rollup for inactive
SELECT
  COALESCE(ad.account_name, ap.parent_company) as account_name,
  ad.ise_name,
  ad.region,
  COALESCE(ad.rfq_lines, 0) as rfq_lines,
  COALESCE(ad.cq_lines, 0) as cq_lines,
  COALESCE(ad.cq_sold, 0) as cq_sold,
  COALESCE(ad.so_count, 0) as so_count,
  COALESCE(ad.so_revenue, 0) as so_revenue,
  COALESCE(ad.so_gp, 0) as so_gp,
  CASE
    WHEN pt.total_rfq IS NULL AND pt.total_cq IS NULL AND pt.total_so IS NULL
    THEN 'red'
    ELSE 'normal'
  END as color_code
FROM all_parents ap
LEFT JOIN parent_totals pt ON ap.parent_company = pt.parent_company
LEFT JOIN all_activity_detailed ad ON ap.parent_company = ad.parent_company
WHERE ad.account_name IS NOT NULL
   OR (pt.total_rfq IS NULL AND pt.total_cq IS NULL AND pt.total_so IS NULL)
ORDER BY account_name, ise_name;


-- ----------------------------------------------------------------------------
-- 1.4 CUSTOMERS REACTIVATED YESTERDAY
-- ----------------------------------------------------------------------------
-- Hybrid approach: Location-level for OEMs, Customer-level for others
-- 30-day minimum threshold + Statistical anomaly detection
-- Strong filtering: only truly noteworthy reactivations

WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
),
-- Exclude brokers, distributors, traders, and non-OEM/EMS customers
excluded_customers AS (
  SELECT DISTINCT c_bpartner_id
  FROM adempiere.c_bpartner
  WHERE isactive = 'Y'
    AND (
      -- Brokers and traders
      UPPER(name) LIKE '%BROKER%' OR
      UPPER(name) LIKE '%TRADING%' OR
      UPPER(name) LIKE '%TRADER%' OR
      -- Distributors
      UPPER(name) LIKE '%DISTRIBUTION%' OR
      UPPER(name) LIKE '%DISTRIBUTOR%' OR
      -- Surplus/Excess dealers
      UPPER(name) LIKE '%SURPLUS%' OR
      UPPER(name) LIKE '%EXCESS%' OR
      -- Specific brokers to exclude
      UPPER(name) LIKE '%A2 GLOBAL%' OR
      UPPER(name) LIKE '%SOURCEABILITY%' OR
      -- Generic suppliers (not OEM/EMS)
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
    STRING_AGG(DISTINCT o.documentno, ', ' ORDER BY o.documentno) as order_numbers,
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
         AND o2.created::date = (SELECT report_date FROM business_day)
         AND o2.isactive = 'Y' AND o2.issotrx = 'Y'
     )), 0) as yesterday_gp,
    (ARRAY_AGG(u.name ORDER BY o.grandtotal DESC))[1] as seller_name,
    (ARRAY_AGG(u.ad_user_id ORDER BY o.grandtotal DESC))[1] as seller_id
  FROM adempiere.c_order o
  JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
  LEFT JOIN adempiere.c_bpartner_location bploc ON o.c_bpartner_location_id = bploc.c_bpartner_location_id AND bploc.isactive = 'Y'
  LEFT JOIN adempiere.c_location loc ON bploc.c_location_id = loc.c_location_id
  LEFT JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
  WHERE o.created::date = (SELECT report_date FROM business_day)
    AND o.isactive = 'Y' AND o.issotrx = 'Y'
    AND bp.c_bpartner_id NOT IN (SELECT c_bpartner_id FROM excluded_customers)
    -- Exclude Jake Harris (different role)
    AND u.ad_user_id != 1000004
    -- Only include component sales (order lines with linked CQ line)
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
  CROSS JOIN business_day
  WHERE o.created::date < (SELECT report_date FROM business_day)
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
  WHERE gap_days IS NOT NULL AND gap_days > 0
  GROUP BY tracking_key
)
SELECT
  yo.customer_name,
  yo.ship_to_city as facility_location,
  'Y' as tracked_at_location_level,
  lopk.first_order_date,
  lopk.last_order_date,
  CURRENT_DATE - lopk.last_order_date as days_gap,
  yo.order_numbers as yesterday_orders,
  yo.yesterday_revenue,
  yo.yesterday_gp,
  yo.seller_name,
  CASE
    WHEN yo.seller_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN yo.seller_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN yo.seller_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN yo.seller_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Kris'
    ELSE 'Other'
  END as region,
  lopk.lifetime_orders,
  lopk.lifetime_revenue,
  COALESCE(og.median_gap, 0) as typical_cycle_days,
  CASE
    WHEN og.median_gap > 0 THEN ROUND((CURRENT_DATE - lopk.last_order_date)::numeric / NULLIF(og.median_gap::numeric, 0), 2)
    ELSE 0
  END as gap_multiplier,
  -- Reactivation type
  CASE
    WHEN yo.yesterday_revenue >= 100000 AND CURRENT_DATE - lopk.last_order_date >= 90 THEN 'high_value_long'
    WHEN og.median_gap > 0 AND (CURRENT_DATE - lopk.last_order_date) > og.median_gap * 3.0 AND CURRENT_DATE - lopk.last_order_date >= 30 THEN 'anomalous_pattern'
    WHEN lopk.lifetime_orders < 10 AND CURRENT_DATE - lopk.last_order_date >= 120 THEN 'small_customer_long'
    WHEN CURRENT_DATE - lopk.last_order_date >= 180 THEN 'dormant_long'
    ELSE 'other'
  END as reactivation_type,
  -- Significance score (higher = more noteworthy)
  CASE
    WHEN yo.yesterday_revenue >= 100000 AND CURRENT_DATE - lopk.last_order_date >= 90 THEN
      (CURRENT_DATE - lopk.last_order_date) * LN(yo.yesterday_revenue + 1) * 2.0
    WHEN og.median_gap > 0 AND (CURRENT_DATE - lopk.last_order_date) > og.median_gap * 3.0 THEN
      ((CURRENT_DATE - lopk.last_order_date)::numeric / NULLIF(og.median_gap, 0)) * LN(yo.yesterday_revenue + 1) * 10
    WHEN CURRENT_DATE - lopk.last_order_date >= 180 THEN
      (CURRENT_DATE - lopk.last_order_date) * LN(yo.yesterday_revenue + 1)
    ELSE (CURRENT_DATE - lopk.last_order_date) * LN(yo.yesterday_revenue + 1) * 0.5
  END as significance_score
FROM yesterday_orders yo
JOIN last_order_per_key lopk ON yo.tracking_key = lopk.tracking_key
LEFT JOIN order_gaps og ON yo.tracking_key = og.tracking_key
WHERE CURRENT_DATE - lopk.last_order_date >= 30
ORDER BY days_gap DESC
LIMIT 5;


-- ============================================================================
-- SECTION 2: NEEDS ATTENTION
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2.1 LATE SHIPMENTS (3+ days past promise date)
-- ----------------------------------------------------------------------------
-- Criteria: $200K+ revenue OR strategic account OR new customer first order
-- Fields: Customer, SO#, ISE, Region, Revenue, Part #s, Promise Date,
--         In Stock Y/N, Days Late
-- Color: Yellow 3-5 days, Red 5+ days
-- Show ALL lines (no limit)

WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
),
strategic_accounts AS (
  SELECT c_bpartner_id
  FROM adempiere.c_bpartner
  WHERE isactive = 'Y'
    AND (
      UPPER(name) LIKE '%ABB%'
      OR UPPER(name) LIKE '%EATON%'
      OR UPPER(name) LIKE '%GE HEALTHCARE%'
      OR UPPER(name) LIKE '%GE MEDICAL%'
      OR UPPER(name) LIKE '%PARKER%MEGGITT%'
      OR UPPER(name) LIKE '%MEGGITT%'
      OR UPPER(name) LIKE '%RTX%'
      OR UPPER(name) LIKE '%RAYTHEON%'
      OR UPPER(name) LIKE '%THALES%'
    )
),
new_customers AS (
  SELECT DISTINCT o.c_bpartner_id
  FROM adempiere.c_order o
  WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
    AND o.isactive = 'Y'
    AND NOT EXISTS (
      SELECT 1 FROM adempiere.c_order o2
      WHERE o2.c_bpartner_id = o.c_bpartner_id
        AND o2.created::date < o.created::date
        AND o2.isactive = 'Y'
    )
)
SELECT
  bp.name as customer_name,
  o.documentno as sales_order,
  u.name as ise_name,
  CASE
    WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  o.grandtotal as total_revenue,
  '' as part_numbers,  -- Temporarily removed for performance
  o.datepromised::date as promise_date,
  'N/A' as in_stock,
  (CURRENT_DATE - o.datepromised::date) as days_late,
  CASE
    WHEN (CURRENT_DATE - o.datepromised::date) >= 5 THEN 'red'
    WHEN (CURRENT_DATE - o.datepromised::date) >= 3 THEN 'yellow'
  END as color_code
FROM adempiere.c_order o
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
LEFT JOIN adempiere.m_inout ship
  ON o.c_order_id = ship.c_order_id
  AND ship.isactive = 'Y'
  AND ship.docstatus IN ('CO', 'CL')
CROSS JOIN business_day
WHERE o.datepromised IS NOT NULL
  AND o.datepromised < CURRENT_DATE - INTERVAL '3 days'
  AND ship.m_inout_id IS NULL  -- Not yet shipped
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
  AND o.docstatus IN ('CO', 'CL')
  AND (
    -- High value (using grandtotal instead of aggregating order lines)
    o.grandtotal >= 200000
    -- OR Strategic account
    OR EXISTS (SELECT 1 FROM strategic_accounts sa WHERE sa.c_bpartner_id = o.c_bpartner_id)
    -- OR New customer
    OR EXISTS (SELECT 1 FROM new_customers nc WHERE nc.c_bpartner_id = o.c_bpartner_id)
  )
ORDER BY days_late DESC, total_revenue DESC;


-- ----------------------------------------------------------------------------
-- 2.2A HIGH VALUE LATE SO LINES ($200K+ Revenue, 3-31 days past due)
-- ----------------------------------------------------------------------------
-- Shows ALL high-value lines that are currently past due (rolling 31-day window)
-- ISEs should be updating promise dates, so old items indicate stale data
-- Color coding: Yellow 3-7 days, Red 8+ days

SELECT
  bp.name as customer_name,
  o.documentno as sales_order,
  ol.line as line_number,
  u.name as ise_name,
  CASE
    WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  ol.datepromised::date as promise_date,
  CURRENT_DATE - ol.datepromised::date as days_late,
  ol.qtyordered - COALESCE(SUM(iol.movementqty), 0) as qty_unshipped,
  ROUND(((ol.qtyordered - COALESCE(SUM(iol.movementqty), 0)) / NULLIF(ol.qtyordered, 0)) * ol.linenetamt, 2) as line_revenue,
  (SELECT COALESCE(ROUND(bi.s_order_line_gp * ((ol.qtyordered - COALESCE(SUM(iol.movementqty), 0)) / NULLIF(ol.qtyordered, 0)), 2), 0)
   FROM adempiere.bi_order_line_v bi
   WHERE bi.order_line_id = ol.c_orderline_id) as line_gp,
  ol.chuboe_mpn as mpn,
  CASE
    WHEN CURRENT_DATE - ol.datepromised::date >= 8 THEN 'red'
    WHEN CURRENT_DATE - ol.datepromised::date >= 3 THEN 'yellow'
  END as color_code
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
LEFT JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
LEFT JOIN adempiere.m_inoutline iol ON ol.c_orderline_id = iol.c_orderline_id
  AND iol.isactive = 'Y'
LEFT JOIN adempiere.m_inout io ON iol.m_inout_id = io.m_inout_id
  AND io.isactive = 'Y'
  AND io.docstatus IN ('CO', 'CL')
WHERE ol.isactive = 'Y'
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
  AND ol.qtyordered > 0
  AND ol.datepromised IS NOT NULL
  AND ol.datepromised >= CURRENT_DATE - INTERVAL '31 days'  -- Rolling 31-day window
  AND ol.datepromised <= CURRENT_DATE - INTERVAL '3 days'   -- At least 3 days late
  AND ol.linenetamt >= 200000  -- High value lines only
GROUP BY ol.c_orderline_id, ol.c_order_id, o.documentno, bp.name, ol.line, ol.qtyordered, ol.datepromised, ol.linenetamt, ol.chuboe_mpn, u.name, u.ad_user_id
HAVING ol.qtyordered > COALESCE(SUM(iol.movementqty), 0)  -- Has unshipped quantity
ORDER BY ol.linenetamt DESC;


-- ----------------------------------------------------------------------------
-- 2.2B TOP 15 SCHEDULED TO SHIP THIS MONTH (by GP)
-- ----------------------------------------------------------------------------
-- Shows top 15 lines by GP scheduled to ship in current month (backlog view)
-- Display: Top 5 visible, next 10 collapsible
-- Promise date can be past due, today, or future - as long as it's in current month
-- Purpose: Backlog that needs to ship by end of month to meet sales goals
-- Color coding: Red if past due, Yellow if due this week, Green if future

SELECT
  bp.name as customer_name,
  o.documentno as sales_order,
  ol.line as line_number,
  u.name as ise_name,
  CASE
    WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  ol.datepromised::date as promise_date,
  ol.datepromised::date - CURRENT_DATE as days_until_promise,
  ol.qtyordered - COALESCE(SUM(iol.movementqty), 0) as qty_unshipped,
  ROUND(((ol.qtyordered - COALESCE(SUM(iol.movementqty), 0)) / NULLIF(ol.qtyordered, 0)) * ol.linenetamt, 2) as line_revenue,
  (SELECT COALESCE(ROUND(bi.s_order_line_gp * ((ol.qtyordered - COALESCE(SUM(iol.movementqty), 0)) / NULLIF(ol.qtyordered, 0)), 2), 0)
   FROM adempiere.bi_order_line_v bi
   WHERE bi.order_line_id = ol.c_orderline_id) as line_gp,
  ol.chuboe_mpn as mpn,
  -- TODO: Stock check - m_storage table not found in database
  -- Currently defaults to 'N' - needs proper inventory table identification
  'N' as in_stock,
  -- Action status based on due date only (until inventory data is available)
  -- Red = past due (urgent), Yellow = due this week (attention), Green = future (OK)
  CASE
    WHEN ol.datepromised::date < CURRENT_DATE
    THEN 'red'  -- Past due = URGENT
    WHEN ol.datepromised::date <= CURRENT_DATE + INTERVAL '7 days'
    THEN 'yellow'  -- Due soon = ATTENTION
    ELSE 'green'  -- Future = OK
  END as action_status,
  CASE
    WHEN ol.datepromised::date < CURRENT_DATE THEN 'red'  -- Past due
    WHEN ol.datepromised::date <= CURRENT_DATE + INTERVAL '7 days' THEN 'yellow'  -- Due this week
    ELSE 'green'  -- Future
  END as color_code
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
LEFT JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
LEFT JOIN adempiere.m_inoutline iol ON ol.c_orderline_id = iol.c_orderline_id
  AND iol.isactive = 'Y'
LEFT JOIN adempiere.m_inout io ON iol.m_inout_id = io.m_inout_id
  AND io.isactive = 'Y'
  AND io.docstatus IN ('CO', 'CL')
WHERE ol.isactive = 'Y'
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
  AND ol.qtyordered > 0
  AND ol.datepromised IS NOT NULL
  AND ol.datepromised >= DATE_TRUNC('month', CURRENT_DATE)  -- Start of current month
  AND ol.datepromised < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'  -- End of current month
GROUP BY ol.c_orderline_id, ol.c_order_id, o.documentno, bp.name, ol.line, ol.qtyordered, ol.datepromised, ol.linenetamt, ol.chuboe_mpn, u.name, u.ad_user_id
HAVING ol.qtyordered > COALESCE(SUM(iol.movementqty), 0)  -- Has unshipped quantity
ORDER BY (SELECT COALESCE(ROUND(bi.s_order_line_gp * ((ol.qtyordered - COALESCE(SUM(iol.movementqty), 0)) / NULLIF(ol.qtyordered, 0)), 2), 0)
   FROM adempiere.bi_order_line_v bi
   WHERE bi.order_line_id = ol.c_orderline_id) DESC  -- Order by GP, highest first
LIMIT 15;


-- ----------------------------------------------------------------------------
-- 2.3 INSIDE SALES REPS ALERT (No RFQ in 3+ days)
-- ----------------------------------------------------------------------------
-- Fields: ISE, Manager, Region, Last RFQ Date, Days Inactive (BUSINESS DAYS only)
-- Color: Yellow 3-6 days, Red 7+ days

WITH seller_list AS (
  SELECT
    ad_user_id,
    name,
    CASE
      WHEN ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    END as region,
    CASE
      WHEN ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'Jeff Wallace'
      WHEN ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'Joel Marquez'
      WHEN ad_user_id IN (1041139, 1023803, 1016958) THEN 'Laurel Kee'
      WHEN ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'Silvia Munoz'
    END as manager
  FROM adempiere.ad_user
  WHERE ad_user_id IN (
    1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017,
    1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224,
    1041139, 1023803, 1016958,
    1039414, 1009866, 1013042, 1009528, 1009478, 1009210
  )
  AND isactive = 'Y'
),
recent_rfq_activity AS (
  SELECT
    salesrep_id,
    MAX(created) as last_rfq_date
  FROM adempiere.chuboe_rfq
  WHERE created >= CURRENT_DATE - INTERVAL '30 days'
    AND isactive = 'Y'
  GROUP BY salesrep_id
)
SELECT
  sl.name as ise_name,
  sl.manager,
  sl.region,
  COALESCE(ra.last_rfq_date::date, (CURRENT_DATE - INTERVAL '30 days')::date) as last_rfq_date,
  -- Calculate business days only (Mon-Fri, excluding weekends)
  COALESCE(
    (SELECT COUNT(*)
     FROM generate_series(ra.last_rfq_date::date + 1, CURRENT_DATE, '1 day'::interval) d
     WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5),
    30
  ) as days_inactive,
  CASE
    WHEN COALESCE(
      (SELECT COUNT(*)
       FROM generate_series(ra.last_rfq_date::date + 1, CURRENT_DATE, '1 day'::interval) d
       WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5),
      30
    ) >= 7 THEN 'red'
    WHEN COALESCE(
      (SELECT COUNT(*)
       FROM generate_series(ra.last_rfq_date::date + 1, CURRENT_DATE, '1 day'::interval) d
       WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5),
      30
    ) >= 3 THEN 'yellow'
  END as color_code
FROM seller_list sl
LEFT JOIN recent_rfq_activity ra ON sl.ad_user_id = ra.salesrep_id
WHERE COALESCE(
  (SELECT COUNT(*)
   FROM generate_series(ra.last_rfq_date::date + 1, CURRENT_DATE, '1 day'::interval) d
   WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5),
  30
) >= 3
ORDER BY days_inactive DESC, sl.region, sl.name;


-- ----------------------------------------------------------------------------
-- 2.4 LOW MARGIN ORDERS TRAIL (<18% GM)
-- ----------------------------------------------------------------------------
-- All order details for orders booked yesterday under 18% margin

WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
)
SELECT
  bp.name as customer_name,
  o.documentno as sales_order,
  u.name as ise_name,
  CASE
    WHEN u.ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN u.ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN u.ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN u.ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  SUM(ol.linenetamt) as revenue,
  SUM(ol.linenetamt - (ol.qtyordered * COALESCE(ol.pricecost, 0))) as gross_profit,
  CASE
    WHEN SUM(ol.linenetamt) > 0
    THEN ((SUM(ol.linenetamt - (ol.qtyordered * COALESCE(ol.pricecost, 0))) / SUM(ol.linenetamt)) * 100)
    ELSE 0
  END as gm_percent,
  '' as part_numbers,  -- Temporarily removed for performance
  o.datepromised::date as promise_date
FROM adempiere.c_order o
JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id AND ol.isactive = 'Y'
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
CROSS JOIN business_day
WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
GROUP BY bp.name, o.documentno, u.name, u.ad_user_id, o.datepromised
HAVING CASE
  WHEN SUM(ol.linenetamt) > 0
  THEN ((SUM(ol.linenetamt - (ol.qtyordered * COALESCE(ol.pricecost, 0))) / SUM(ol.linenetamt)) * 100)
  ELSE 0
END < 18
ORDER BY gm_percent ASC, revenue DESC;


-- ============================================================================
-- SECTION 3: YESTERDAY'S ACTIVITY BY REGION
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 3.1 GLOBAL ACTIVITY SUMMARY (Yesterday)
-- ----------------------------------------------------------------------------
-- Inline business day logic in each subquery since CTEs can't be referenced from SELECT subqueries

SELECT
  (SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id)
   FROM adempiere.chuboe_rfq r
   JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id AND rl.isactive = 'Y'
   WHERE r.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND r.isactive = 'Y') as rfq_lines,
  (SELECT COUNT(DISTINCT r.c_bpartner_id)
   FROM adempiere.chuboe_rfq r
   WHERE r.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND r.isactive = 'Y') as rfq_customers,
  (SELECT COUNT(DISTINCT cq.chuboe_cq_line_id)
   FROM adempiere.chuboe_cq_line cq
   WHERE cq.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND cq.isactive = 'Y') as cq_lines,
  (SELECT COUNT(DISTINCT cq.chuboe_cq_line_id)
   FROM adempiere.chuboe_cq_line cq
   WHERE cq.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND cq.issold = 'Y' AND cq.isactive = 'Y') as cq_sold,
  (SELECT COUNT(DISTINCT o.c_order_id)
   FROM adempiere.c_order o
   WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND o.isactive = 'Y' AND o.issotrx = 'Y') as so_lines,
  (SELECT SUM(o.grandtotal)
   FROM adempiere.c_order o
   WHERE o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND o.isactive = 'Y' AND o.issotrx = 'Y') as so_revenue;


-- ----------------------------------------------------------------------------
-- 3.2 ACTIVITY BY REGION (Yesterday)
-- ----------------------------------------------------------------------------
-- Rolled up by region: USA (Jeff), MEX (Joel), APAC-Laurel, APAC-Silvia, APAC-Lavanya, Other
-- Inline business day logic in each subquery since CTEs can't be referenced from SELECT subqueries

WITH regional_users AS (
  SELECT
    ad_user_id,
    CASE
      WHEN ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
      WHEN ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
      WHEN ad_user_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
      WHEN ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
      ELSE 'Other'
    END as region,
    CASE
      WHEN ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'Jeff Wallace'
      WHEN ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'Joel Marquez'
      WHEN ad_user_id IN (1041139, 1023803, 1016958) THEN 'Laurel Kee'
      WHEN ad_user_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'Silvia Munoz'
      ELSE ''
    END as manager
  FROM adempiere.ad_user
  WHERE isactive = 'Y'
)
SELECT
  ru.region,
  ru.manager,
  (SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id)
   FROM adempiere.chuboe_rfq r
   JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id AND rl.isactive = 'Y'
   JOIN regional_users ru2 ON r.salesrep_id = ru2.ad_user_id
   WHERE ru2.region = ru.region
     AND r.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND r.isactive = 'Y') as rfq_lines,
  (SELECT COUNT(DISTINCT cq.chuboe_cq_line_id)
   FROM adempiere.chuboe_rfq r
   JOIN adempiere.chuboe_cq_line cq ON r.chuboe_rfq_id = cq.chuboe_rfq_id AND cq.isactive = 'Y'
   JOIN regional_users ru2 ON r.salesrep_id = ru2.ad_user_id
   WHERE ru2.region = ru.region
     AND cq.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND r.isactive = 'Y') as cq_lines,
  (SELECT COUNT(DISTINCT cq.chuboe_cq_line_id)
   FROM adempiere.chuboe_rfq r
   JOIN adempiere.chuboe_cq_line cq ON r.chuboe_rfq_id = cq.chuboe_rfq_id AND cq.isactive = 'Y'
   JOIN regional_users ru2 ON r.salesrep_id = ru2.ad_user_id
   WHERE ru2.region = ru.region
     AND cq.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND cq.issold = 'Y'
     AND r.isactive = 'Y') as cq_sold,
  (SELECT COUNT(DISTINCT o.c_order_id)
   FROM adempiere.c_order o
   JOIN regional_users ru2 ON o.salesrep_id = ru2.ad_user_id
   WHERE ru2.region = ru.region
     AND o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND o.isactive = 'Y'
     AND o.issotrx = 'Y') as so_lines,
  (SELECT COALESCE(SUM(o.grandtotal), 0)
   FROM adempiere.c_order o
   JOIN regional_users ru2 ON o.salesrep_id = ru2.ad_user_id
   WHERE ru2.region = ru.region
     AND o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND o.isactive = 'Y'
     AND o.issotrx = 'Y') as so_revenue,
  (SELECT COALESCE(SUM(bi.s_order_line_gp), 0)
   FROM adempiere.c_order o
   JOIN regional_users ru2 ON o.salesrep_id = ru2.ad_user_id
   LEFT JOIN adempiere.bi_order_line_v bi ON o.c_order_id = bi.order_id
   WHERE ru2.region = ru.region
     AND o.created::date = CASE WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days' ELSE CURRENT_DATE - INTERVAL '1 day' END
     AND o.isactive = 'Y'
     AND o.issotrx = 'Y') as so_gp
FROM (SELECT DISTINCT region, manager FROM regional_users) ru
ORDER BY region;
