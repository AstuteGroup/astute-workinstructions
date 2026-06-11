-- ============================================
-- SALES PULSE DAILY - FINAL QUERY SET
-- ============================================
-- Global Snapshot: Yesterday only (V5 approach - all RFQ lines)
-- Buyer Queue Status: Last 3 business days (rolling)
-- Claude Harris ID: 1049524

-- ============================================
-- GLOBAL SNAPSHOT - Yesterday Activity Only
-- ============================================
-- Simple counts: What was created/loaded yesterday in each table

-- 1. RFQ LINES ENTERED YESTERDAY
SELECT
  COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_lines_entered,
  COUNT(DISTINCT r.c_bpartner_id) AS distinct_customers
FROM adempiere.chuboe_rfq_line rl
JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
WHERE rl.isactive = 'Y'
  AND r.isactive = 'Y'
  AND rl.created::date = CURRENT_DATE - 1;

-- 2. VQ LINES LOADED YESTERDAY (total count + breakdown)
SELECT
  COUNT(DISTINCT vq.chuboe_vq_line_id) AS vq_lines_loaded,
  COUNT(DISTINCT CASE WHEN vq.chuboe_buyer_id IS NOT NULL THEN vq.chuboe_vq_line_id END) AS with_buyer_assigned,
  COUNT(DISTINCT CASE WHEN vq.createdby = 1049524 THEN vq.chuboe_vq_line_id END) AS claude_vqs,
  COUNT(DISTINCT CASE WHEN vq.chuboe_buyer_id IS NULL AND vq.createdby != 1049524 THEN vq.chuboe_vq_line_id END) AS no_buyer_assigned
FROM adempiere.chuboe_vq_line vq
WHERE vq.isactive = 'Y'
  AND vq.created::date = CURRENT_DATE - 1;

-- 3. VQ SOURCE BREAKDOWN (for footer insights)
-- Of yesterday's VQs, what % were buyer-assigned vs Claude vs no-buyer
SELECT
  CASE
    WHEN vq.createdby = 1049524 THEN 'Claude Harris'
    WHEN vq.chuboe_buyer_id IS NOT NULL THEN 'Buyer-Assigned'
    ELSE 'No Buyer'
  END AS vq_source,
  COUNT(DISTINCT vq.chuboe_vq_line_id) AS line_count,
  ROUND(100.0 * COUNT(DISTINCT vq.chuboe_vq_line_id) /
    SUM(COUNT(DISTINCT vq.chuboe_vq_line_id)) OVER (), 1) AS pct
FROM adempiere.chuboe_vq_line vq
WHERE vq.isactive = 'Y'
  AND vq.created::date = CURRENT_DATE - 1
GROUP BY
  CASE
    WHEN vq.createdby = 1049524 THEN 'Claude Harris'
    WHEN vq.chuboe_buyer_id IS NOT NULL THEN 'Buyer-Assigned'
    ELSE 'No Buyer'
  END
ORDER BY line_count DESC;

-- 5. CQ LINES ENTERED YESTERDAY
SELECT
  COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_entered,
  COUNT(DISTINCT cq.c_bpartner_id) AS distinct_customers
FROM adempiere.chuboe_cq_line cq
WHERE cq.isactive = 'Y'
  AND cq.created::date = CURRENT_DATE - 1;

-- 6. CQ LINES SOLD YESTERDAY (approximation via updated timestamp)
SELECT
  COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_sold
FROM adempiere.chuboe_cq_line cq
WHERE cq.isactive = 'Y'
  AND cq.issold = 'Y'
  AND cq.updated::date = CURRENT_DATE - 1;

-- 7. SO LINES BOOKED YESTERDAY
SELECT
  COUNT(DISTINCT ol.c_orderline_id) AS so_lines_booked,
  ROUND(SUM(ol.linenetamt)::numeric, 2) AS total_booked
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
WHERE ol.isactive = 'Y'
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'
  AND o.dateordered::date = CURRENT_DATE - 1;

-- ============================================
-- BUYER QUEUE EFFECTIVENESS - Last 3 Business Days
-- ============================================

-- Helper: Get last 3 business days (excluding weekends)
WITH RECURSIVE business_days AS (
  SELECT
    CURRENT_DATE - 1 AS day,
    1 AS day_count

  UNION ALL

  SELECT
    day - 1,
    day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
  FROM business_days
  WHERE day_count < 3
),
last_3_bdays AS (
  SELECT day
  FROM business_days
  WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)  -- Exclude Sat/Sun
  ORDER BY day DESC
  LIMIT 3
);

