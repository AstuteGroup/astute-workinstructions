/**
 * CQ Patcher — enforced wrapper around IsSold='Y' PATCH.
 *
 * Parallels shared/vq-patcher.js on the sell side. Callers DO NOT call
 * `patchRecord('chuboe_cq_line', id, { IsSold: 'Y' })` directly — they call
 * `markCQSold()` which:
 *   1. Looks up the winning VQ (IsPurchased='Y') on the same RFQ line.
 *   2. Mirrors GOODS-side fields from the VQ onto the CQ (warehouse, packaging,
 *      date code, RoHS, COO, lead time) — these describe WHAT is being shipped
 *      and WHERE it's coming from. Both sides always agree.
 *   3. Accepts CUSTOMER-side fields from the caller (DatePromised, ship-to BP
 *      location, shipper, incoterm, product code, lead-time ID, shipping acct).
 *      These come from the customer PO, not the VQ — customer promise date is
 *      NOT the vendor promise date, customer carrier is NOT the vendor carrier.
 *   4. Runs the validator and aborts loudly on any violation.
 *   5. PATCHes the whole bundle plus IsSold='Y', R_Status_ID=1000026 (Closed),
 *      POReference in ONE atomic call.
 *
 * USAGE:
 *   const { markCQSold } = require('../shared/cq-patcher');
 *   await markCQSold(cqId, {
 *     poReference:          '304068',       // customer PO#
 *     datePromised:         '2026-06-05',   // ship-promise date (from PO)
 *     dockDate:             '2026-06-05',   // when goods must reach customer dock (defaults to datePromised)
 *     bpartnerLocationId:   1002806,        // customer ship-to (c_bpartner_location_id)
 *     shipperId:            1000026,        // carrier from PO (UPS Ground, FedEx, etc.)
 *     incoTermId:           1000000,        // EXW is the stock-sale default
 *     productCodeId:        1000001,        // PA - Passives / DA - Digital Analog / etc.
 *     leadTimeId:           1000005,        // STOCK
 *     shippingAcct:         '124-121',      // optional — customer's account # from PO
 *     extra:                { },            // any other overrides
 *   });
 *
 * See shared/cq-sold-validator.js for validation rules.
 */

const { validateCQForSold } = require('./cq-sold-validator');
const { patchRecord } = require('./record-updater');

// CQ "Closed" status — matches the state OT leaves a sold CQ in.
const CLOSED_STATUS_ID = 1000026;

// Default C_UOM_ID (Each). Only applied when caller doesn't provide one.
const DEFAULT_UOM_ID = 100;

// VQ → CQ mirror map — GOODS-SIDE ONLY. Source keys are lowercase Postgres
// rows (from the validator query); payload keys are PascalCase API columns.
//
// Rule: only mirror fields that describe WHAT is being shipped and FROM WHERE.
// Customer-side fields (DatePromised, shipper, incoterm, ship-to) do NOT belong
// here — they come from the customer PO, not the VQ. Attempting to mirror
// DatePromised caused a bug on Masline PO 304068 (VQ promise 4/27 ≠ customer
// promise 6/5). Lesson: VQ and CQ promise dates are different commitments.
const VQ_TO_CQ_MIRROR = [
  ['chuboe_lead_time',          'Chuboe_Lead_Time'],     // STOCK / "3 Weeks" / etc.
  ['chuboe_date_code',          'Chuboe_Date_Code'],     // what's stamped on the parts
  ['chuboe_packaging_id',       'Chuboe_Packaging_ID'],  // REEL / CUT TAPE / BULK / etc.
  ['chuboe_rohs',               'Chuboe_RoHS'],          // Y / N
  ['c_country_id',              'C_Country_ID'],         // COO
  ['chuboe_warehouse_id',       'Chuboe_Warehouse_ID'],  // physical source
  ['chuboe_warehouse_group_id', 'Chuboe_Warehouse_Group_ID'],
];

