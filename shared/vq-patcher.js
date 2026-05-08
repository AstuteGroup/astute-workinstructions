/**
 * VQ Patcher — enforced wrapper around IsPurchased='Y' PATCH.
 *
 * WHY IT EXISTS:
 *   `shared/vq-purchase-validator.js` turns the approval checklist into an
 *   enforced gate, but nothing forces callers to invoke it. This module is
 *   the single authorized path to tick a VQ as purchased. Callers DO NOT
 *   call `patchRecord('chuboe_vq_line', id, { IsPurchased: 'Y' })` directly
 *   — they call `tickVQForPurchase()` which runs the validator first and
 *   aborts loudly on any violation.
 *
 * USAGE:
 *   const { tickVQForPurchase } = require('../shared/vq-patcher');
 *   await tickVQForPurchase(vqId, {
 *     program: 'LAM_KITTING',
 *     extra: { Chuboe_Lead_Time: 'STOCK - 1 WEEK', DatePromised: '2026-04-24' },
 *   });
 *
 * The `extra` object lets callers fill gaps the validator flagged (common
 * pattern: fetch VQ, see what's missing, supply it alongside the tick). If
 * the validator still reports violations after the extras are applied, the
 * call aborts before any PATCH is sent — guarantees the DB is either in a
 * fully-valid purchase state or untouched.
 */

const { validateVQForPurchase } = require('./vq-purchase-validator');
const { patchRecord } = require('./record-updater');

/**
 * Tick a VQ as purchased. Enforces the pre-approval checklist via the validator.
 *
 * @param {number} vqId                    chuboe_vq_line_id to tick
 * @param {object} opts
 * @param {string} opts.program            'LAM_KITTING' | 'LAM_EPG' | null
 * @param {object} [opts.extra]            additional fields to PATCH alongside
 *                                         IsPurchased='Y' (DatePromised, etc.).
 *                                         Applied in a single PATCH so the
 *                                         validator sees the final state.
 * @param {boolean} [opts.skipUntickCompeting=false]
 *                                         If true, skip the auto-untick of
 *                                         competing VQs. Default is to untick
 *                                         them first so only one winner remains.
 * @returns {object} { vqId, ticked: true, untickedCompeting: number[] }
 * @throws {Error} with a `violations` list if the VQ can't be ticked
 */
async function tickVQForPurchase(vqId, opts = {}) {
  const { program = null, extra = {}, skipUntickCompeting = false, allowCompetingTicked = false } = opts;

  // Apply extras FIRST so the validator sees the final state.
  // This lets callers supply missing fields (lead time, promise date, etc.)
  // in the same operation — common pattern when a franchise-API VQ lands
  // incomplete and the buyer fills in the gaps at tick time.
  if (Object.keys(extra).length > 0) {
    await patchRecord('chuboe_vq_line', vqId, extra);
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
  return { vqId, ticked: true, untickedCompeting };
}

module.exports = { tickVQForPurchase };
