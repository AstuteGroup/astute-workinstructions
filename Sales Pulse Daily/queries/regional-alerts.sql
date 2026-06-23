-- Sales Pulse Daily - Regional Breakdown & Alerts
-- Companion to sales-pulse-daily-queries.sql

-- ============================================
-- REGIONAL BREAKDOWN (Yesterday)
-- ============================================

-- Map sellers to regions based on org structure
WITH seller_regions AS (
  SELECT ad_user_id, name,
    CASE
      -- USA (Jeff Wallace - 9 sellers)
      WHEN name IN ('Aaron Mendoza', 'Dan Reiser', 'Jake McAloose', 'James Diaz',
                    'Josh Syre', 'Justin Goodwin', 'Michael Stifter', 'Thomas Haynes', 'Will Rob')
      THEN 'USA'

      -- MEX (Joel Marquez - 9 sellers)
      WHEN name IN ('Alejandro Padilla', 'Alex Partida', 'Alfredo Martinez', 'Carlos Moreno',
                    'Carolina Hinestroza', 'Joel Flores', 'Juan Botero', 'Ricardo Morales', 'Salvador Horner')
      THEN 'MEX'

      -- APAC - Laurel Kee (Singapore - 3 sellers)
      WHEN name IN ('Ivy Chew', 'Jasper Kee', 'Ray Ng')
      THEN 'APAC-Laurel'

      -- APAC - Kris Munoz/Silvia (Philippines/China - 5 sellers)
      WHEN name IN ('James Xu', 'Joy Phromsatcha', 'Spring Tu', 'Wing Zhang', 'Winnie Lee')
      THEN 'APAC-Kris'

      -- APAC - Lavanya Manohar (India - 3 sellers)
      WHEN name IN ('Manikandan Subramani', 'Meenakshi Chidambaram', 'NANDHINI .')
      THEN 'APAC-Lavanya'

      ELSE 'OTHER'
    END AS region
  FROM adempiere.ad_user
  WHERE isactive = 'Y'
),
yesterday_routed AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at,
    rq.createdby AS seller_id
  FROM adempiere.r_request rq
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created::date = CURRENT_DATE - 1
),
human_vqs AS (
  SELECT
    vq.chuboe_rfq_line_id,
    MIN(vq.created) AS first_vq_at
  FROM adempiere.chuboe_vq_line vq
  WHERE vq.isactive = 'Y'
    AND vq.createdby != 1049524  -- Human buyers only
  GROUP BY vq.chuboe_rfq_line_id
)
SELECT
  COALESCE(sr.region, 'UNKNOWN') AS region,
  COUNT(DISTINCT yr.chuboe_rfq_line_id) AS rfq_lines_routed,
  COUNT(DISTINCT CASE WHEN hv.chuboe_rfq_line_id IS NOT NULL THEN yr.chuboe_rfq_line_id END) AS with_human_vq,
  ROUND(
    100.0 * COUNT(DISTINCT CASE WHEN hv.chuboe_rfq_line_id IS NOT NULL THEN yr.chuboe_rfq_line_id END) /
    NULLIF(COUNT(DISTINCT yr.chuboe_rfq_line_id), 0),
    1
  ) AS coverage_pct,
  ROUND(
    AVG(CASE WHEN hv.first_vq_at IS NOT NULL AND hv.first_vq_at > yr.routed_at
      THEN EXTRACT(EPOCH FROM (hv.first_vq_at - yr.routed_at)) / 86400
    END)::numeric,
    2
  ) AS avg_days_to_vq
FROM yesterday_routed yr
LEFT JOIN seller_regions sr ON yr.seller_id = sr.ad_user_id
LEFT JOIN human_vqs hv ON yr.chuboe_rfq_line_id = hv.chuboe_rfq_line_id
GROUP BY sr.region
ORDER BY
  CASE sr.region
    WHEN 'USA' THEN 1
    WHEN 'MEX' THEN 2
    WHEN 'APAC-Laurel' THEN 3
    WHEN 'APAC-Kris' THEN 4
    WHEN 'APAC-Lavanya' THEN 5
    ELSE 99
  END;

-- ============================================
-- NEEDS ATTENTION - Stuck in Queue >48hrs
-- ============================================

-- Routed RFQ lines with no human VQ after 48 hours
-- Grouped by region for actionability
WITH seller_regions AS (
  SELECT ad_user_id, name,
    CASE
      WHEN name IN ('Aaron Mendoza', 'Dan Reiser', 'Jake McAloose', 'James Diaz',
                    'Josh Syre', 'Justin Goodwin', 'Michael Stifter', 'Thomas Haynes', 'Will Rob')
      THEN 'USA'
      WHEN name IN ('Alejandro Padilla', 'Alex Partida', 'Alfredo Martinez', 'Carlos Moreno',
                    'Carolina Hinestroza', 'Joel Flores', 'Juan Botero', 'Ricardo Morales', 'Salvador Horner')
      THEN 'MEX'
      WHEN name IN ('Ivy Chew', 'Jasper Kee', 'Ray Ng')
      THEN 'APAC-Laurel'
      WHEN name IN ('James Xu', 'Joy Phromsatcha', 'Spring Tu', 'Wing Zhang', 'Winnie Lee')
      THEN 'APAC-Kris'
      WHEN name IN ('Manikandan Subramani', 'Meenakshi Chidambaram', 'NANDHINI .')
      THEN 'APAC-Lavanya'
      ELSE 'OTHER'
    END AS region
  FROM adempiere.ad_user WHERE isactive = 'Y'
),
stuck_lines AS (
  SELECT
    rq.record_id AS chuboe_rfq_line_id,
    rq.created AS routed_at,
    rq.createdby AS seller_id,
    rq.ad_user_id AS assigned_buyer_id,
    rl.chuboe_mpn,
    rlm.chuboe_mfr_text,
    rl.qty,
    r.value AS rfq_doc,
    r.chuboe_rfq_id,
    bp.name AS customer_name,
    EXTRACT(EPOCH FROM (NOW() - rq.created)) / 3600 AS hrs_stuck
  FROM adempiere.r_request rq
  JOIN adempiere.chuboe_rfq_line rl ON rq.record_id = rl.chuboe_rfq_line_id
  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
  LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
  LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
  WHERE rq.isactive = 'Y'
    AND rq.r_requesttype_id = 1000001
    AND rq.created < NOW() - INTERVAL '48 hours'
    AND rl.isactive = 'Y'
    AND r.isactive = 'Y'
    AND NOT EXISTS (
      SELECT 1 FROM adempiere.chuboe_vq_line vq
      WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
        AND vq.isactive = 'Y'
        AND vq.createdby != 1049524  -- Exclude Claude Harris
    )
)
SELECT
  COALESCE(sr.region, 'UNKNOWN') AS region,
  sl.rfq_doc,
  sl.chuboe_mpn AS mpn,
  sl.chuboe_mfr_text AS mfr,
  sl.qty,
  sl.customer_name,
  u_seller.name AS seller,
  u_buyer.name AS assigned_buyer,
  ROUND(sl.hrs_stuck::numeric, 1) AS hrs_stuck
FROM stuck_lines sl
LEFT JOIN seller_regions sr ON sl.seller_id = sr.ad_user_id
LEFT JOIN adempiere.ad_user u_seller ON sl.seller_id = u_seller.ad_user_id
LEFT JOIN adempiere.ad_user u_buyer ON sl.assigned_buyer_id = u_buyer.ad_user_id
WHERE sl.hrs_stuck > 48
ORDER BY sr.region, sl.hrs_stuck DESC
LIMIT 50;