/**
 * Mark a CQ line as sold. Mirrors goods-side fields from the winning VQ;
 * requires customer-side fields from the caller (sourced from the customer PO).
 *
 * @param {number} cqId                    chuboe_cq_line_id to mark sold
 * @param {object} opts
 * @param {string} opts.poReference        Customer PO# (required)
 * @param {string|Date} opts.datePromised  Customer due date from PO (required)
 * @param {number} opts.bpartnerLocationId Customer ship-to (c_bpartner_location_id) (required)
 * @param {number} opts.shipperId          Carrier (m_shipper_id) from PO (required)
 * @param {number} opts.incoTermId         Incoterm (chuboe_inco_term_id) — default EXW 1000000
 * @param {number} opts.productCodeId      Product code (chuboe_product_code_id) (required)
 * @param {number} opts.leadTimeId         Lead time lookup (chuboe_leadtime_id) — default STOCK 1000005
 * @param {string} [opts.shippingAcct]     Customer's carrier account # from PO (optional)
 * @param {number} [opts.uomId=100]        UOM — default Each
 * @param {object} [opts.extra]            Additional overrides / gap-fills
 * @param {boolean} [opts.allowCompetingSold=false]
 * @param {boolean} [opts.allowNoPurchasedVQ=false]
 * @returns {object} { cqId, marked: true, payload }
 * @throws {Error} with a `violations` list if the CQ can't be marked sold
 */
async function markCQSold(cqId, opts = {}) {
  const {
    poReference,
    datePromised,
    dockDate,                // defaults to datePromised if unset
    bpartnerLocationId,
    shipperId,
    incoTermId = 1000000,    // EXW default
    productCodeId,
    leadTimeId = 1000005,    // STOCK default
    shippingAcct = null,
    uomId = DEFAULT_UOM_ID,
    extra = {},
    allowCompetingSold = false,
    allowNoPurchasedVQ = false,
  } = opts;
  const dockDateEffective = dockDate || datePromised;

  // Required from caller (no sensible default)
  if (!poReference)        throw new Error('markCQSold: poReference is required');
  if (!datePromised)       throw new Error('markCQSold: datePromised (customer PO due date) is required');
  if (!bpartnerLocationId) throw new Error('markCQSold: bpartnerLocationId (customer ship-to) is required');
  if (!shipperId)          throw new Error('markCQSold: shipperId (customer carrier from PO) is required');
  if (!productCodeId)      throw new Error('markCQSold: productCodeId is required');

  // Peek at current CQ state + fetch the purchased VQ.
  const peek = await validateCQForSold(cqId, { allowCompetingSold, allowNoPurchasedVQ });
  if (!peek.cq) {
    throw new Error(`markCQSold: CQ ${cqId} not found`);
  }
  if (!peek.purchasedVq && !allowNoPurchasedVQ) {
    throw new Error(
      `markCQSold: no purchased VQ on RFQ line ${peek.cq.chuboe_rfq_line_id}. ` +
      `Tick the winning VQ first via shared/vq-patcher.js.`
    );
  }

  // Build goods-side mirror from the purchased VQ.
  const mirrored = {};
  if (peek.purchasedVq) {
    for (const [src, dst] of VQ_TO_CQ_MIRROR) {
      const v = peek.purchasedVq[src];
      if (v !== null && v !== undefined && v !== '') mirrored[dst] = v;
    }
  }

  // Customer-side (PO-derived) fields.
  const customerSide = {
    DatePromised:           datePromised,
    DateNextAction:         dockDateEffective,  // "Dock Date" in OT UI
    C_BPartner_Location_ID: bpartnerLocationId,
    M_Shipper_ID:           shipperId,
    Chuboe_Inco_Term_ID:    incoTermId,
    Chuboe_Product_Code_ID: productCodeId,
    Chuboe_LeadTime_ID:     leadTimeId,
    C_UOM_ID:               uomId,
  };
  if (shippingAcct) customerSide.Chuboe_ShippingAcct = shippingAcct;

  // Compose the PATCH. Precedence: mirror → customer-side → extras → sold markers.
  const payload = {
    ...mirrored,
    ...customerSide,
    ...extra,
    IsSold: 'Y',
    R_Status_ID: CLOSED_STATUS_ID,
    POReference: poReference,
  };

  await patchRecord('chuboe_cq_line', cqId, payload);

  const report = await validateCQForSold(cqId, { allowCompetingSold, allowNoPurchasedVQ });
  if (!report.ok) {
    const err = new Error(
      `CQ ${cqId} failed post-PATCH validation — state may be inconsistent. ` +
      `Fix violations and retry:\n  - ${report.violations.join('\n  - ')}`
    );
    err.violations = report.violations;
    err.cqId = cqId;
    throw err;
  }

  return { cqId, marked: true, payload };
}

module.exports = { markCQSold };
