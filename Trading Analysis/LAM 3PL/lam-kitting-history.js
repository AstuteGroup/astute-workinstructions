/**
 * LAM Kitting Historical Data Module
 *
 * Shared OT queries for historical purchase data, RFQ history, and pending orders.
 * Used by both lam-kitting-reorder.js and new awards handler.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const { normalizeMPN } = require('../../shared/mpn-normalization');

// ─── SQL EXECUTION HELPER ──────────────────────────────────────────────────────

function runPsql(sql, label) {
  const tmpDir = os.tmpdir();
  const tmpSql = path.join(tmpDir, `lam_${label}_${Date.now()}.sql`);
  const tmpOut = path.join(tmpDir, `lam_${label}_${Date.now()}.out`);
  fs.writeFileSync(tmpSql, sql);
  try {
    execSync(`psql -U analytics_user -d idempiere_replica -t -A -F '|' -f ${tmpSql} -o ${tmpOut}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
      console.error(`  WARNING: psql ${label} failed: ${(e.message || '').slice(0, 300)}`);
    }
  }
  const result = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
  // Cleanup
  try { fs.unlinkSync(tmpSql); } catch {}
  try { fs.unlinkSync(tmpOut); } catch {}
  return result;
}

// ─── HISTORICAL PURCHASE DATA ──────────────────────────────────────────────────

/**
 * Load historical purchase data for a set of MPNs.
 * Returns: { [normalizedMPN]: { OT_Previous_Supplier, Historical_Purchase_Price, ... } }
 */
function loadHistoricalPurchaseData(mpns) {
  if (!mpns || mpns.length === 0) return {};

  // Query A: most recent closed LAM PO per MPN
  const sqlClosedPO = `
    WITH lam_purchases AS (
      SELECT
        TRIM(ol.chuboe_mpn) as chuboe_mpn,
        bp.name as supplier_name,
        ol.priceentered as purchase_price,
        ol.datepromised,
        u.name as buyer_name,
        CASE WHEN ol.chuboe_po_string LIKE 'POV%' THEN ol.chuboe_po_string ELSE '' END as pov_number,
        ROW_NUMBER() OVER (PARTITION BY TRIM(ol.chuboe_mpn) ORDER BY ol.datepromised DESC NULLS LAST) as rn
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.ad_user u ON o.createdby = u.ad_user_id
      LEFT JOIN adempiere.chuboe_vq_line vl ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
      LEFT JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND o.docstatus IN ('CO', 'IP')
        AND ol.qtyordered > 0
        AND ol.chuboe_mpn IS NOT NULL
        AND ol.chuboe_mpn != ''
        AND rfq.c_bpartner_id = 1000730
    )
    SELECT chuboe_mpn, supplier_name, purchase_price, buyer_name,
      datepromised::date, pov_number
    FROM lam_purchases
    WHERE rn = 1;
  `;

  // Query B: most recent LAM RFQ per MPN
  const sqlLastRFQ = `
    SELECT DISTINCT ON (TRIM(rlm.chuboe_mpn))
      TRIM(rlm.chuboe_mpn) as mpn,
      rfq.value as rfq_number,
      rfq.created::date as rfq_date
    FROM adempiere.chuboe_rfq rfq
    JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rfq.c_bpartner_id = 1000730
      AND rfq.isactive = 'Y'
      AND rfq.created::date < CURRENT_DATE
      AND rlm.chuboe_mpn IS NOT NULL
      AND rlm.chuboe_mpn != ''
    ORDER BY TRIM(rlm.chuboe_mpn), rfq.created DESC;
  `;

  const historicalData = {};

  // Closed-PO history
  const closedResult = runPsql(sqlClosedPO, 'history');
  for (const line of closedResult.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [mpn, supplier, price, buyer, dateordered, povNum] = line.split('|');
    const key = normalizeMPN(mpn);
    if (key) {
      historicalData[key] = {
        OT_Previous_Supplier: (supplier || '').trim(),
        Historical_Purchase_Price: parseFloat(price) || 0,
        OT_Buyer: (buyer || '').trim(),
        Last_Purchase_Date: (dateordered || '').trim(),
        POV_Number: (povNum || '').trim(),
        RFQ_Number: '',
        RFQ_Customer: 'Lam Research'
      };
    }
  }

  // Latest LAM RFQ
  const rfqResult = runPsql(sqlLastRFQ, 'last_rfq');
  for (const line of rfqResult.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const [mpn, rfqNum, rfqDate] = line.split('|');
    const key = normalizeMPN(mpn);
    if (key) {
      if (!historicalData[key]) {
        historicalData[key] = {
          OT_Previous_Supplier: '', Historical_Purchase_Price: 0, OT_Buyer: '',
          Last_Purchase_Date: '', POV_Number: '',
          RFQ_Number: '', RFQ_Customer: 'Lam Research'
        };
      }
      historicalData[key].RFQ_Number = (rfqNum || '').trim();
      historicalData[key].RFQ_Date = (rfqDate || '').trim();
    }
  }

  return historicalData;
}

// ─── PENDING ORDER DATA (Recent POV) ───────────────────────────────────────────

/**
 * Load pending order data by CPC.
 * Returns: { [CPC]: { Qty_On_Order, OT_PO_Number, POV_Number, Supplier, Promise_Date, ... } }
 */
