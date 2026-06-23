-- Sales Pulse Daily - Core Metrics
-- Focus: Routed RFQ lines + Human buyer VQs only
-- Claude Harris (1049524) tracked separately

-- ============================================
-- GLOBAL SNAPSHOT - Yesterday's Activity
-- ============================================

-- 1. RFQ LINES ROUTED TO BUYER QUEUE (Yesterday)
-- Counts r_request records with type "Buyer Queue" created yesterday
WITH yesterday AS (
  SELECT CURRENT_DATE - 1 AS target_date
),
routed_rfq_lines AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at,
    rq.r_request_id,
    rq.ad_user_id AS assigned_buyer_id
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001  -- Buyer Queue type
    AND rq.created::date = (SELECT target_date FROM yesterday)
)
SELECT
  COUNT(DISTINCT chuboe_rfq_line_id) AS rfq_lines_routed,
  COUNT(DISTINCT CASE WHEN assigned_buyer_id IS NOT NULL THEN chuboe_rfq_line_id END) AS lines_with_assigned_buyer
FROM routed_rfq_lines;

-- 2. HUMAN VQ COVERAGE % (of routed lines yesterday)
-- % of routed lines that received at least 1 human VQ
WITH yesterday AS (
  SELECT CURRENT_DATE - 1 AS target_date
),
routed_lines AS (
  SELECT DISTINCT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date = (SELECT target_date FROM yesterday)
),
human_vqs AS (
  SELECT DISTINCT
    vq.chuboe_rfq_line_id
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.createdby != 1049524  -- Exclude Claude Harris
)
SELECT
  COUNT(DISTINCT rl.chuboe_rfq_line_id) AS total_routed,
  COUNT(DISTINCT CASE WHEN hv.chuboe_rfq_line_id IS NOT NULL THEN rl.chuboe_rfq_line_id END) AS with_human_vq,
  ROUND(
    100.0 * COUNT(DISTINCT CASE WHEN hv.chuboe_rfq_line_id IS NOT NULL THEN rl.chuboe_rfq_line_id END) /
    NULLIF(COUNT(DISTINCT rl.chuboe_rfq_line_id), 0),
    1
  ) AS coverage_pct
FROM routed_lines rl
LEFT JOIN human_vqs hv ON rl.chuboe_rfq_line_id = hv.chuboe_rfq_line_id;

-- 3. AVG HUMAN VQ RESPONSE TIME (for routed lines with human VQs)
-- Days from r_request.created to first human VQ
WITH yesterday AS (
  SELECT CURRENT_DATE - 1 AS target_date
),
routed_lines AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date = (SELECT target_date FROM yesterday)
),
first_human_vq AS (
  SELECT
    vq.chuboe_rfq_line_id,
    MIN(vq.created) AS first_vq_at
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.createdby != 1049524  -- Human buyers only
  GROUP BY vq.chuboe_rfq_line_id
)
SELECT
  COUNT(*) AS routed_with_human_vq,
  ROUND(AVG(EXTRACT(EPOCH FROM (fv.first_vq_at - rl.routed_at)) / 3600)::numeric, 2) AS avg_hrs_to_vq,
  ROUND(AVG(EXTRACT(EPOCH FROM (fv.first_vq_at - rl.routed_at)) / 86400)::numeric, 2) AS avg_days_to_vq
FROM routed_lines rl
JOIN first_human_vq fv ON rl.chuboe_rfq_line_id = fv.chuboe_rfq_line_id
WHERE fv.first_vq_at > rl.routed_at;  -- VQ created after routing

-- 4. CLAUDE HARRIS VQ COVERAGE (separate tracking)
-- % of routed lines that received Claude Harris VQs
WITH yesterday AS (
  SELECT CURRENT_DATE - 1 AS target_date
),
routed_lines AS (
  SELECT DISTINCT
    rq.record_id AS chuboe_rfq_line_id
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date = (SELECT target_date FROM yesterday)
),
claude_vqs AS (
  SELECT DISTINCT
    vq.chuboe_rfq_line_id
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.createdby = 1049524  -- Claude Harris only
)
SELECT
  COUNT(DISTINCT rl.chuboe_rfq_line_id) AS total_routed,
  COUNT(DISTINCT CASE WHEN cv.chuboe_rfq_line_id IS NOT NULL THEN rl.chuboe_rfq_line_id END) AS with_claude_vq,
  ROUND(
    100.0 * COUNT(DISTINCT CASE WHEN cv.chuboe_rfq_line_id IS NOT NULL THEN rl.chuboe_rfq_line_id END) /
    NULLIF(COUNT(DISTINCT rl.chuboe_rfq_line_id), 0),
    1
  ) AS claude_coverage_pct
