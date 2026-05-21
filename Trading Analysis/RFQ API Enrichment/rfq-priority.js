/**
 * RFQ Priority Classifier
 *
 * Two-lane priority model driven by demand signals. The express lane (P1) is
 * further subdivided so urgent small RFQs beat pricing-exercise small RFQs
 * when quota is tight.
 *
 * Replaces the old region-based tier model (rfq-region.js) which assumed
 * "US is sleeping, prioritize regions that are in their workday." That
 * premise doesn't hold for Astute's 24/7 footprint (Mexico + Texas core
 * commercial + China/India/Singapore/South Korea) — there are no true
 * "off hours" to defer to. Region is not a useful urgency signal.
 *
 * Priority model:
 *
 *   P1a — Express urgent:
 *     Shortage / Hot Parts RFQs < EXPRESS_THRESHOLD MPNs.
 *     Rationale: small + urgent type = customer actively chasing a part.
 *     Drains first at quota refresh so we don't burn the new daily allowance
 *     on PPV pricing exercises before getting to real shortages.
 *
 *   P1b — Express neutral:
 *     Other immediate types (EOL/LTB, 3PL/VMI, Stock, Astute Franchised,
 *     Unqualified Spot RFQ) < EXPRESS_THRESHOLD MPNs.
 *
 *   P1c — Express PPV/proactive:
 *     PPV / Proactive Offer / Import / anything not in IMMEDIATE_TYPES,
 *     < EXPRESS_THRESHOLD MPNs. Still "small so user is waiting," but
 *     queued behind P1a/P1b at refresh time.
 *
 *   P2 — Main immediate:
 *     Non-PPV RFQs with ≥ EXPRESS_THRESHOLD MPNs.
 *     (Shortage, EOL/LTB, 3PL/VMI, Hot Parts, Stock, etc.)
 *     Rationale: type signals urgency — active problem, not pricing exercise.
 *     NOTE: large Shortage RFQs are NOT elevated here — empirically, ≥100-MPN
 *     "Shortage" lists are usually customer demand-gap surveys, not real
 *     shortages. P1 subdivision is small-only by design. (Operator policy
 *     2026-05-21.)
 *
 *   P3 — Backlog (rolling drain):
 *     PPV RFQs with ≥ EXPRESS_THRESHOLD MPNs + Proactive Offer + Import.
 *     Drained opportunistically across ticks.
 *
 * Dispatch order: P1a → P1b → P1c → P2 → P3 (alphabetic localeCompare in
 * the existing comparator — no worker change needed). Tiebreak by enqueue
 * time (FIFO) within tier.
 *
 * Future: P2.5 for "PPV with close date < 7 days" — deferred until we
 * have a reliable deadline field on chuboe_rfq (no such column today).
 */

// Below this MPN count, the RFQ is "express" — immediate priority regardless of type.
// Matches the loader fast-path threshold (J2) for consistency across the system.
const EXPRESS_THRESHOLD = 100;

// RFQ types treated as immediately-enrichable regardless of size.
// Anything NOT in this set that exceeds the express threshold goes to backlog.
const IMMEDIATE_TYPES = new Set([
  'Shortage',
  'EOL/LTB',
  '3PL/VMI',
  'Hot Parts',
  'Stock',
  'Unqualified Spot RFQ',
  'Astute Franchised',
]);

// Express-lane urgency subdivision. Subset of IMMEDIATE_TYPES that gets the
// front-of-line treatment within P1 when quota is tight.
const URGENT_EXPRESS_TYPES = new Set([
  'Shortage',
  'Hot Parts',
]);

const PRIORITY = {
  EXPRESS_URGENT:  'P1a', // Shortage / Hot Parts < EXPRESS_THRESHOLD
  EXPRESS_NEUTRAL: 'P1b', // Other immediate types < EXPRESS_THRESHOLD
  EXPRESS_PPV:     'P1c', // PPV / Proactive Offer / Import / other < EXPRESS_THRESHOLD
  MAIN_IMMEDIATE:  'P2',
  BACKLOG:         'P3',
};

/**
 * Assign priority to an RFQ based on size + type.
 *
 * @param {string} rfqType - RFQ type name from chuboe_rfq_type.name
 * @param {number} lineMpnCount - Count of MPNs in the RFQ
 * @returns {string} One of 'P1a' | 'P1b' | 'P1c' | 'P2' | 'P3'
 */
function assignPriority(rfqType, lineMpnCount) {
  const n = Number(lineMpnCount) || 0;

  // Express lane — small RFQs subdivided by urgency
  if (n < EXPRESS_THRESHOLD) {
    if (URGENT_EXPRESS_TYPES.has(rfqType)) return PRIORITY.EXPRESS_URGENT;
    if (IMMEDIATE_TYPES.has(rfqType))      return PRIORITY.EXPRESS_NEUTRAL;
    return PRIORITY.EXPRESS_PPV;
  }

  // Main immediate — non-PPV at scale
  if (IMMEDIATE_TYPES.has(rfqType)) return PRIORITY.MAIN_IMMEDIATE;

  // Backlog — large PPV, Proactive Offer, Import, anything else
  return PRIORITY.BACKLOG;
}

/**
 * Collapse a subdivided priority into its parent tier for display/aggregation.
 * 'P1a'|'P1b'|'P1c' → 'P1'. Other values pass through.
 */
function parentTier(priority) {
  if (!priority) return priority;
  if (priority.length > 2 && priority[0] === 'P' && /\d/.test(priority[1])) {
    return priority.slice(0, 2);
  }
  return priority;
}

/**
 * Is this priority drained immediately on the current tick?
 */
function isImmediate(priority) {
  return priority === PRIORITY.EXPRESS_URGENT
      || priority === PRIORITY.EXPRESS_NEUTRAL
      || priority === PRIORITY.EXPRESS_PPV
      || priority === PRIORITY.MAIN_IMMEDIATE;
}

/**
 * Comparator for sorting RFQs by dispatch priority.
 * P1 < P2 < P3, then FIFO (oldest first) within same priority.
 *
 * Usage: rfqs.sort(priorityComparator)
 */
function priorityComparator(a, b) {
  const ap = a.priority || assignPriority(a.rfq_type, a.line_mpns);
  const bp = b.priority || assignPriority(b.rfq_type, b.line_mpns);
  if (ap !== bp) return ap.localeCompare(bp); // 'P1' < 'P2' < 'P3' alphabetically
  const at = a.created ? new Date(a.created).getTime() : 0;
  const bt = b.created ? new Date(b.created).getTime() : 0;
  return at - bt;
}

module.exports = {
  PRIORITY,
  EXPRESS_THRESHOLD,
  IMMEDIATE_TYPES,
  URGENT_EXPRESS_TYPES,
  assignPriority,
  parentTier,
  isImmediate,
  priorityComparator,
};
