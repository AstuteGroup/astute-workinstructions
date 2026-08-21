/**
 * VQ Patcher — enforced wrappers for VQ modifications.
 *
 * EXPORTS:
 *   - tickVQForPurchase(vqId, opts) — tick IsPurchased='Y' with validation
 *   - correctVQ(vqId, corrections)  — correct vendor/buyer/other fields on existing VQ
 *
 * WHY IT EXISTS:
 *   `shared/vq-purchase-validator.js` turns the approval checklist into an
 *   enforced gate, but nothing forces callers to invoke it. This module is
 *   the single authorized path to tick a VQ as purchased. Callers DO NOT
 *   call `patchRecord('chuboe_vq_line', id, { IsPurchased: 'Y' })` directly
 *   — they call `tickVQForPurchase()` which runs the validator first and
 *   aborts loudly on any violation.
 *
 * USAGE (tick for purchase):
 *   const { tickVQForPurchase } = require('../shared/vq-patcher');
 *   await tickVQForPurchase(vqId, {
 *     program: 'LAM_KITTING',
 *     extra: { Chuboe_Lead_Time: 'STOCK - 1 WEEK', DatePromised: '2026-04-24' },
 *   });
 *
 * USAGE (correct vendor/buyer):
 *   const { correctVQ } = require('../shared/vq-patcher');
 *   await correctVQ(vqId, {
 *     vendorBpId: 1011486,           // new vendor
 *     vendorLocationId: 1016091,     // new vendor location
 *     buyerId: 1042105,              // new buyer
 *     reason: 'Wrong vendor loaded — Ezkey should be E-KEY Components GmbH',
 *   });
 *
 * The `extra` object lets callers fill gaps the validator flagged (common
 * pattern: fetch VQ, see what's missing, supply it alongside the tick). If
 * the validator still reports violations after the extras are applied, the
 * call aborts before any PATCH is sent — guarantees the DB is either in a
 * fully-valid purchase state or untouched.
 *
 * BUYER CLEANUP (2026-07-08):
 *   Claude Harris (1049524) is the API user and should NOT be a buyer on VQs.
 *   If the VQ has Claude Harris as the buyer at tick time, this module auto-
 *   corrects it to Jake Harris (1000004) unless a different buyer is specified
 *   via opts.buyerId.
 */

const { validateVQForPurchase } = require('./vq-purchase-validator');
const { patchRecord } = require('./record-updater');

// Claude Harris = API user, should not be a buyer
const CLAUDE_HARRIS_USER_ID = 1049524;
// Default buyer when Claude Harris is detected
const JAKE_HARRIS_USER_ID = 1000004;

/**
 * Tick a VQ as purchased. Enforces the pre-approval checklist via the validator.
 *
 * @param {number} vqId                    chuboe_vq_line_id to tick
 * @param {object} opts
 * @param {string} opts.program            'LAM_KITTING' | null
 * @param {object} [opts.extra]            additional fields to PATCH alongside
 *                                         IsPurchased='Y' (DatePromised, etc.).
 *                                         Applied in a single PATCH so the
 *                                         validator sees the final state.
 * @param {number} [opts.buyerId]          Override buyer. If not specified and
 *                                         current buyer is Claude Harris, auto-
 *                                         corrects to Jake Harris.
 * @param {boolean} [opts.skipUntickCompeting=false]
 *                                         If true, skip the auto-untick of
 *                                         competing VQs. Default is to untick
 *                                         them first so only one winner remains.
 * @returns {object} { vqId, ticked: true, untickedCompeting: number[], buyerCorrected: boolean }
 * @throws {Error} with a `violations` list if the VQ can't be ticked
 */