FROM routed_lines rl
LEFT JOIN claude_vqs cv ON rl.chuboe_rfq_line_id = cv.chuboe_rfq_line_id;

-- 5. LINES STUCK >48HRS WITH NO HUMAN VQ
-- Routed lines older than 48 hours with no human VQ response
WITH routed_lines AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at,
    rq.r_request_id,
    rl.chuboe_mpn,
    r.value AS rfq_doc
  FROM adempiere.r_request rq
  JOIN adempiere.chuboe_rfq_line rl ON rq.record_id = rl.chuboe_rfq_line_id
  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created < NOW() - INTERVAL '48 hours'
    AND rl.isactive = 'Y'
    AND r.isactive = 'Y'
),
human_vqs AS (
  SELECT DISTINCT
    vq.chuboe_rfq_line_id
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.createdby != 1049524
)
SELECT
  COUNT(*) AS stuck_lines,
  ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - rl.routed_at)) / 3600)::numeric, 1) AS avg_hrs_stuck
FROM routed_lines rl
LEFT JOIN human_vqs hv ON rl.chuboe_rfq_line_id = hv.chuboe_rfq_line_id
WHERE hv.chuboe_rfq_line_id IS NULL;  -- No human VQ yet

-- ============================================
-- 5-DAY ROLLING AVERAGE (for trend comparison)
-- ============================================

-- Rolling avg for RFQ lines routed
WITH last_5_days AS (
  SELECT generate_series(
    CURRENT_DATE - 6,
    CURRENT_DATE - 2,
    '1 day'::interval
  )::date AS day
),
daily_routed AS (
  SELECT
    rq.created::date AS day,
    COUNT(DISTINCT rq.record_id) AS routed_count
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date IN (SELECT day FROM last_5_days)
  GROUP BY rq.created::date
)
SELECT
  ROUND(AVG(routed_count)::numeric, 1) AS avg_routed_last_5_days
FROM daily_routed;

-- Rolling avg for human VQ coverage %
WITH last_5_days AS (
  SELECT generate_series(
    CURRENT_DATE - 6,
    CURRENT_DATE - 2,
    '1 day'::interval
  )::date AS day
),
daily_coverage AS (
  SELECT
    rq.created::date AS day,
    COUNT(DISTINCT rq.record_id) AS routed,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM adempiere.chuboe_vq_line vq
        WHERE vq.chuboe_rfq_line_id = rq.record_id
          AND vq.isactive = 'Y'
          AND vq.createdby != 1049524
      ) THEN rq.record_id
    END) AS with_human_vq
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date IN (SELECT day FROM last_5_days)
  GROUP BY rq.created::date
)
SELECT
  ROUND(AVG(100.0 * with_human_vq / NULLIF(routed, 0))::numeric, 1) AS avg_coverage_pct_last_5_days
FROM daily_coverage;

-- ============================================
-- CQ METRICS (from earlier research)
-- ============================================

-- CQ Lines Entered Yesterday
SELECT
  COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_entered
FROM adempiere.chuboe_cq_line cq
WHERE cq.isactive = 'Y'
  AND cq.created::date = CURRENT_DATE - 1;

-- CQ Lines Sold Yesterday
SELECT
  COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_sold
FROM adempiere.chuboe_cq_line cq
WHERE cq.isactive = 'Y'
  AND cq.issold = 'Y'
  AND cq.updated::date = CURRENT_DATE - 1;  -- Approximation for when marked sold

-- SO Lines Booked Yesterday
SELECT
  COUNT(DISTINCT ol.c_orderline_id) AS so_lines_booked,
  ROUND(SUM(ol.linenetamt)::numeric, 2) AS total_booked
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
WHERE ol.isactive = 'Y'
  AND o.isactive = 'Y'
  AND o.issotrx = 'Y'  -- Sales orders only
  AND o.dateordered::date = CURRENT_DATE - 1;
