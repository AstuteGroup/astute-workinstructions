-- ============================================
-- SECTION 1: GLOBAL SNAPSHOT
-- Yesterday vs. 5-Day Rolling Average
-- ============================================

-- Helper: Last 5 business days
WITH RECURSIVE business_days_5 AS (
  SELECT
    CURRENT_DATE - 1 AS day,
    1 AS day_count
  UNION ALL
  SELECT
    day - 1,
    day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
  FROM business_days_5
  WHERE day_count < 5
),
last_5_bdays AS (
  SELECT day
  FROM business_days_5
  WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
  ORDER BY day DESC
  LIMIT 5
);

-- ============================================
-- SUBSECTION 1: PIPELINE INPUT
-- ============================================

-- 1.1 RFQ LINES ENTERED (yesterday + 5-day avg + change)
WITH yesterday AS (
  SELECT
    COUNT(DISTINCT rl.chuboe_rfq_line_id) AS lines,
    COUNT(DISTINCT r.c_bpartner_id) AS customers
  FROM adempiere.chuboe_rfq_line rl
  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
  WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
    AND rl.created::date = CURRENT_DATE - 1
),
five_day AS (
  SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
  FROM (
    SELECT
      rl.created::date,
      COUNT(DISTINCT rl.chuboe_rfq_line_id) AS daily_lines
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    CROSS JOIN last_5_bdays bd
    WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
      AND rl.created::date IN (SELECT day FROM last_5_bdays)
    GROUP BY rl.created::date
  ) daily
)
SELECT
  y.lines AS yesterday_lines,
  y.customers AS yesterday_customers,
  f.avg_lines AS five_day_avg_lines,
  ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
FROM yesterday y
CROSS JOIN five_day f;

-- 1.2 RFQ LINES WITH RESPONSE (yesterday + 5-day avg + change)
-- Response = has at least 1 VQ
WITH yesterday AS (
  SELECT
    COUNT(DISTINCT rl.chuboe_rfq_line_id) AS total_lines,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM adempiere.chuboe_vq_line vq
        WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
          AND vq.isactive = 'Y'
      ) THEN rl.chuboe_rfq_line_id
    END) AS with_response
  FROM adempiere.chuboe_rfq_line rl
  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
  WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
    AND rl.created::date = CURRENT_DATE - 1
),
five_day AS (
  SELECT ROUND(AVG(daily_response)::numeric, 1) AS avg_with_response
  FROM (
    SELECT
      rl.created::date,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_vq_line vq
          WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
            AND vq.isactive = 'Y'
        ) THEN rl.chuboe_rfq_line_id
      END) AS daily_response
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    CROSS JOIN last_5_bdays bd
    WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
      AND rl.created::date IN (SELECT day FROM last_5_bdays)
    GROUP BY rl.created::date
  ) daily
)
SELECT
  y.total_lines,
  y.with_response AS yesterday_with_response,
  ROUND(100.0 * y.with_response / NULLIF(y.total_lines, 0), 1) AS yesterday_pct,
  f.avg_with_response AS five_day_avg_response,
  ROUND(100.0 * (y.with_response - f.avg_with_response) / NULLIF(f.avg_with_response, 0), 1) AS pct_change
FROM yesterday y
CROSS JOIN five_day f;

