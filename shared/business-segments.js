/**
 * Business segment classifier + framing labels.
 *
 * Standard Astute purchasing only buys when a customer order exists. The
 * "winning business" signal is the Adoption segment — non-LAM, non-Stock
 * RFQs where a seller is sourcing for a real customer ask. LAM Kitting
 * (autonomous cron) and Stock RFQ (broker-to-broker) are exceptions to
 * the buy-on-customer-order rule: huge process improvements, but NOT
 * competitive sales wins.
 *
 * Any scorecard / dashboard / activity report that reports Claude bot
 * activity MUST use this module to split segments. That keeps the
 * "winning vs efficiency" framing consistent across reports.
 *
 * Doctrine source: CLAUDE.md § Recent decisions (2026-05-11) and the
 * matching memory: `feedback_roi_framing_winning_vs_efficiency.md`.
 *
 * @module shared/business-segments
 */

/** Lam Research BP — flagged separately because LAM Kitting cron is autonomous. */
const LAM_BP_ID = 1000730;

/** chuboe_rfq_type "Stock" — broker-to-broker sales-from-inventory flow. */
const STOCK_RFQ_TYPE_ID = 1000007;

/**
 * Canonical segment metadata. Consumers should pull labels + framing from
 * here, not hardcode strings.
 *
 *   framing = 'winning'    → competitive win signal; goes in win-attribution rollups
 *   framing = 'efficiency' → autonomous activity; report under "process efficiency"
 */
const SEGMENTS = {
  lam: {
    label:       'LAM Kitting (autonomous cron)',
    shortLabel:  'LAM',
    framing:     'efficiency',
    emoji:       '⚙️',
    description: 'Autonomous Mon cron replenishment — Claude writes VQs and the LAM Kitting flow processes them without a customer order. Drives huge efficiency but not a competitive win.',
  },
  stock: {
    label:       'Stock RFQ (broker-to-broker)',
    shortLabel:  'Stock',
    framing:     'efficiency',
    emoji:       '⚙️',
    description: 'Sales-from-inventory broker flow. Claude\'s VQs feed the process but the buy is driven by existing stock, not a fresh customer sourcing event.',
  },
  adoption: {
    label:       'Adoption (seller-driven sourcing)',
    shortLabel:  'Adoption',
    framing:     'winning',
    emoji:       '🏆',
    description: 'Standard sourcing: customer ask → seller sources → buyer purchases. The only segment where Claude\'s data choices are competing for a real win.',
  },
};

/**
 * Classify a row by its RFQ shape. Row should expose `bp_id` (the RFQ
 * customer BP — `chuboe_rfq.c_bpartner_id`) and `rfq_type_id`
 * (`chuboe_rfq.chuboe_rfq_type_id`).
 *
 * Precedence: LAM > Stock > Adoption. A LAM Stock RFQ (rare) classifies
 * as LAM because LAM autonomous flow takes priority.
 *
 * @param {{bp_id: number|string, rfq_type_id: number|string}} row
 * @returns {'lam'|'stock'|'adoption'}
 */
function classifySegment(row) {
  if (Number(row.bp_id) === LAM_BP_ID) return 'lam';
  if (Number(row.rfq_type_id) === STOCK_RFQ_TYPE_ID) return 'stock';
  return 'adoption';
}

/**
 * Is this row in the "winning business" framing? True only for Adoption
 * segment. Use to gate inclusion in win-attribution rollups.
 *
 * @param {{bp_id: number|string, rfq_type_id: number|string}} row
 * @returns {boolean}
 */
function isWinningContext(row) {
  return classifySegment(row) === 'adoption';
}

/**
 * Get the framing classification ('winning' or 'efficiency') for a row.
 *
 * @param {{bp_id: number|string, rfq_type_id: number|string}} row
 * @returns {'winning'|'efficiency'}
 */
function getFraming(row) {
  return SEGMENTS[classifySegment(row)].framing;
}

module.exports = {
  LAM_BP_ID,
  STOCK_RFQ_TYPE_ID,
  SEGMENTS,
  classifySegment,
  isWinningContext,
  getFraming,
};
