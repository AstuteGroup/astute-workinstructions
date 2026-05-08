/**
 * CQ Sold Validator — pre-flight gate for PATCHing IsSold='Y' on a CQ line.
 *
 * Parallels shared/vq-purchase-validator.js on the sell side. An approved CQ
 * that becomes an SO must have matching operational details against the winning
 * VQ — ship date, lead time, date code, packaging, COO — otherwise the SO lands
 * with inconsistent / blank fields and support has to chase them down.
 *
 * USAGE (always call before PATCHing IsSold='Y'):
 *   const { validateCQForSold } = require('../shared/cq-sold-validator');
 *   const report = await validateCQForSold(cqId);
 *   if (!report.ok) {
 *     console.error('CQ cannot be marked sold — violations:');
 *     report.violations.forEach(v => console.error(`  - ${v}`));
 *     throw new Error(`Aborting sold-mark for CQ ${cqId}`);
 *   }
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

/**
 * Validate a CQ line for sold-state readiness.
 *
 * @param {number} cqId  chuboe_cq_line_id
 * @param {object} opts
 * @param {boolean} [opts.allowCompetingSold=false]  Legitimate multi-sold case
 *   (e.g., line qty split across date-code lots, each its own CQ). Default is
 *   to reject — only one winner per RFQ line matches the standard flow.
 * @param {boolean} [opts.allowNoPurchasedVQ=false]  Edge case: back-dated
 *   sold-marks on CQs whose VQ chain was never captured. Default is to reject.
 * @returns {object} { ok, violations, cq, purchasedVq }
 */