-- 1.3 BUYER QUEUE TIME (routed → picked)
-- Yesterday avg + 5-day avg
WITH yesterday_routed AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date = CURRENT_DATE - 1
),
yesterday_picked AS (
  SELECT
    vq.chuboe_rfq_line_id,
    MIN(vq.created) AS picked_at
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.chuboe_buyer_id IS NOT NULL
  GROUP BY vq.chuboe_rfq_line_id
),
yesterday_avg AS (
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (yp.picked_at - yr.routed_at)) / 86400)::numeric, 2) AS avg_days
  FROM yesterday_routed yr
  JOIN yesterday_picked yp ON yr.chuboe_rfq_line_id = yp.chuboe_rfq_line_id
  WHERE yp.picked_at > yr.routed_at
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_avg)::numeric, 2) AS avg_days
  FROM (
    SELECT
      rq.created::date,
      AVG(EXTRACT(EPOCH FROM (vq.picked_at - rq.created)) / 86400) AS daily_avg
    FROM adempiere.r_request rq
    CROSS JOIN last_5_bdays bd
    JOIN (
      SELECT
        chuboe_rfq_line_id,
        MIN(created) AS picked_at
      FROM adempiere.chuboe_vq_line
      WHERE isactive = 'Y'
        AND chuboe_buyer_id IS NOT NULL
      GROUP BY chuboe_rfq_line_id
    ) vq ON rq.record_id = vq.chuboe_rfq_line_id
    WHERE rq.isactive = 'Y'
      AND rq.r_requesttype_id = 1000001
      AND rq.created::date IN (SELECT day FROM last_5_bdays)
      AND vq.picked_at > rq.created
    GROUP BY rq.created::date
  ) daily
)
SELECT
  COALESCE(y.avg_days, 0) AS yesterday_avg_days,
  COALESCE(f.avg_days, 0) AS five_day_avg_days,
  ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
FROM yesterday_avg y
CROSS JOIN five_day_avg f;

-- 1.4 BUYER RESPONSE TIME (picked → first response)
-- Approximated as: first buyer VQ → first CQ on same RFQ line
WITH yesterday_picked AS (
  SELECT
    vq.chuboe_rfq_line_id,
    MIN(vq.created) AS picked_at
  FROM adempiere.chuboe_vq_line vq
  JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
  WHERE vq.isactive = 'Y'
    AND vq.chuboe_buyer_id IS NOT NULL
    AND rl.created::date = CURRENT_DATE - 1
  GROUP BY vq.chuboe_rfq_line_id
),
yesterday_response AS (
  SELECT
    cq.chuboe_rfq_line_id,
    MIN(cq.created) AS response_at
  FROM adempiere.chuboe_cq_line cq
  WHERE cq.isactive = 'Y'
  GROUP BY cq.chuboe_rfq_line_id
),
yesterday_avg AS (
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (yr.response_at - yp.picked_at)) / 86400)::numeric, 2) AS avg_days
  FROM yesterday_picked yp
  JOIN yesterday_response yr ON yp.chuboe_rfq_line_id = yr.chuboe_rfq_line_id
  WHERE yr.response_at > yp.picked_at
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_avg)::numeric, 2) AS avg_days
  FROM (
    SELECT
      rl.created::date,
      AVG(EXTRACT(EPOCH FROM (cq.response_at - vq.picked_at)) / 86400) AS daily_avg
    FROM adempiere.chuboe_rfq_line rl
    CROSS JOIN last_5_bdays bd
    JOIN (
      SELECT
        chuboe_rfq_line_id,
        MIN(created) AS picked_at
      FROM adempiere.chuboe_vq_line
      WHERE isactive = 'Y'
        AND chuboe_buyer_id IS NOT NULL
      GROUP BY chuboe_rfq_line_id
    ) vq ON rl.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
    JOIN (
      SELECT
        chuboe_rfq_line_id,
        MIN(created) AS response_at
      FROM adempiere.chuboe_cq_line
      WHERE isactive = 'Y'
      GROUP BY chuboe_rfq_line_id
    ) cq ON rl.chuboe_rfq_line_id = cq.chuboe_rfq_line_id
    WHERE rl.isactive = 'Y'
      AND rl.created::date IN (SELECT day FROM last_5_bdays)
      AND cq.response_at > vq.picked_at
    GROUP BY rl.created::date
  ) daily
)
SELECT
  COALESCE(y.avg_days, 0) AS yesterday_avg_days,
  COALESCE(f.avg_days, 0) AS five_day_avg_days,
  ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
FROM yesterday_avg y
CROSS JOIN five_day_avg f;