function loadPendingOrderData() {
  const sql = `
    WITH all_activity AS (
      -- Open POs (with or without Infor POV stamp)
      SELECT
        TRIM(rl.chuboe_cpc) AS cpc,
        TRIM(ol.chuboe_mpn) AS mpn,
        CASE WHEN ol.chuboe_po_string LIKE 'POV%' THEN ol.chuboe_po_string ELSE '' END AS pov_number,
        o.documentno AS ot_po_number,
        (ol.qtyordered - ol.qtydelivered) AS qty,
        ol.datepromised::date AS promise_date,
        o.created::date AS po_created_date,
        bp.name AS supplier,
        rfq.value AS rfq_number,
        'PO' AS state,
        1 AS preference,
        COALESCE(ol.datepromised, o.created) AS sort_date,
        COALESCE(ol.chuboe_trackingnumbers, '') AS tracking,
        u_buyer.name AS buyer
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      JOIN adempiere.chuboe_vq_line vl ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
      JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line rl ON vl.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      LEFT JOIN adempiere.ad_user u_buyer ON vl.chuboe_buyer_id = u_buyer.ad_user_id
      WHERE o.issotrx = 'N'
        AND o.isactive = 'Y'
        AND o.docstatus IN ('CO', 'IP')
        AND (ol.qtyordered - ol.qtydelivered) > 0
        AND rfq.c_bpartner_id = 1000730
        AND (
          o.created >= CURRENT_DATE - INTERVAL '90 days'
          OR ol.datepromised >= CURRENT_DATE
        )

      UNION ALL

      -- VQ ticked but no PO cut yet
      SELECT
        TRIM(rl.chuboe_cpc) AS cpc,
        TRIM(vl.chuboe_mpn) AS mpn,
        '' AS pov_number,
        '' AS ot_po_number,
        vl.qty AS qty,
        vl.datepromised::date AS promise_date,
        rfq.created::date AS po_created_date,
        bp.name AS supplier,
        rfq.value AS rfq_number,
        'VQ_TICKED' AS state,
        2 AS preference,
        COALESCE(vl.datepromised, rfq.created) AS sort_date,
        '' AS tracking,
        u_buyer.name AS buyer
      FROM adempiere.chuboe_vq_line vl
      JOIN adempiere.chuboe_rfq_line rl ON vl.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
      JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.ad_user u_buyer ON vl.chuboe_buyer_id = u_buyer.ad_user_id
      WHERE vl.isactive = 'Y'
        AND vl.ispurchased = 'Y'
        AND NOT EXISTS (
          SELECT 1 FROM adempiere.c_orderline ol2
          WHERE ol2.chuboe_vq_line_id = vl.chuboe_vq_line_id
            AND ol2.isactive = 'Y'
        )
        AND rfq.c_bpartner_id = 1000730
        AND (
          rfq.created >= CURRENT_DATE - INTERVAL '90 days'
          OR vl.datepromised >= CURRENT_DATE
        )
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY cpc ORDER BY preference, sort_date DESC) AS rn,
        SUM(qty) OVER (PARTITION BY cpc) AS total_on_order
      FROM all_activity
    )
    SELECT cpc, mpn, pov_number, ot_po_number, qty, promise_date, po_created_date,
           supplier, rfq_number, state, tracking, buyer, total_on_order
    FROM ranked WHERE rn = 1;
  `;

  const pendingData = {};
  const result = runPsql(sql, 'pending');

  for (const line of result.trim().split('\n').filter(l => l.trim() && l.includes('|'))) {
    const parts = line.split('|');
    const [cpc, mpn, povNum, otPo, qty, promiseDate, poCreatedDate, supplier, rfqNum, state, tracking, buyer, totalOnOrder] = parts;
    if (cpc) {
      pendingData[cpc.trim()] = {
        CPC: cpc.trim(),
        Purchased_MPN: mpn ? mpn.trim() : '',
        POV_Number: povNum ? povNum.trim() : '',
        OT_PO_Number: otPo ? otPo.trim() : '',
        POV_Qty: parseInt(qty) || 0,
        POV_Date: promiseDate ? promiseDate.trim() : '',
        PO_Created_Date: poCreatedDate ? poCreatedDate.trim() : '',
        POV_Supplier: supplier ? supplier.trim() : '',
        RFQ_Number: rfqNum ? rfqNum.trim() : '',
        State: state ? state.trim() : '',
        Tracking: tracking ? tracking.trim() : '',
        Buyer: buyer ? buyer.trim() : '',
        Qty_On_Order: parseInt(totalOnOrder) || 0,
      };
    }
  }

  return pendingData;
}

// ─── FORMAT HELPERS ────────────────────────────────────────────────────────────

function formatPOVCell(pov) {
  if (!pov) return '';
  const rfqTag = pov.RFQ_Number ? ` [RFQ ${pov.RFQ_Number}]` : '';

  if (pov.State === 'PO') {
    const id = pov.POV_Number || pov.OT_PO_Number || 'PO';
    const datePart = pov.PO_Created_Date ? `${pov.PO_Created_Date}, ` : '';
    return `${id} (${datePart}${pov.POV_Qty} pcs from ${pov.POV_Supplier}${rfqTag})`;
  }
  if (pov.State === 'VQ_TICKED') {
    return `VQ ticked - PO pending (${pov.POV_Qty} pcs from ${pov.POV_Supplier}${rfqTag})`;
  }
  return '';
}

module.exports = {
  loadHistoricalPurchaseData,
  loadPendingOrderData,
  formatPOVCell,
};