async function validateCQForSold(cqId, opts = {}) {
  const { allowCompetingSold = false, allowNoPurchasedVQ = false } = opts;

  const { rows } = await pool.query(`
    SELECT cq.chuboe_cq_line_id, cq.chuboe_rfq_line_id, cq.chuboe_rfq_id,
           cq.chuboe_mpn, cq.qty, cq.priceentered, cq.issold,
           cq.poreference, cq.datepromised, cq.chuboe_lead_time,
           cq.chuboe_date_code, cq.chuboe_packaging_id, cq.chuboe_rohs,
           cq.c_country_id, cq.chuboe_warehouse_id, cq.chuboe_warehouse_group_id,
           cq.c_bpartner_id, cq.c_bpartner_location_id, cq.m_shipper_id,
           cq.chuboe_inco_term_id, cq.chuboe_product_code_id,
           cq.chuboe_leadtime_id, cq.c_uom_id, cq.datenextaction, cq.isactive
    FROM adempiere.chuboe_cq_line cq
    WHERE cq.chuboe_cq_line_id = $1
  `, [cqId]);

  if (rows.length === 0) {
    return { ok: false, violations: [`CQ ${cqId} not found`], cq: null, purchasedVq: null };
  }
  const cq = rows[0];
  const violations = [];

  if (cq.isactive !== 'Y') violations.push(`CQ ${cqId} is inactive (isactive='${cq.isactive}')`);

  // Core identity
  if (!cq.chuboe_mpn) violations.push('Chuboe_MPN is blank');
  if (!cq.c_bpartner_id) violations.push('C_BPartner_ID is blank (no customer)');
  if (cq.priceentered === null || Number(cq.priceentered) <= 0) {
    violations.push(`PriceEntered is ${cq.priceentered} (must be > 0)`);
  }
  if (!cq.qty || Number(cq.qty) <= 0) violations.push(`Qty is ${cq.qty} (must be > 0)`);
  if (!cq.chuboe_rfq_line_id) violations.push('Chuboe_RFQ_Line_ID is blank — cannot link to winning VQ');

  // Sold-state fields — what the SO needs. Split into two groups.
  //
  // Customer-side (comes from the customer PO — caller must supply at sold time):
  if (!cq.poreference)            violations.push('POReference is blank (required — customer PO#)');
  if (!cq.datepromised)            violations.push('DatePromised is blank (required — customer due date from PO)');
  if (!cq.datenextaction)          violations.push('DateNextAction is blank (required — "Dock Date" in OT; usually = DatePromised)');
  if (!cq.c_bpartner_location_id)  violations.push('C_BPartner_Location_ID is blank (required — customer ship-to)');
  if (!cq.m_shipper_id)            violations.push('M_Shipper_ID is blank (required — carrier from PO)');
  if (!cq.chuboe_inco_term_id)     violations.push('Chuboe_Inco_Term_ID is blank (required — incoterm, default EXW)');
  if (!cq.chuboe_product_code_id)  violations.push('Chuboe_Product_Code_ID is blank (required — MFR category, e.g. PA Passives)');
  if (!cq.chuboe_leadtime_id)      violations.push('Chuboe_LeadTime_ID is blank (required — STOCK / lead-time lookup)');
  if (!cq.c_uom_id)                violations.push('C_UOM_ID is blank (required — Each/100 default)');
  // Goods-side (mirrored from the winning VQ — must be populated):
  if (!cq.chuboe_lead_time)        violations.push('Chuboe_Lead_Time is blank (required — text form, "STOCK" / "3 Weeks")');

  // Find the winning (purchased) VQ on the same RFQ line — source of truth for operational fields
  let purchasedVq = null;
  if (cq.chuboe_rfq_line_id) {
    const { rows: vqRows } = await pool.query(`
      SELECT chuboe_vq_line_id, chuboe_mpn, cost, qty, c_bpartner_id,
             datepromised, chuboe_lead_time, chuboe_date_code,
             chuboe_packaging_id, chuboe_rohs, c_country_id,
             chuboe_warehouse_id, chuboe_warehouse_group_id, ispurchased
      FROM adempiere.chuboe_vq_line
      WHERE chuboe_rfq_line_id = $1
        AND isactive = 'Y'
        AND ispurchased = 'Y'
      ORDER BY created DESC
    `, [cq.chuboe_rfq_line_id]);

    if (vqRows.length === 0 && !allowNoPurchasedVQ) {
      violations.push(
        `No purchased VQ (IsPurchased='Y') on RFQ line ${cq.chuboe_rfq_line_id}. ` +
        `Tick the winning VQ first via shared/vq-patcher.js, then mark the CQ sold. ` +
        `If this is a back-dated sold-mark, pass allowNoPurchasedVQ=true.`
      );
    } else if (vqRows.length > 0) {
      purchasedVq = vqRows[0]; // most recent purchased VQ
    }
  }

  // Sanity check: GOODS-SIDE fields must MATCH the winning VQ (same physical
  // parts shipped from same physical location). DatePromised is NOT in this
  // list — VQ promise (vendor → us) and CQ promise (us → customer) are
  // separate commitments.
  if (purchasedVq) {
    const mustMatch = [
      ['chuboe_lead_time',         'Chuboe_Lead_Time'],
      ['chuboe_date_code',         'Chuboe_Date_Code'],
      ['chuboe_packaging_id',      'Chuboe_Packaging_ID'],
      ['chuboe_rohs',              'Chuboe_RoHS'],
      ['chuboe_warehouse_id',      'Chuboe_Warehouse_ID'],
      ['chuboe_warehouse_group_id','Chuboe_Warehouse_Group_ID'],
    ];
    for (const [col, label] of mustMatch) {
      const cqVal = cq[col];
      const vqVal = purchasedVq[col];
      if (cqVal === null || cqVal === undefined || cqVal === '') continue; // blank caught above
      if (vqVal === null || vqVal === undefined || vqVal === '') continue; // VQ missing — not our job here
      const sameVal = String(cqVal).trim() === String(vqVal).trim();
      if (!sameVal) {
        violations.push(
          `${label} mismatch vs purchased VQ: CQ="${cqVal}" / VQ="${vqVal}". ` +
          `Mirror the VQ value onto the CQ before marking sold.`
        );
      }
    }
  }

  // Competing sold CQs on the same line
  if (cq.chuboe_rfq_line_id && !allowCompetingSold) {
    const { rows: competing } = await pool.query(`
      SELECT chuboe_cq_line_id, c_bpartner_id
      FROM adempiere.chuboe_cq_line
      WHERE chuboe_rfq_line_id = $1
        AND chuboe_cq_line_id <> $2
        AND isactive = 'Y'
        AND issold = 'Y'
    `, [cq.chuboe_rfq_line_id, cqId]);
    if (competing.length > 0) {
      const ids = competing.map(r => r.chuboe_cq_line_id).join(', ');
      violations.push(
        `Competing CQ(s) on the same RFQ line already marked IsSold=Y: ${ids}. ` +
        `Unmark them before proceeding (one winner per line). ` +
        `If this is a legitimate split-sell case, pass allowCompetingSold=true.`
      );
    }
  }

  return { ok: violations.length === 0, violations, cq, purchasedVq };
}

module.exports = { validateCQForSold };