-- 1.5 TOTAL RESPONSE TIME (routed → first response)
-- Combines queue time + buyer response time
WITH yesterday_routed AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date = CURRENT_DATE - 1
),
yesterday_response AS (
  SELECT
    cq.chuboe_rfq_line_id,
    MIN(cq.created) AS response_at
  FROM adempiere.chuboe_cq_line cq
  WHERE cq.isactive = 'Y'
  GROUP BY cq.chuboe_rfq_line_id
),
yesterday_avg AS (
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (yr.response_at - yt.routed_at)) / 86400)::numeric, 2) AS avg_days
  FROM yesterday_routed yt
  JOIN yesterday_response yr ON yt.chuboe_rfq_line_id = yr.chuboe_rfq_line_id
  WHERE yr.response_at > yt.routed_at
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_avg)::numeric, 2) AS avg_days
  FROM (
    SELECT
      rq.created::date,
      AVG(EXTRACT(EPOCH FROM (cq.response_at - rq.created)) / 86400) AS daily_avg
    FROM adempiere.r_request rq
    CROSS JOIN last_5_bdays bd
    JOIN (
      SELECT
        chuboe_rfq_line_id,
        MIN(created) AS response_at
      FROM adempiere.chuboe_cq_line
      WHERE isactive = 'Y'
      GROUP BY chuboe_rfq_line_id
    ) cq ON rq.record_id = cq.chuboe_rfq_line_id
    WHERE rq.isactive = 'Y'
      AND rq.r_requesttype_id = 1000001
      AND rq.created::date IN (SELECT day FROM last_5_bdays)
      AND cq.response_at > rq.created
    GROUP BY rq.created::date
  ) daily
)
SELECT
  COALESCE(y.avg_days, 0) AS yesterday_avg_days,
  COALESCE(f.avg_days, 0) AS five_day_avg_days,
  ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
FROM yesterday_avg y
CROSS JOIN five_day_avg f;

-- ============================================
-- SUBSECTION 2: QUOTING ACTIVITY
-- ============================================

-- 2.1 CQ LINES ENTERED (yesterday + 5-day avg + change)
WITH yesterday AS (
  SELECT
    COUNT(DISTINCT cq.chuboe_cq_line_id) AS lines,
    COUNT(DISTINCT cq.c_bpartner_id) AS customers
  FROM adempiere.chuboe_cq_line cq
  WHERE cq.isactive = 'Y'
    AND cq.created::date = CURRENT_DATE - 1
),
five_day AS (
  SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
  FROM (
    SELECT
      cq.created::date,
      COUNT(DISTINCT cq.chuboe_cq_line_id) AS daily_lines
    FROM adempiere.chuboe_cq_line cq
    CROSS JOIN last_5_bdays bd
    WHERE cq.isactive = 'Y'
      AND cq.created::date IN (SELECT day FROM last_5_bdays)
    GROUP BY cq.created::date
  ) daily
)
SELECT
  y.lines AS yesterday_lines,
  y.customers AS yesterday_customers,
  f.avg_lines AS five_day_avg_lines,
  ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
FROM yesterday y
CROSS JOIN five_day f;

-- 2.2 CQ LINES SOLD (yesterday + 5-day avg + change)
WITH yesterday AS (
  SELECT COUNT(DISTINCT cq.chuboe_cq_line_id) AS lines
  FROM adempiere.chuboe_cq_line cq
  WHERE cq.isactive = 'Y'
    AND cq.issold = 'Y'
    AND cq.updated::date = CURRENT_DATE - 1
),
five_day AS (
  SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
  FROM (
    SELECT
      cq.updated::date,
      COUNT(DISTINCT cq.chuboe_cq_line_id) AS daily_lines
    FROM adempiere.chuboe_cq_line cq
    CROSS JOIN last_5_bdays bd
    WHERE cq.isactive = 'Y'
      AND cq.issold = 'Y'
      AND cq.updated::date IN (SELECT day FROM last_5_bdays)
    GROUP BY cq.updated::date
  ) daily
)
SELECT
  y.lines AS yesterday_lines,
  f.avg_lines AS five_day_avg_lines,
  ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
FROM yesterday y
CROSS JOIN five_day f;

