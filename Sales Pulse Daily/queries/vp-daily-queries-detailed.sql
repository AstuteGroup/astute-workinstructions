-- VP Daily Brief - DETAILED QUERIES (On-Demand with Part Details)
-- Created: 2026-06-18
-- NOTE: These queries are SLOWER (30-60s) due to orderline aggregations
-- Use for on-demand detailed reports only, NOT for automated daily email

-- ============================================================================
-- SECTION 1: YESTERDAY'S TOP WINS (WITH PARTS)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 TOP 5 ORDERS WON (with part details)
-- ----------------------------------------------------------------------------

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
  (
    SELECT STRING_AGG(DISTINCT ol.chuboe_mpn, ', ' ORDER BY ol.chuboe_mpn)
    FROM adempiere.c_orderline ol
    WHERE ol.c_order_id = o.c_order_id
      AND ol.isactive = 'Y'
      AND ol.chuboe_mpn IS NOT NULL
  ) as part_numbers
FROM adempiere.c_order o
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
ORDER BY o.grandtotal DESC
LIMIT 5;


-- ----------------------------------------------------------------------------
-- 1.4 REACTIVATED CUSTOMERS (with part details)
-- ----------------------------------------------------------------------------

WITH last_orders AS (
  SELECT
    o.c_bpartner_id,
    MAX(o.created) as last_order_date,
    (ARRAY_AGG(u.name ORDER BY o.created DESC))[1] as previous_rep
  FROM adempiere.c_order o
  JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
  WHERE o.created::date < CURRENT_DATE - INTERVAL '180 days'
    AND o.isactive = 'Y'
    AND o.issotrx = 'Y'
  GROUP BY o.c_bpartner_id
),
yesterday_orders AS (
  SELECT
    o.c_bpartner_id,
    bp.c_bpartner_id as bp_id,
    bp.name as customer_name,
    (ARRAY_AGG(u.name ORDER BY o.created DESC))[1] as seller_name,
    (ARRAY_AGG(u.ad_user_id ORDER BY o.created DESC))[1] as seller_id,
    COUNT(DISTINCT o.c_order_id) as order_count,
    STRING_AGG(o.documentno, ', ' ORDER BY o.grandtotal DESC) as order_numbers,
    SUM(o.grandtotal) as total_revenue,
    (ARRAY_AGG(o.c_bpartner_location_id ORDER BY o.created DESC))[1] as bploc_id,
    (ARRAY_AGG(o.ad_user_id ORDER BY o.created DESC))[1] as contact_id,
    MIN(o.datepromised::date) as earliest_promise_date,
    -- Part details aggregated across all orders from this customer yesterday
    (
      SELECT STRING_AGG(DISTINCT ol.chuboe_mpn, ', ' ORDER BY ol.chuboe_mpn)
      FROM adempiere.c_orderline ol
      WHERE ol.c_order_id IN (
        SELECT o2.c_order_id
        FROM adempiere.c_order o2
        WHERE o2.c_bpartner_id = o.c_bpartner_id
          AND o2.created::date = CURRENT_DATE - INTERVAL '1 day'
          AND o2.isactive = 'Y'
      )
      AND ol.isactive = 'Y'
      AND ol.chuboe_mpn IS NOT NULL
    ) as mpns,
    (
      SELECT SUM(ol.qtyordered)
      FROM adempiere.c_orderline ol
      WHERE ol.c_order_id IN (
        SELECT o2.c_order_id
        FROM adempiere.c_order o2
        WHERE o2.c_bpartner_id = o.c_bpartner_id
          AND o2.created::date = CURRENT_DATE - INTERVAL '1 day'
          AND o2.isactive = 'Y'
      )
      AND ol.isactive = 'Y'
    ) as total_qty
  FROM adempiere.c_order o
  JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
  JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id AND u.isactive = 'Y'
  WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
    AND o.isactive = 'Y'
    AND o.issotrx = 'Y'
  GROUP BY o.c_bpartner_id, bp.c_bpartner_id, bp.name
)
SELECT
  yo.seller_name,
  CASE
    WHEN yo.seller_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
    WHEN yo.seller_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
    WHEN yo.seller_id IN (1041139, 1023803, 1016958) THEN 'APAC-Laurel'
    WHEN yo.seller_id IN (1039414, 1009866, 1013042, 1009528, 1009478, 1009210) THEN 'APAC-Silvia'
    ELSE 'Other'
  END as region,
  yo.customer_name,
  yo.bp_id as c_bpartner_id,
  yo.order_count,
  yo.order_numbers,
  yo.total_revenue,
  yo.mpns,
  '' as mfr_names,  -- Can add manufacturer lookup if needed
  yo.total_qty,
  loc.address1 || COALESCE(', ' || loc.address2, '') || ', ' ||
    loc.city || ', ' || COALESCE(loc.regionname, '') || ' ' ||
    COALESCE(loc.postal, '') || ', ' || c.name as customer_location,
  contact.name as contact_name,
  yo.earliest_promise_date as promise_date,
  lo.last_order_date::date as last_order_date,
  CURRENT_DATE - lo.last_order_date::date as days_since_last_order,
  lo.previous_rep as previous_sales_rep
FROM yesterday_orders yo
JOIN last_orders lo ON yo.c_bpartner_id = lo.c_bpartner_id
LEFT JOIN adempiere.c_bpartner_location bploc ON yo.bploc_id = bploc.c_bpartner_location_id AND bploc.isactive = 'Y'
LEFT JOIN adempiere.c_location loc ON bploc.c_location_id = loc.c_location_id
LEFT JOIN adempiere.c_country c ON loc.c_country_id = c.c_country_id
LEFT JOIN adempiere.ad_user contact ON yo.contact_id = contact.ad_user_id AND contact.isactive = 'Y'
WHERE CURRENT_DATE - lo.last_order_date::date >= 180
ORDER BY yo.total_revenue DESC;
