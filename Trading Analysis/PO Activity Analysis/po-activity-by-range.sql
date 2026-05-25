\timing on
\set ON_ERROR_STOP on

-- ============================================================
-- PO Activity by date range — TEMPLATE
--
-- This file is a TEMPLATE. The driver script (build-po-activity.js) replaces
-- the @PLACEHOLDERS@ below with concrete values before invoking psql.
--
-- Placeholders:
--   @START_DATE@    YYYY-MM-DD, inclusive
--   @END_DATE@      YYYY-MM-DD, EXCLUSIVE (first day of the month AFTER the last month you want)
--   @OUT_CSV@       absolute path for the line-level fact CSV
--   @OUT_MFR_CSV@   absolute path for the MFR breakdown CSV
--   @OUT_CONV_CSV@  absolute path for the per-CPC conversion CSV
--
-- For "Jan through Apr 2026": @START_DATE@='2026-01-01' @END_DATE@='2026-05-01'.
-- Direct invocation (without the driver) requires hand-substituting all five placeholders.
-- ============================================================

-- Pass 1: PO lines in period (purchase side) with tracking on the orderline
DROP TABLE IF EXISTS tmp_po;
CREATE TEMP TABLE tmp_po AS
SELECT
  o.documentno                AS ot_po,
  o.docstatus                 AS po_docstatus,
  o.dateordered::date         AS po_date,
  ol.datepromised::date       AS promise_date,
  ol.chuboe_po_string         AS infor_pov,
  ol.line                     AS po_line_no,
  ol.c_orderline_id,
  ol.chuboe_vq_line_id,
  ol.chuboe_mpn               AS line_mpn,
  COALESCE(NULLIF(ol.qtyordered, 0), ol.qtyentered) AS line_qty,
  ol.priceentered             AS po_price,
  ol.chuboe_trackingnumbers   AS po_tracking,
  o.c_bpartner_id             AS vendor_bp_id,
  o.salesrep_id               AS po_salesrep_id
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id AND o.isactive='Y'
WHERE ol.isactive='Y' AND o.issotrx='N' AND ol.chuboe_po_string LIKE 'POV%'
  AND o.dateordered >= '@START_DATE@'::date AND o.dateordered < '@END_DATE@'::date
  -- Exclude services / testing / fees / freight (parts only)
  AND COALESCE(ol.chuboe_mpn, '') !~* '\m(SERVICE|TESTING|FEE|CHARGE|EXPEDIT|FREIGHT|SHIPPING)\M'
  AND NOT EXISTS (
    SELECT 1 FROM adempiere.chuboe_vq_line v2
    JOIN adempiere.chuboe_mfr m2 ON m2.chuboe_mfr_id = v2.chuboe_mfr_id
    WHERE v2.chuboe_vq_line_id = ol.chuboe_vq_line_id AND m2.name = 'Charge'
  );
CREATE INDEX ON tmp_po (chuboe_vq_line_id);
ANALYZE tmp_po;

-- Pass 2: enrich VQ details (vendor / qty / cost / mfr / buyer)
DROP TABLE IF EXISTS tmp_enriched;
CREATE TEMP TABLE tmp_enriched AS
SELECT
  j.*,
  v.chuboe_rfq_line_id,
  v.chuboe_rfq_id,
  v.c_bpartner_id AS v_vendor_id,
  v.qty           AS v_qty,
  v.cost          AS v_cost,
  v.chuboe_mpn    AS v_mpn,
  v.chuboe_mfr_id AS v_mfr_id,
  v.chuboe_buyer_id,
  v.salesrep_id   AS v_salesrep_id
FROM tmp_po j
LEFT JOIN adempiere.chuboe_vq_line v ON v.chuboe_vq_line_id = j.chuboe_vq_line_id;
CREATE INDEX ON tmp_enriched (chuboe_rfq_line_id);
CREATE INDEX ON tmp_enriched (chuboe_vq_line_id);
ANALYZE tmp_enriched;

