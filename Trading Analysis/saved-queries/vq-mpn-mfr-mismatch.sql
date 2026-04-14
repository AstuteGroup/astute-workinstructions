-- VQ vs RFQ AVL mismatch scan
--
-- Finds chuboe_vq_line records whose MPN or MFR doesn't match any MPN/MFR
-- on the linked RFQ line's AVL sub-rows. Surfaces:
--   * Wrong-parser-match residue (pre-2026-04-14, Chuboe_MFR_Text was set
--     from the distributor's returned MFR — so a wrong-match wrote the
--     wrong MFR even though Chuboe_MPN stayed correct because vq-writer.js
--     always uses opts.searchedMpn)
--   * Broker alternates surfaced on Stock RFQs (legit — operator decides)
--   * Data-quality issues on the RFQ side (URLs in MPN fields, MFR codes
--     concatenated into MPN, etc.)
--
-- Normalization: strips all non-alphanumeric characters, uppercases. Accepts
-- both exact matches and "variant" matches (one side prefix-contains the
-- other, both sides ≥5 chars after normalization — catches packaging suffixes
-- like LM358N ↔ LM358N/NOPB without enumerating distributor conventions).
--
-- MFR comparison uses same normalization. Does NOT currently resolve
-- acquisitions/aliases (Linear → ADI) at the SQL layer — a hit flagged here
-- might be a legitimate acquisition relabel. For that, export the flagged
-- rows and cross-check with shared/mfr-equivalence.js in Node.
--
-- USAGE:
--   psql -f vq-mpn-mfr-mismatch.sql
--   psql -f vq-mpn-mfr-mismatch.sql -v rfq_value=1132320       -- scope to one RFQ
--   psql -f vq-mpn-mfr-mismatch.sql -v since='2026-04-01'      -- date window

\set since '2026-01-01'
\set rfq_value ''