async function tickVQForPurchase(vqId, opts = {}) {
  const { program = null, extra = {}, buyerId = null, skipUntickCompeting = false, allowCompetingTicked = false } = opts;

  // Build the extras payload, potentially including buyer correction.
  const patchPayload = { ...extra };
  let buyerCorrected = false;

  // Check current buyer — if Claude Harris, correct to Jake Harris (or specified override).
  // This query runs before we apply extras so we see the current DB state.
  const preflight = await validateVQForPurchase(vqId, { program, allowCompetingTicked });
  if (preflight.vq) {
    // pg returns numeric columns (chuboe_buyer_id) as strings — cast before
    // comparing against the numeric ID constants, or these checks never fire.
    const currentBuyer = preflight.vq.chuboe_buyer_id != null ? Number(preflight.vq.chuboe_buyer_id) : null;
    if (currentBuyer === CLAUDE_HARRIS_USER_ID) {
      patchPayload.Chuboe_Buyer_ID = buyerId || JAKE_HARRIS_USER_ID;
      buyerCorrected = true;
    } else if (buyerId && currentBuyer !== Number(buyerId)) {
      // Caller explicitly specified a different buyer
      patchPayload.Chuboe_Buyer_ID = buyerId;
      buyerCorrected = true;
    }
  }

  // Apply extras (and buyer correction) FIRST so the validator sees the final state.
  // This lets callers supply missing fields (lead time, promise date, etc.)
  // in the same operation — common pattern when a franchise-API VQ lands
  // incomplete and the buyer fills in the gaps at tick time.
  if (Object.keys(patchPayload).length > 0) {
    await patchRecord('chuboe_vq_line', vqId, patchPayload);
  }

  // Validate. If the VQ still has violations after extras, abort.
  const report = await validateVQForPurchase(vqId, { program, allowCompetingTicked });

  // The validator flags competing ticked VQs as a violation. Unless the caller
  // opts out, auto-untick them first and re-validate. This is the documented
  // "flip previous winner before ticking new one" flow (see feedback_vq_mark_
  // purchased_before_approval.md).
  let untickedCompeting = [];
  if (!report.ok && !skipUntickCompeting) {
    const competingViolation = report.violations.find(v =>
      v.startsWith('Competing VQ(s) on the same RFQ line already ticked'));
    if (competingViolation) {
      const match = competingViolation.match(/ticked IsPurchased=Y: ([\d, ]+)\./);
      if (match) {
        const ids = match[1].split(',').map(s => Number(s.trim())).filter(Boolean);
        for (const id of ids) {
          await patchRecord('chuboe_vq_line', id, { IsPurchased: 'N' });
          untickedCompeting.push(id);
        }
        // Re-validate after unticking
        const retry = await validateVQForPurchase(vqId, { program });
        Object.assign(report, retry);
      }
    }
  }

  if (!report.ok) {
    const err = new Error(
      `VQ ${vqId} failed pre-purchase validation — aborting tick. ` +
      `Fix violations and retry:\n  - ${report.violations.join('\n  - ')}`
    );
    err.violations = report.violations;
    err.vqId = vqId;
    throw err;
  }

  // All clear — tick it.
  await patchRecord('chuboe_vq_line', vqId, { IsPurchased: 'Y' });
  return { vqId, ticked: true, untickedCompeting, buyerCorrected };
}

// ─── CORRECT VQ ─────────────────────────────────────────────────────────────

/**
 * Correct fields on an existing VQ line (vendor, buyer, mfr, etc.).
 *
 * Use this when a VQ was loaded with incorrect data and needs post-load correction.
 * This is cleaner than deactivate+rewrite because it preserves the VQ line ID.
 *
 * @param {number} vqId                    chuboe_vq_line_id to correct
 * @param {object} corrections
 * @param {number} [corrections.vendorBpId]       New vendor C_BPartner_ID
 * @param {number} [corrections.vendorLocationId] New vendor C_BPartner_Location_ID
 * @param {number} [corrections.buyerId]          New buyer AD_User_ID (Chuboe_Buyer_ID)
 * @param {number} [corrections.mfrId]            New manufacturer Chuboe_Mfr_ID
 * @param {string} [corrections.mfrText]          New manufacturer text (Chuboe_Mfr_Text)
 * @param {string} [corrections.mpn]              New MPN (Chuboe_MPN)
 * @param {number} [corrections.qty]              New quantity
 * @param {number} [corrections.cost]             New cost/price
 * @param {string} [corrections.dateCode]         New date code (Chuboe_Date_Code)
 * @param {string} [corrections.leadTime]         New lead time (Chuboe_Lead_Time)
 * @param {string} [corrections.reason]           Reason for correction (for audit)
 * @returns {object} { vqId, corrected: true, fields: [...], before: {...}, after: {...} }
 * @throws {Error} if VQ not found or PATCH fails
 */