-- Pass 3: SALES orderlines aggregated per RFQ line — booked sales price + SO#s + COVs
DROP TABLE IF EXISTS tmp_so_agg;
CREATE TEMP TABLE tmp_so_agg AS
WITH so_lines AS (
  SELECT
    ol.chuboe_rfq_line_id,
    o.documentno,
    NULLIF(o.poreference, '') AS poreference,
    o.docstatus,
    o.dateordered,
    ol.c_orderline_id,
    COALESCE(NULLIF(ol.qtyordered, 0), ol.qtyentered) AS so_qty,
    ol.priceentered
  FROM adempiere.c_orderline ol
  JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id AND o.isactive='Y'
  WHERE ol.isactive='Y' AND o.issotrx='Y'
    AND ol.chuboe_rfq_line_id IN (
      SELECT chuboe_rfq_line_id FROM tmp_enriched WHERE chuboe_rfq_line_id IS NOT NULL
    )
)
SELECT
  chuboe_rfq_line_id,
  STRING_AGG(DISTINCT documentno, ', ' ORDER BY documentno)                                       AS so_docs,
  STRING_AGG(DISTINCT docstatus,  ', ' ORDER BY docstatus)                                        AS so_docstatuses,
  STRING_AGG(DISTINCT poreference,', ' ORDER BY poreference)                                      AS covs,
  COUNT(DISTINCT c_orderline_id)                                                                  AS so_line_count,
  SUM(so_qty)                                                                                     AS so_qty_total,
  SUM(so_qty * priceentered)                                                                      AS so_extended_total,
  CASE WHEN SUM(so_qty) > 0
       THEN SUM(so_qty * priceentered) / SUM(so_qty)
       ELSE NULL END                                                                              AS so_price_wavg,
  MAX(dateordered)::date                                                                          AS so_latest_date
FROM so_lines
GROUP BY chuboe_rfq_line_id;
CREATE INDEX ON tmp_so_agg (chuboe_rfq_line_id);

-- Pass 3b: receipts per PO line (m_inout — actual goods receipt)
DROP TABLE IF EXISTS tmp_recv_agg;
CREATE TEMP TABLE tmp_recv_agg AS
SELECT
  iol.c_orderline_id,
  MIN(io.movementdate)::date           AS first_recv_date,
  MAX(io.movementdate)::date           AS last_recv_date,
  SUM(iol.movementqty)                 AS recv_qty,
  STRING_AGG(DISTINCT io.documentno, ', ' ORDER BY io.documentno) AS recv_docs,
  STRING_AGG(DISTINCT io.docstatus,  ', ' ORDER BY io.docstatus)  AS recv_docstatuses
FROM adempiere.m_inoutline iol
JOIN adempiere.m_inout io ON iol.m_inout_id = io.m_inout_id AND io.isactive='Y'
WHERE iol.isactive='Y'
  AND iol.c_orderline_id IN (SELECT c_orderline_id FROM tmp_po)
GROUP BY iol.c_orderline_id;
CREATE INDEX ON tmp_recv_agg (c_orderline_id);

-- Pass 4: inspection-validated pick per VQ
DROP TABLE IF EXISTS tmp_insp_pick;
CREATE TEMP TABLE tmp_insp_pick AS
WITH rcv_to_lot AS (
  SELECT por.chuboe_vq_line_id, rcd.m_attributesetinstance_id AS chuboe_insp_lot_id,
         por.chuboe_po_pickeddate
  FROM adempiere.chuboe_po_receiving por
  JOIN adempiere.m_attributeinstance rcd
    ON rcd.valuenumber = por.chuboe_po_receiving_id
   AND rcd.m_attribute_id = (SELECT m_attribute_id FROM adempiere.m_attribute WHERE m_attribute_uu='b9b25358-a59b-4010-bd86-a7f90d87f1e7')
  WHERE por.isactive='Y' AND por.chuboe_vq_line_id IN (SELECT chuboe_vq_line_id FROM tmp_enriched WHERE chuboe_vq_line_id IS NOT NULL)
),
lot_agg AS (
  SELECT lnk.chuboe_insp_lot_id,
         MAX(lnk.isvalidate) AS isvalidate,
         MAX(lnk.processed)  AS processed,
         MIN(lnk.created)                                    AS lot_opened_ts,
         MAX(lnk.updated) FILTER (WHERE lnk.isvalidate='Y') AS validated_ts
  FROM adempiere.chuboe_insp_lot_lnk lnk
  WHERE lnk.isactive='Y' AND lnk.chuboe_insp_lot_id IN (SELECT chuboe_insp_lot_id FROM rcv_to_lot)
  GROUP BY lnk.chuboe_insp_lot_id
)
SELECT DISTINCT ON (r.chuboe_vq_line_id)
  r.chuboe_vq_line_id,
  r.chuboe_insp_lot_id::text AS otin_lot,
  l.isvalidate               AS insp_validated,
  l.processed                AS insp_processed,
  l.lot_opened_ts            AS insp_opened_ts,
  l.validated_ts             AS insp_validated_ts,
  r.chuboe_po_pickeddate     AS receipt_picked_date