WITH scoped AS (
  SELECT v.chuboe_vq_line_id, v.chuboe_rfq_line_id,
         v.created::date AS created,
         COALESCE(u.name, 'system') AS creator,
         v.chuboe_mpn AS vq_mpn,
         v.chuboe_mfr_text AS vq_mfr,
         v.cost, v.qty,
         bp.name AS vendor,
         r.value AS rfq, rl.line, rl.chuboe_cpc
  FROM adempiere.chuboe_vq_line v
  JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = v.chuboe_rfq_line_id
  JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id = rl.chuboe_rfq_id
  LEFT JOIN adempiere.ad_user u ON u.ad_user_id = v.createdby
  LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id
  WHERE v.isactive = 'Y' AND rl.isactive = 'Y'
    AND v.created >= :'since'::date
    AND (:'rfq_value' = '' OR r.value = :'rfq_value')
),
checked AS (
  SELECT s.*,
    -- MPN exact: normalized (alphanumeric only) equal
    EXISTS (
      SELECT 1 FROM adempiere.chuboe_rfq_line_mpn lm
      WHERE lm.chuboe_rfq_line_id = s.chuboe_rfq_line_id AND lm.isactive = 'Y'
        AND UPPER(REGEXP_REPLACE(COALESCE(lm.chuboe_mpn,''),'[^A-Za-z0-9]','','g'))
          = UPPER(REGEXP_REPLACE(COALESCE(s.vq_mpn,''),'[^A-Za-z0-9]','','g'))
    ) AS mpn_exact,
    -- MPN variant: prefix-contains, both ≥5 chars
    EXISTS (
      SELECT 1 FROM adempiere.chuboe_rfq_line_mpn lm
      WHERE lm.chuboe_rfq_line_id = s.chuboe_rfq_line_id AND lm.isactive = 'Y'
        AND LENGTH(UPPER(REGEXP_REPLACE(COALESCE(lm.chuboe_mpn,''),'[^A-Za-z0-9]','','g'))) >= 5
        AND LENGTH(UPPER(REGEXP_REPLACE(COALESCE(s.vq_mpn,''),'[^A-Za-z0-9]','','g'))) >= 5
        AND (
          UPPER(REGEXP_REPLACE(COALESCE(lm.chuboe_mpn,''),'[^A-Za-z0-9]','','g'))
            LIKE UPPER(REGEXP_REPLACE(COALESCE(s.vq_mpn,''),'[^A-Za-z0-9]','','g'))||'%'
          OR UPPER(REGEXP_REPLACE(COALESCE(s.vq_mpn,''),'[^A-Za-z0-9]','','g'))
            LIKE UPPER(REGEXP_REPLACE(COALESCE(lm.chuboe_mpn,''),'[^A-Za-z0-9]','','g'))||'%'
        )
    ) AS mpn_variant,
    -- MFR exact: normalized equal (alphanumeric), only flagged when both sides populated
    CASE
      WHEN COALESCE(s.vq_mfr,'') = '' THEN NULL  -- VQ side blank — can't judge
      WHEN NOT EXISTS (
        SELECT 1 FROM adempiere.chuboe_rfq_line_mpn lm
        WHERE lm.chuboe_rfq_line_id = s.chuboe_rfq_line_id AND lm.isactive = 'Y'
          AND COALESCE(lm.chuboe_mfr_text,'') <> ''
      ) THEN NULL  -- RFQ side all blank — can't judge
      WHEN EXISTS (
        SELECT 1 FROM adempiere.chuboe_rfq_line_mpn lm
        WHERE lm.chuboe_rfq_line_id = s.chuboe_rfq_line_id AND lm.isactive = 'Y'
          AND UPPER(REGEXP_REPLACE(COALESCE(lm.chuboe_mfr_text,''),'[^A-Za-z0-9]','','g'))
            = UPPER(REGEXP_REPLACE(COALESCE(s.vq_mfr,''),'[^A-Za-z0-9]','','g'))
      ) THEN TRUE
      ELSE FALSE
    END AS mfr_match,
    (SELECT string_agg(DISTINCT lm.chuboe_mpn, ' | ') FROM adempiere.chuboe_rfq_line_mpn lm
     WHERE lm.chuboe_rfq_line_id = s.chuboe_rfq_line_id AND lm.isactive = 'Y') AS avl_mpns,
    (SELECT string_agg(DISTINCT lm.chuboe_mfr_text, ' | ') FROM adempiere.chuboe_rfq_line_mpn lm
     WHERE lm.chuboe_rfq_line_id = s.chuboe_rfq_line_id AND lm.isactive = 'Y'
       AND COALESCE(lm.chuboe_mfr_text,'') <> '') AS avl_mfrs
  FROM scoped s
)
SELECT
  CASE
    WHEN NOT mpn_exact AND NOT mpn_variant AND mfr_match IS FALSE THEN 'BOTH_MISMATCH'
    WHEN NOT mpn_exact AND NOT mpn_variant                        THEN 'MPN_MISMATCH'
    WHEN mfr_match IS FALSE                                       THEN 'MFR_MISMATCH'
    WHEN NOT mpn_exact AND mpn_variant                            THEN 'MPN_VARIANT'
    ELSE 'MATCH'
  END AS flag,
  rfq, line, chuboe_cpc, vq_mpn, avl_mpns, vq_mfr, avl_mfrs,
  vendor, cost, qty, creator, created, chuboe_vq_line_id
FROM checked
WHERE NOT (mpn_exact AND (mfr_match IS NULL OR mfr_match IS TRUE))
ORDER BY
  CASE
    WHEN NOT mpn_exact AND NOT mpn_variant AND mfr_match IS FALSE THEN 1  -- most suspicious first
    WHEN NOT mpn_exact AND NOT mpn_variant                        THEN 2
    WHEN mfr_match IS FALSE                                       THEN 3
    ELSE 4
  END,
  created DESC, rfq DESC, line;