-- 8. ROUTED LINES (last 3 business days)
SELECT
  COUNT(DISTINCT rq.record_id) AS lines_routed_3day,
  MIN(bd.day) AS earliest_day,
  MAX(bd.day) AS latest_day
FROM adempiere.r_request rq
CROSS JOIN last_3_bdays bd
WHERE rq.isactive = 'Y'
  AND rq.r_requesttype_id = 1000001
  AND rq.created::date IN (SELECT day FROM last_3_bdays);

-- 9. BUYER RESPONSE RATE (last 3 business days)
-- Buyer gets credit when chuboe_buyer_id IS NOT NULL (regardless of who loaded it)
WITH routed_3day AS (
  SELECT DISTINCT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  CROSS JOIN last_3_bdays bd
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date IN (SELECT day FROM last_3_bdays)
),
buyer_vqs AS (
  SELECT DISTINCT vq.chuboe_rfq_line_id
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.chuboe_buyer_id IS NOT NULL  -- Buyer assigned (loaded by buyer OR data entry)
)
SELECT
  COUNT(DISTINCT r3.chuboe_rfq_line_id) AS total_routed,
  COUNT(DISTINCT CASE WHEN bv.chuboe_rfq_line_id IS NOT NULL THEN r3.chuboe_rfq_line_id END) AS with_buyer_vq,
  ROUND(
    100.0 * COUNT(DISTINCT CASE WHEN bv.chuboe_rfq_line_id IS NOT NULL THEN r3.chuboe_rfq_line_id END) /
    NULLIF(COUNT(DISTINCT r3.chuboe_rfq_line_id), 0),
    1
  ) AS buyer_response_pct
FROM routed_3day r3
LEFT JOIN buyer_vqs bv ON r3.chuboe_rfq_line_id = bv.chuboe_rfq_line_id;

-- 10. AVG RESPONSE TIME (for routed lines that got buyer VQs)
WITH routed_3day AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  CROSS JOIN last_3_bdays bd
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date IN (SELECT day FROM last_3_bdays)
),
first_buyer_vq AS (
  SELECT
    vq.chuboe_rfq_line_id,
    MIN(vq.created) AS first_vq_at
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.chuboe_buyer_id IS NOT NULL  -- Buyer assigned
  GROUP BY vq.chuboe_rfq_line_id
)
SELECT
  COUNT(*) AS responded_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (fv.first_vq_at - r3.routed_at)) / 3600)::numeric, 2) AS avg_hrs_to_vq,
  ROUND(AVG(EXTRACT(EPOCH FROM (fv.first_vq_at - r3.routed_at)) / 86400)::numeric, 2) AS avg_days_to_vq
FROM routed_3day r3
JOIN first_buyer_vq fv ON r3.chuboe_rfq_line_id = fv.chuboe_rfq_line_id
WHERE fv.first_vq_at > r3.routed_at;

-- 11. LINES STUCK >48HRS (from 3-day window, no buyer VQ)
WITH routed_3day AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  CROSS JOIN last_3_bdays bd
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date IN (SELECT day FROM last_3_bdays)
    AND rq.created < NOW() - INTERVAL '48 hours'
),
buyer_vqs AS (
  SELECT DISTINCT vq.chuboe_rfq_line_id
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.chuboe_buyer_id IS NOT NULL  -- Buyer assigned
)
SELECT
  COUNT(*) AS stuck_count,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM routed_3day), 1) AS stuck_pct
FROM routed_3day r3
LEFT JOIN buyer_vqs bv ON r3.chuboe_rfq_line_id = bv.chuboe_rfq_line_id
WHERE bv.chuboe_rfq_line_id IS NULL;

-- 12. DAILY BREAKDOWN (last 3 business days)
WITH routed_by_day AS (
  SELECT
    rq.created::date AS day,
    COUNT(DISTINCT rq.record_id) AS routed_count,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM adempiere.chuboe_vq_line vq
        WHERE vq.chuboe_rfq_line_id = rq.record_id
          AND vq.isactive = 'Y'
          AND vq.chuboe_buyer_id IS NOT NULL  -- Buyer assigned
      ) THEN rq.record_id
    END) AS responded_count
  FROM adempiere.r_request rq
  CROSS JOIN last_3_bdays bd
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date IN (SELECT day FROM last_3_bdays)
  GROUP BY rq.created::date
)
SELECT
  day,
  routed_count,
  responded_count,
  ROUND(100.0 * responded_count / NULLIF(routed_count, 0), 1) AS response_pct
FROM routed_by_day
ORDER BY day;