-- 2.3 AVG QUOTE AGE - SHORT CYCLE (Shortage/PPV/Stock)
-- Yesterday avg + 5-day avg
WITH short_cycle_types AS (
  SELECT chuboe_rfq_type_id FROM (VALUES (1000000), (1000001), (1000007)) AS t(chuboe_rfq_type_id)
),
yesterday_age AS (
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (CURRENT_DATE - cq.created)) / 86400)::numeric, 1) AS avg_days
  FROM adempiere.chuboe_cq_line cq
  JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
  WHERE cq.isactive = 'Y'
    AND cq.issold = 'N'
    AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM short_cycle_types)
    AND cq.created >= CURRENT_DATE - 30  -- Within 30-day window
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_avg)::numeric, 1) AS avg_days
  FROM (
    SELECT
      bd.day,
      AVG(EXTRACT(EPOCH FROM (bd.day - cq.created)) / 86400) AS daily_avg
    FROM adempiere.chuboe_cq_line cq
    JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    CROSS JOIN last_5_bdays bd
    WHERE cq.isactive = 'Y'
      AND cq.issold = 'N'
      AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM short_cycle_types)
      AND cq.created < bd.day
      AND cq.created >= bd.day - 30
    GROUP BY bd.day
  ) daily
)
SELECT
  COALESCE(y.avg_days, 0) AS yesterday_avg_days,
  COALESCE(f.avg_days, 0) AS five_day_avg_days,
  ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
FROM yesterday_age y
CROSS JOIN five_day_avg f;

-- 2.4 AVG QUOTE AGE - LONG CYCLE (EOL/LTB)
WITH long_cycle_types AS (
  SELECT chuboe_rfq_type_id FROM (VALUES (1000003)) AS t(chuboe_rfq_type_id)
),
yesterday_age AS (
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (CURRENT_DATE - cq.created)) / 86400)::numeric, 1) AS avg_days
  FROM adempiere.chuboe_cq_line cq
  JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
  WHERE cq.isactive = 'Y'
    AND cq.issold = 'N'
    AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM long_cycle_types)
    AND cq.created >= CURRENT_DATE - 64  -- Within 64-day window
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_avg)::numeric, 1) AS avg_days
  FROM (
    SELECT
      bd.day,
      AVG(EXTRACT(EPOCH FROM (bd.day - cq.created)) / 86400) AS daily_avg
    FROM adempiere.chuboe_cq_line cq
    JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    CROSS JOIN last_5_bdays bd
    WHERE cq.isactive = 'Y'
      AND cq.issold = 'N'
      AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM long_cycle_types)
      AND cq.created < bd.day
      AND cq.created >= bd.day - 64
    GROUP BY bd.day
  ) daily
)
SELECT
  COALESCE(y.avg_days, 0) AS yesterday_avg_days,
  COALESCE(f.avg_days, 0) AS five_day_avg_days,
  ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
FROM yesterday_age y
CROSS JOIN five_day_avg f;

-- ============================================
-- SUBSECTION 3: WINS
-- ============================================

-- 3.1 SO LINES BOOKED (yesterday + 5-day avg + change)
WITH yesterday AS (
  SELECT COUNT(DISTINCT ol.c_orderline_id) AS lines
  FROM adempiere.c_orderline ol
  JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
  WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
    AND o.issotrx = 'Y'
    AND o.dateordered::date = CURRENT_DATE - 1
),
five_day AS (
  SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
  FROM (
    SELECT
      o.dateordered::date,
      COUNT(DISTINCT ol.c_orderline_id) AS daily_lines
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    CROSS JOIN last_5_bdays bd
    WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
      AND o.issotrx = 'Y'
      AND o.dateordered::date IN (SELECT day FROM last_5_bdays)
    GROUP BY o.dateordered::date
  ) daily
)
SELECT
  y.lines AS yesterday_lines,
  f.avg_lines AS five_day_avg_lines,
  ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
FROM yesterday y
CROSS JOIN five_day f;

-- 3.2 $ BOOKED (yesterday + 5-day avg + change)
WITH yesterday AS (
  SELECT ROUND(SUM(ol.linenetamt)::numeric, 2) AS amount
  FROM adempiere.c_orderline ol
  JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
  WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
    AND o.issotrx = 'Y'
    AND o.dateordered::date = CURRENT_DATE - 1
),
five_day AS (
  SELECT ROUND(AVG(daily_amount)::numeric, 2) AS avg_amount
  FROM (
    SELECT
      o.dateordered::date,
      SUM(ol.linenetamt) AS daily_amount
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    CROSS JOIN last_5_bdays bd
    WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
      AND o.issotrx = 'Y'
      AND o.dateordered::date IN (SELECT day FROM last_5_bdays)
    GROUP BY o.dateordered::date
  ) daily
)
SELECT
  y.amount AS yesterday_amount,
  f.avg_amount AS five_day_avg_amount,
  ROUND(100.0 * (y.amount - f.avg_amount) / NULLIF(f.avg_amount, 0), 1) AS pct_change
