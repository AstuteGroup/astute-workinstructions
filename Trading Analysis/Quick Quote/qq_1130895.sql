-- Quick Quote for RFQ 1130895 (Sanmina Corporation)
-- Generated: 2026-03-10
-- Parameters: 15% min margin, $250 min GP, 30% fat margin fallback

WITH rfq_lines AS (
  SELECT
    COALESCE(rlm.chuboe_cpc, rlm.chuboe_mpn) AS cpc,
    rlm.chuboe_mpn AS rfq_mpn,
    rlm.chuboe_mpn_clean,
    rlm.qty AS rfq_qty,
    rlm.priceentered AS rfq_target,
    r.created AS rfq_created,
    r.c_bpartner_id AS rfq_customer_id,
    bp.name AS rfq_customer
  FROM adempiere.chuboe_rfq r
  JOIN adempiere.chuboe_rfq_line_mpn rlm ON r.chuboe_rfq_id = rlm.chuboe_rfq_id
  LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
  WHERE r.value = '1130895'
    AND rlm.priceentered > 0
),

recent_vqs AS (
  SELECT
    vql.vendor_quote_mpn_clean,
    vql.vendor_quote_mpn AS vq_mpn,
    vql.vendor_quote_bpartner_name AS supplier,
    vql.vendor_quote_cost AS vq_cost,
    vql.vendor_quote_quantity AS vq_qty,
    vql.vendor_quote_date_code AS date_code,
    vql.vendor_quote_lead_time AS lead_time,
    vql.vendor_quote_created AS vq_created,
    EXTRACT(DAY FROM CURRENT_TIMESTAMP - vql.vendor_quote_created)::int AS days_old
  FROM adempiere.bi_vendor_quote_line_v vql
  WHERE vql.vendor_quote_created >= CURRENT_DATE - INTERVAL '30 days'
    AND vql.vendor_quote_cost > 0
),

sales_history AS (
  SELECT
    ol.chuboe_mpn_clean,
    ol.chuboe_mpn,
    o.c_bpartner_id AS sale_customer_id,
    bp.name AS sale_customer,
    ol.priceentered AS sale_price,
    ol.qtyentered AS sale_qty,
    o.dateordered AS sale_date,
    o.documentno AS order_no,
    CASE
      WHEN o.c_doctype_id IN (SELECT c_doctype_id FROM adempiere.c_doctype WHERE name ILIKE '%ppv%') THEN 'PPV'
      WHEN o.c_doctype_id IN (SELECT c_doctype_id FROM adempiere.c_doctype WHERE name ILIKE '%shortage%') THEN 'Shortage'
      ELSE 'Standard'
    END AS sale_type
  FROM adempiere.c_orderline ol
  JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
  LEFT JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
  WHERE o.dateordered >= CURRENT_DATE - INTERVAL '12 months'
    AND o.docstatus IN ('CO', 'CL')
    AND ol.priceentered > 0
),

vq_matches AS (
  SELECT
    rl.cpc,
    rl.rfq_mpn,
    rl.rfq_target,
    rl.rfq_qty,
    rl.rfq_customer_id,
    rl.rfq_customer,
    vq.vq_mpn AS source_mpn,
    vq.supplier,
    vq.vq_cost,
    vq.vq_qty AS source_qty,
    vq.date_code,
    vq.lead_time,
    vq.days_old,
    GREATEST(
      vq.vq_cost / 0.85,
      vq.vq_cost + 250.0 / NULLIF(rl.rfq_qty, 0)
    ) AS floor_price,
    CASE
      WHEN vq.days_old <= 14 THEN 'High'
      ELSE 'Medium'
    END AS confidence,
    'VQ' AS source_type,
    (SELECT sh.sale_price FROM sales_history sh
     WHERE sh.chuboe_mpn_clean = rl.chuboe_mpn_clean
       AND sh.sale_customer_id = rl.rfq_customer_id
       AND sh.sale_type = 'PPV'
     ORDER BY sh.sale_date DESC LIMIT 1) AS same_cust_ppv_price,
    (SELECT sh.sale_price FROM sales_history sh
     WHERE sh.chuboe_mpn_clean = rl.chuboe_mpn_clean
       AND sh.sale_customer_id = rl.rfq_customer_id
       AND sh.sale_type = 'Shortage'
     ORDER BY sh.sale_date DESC LIMIT 1) AS same_cust_shortage_price,
    (SELECT sh.sale_price FROM sales_history sh
     WHERE sh.chuboe_mpn_clean = rl.chuboe_mpn_clean
       AND sh.sale_customer_id != rl.rfq_customer_id
       AND sh.sale_date >= CURRENT_DATE - INTERVAL '6 months'
     ORDER BY sh.sale_date DESC LIMIT 1) AS other_cust_price,
    (SELECT STRING_AGG(
      sh.sale_customer || ' (' || sh.sale_type || ') $' || ROUND(sh.sale_price::numeric, 2) || ' ' || TO_CHAR(sh.sale_date, 'MM/DD'),
      '; ' ORDER BY sh.sale_date DESC
    ) FROM (
      SELECT DISTINCT ON (sale_customer_id, sale_type) *
      FROM sales_history
      WHERE chuboe_mpn_clean = rl.chuboe_mpn_clean
      ORDER BY sale_customer_id, sale_type, sale_date DESC
    ) sh) AS sales_history_summary
  FROM rfq_lines rl
  JOIN recent_vqs vq ON vq.vendor_quote_mpn_clean = rl.chuboe_mpn_clean
  WHERE (
    vq.date_code IS NULL
    OR vq.date_code = ''
    OR vq.date_code ~ '[Ww][Kk]|[Ll][Ee][Aa][Dd]|[Dd][Aa][Yy]'
    OR SUBSTRING(vq.date_code FROM '[0-9]{2}') >= '22'
    OR SUBSTRING(vq.date_code FROM '[0-9]{4}') >= '2022'
  )
),

