/**
 * RFQ Priority Classifier
 *
 * Two-lane, three-priority model driven by demand signals.
 *
 * Replaces the old region-based tier model (rfq-region.js) which assumed
 * "US is sleeping, prioritize regions that are in their workday." That
 * premise doesn't hold for Astute's 24/7 footprint (Mexico + Texas core
 * commercial + China/India/Singapore/South Korea) — there are no true
 * "off hours" to defer to. Region is not a useful urgency signal.
 *
 * Priority model:
 *
 *   P1 — Express lane (immediate):
 *     Any RFQ < EXPRESS_THRESHOLD MPNs, regardless of type.
 *     Rationale: small = user is waiting for a fast answer.
 *     A 10-line RFQ never queues behind a 5,000-line anything.
 *
 *   P2 — Main immediate:
 *     Non-PPV RFQs with ≥ EXPRESS_THRESHOLD MPNs.
 *     (Shortage, EOL/LTB, 3PL/VMI, Hot Parts, Stock, etc.)
 *     Rationale: type signals urgency — active problem, not pricing exercise.
 *
 *   P3 — Backlog (rolling drain):
 *     PPV RFQs with ≥ EXPRESS_THRESHOLD MPNs + Proactive Offer + Import.
 *     Drained opportunistically across ticks.
 *
 * Dispatch order: P1 → P2 → P3. Tiebreak by enqueue time (FIFO).
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

const PRIORITY = {
  EXPRESS: 'P1',
  MAIN_IMMEDIATE: 'P2',
  BACKLOG: 'P3',
};

/**
 * Assign priority to an RFQ based on size + type.
 *
 * @param {string} rfqType - RFQ type name from chuboe_rfq_type.name
 * @param {number} lineMpnCount - Count of MPNs in the RFQ
 * @returns {string} One of 'P1', 'P2', 'P3'
 */
function assignPriority(rfqType, lineMpnCount) {
  const n = Number(lineMpnCount) || 0;

  // Express lane — small RFQs of any type
  if (n < EXPRESS_THRESHOLD) return PRIORITY.EXPRESS;

  // Main immediate — non-PPV at scale
  if (IMMEDIATE_TYPES.has(rfqType)) return PRIORITY.MAIN_IMMEDIATE;

  // Backlog — large PPV, Proactive Offer, Import, anything else
  return PRIORITY.BACKLOG;
}

/**
 * Is this priority drained immediately on the current tick?
 */
function isImmediate(priority) {
  return priority === PRIORITY.EXPRESS || priority === PRIORITY.MAIN_IMMEDIATE;
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
  assignPriority,
  isImmediate,
  priorityComparator,
};