FROM yesterday y
CROSS JOIN five_day f;

-- ============================================
-- SUBSECTION 4: SYSTEM DISCIPLINE
-- ============================================

-- 4.1 CQs ENTERED WITHIN 2HRS OF MARKING SOLD
WITH sold_yesterday AS (
  SELECT
    cq.chuboe_cq_line_id,
    cq.created AS cq_created,
    cq.updated AS sold_at
  FROM adempiere.chuboe_cq_line cq
  WHERE cq.isactive = 'Y'
    AND cq.issold = 'Y'
    AND cq.updated::date = CURRENT_DATE - 1
),
yesterday_stats AS (
  SELECT
    COUNT(*) AS total_sold,
    COUNT(CASE WHEN cq_created <= sold_at AND EXTRACT(EPOCH FROM (sold_at - cq_created)) / 3600 <= 2 THEN 1 END) AS within_2hrs
  FROM sold_yesterday
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_pct)::numeric, 1) AS avg_pct
  FROM (
    SELECT
      cq.updated::date,
      100.0 * COUNT(CASE WHEN cq.created <= cq.updated AND EXTRACT(EPOCH FROM (cq.updated - cq.created)) / 3600 <= 2 THEN 1 END) / NULLIF(COUNT(*), 0) AS daily_pct
    FROM adempiere.chuboe_cq_line cq
    CROSS JOIN last_5_bdays bd
    WHERE cq.isactive = 'Y'
      AND cq.issold = 'Y'
      AND cq.updated::date IN (SELECT day FROM last_5_bdays)
    GROUP BY cq.updated::date
  ) daily
)
SELECT
  ys.total_sold,
  ys.within_2hrs,
  ROUND(100.0 * ys.within_2hrs / NULLIF(ys.total_sold, 0), 1) AS yesterday_pct,
  f.avg_pct AS five_day_avg_pct,
  ROUND((100.0 * ys.within_2hrs / NULLIF(ys.total_sold, 0)) - f.avg_pct, 1) AS pts_change
FROM yesterday_stats ys
CROSS JOIN five_day_avg f;

-- 4.2 RETROACTIVE CQ ENTRY RATE (entered after sold)
WITH sold_yesterday AS (
  SELECT
    cq.chuboe_cq_line_id,
    cq.created AS cq_created,
    cq.updated AS sold_at
  FROM adempiere.chuboe_cq_line cq
  WHERE cq.isactive = 'Y'
    AND cq.issold = 'Y'
    AND cq.updated::date = CURRENT_DATE - 1
),
yesterday_stats AS (
  SELECT
    COUNT(*) AS total_sold,
    COUNT(CASE WHEN cq_created > sold_at THEN 1 END) AS retroactive
  FROM sold_yesterday
),
five_day_avg AS (
  SELECT ROUND(AVG(daily_pct)::numeric, 1) AS avg_pct
  FROM (
    SELECT
      cq.updated::date,
      100.0 * COUNT(CASE WHEN cq.created > cq.updated THEN 1 END) / NULLIF(COUNT(*), 0) AS daily_pct
    FROM adempiere.chuboe_cq_line cq
    CROSS JOIN last_5_bdays bd
    WHERE cq.isactive = 'Y'
      AND cq.issold = 'Y'
      AND cq.updated::date IN (SELECT day FROM last_5_bdays)
    GROUP BY cq.updated::date
  ) daily
)
SELECT
  ys.total_sold,
  ys.retroactive,
  ROUND(100.0 * ys.retroactive / NULLIF(ys.total_sold, 0), 1) AS yesterday_pct,
  f.avg_pct AS five_day_avg_pct,
  ROUND((100.0 * ys.retroactive / NULLIF(ys.total_sold, 0)) - f.avg_pct, 1) AS pts_change
FROM yesterday_stats ys
CROSS JOIN five_day_avg f;