FROM rcv_to_lot r
LEFT JOIN lot_agg l ON l.chuboe_insp_lot_id = r.chuboe_insp_lot_id
ORDER BY r.chuboe_vq_line_id, (l.isvalidate='Y') DESC NULLS LAST, l.validated_ts DESC NULLS LAST;
CREATE INDEX ON tmp_insp_pick (chuboe_vq_line_id);

-- Final assembly — line-level fact table
DROP TABLE IF EXISTS tmp_final;
CREATE TEMP TABLE tmp_final AS
SELECT
  e.ot_po,
  e.po_docstatus,
  e.infor_pov,
  e.po_date,
  e.promise_date,
  e.po_line_no,
  COALESCE(bp_v.name, '')              AS supplier,
  COALESCE(buyer.name, '')             AS buyer,
  COALESCE(e.line_mpn, e.v_mpn)        AS mpn,
  mfr.name                             AS mfr,
  e.line_qty                            AS po_qty,
  e.po_price                            AS po_price,
  e.po_tracking                         AS po_tracking,
  -- Receipt info
  recv.recv_qty                         AS recv_qty,
  recv.first_recv_date                  AS first_recv_date,
  recv.last_recv_date                   AS last_recv_date,
  recv.recv_docs                        AS recv_docs,
  -- Lifecycle status
  CASE
    WHEN recv.recv_qty IS NULL OR recv.recv_qty = 0     THEN 'NOT_RECEIVED'
    WHEN insp.otin_lot IS NULL                          THEN 'RECEIVED_NO_LOT'
    WHEN insp.insp_validated = 'Y' AND insp.insp_processed = 'Y' THEN 'PROCESSED'
    WHEN insp.insp_validated = 'Y'                      THEN 'VALIDATED'
    ELSE 'LOT_OPEN'
  END                                   AS otin_status,
  -- Past-due flag relative to today
  CASE
    WHEN recv.recv_qty IS NOT NULL AND recv.recv_qty > 0 THEN 'received'
    WHEN e.promise_date IS NULL                          THEN 'no_promise_date'
    WHEN e.promise_date < CURRENT_DATE                   THEN 'past_due'
    WHEN e.promise_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'due_within_7d'
    ELSE 'future'
  END                                   AS delivery_status,
  rfq.value                            AS rfq_search_key,
  rtype.name                           AS rfq_type,
  COALESCE(bp_c.name, '')              AS customer,
  COALESCE(seller.name, '')            AS seller,
  so.so_docs                           AS so_docs,
  so.so_docstatuses                    AS so_docstatuses,
  so.covs                              AS cov,
  so.so_line_count                     AS so_line_count,
  so.so_qty_total                      AS so_qty_total,
  so.so_price_wavg                     AS so_price_wavg,
  so.so_extended_total                 AS so_revenue_full_rfq,
  -- Attribute revenue to THIS PO line (avoids multi-PO double-count)
  CASE WHEN so.so_price_wavg IS NOT NULL AND e.line_qty IS NOT NULL AND e.line_qty > 0
       THEN e.line_qty * so.so_price_wavg
       ELSE NULL END                   AS attributed_so_revenue,
  so.so_latest_date                    AS so_latest_date,
  insp.otin_lot                        AS otin_lot,
  insp.insp_validated                  AS insp_validated,
  insp.insp_processed                  AS insp_processed,
  insp.insp_opened_ts::date            AS insp_opened_date,
  insp.insp_validated_ts::date         AS insp_validated_date,
  insp.receipt_picked_date::date       AS receipt_picked_date