async function correctVQ(vqId, corrections = {}) {
  const {
    vendorBpId,
    vendorLocationId,
    buyerId,
    mfrId,
    mfrText,
    mpn,
    qty,
    cost,
    dateCode,
    leadTime,
    reason = 'Correction applied',
  } = corrections;

  // Build the PATCH payload — only include fields that were specified
  const payload = {};
  const fieldMap = {
    vendorBpId: 'C_BPartner_ID',
    vendorLocationId: 'C_BPartner_Location_ID',
    buyerId: 'Chuboe_Buyer_ID',
    mfrId: 'Chuboe_Mfr_ID',
    mfrText: 'Chuboe_Mfr_Text',
    mpn: 'Chuboe_MPN',
    qty: 'Qty',
    cost: 'Cost',
    dateCode: 'Chuboe_Date_Code',
    leadTime: 'Chuboe_Lead_Time',
  };

  const correctedFields = [];
  for (const [optKey, dbField] of Object.entries(fieldMap)) {
    const value = corrections[optKey];
    if (value !== undefined && value !== null) {
      payload[dbField] = value;
      correctedFields.push(optKey);
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new Error('correctVQ: No corrections specified');
  }

  // Fetch current state for audit trail
  const { apiGet } = require('./api-client');
  let currentVQ;
  try {
    currentVQ = await apiGet(`chuboe_vq_line/${vqId}`);
  } catch (err) {
    throw new Error(`correctVQ: VQ ${vqId} not found — ${err.message}`);
  }

  // Capture before values
  const before = {};
  for (const dbField of Object.values(fieldMap)) {
    if (payload[dbField] !== undefined) {
      // Handle FK objects (e.g., C_BPartner_ID returns { id: 123, identifier: 'Name' })
      const val = currentVQ[dbField];
      before[dbField] = val && typeof val === 'object' ? val.id : val;
    }
  }

  // Apply the PATCH
  const result = await patchRecord('chuboe_vq_line', vqId, payload, {
    source: 'vq-correction',
  });

  if (result.status === 'error') {
    throw new Error(`correctVQ: PATCH failed — ${result.error}`);
  }

  // Log the correction
  const breadcrumbs = require('./breadcrumbs');
  breadcrumbs.write({
    cog: 'vq-patcher',
    event: 'vq-corrected',
    vqId,
    reason,
    fields: correctedFields,
    before,
    after: payload,
  });

  return {
    vqId,
    corrected: true,
    fields: correctedFields,
    reason,
    before,
    after: payload,
  };
}

/**
 * Correct multiple VQ lines with the same corrections.
 * Useful when a batch was loaded with the wrong vendor/buyer.
 *
 * @param {number[]} vqIds                 Array of chuboe_vq_line_id to correct
 * @param {object} corrections             Same as correctVQ
 * @returns {object} { total, corrected, errors, results: [...] }
 */
async function correctVQBatch(vqIds, corrections = {}) {
  const results = [];
  let corrected = 0;
  let errors = 0;

  for (const vqId of vqIds) {
    try {
      const result = await correctVQ(vqId, corrections);
      results.push({ vqId, status: 'corrected', ...result });
      corrected++;
    } catch (err) {
      results.push({ vqId, status: 'error', error: err.message });
      errors++;
    }
  }

  return {
    total: vqIds.length,
    corrected,
    errors,
    results,
  };
}

module.exports = { tickVQForPurchase, correctVQ, correctVQBatch };