priced_vqs AS (
  SELECT
    vm.*,
    CASE
      WHEN vm.same_cust_ppv_price IS NOT NULL THEN
        GREATEST(vm.floor_price, vm.same_cust_ppv_price)
      WHEN vm.same_cust_shortage_price IS NOT NULL THEN
        GREATEST(vm.floor_price, vm.same_cust_shortage_price)
      WHEN vm.other_cust_price IS NOT NULL THEN
        GREATEST(vm.floor_price, vm.floor_price + (vm.other_cust_price - vm.floor_price) * 0.5)
      WHEN (vm.rfq_target - vm.vq_cost) / NULLIF(vm.rfq_target, 0) <= 0.35 THEN
        GREATEST(vm.floor_price, vm.rfq_target)
      ELSE
        GREATEST(vm.floor_price, vm.vq_cost / 0.70)
    END AS suggested_resale,
    CASE
      WHEN vm.same_cust_ppv_price IS NOT NULL THEN 'Same-cust PPV'
      WHEN vm.same_cust_shortage_price IS NOT NULL THEN 'Same-cust Shortage'
      WHEN vm.other_cust_price IS NOT NULL THEN 'Other-cust split'
      WHEN (vm.rfq_target - vm.vq_cost) / NULLIF(vm.rfq_target, 0) <= 0.35 THEN 'Target (margin OK)'
      ELSE 'Cost-based 30%'
    END AS resale_basis
  FROM vq_matches vm
)

SELECT
  pv.cpc AS "CPC",
  pv.source_type AS "Type",
  CASE
    WHEN pv.source_qty = 0 THEN 'VERIFY QTY'
    WHEN pv.suggested_resale <= pv.rfq_target THEN 'UNDER'
    ELSE 'OVER'
  END AS "vs Target",
  ROUND(pv.rfq_target::numeric, 4) AS "RFQ Target",
  pv.rfq_qty AS "RFQ Qty",
  pv.source_mpn AS "Source MPN",
  pv.supplier AS "Supplier",
  ROUND(pv.vq_cost::numeric, 4) AS "VQ Cost",
  pv.source_qty AS "Source Qty",
  pv.date_code AS "Date Code",
  ROUND(pv.floor_price::numeric, 4) AS "Floor Price",
  ROUND(pv.suggested_resale::numeric, 4) AS "Suggested Resale",
  pv.resale_basis AS "Resale Basis",
  ROUND(((pv.rfq_target - pv.suggested_resale) / NULLIF(pv.rfq_target, 0) * 100)::numeric, 1) AS "% Under Tgt",
  ROUND(((pv.suggested_resale - pv.vq_cost) * LEAST(pv.source_qty, pv.rfq_qty))::numeric, 2) AS "Quoted GP",
  ROUND((pv.source_qty::numeric / NULLIF(pv.rfq_qty, 0) * 100)::numeric, 0) AS "% Demand",
  ROUND((pv.rfq_target * pv.rfq_qty)::numeric, 2) AS "Opp Amount",
  pv.confidence AS "Confidence",
  pv.days_old AS "Days Btw",
  pv.sales_history_summary AS "Sales History",
  pv.rfq_customer AS "Customer"
FROM priced_vqs pv
WHERE (
  pv.floor_price <= pv.rfq_target * 1.20
  OR pv.sales_history_summary IS NOT NULL
)
ORDER BY
  CASE
    WHEN pv.source_qty = 0 THEN 2
    WHEN pv.suggested_resale <= pv.rfq_target THEN 1
    ELSE 3
  END,
  ((pv.rfq_target - pv.suggested_resale) / NULLIF(pv.rfq_target, 0)) DESC;