FROM tmp_enriched e
LEFT JOIN adempiere.c_bpartner bp_v ON bp_v.c_bpartner_id = COALESCE(e.v_vendor_id, e.vendor_bp_id)
LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = e.v_mfr_id
LEFT JOIN adempiere.ad_user buyer ON buyer.ad_user_id = e.chuboe_buyer_id
LEFT JOIN adempiere.chuboe_rfq rfq ON rfq.chuboe_rfq_id = e.chuboe_rfq_id
LEFT JOIN adempiere.chuboe_rfq_type rtype ON rtype.chuboe_rfq_type_id = rfq.chuboe_rfq_type_id
LEFT JOIN adempiere.c_bpartner bp_c ON bp_c.c_bpartner_id = rfq.c_bpartner_id
LEFT JOIN adempiere.ad_user seller ON seller.ad_user_id = COALESCE(rfq.salesrep_id, e.po_salesrep_id, e.v_salesrep_id)
LEFT JOIN tmp_so_agg so ON so.chuboe_rfq_line_id = e.chuboe_rfq_line_id
LEFT JOIN tmp_insp_pick insp ON insp.chuboe_vq_line_id = e.chuboe_vq_line_id
LEFT JOIN tmp_recv_agg recv ON recv.c_orderline_id = e.c_orderline_id
ORDER BY e.po_date, e.infor_pov, e.po_line_no;

SELECT 'final' AS step, COUNT(*) AS rows FROM tmp_final;

\copy tmp_final TO '@OUT_CSV@' WITH CSV HEADER

-- ============================================================
-- MFR cumulative breakdown — top 50 by attributed revenue (fallback: spend)
-- ============================================================
DROP TABLE IF EXISTS tmp_mfr_agg;
CREATE TEMP TABLE tmp_mfr_agg AS
SELECT
  COALESCE(NULLIF(mfr,''),'(unknown)') AS mfr,
  COUNT(*)                                              AS po_lines,
  COUNT(DISTINCT supplier)                              AS supplier_count,
  COUNT(DISTINCT customer) FILTER (WHERE customer<>'')  AS customer_count,
  SUM(po_qty * po_price)                                AS spend,
  SUM(attributed_so_revenue)                            AS revenue,
  SUM(attributed_so_revenue - (po_qty * po_price))      AS booked_gp,
  CASE WHEN SUM(attributed_so_revenue) > 0
       THEN (SUM(attributed_so_revenue) - SUM(po_qty * po_price)) / SUM(attributed_so_revenue)
       ELSE NULL END                                    AS booked_margin_pct,
  COUNT(*) FILTER (WHERE otin_status IN ('VALIDATED','PROCESSED'))::numeric / NULLIF(COUNT(*),0) AS validation_rate,
  COUNT(*) FILTER (WHERE delivery_status='past_due')::numeric / NULLIF(COUNT(*),0)               AS past_due_rate
FROM tmp_final
GROUP BY COALESCE(NULLIF(mfr,''),'(unknown)')
ORDER BY spend DESC NULLS LAST;

\copy (SELECT * FROM tmp_mfr_agg ORDER BY spend DESC NULLS LAST LIMIT 50) TO '@OUT_MFR_CSV@' WITH CSV HEADER

-- ============================================================
-- VQ→PO+SO conversion (per CPC, cumulative over period)
--
-- Universe: distinct CPCs with at least one VQ created in period.
-- Conversion: same CPC also has BOTH a PO placed in period AND a sold CQ in period.
-- ============================================================
DROP TABLE IF EXISTS tmp_vq_universe;
CREATE TEMP TABLE tmp_vq_universe AS
SELECT DISTINCT
  rl.chuboe_cpc                                AS cpc,
  bp.name                                      AS customer
FROM adempiere.chuboe_vq_line v
JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = v.chuboe_rfq_line_id
LEFT JOIN adempiere.chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
LEFT JOIN adempiere.c_bpartner bp  ON bp.c_bpartner_id = rfq.c_bpartner_id
WHERE v.created >= '@START_DATE@'::date AND v.created < '@END_DATE@'::date
  AND v.isactive='Y' AND rl.isactive='Y'
  AND COALESCE(rl.chuboe_cpc,'') <> '';
CREATE INDEX ON tmp_vq_universe (cpc);

