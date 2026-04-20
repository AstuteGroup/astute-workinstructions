/**
 * R_Request Writer — enforced wrapper around approve-order POSTs.
 *
 * WHY IT EXISTS:
 *   `shared/r-requests.md` documents the canonical Approve-Order payload
 *   (routing to Jake, R_Status_ID=1000000, Chuboe_Approval_Text set at
 *   create time, etc.), and `shared/vq-purchase-validator.js` enforces
 *   the VQ-side preconditions. But nothing forces a caller to walk both
 *   doors before POSTing. This module is the single authorized path.
 *
 *   Callers DO NOT call `apiPost('r_request', ...)` directly for approve
 *   orders — they call `postApproveOrder()` which:
 *     1. Runs `validateVQForPurchase(vqId, { program })` and aborts on fail.
 *        The VQ must already be ticked (IsPurchased='Y') at this point;
 *        use `shared/vq-patcher.js` to tick it first.
 *     2. Forces the routing + status defaults that r-requests.md mandates.
 *     3. Fills Chuboe_Approval_Text AND Result (both, since Approval_Text
 *        is non-updateable post-POST and Result mirrors it for the
 *        "Message to User" panel).
 *
 * USAGE:
 *   const { postApproveOrder } = require('../shared/r-request-writer');
 *   const { id, documentNo } = await postApproveOrder({
 *     vqId:           2134052,
 *     program:        'LAM_KITTING',
 *     rfqId:          1142189,
 *     summary:        'approve order — Master R-78C3.3-1.0 (LAM Kitting)',
 *     approvalText:   'Line 270  R-78C3.3-1.0  5pcs @ $8.38  DC 24+  RECOM\nVendor: Master Electronics',
 *     priority:       '5',            // optional: 1 High / 5 Medium / 9 Low
 *   });
 *
 * DO NOT skip the validator. The history behind this gate is three
 * manually-caught approval bugs on 2026-04-20 (blank lead time, blank
 * promise date, internal content in public note, wrong warehouse group).
 */

const { apiPost } = require('./api-client');
const { validateVQForPurchase } = require('./vq-purchase-validator');

// Canonical routing — see feedback_r_request_route_to_jake.md.
const JAKE_USER_ID = 1000004;

// Canonical IDs — see shared/r-requests.md.
const APPROVE_ORDER_TYPE_ID = 1000000;
const SUBMITTED_STATUS_ID   = 1000000;
const AD_TABLE_CHUBOE_RFQ   = 1000002;

/**
 * Post an approve-order R_Request.
 *
 * @param {object} opts
 * @param {number} opts.vqId          The ticked VQ (IsPurchased='Y' must already be set).
 *                                    Validator runs against this VQ.
 * @param {string} opts.program       'LAM_KITTING' | 'LAM_EPG' | null
 * @param {number} opts.rfqId         chuboe_rfq_id (Record_ID for AD_Table_ID=1000002)
 * @param {string} opts.summary       Queue-list one-liner. Must start with "approve order — ".
 * @param {string} opts.approvalText  "Text to Approve" body. Use the canonical
 *                                    "Line N  MPN  Npcs @ $price  DC ..  MFR" format.
 * @param {string} [opts.priority='5'] '1' | '5' | '9'
 * @returns {object} { id, documentNo }
 * @throws {Error} if validator fails or required fields are missing
 */
async function postApproveOrder(opts = {}) {
  const { vqId, program = null, rfqId, summary, approvalText, priority = '5' } = opts;

  if (!vqId)          throw new Error('postApproveOrder: vqId is required');
  if (!rfqId)         throw new Error('postApproveOrder: rfqId is required');
  if (!summary)       throw new Error('postApproveOrder: summary is required');
  if (!approvalText)  throw new Error('postApproveOrder: approvalText is required');

  // Enforce summary convention — support pattern-matches on the prefix.
  if (!/^approve order\b/i.test(summary)) {
    throw new Error(`postApproveOrder: summary must start with "approve order —" (got: "${summary}")`);
  }

  // Validator gate. VQ must be in a purchasable state AND must be ticked;
  // the validator doesn't check IsPurchased itself since tick order isn't
  // enforced, but if it's not ticked support has nothing to approve.
  const report = await validateVQForPurchase(vqId, { program });
  if (!report.ok) {
    const err = new Error(
      `VQ ${vqId} failed validation — aborting R_Request POST. ` +
      `Fix violations and retry (use shared/vq-patcher.js to tick):\n  - ${report.violations.join('\n  - ')}`
    );
    err.violations = report.violations;
    throw err;
  }
  if (report.vq && report.vq.ispurchased !== 'Y') {
    throw new Error(
      `VQ ${vqId} is not ticked (IsPurchased='${report.vq.ispurchased}'). ` +
      `Call tickVQForPurchase() from shared/vq-patcher.js before posting the approval.`
    );
  }

  const result = await apiPost('r_request', {
    AD_Table_ID:          AD_TABLE_CHUBOE_RFQ,
    Record_ID:            rfqId,
    R_RequestType_ID:     APPROVE_ORDER_TYPE_ID,
    R_Status_ID:          SUBMITTED_STATUS_ID,
    AD_User_ID:           JAKE_USER_ID,
    SalesRep_ID:          JAKE_USER_ID,
    Priority:             priority,
    Summary:              summary,
    Chuboe_Approval_Text: approvalText,   // "Text to Approve" — non-updateable post-POST
    Result:               approvalText,   // "Message to User" — mirrors approval text
  });

  return { id: result.id, documentNo: result.DocumentNo };
}

module.exports = { postApproveOrder };