DROP TABLE IF EXISTS tmp_cpc_po;
CREATE TEMP TABLE tmp_cpc_po AS
SELECT DISTINCT rl.chuboe_cpc AS cpc
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o            ON o.c_order_id = ol.c_order_id
JOIN adempiere.chuboe_vq_line v     ON v.chuboe_vq_line_id = ol.chuboe_vq_line_id
JOIN adempiere.chuboe_rfq_line rl   ON rl.chuboe_rfq_line_id = v.chuboe_rfq_line_id
WHERE o.issotrx='N' AND o.dateordered >= '@START_DATE@'::date AND o.dateordered < '@END_DATE@'::date
  AND ol.isactive='Y' AND o.isactive='Y' AND ol.chuboe_po_string LIKE 'POV%'
  AND COALESCE(rl.chuboe_cpc,'') <> '';
CREATE INDEX ON tmp_cpc_po (cpc);

DROP TABLE IF EXISTS tmp_cpc_soldcq;
CREATE TEMP TABLE tmp_cpc_soldcq AS
SELECT DISTINCT rl.chuboe_cpc AS cpc
FROM adempiere.chuboe_cq_line c
JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = c.chuboe_rfq_line_id
WHERE c.issold='Y' AND c.isactive='Y' AND rl.isactive='Y'
  AND COALESCE(rl.chuboe_cpc,'') <> ''
  AND c.created >= '@START_DATE@'::date AND c.created < '@END_DATE@'::date;
CREATE INDEX ON tmp_cpc_soldcq (cpc);

-- Per-CPC conversion detail (one row per CPC; collapse duplicate customer rows)
DROP TABLE IF EXISTS tmp_conv_detail;
CREATE TEMP TABLE tmp_conv_detail AS
SELECT
  u.cpc,
  STRING_AGG(DISTINCT NULLIF(u.customer,''), ', ' ORDER BY NULLIF(u.customer,'')) AS customers,
  (u.cpc IN (SELECT cpc FROM tmp_cpc_po))      AS had_po,
  (u.cpc IN (SELECT cpc FROM tmp_cpc_soldcq))  AS had_soldcq,
  ((u.cpc IN (SELECT cpc FROM tmp_cpc_po)) AND (u.cpc IN (SELECT cpc FROM tmp_cpc_soldcq))) AS converted
FROM tmp_vq_universe u
GROUP BY u.cpc;

\copy (SELECT * FROM tmp_conv_detail ORDER BY converted DESC, had_po DESC, had_soldcq DESC, cpc) TO '@OUT_CONV_CSV@' WITH CSV HEADER

-- Console summary
SELECT
  COUNT(*)                                         AS cpcs_with_vq,
  COUNT(*) FILTER (WHERE had_po)                   AS cpcs_to_po,
  COUNT(*) FILTER (WHERE had_soldcq)               AS cpcs_to_soldcq,
  COUNT(*) FILTER (WHERE converted)                AS cpcs_to_po_and_soldcq,
  ROUND(100.0 * COUNT(*) FILTER (WHERE converted) / NULLIF(COUNT(*),0), 2) AS conversion_pct
FROM tmp_conv_detail;

-- Standard headline counts
SELECT
  COUNT(*)                                                              AS po_lines,
  COUNT(*) FILTER (WHERE COALESCE(po_tracking,'')<>'')                  AS lines_with_tracking,
  COUNT(*) FILTER (WHERE recv_qty > 0)                                  AS lines_received,
  COUNT(*) FILTER (WHERE insp_validated='Y')                            AS lines_validated,
  COUNT(*) FILTER (WHERE so_docs IS NOT NULL)                           AS lines_with_so_link,
  COUNT(DISTINCT infor_pov)                                             AS distinct_povs
FROM tmp_final;

-- OTIN-status breakdown
SELECT otin_status, COUNT(*) AS lines,
       ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (), 1) AS pct
FROM tmp_final
GROUP BY otin_status
ORDER BY lines DESC;

-- Delivery status breakdown
SELECT delivery_status, COUNT(*) AS lines,
       MIN(promise_date) AS earliest_promise,
       MAX(promise_date) AS latest_promise
FROM tmp_final
GROUP BY delivery_status
ORDER BY lines DESC;

SELECT 'done' AS step;
