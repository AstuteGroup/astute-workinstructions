/**
 * shared/disqualified-vendor-types.js
 *
 * Single source of truth for "do NOT load a write to this BP regardless of
 * what else looks right." These are operator-flagged vendor types that any
 * writer (vq-writer, offer-writeback, rfq-writer, cq-writer) should skip
 * before posting.
 *
 * The set is OUR opinion on the data, layered ON TOP of OT's bean-callouts
 * (which we don't fully control). Bean callouts may not block writes against
 * Suspended/Prohibited BPs — we have to enforce client-side.
 *
 * To add a disqualifier:
 *   1. Confirm with operator that the vendor type means "do not buy from"
 *      (vs. just "low priority" — those are different).
 *   2. Add the chuboe_vendortype_id to the set.
 *   3. Add a label mapping for the skip reason.
 *
 * Vendor type IDs (per psql adempiere.chuboe_vendortype, 2026-05-14):
 *    1000001 Manufacture Direct Component
 *    1000002 Franchise
 *    1000003 Non-Traceable with one or more Franchised lines
 *    1000004 Suspended               ← disqualified
 *    1000005 Prohibited              ← disqualified
 *    1000006 Services
 *    1000007 Manufacture Direct Assemblies
 *    1000008 Catalog
 *    1000009 Online Distributor
 *    1000010 Non-Traceable without Franchised lines
 *    1000011 Manufacture/Franchise with no QA accreditation
 *    1000013 New/Ungraded Vendor
 *    1000014 Manufacturer with No Accreditations
 *    1000017 Global Sourcing
 *    1000020 Quality
 */

'use strict';

const DISQUALIFIED_VTYPE_IDS = new Set([
  1000004,  // Suspended
  1000005,  // Prohibited
]);

const DISQUALIFIED_LABELS = {
  1000004: 'VENDOR_SUSPENDED',
  1000005: 'VENDOR_PROHIBITED',
};

const DISQUALIFIED_NAMES = {
  1000004: 'Suspended',
  1000005: 'Prohibited',
};

/**
 * Test whether a vendor-type-id is in the disqualified set.
 *
 * @param {number|null|undefined} vtypeId  chuboe_vendortype_id
 * @returns {boolean}
 */
function isDisqualified(vtypeId) {
  if (vtypeId == null) return false;
  return DISQUALIFIED_VTYPE_IDS.has(Number(vtypeId));
}

/**
 * Get the skip-reason label (e.g., 'VENDOR_SUSPENDED', 'VENDOR_PROHIBITED')
 * for a disqualified vtypeId. Returns null if the vtypeId isn't disqualified.
 *
 * @param {number} vtypeId
 * @returns {string|null}
 */
function disqualificationLabel(vtypeId) {
  if (vtypeId == null) return null;
  return DISQUALIFIED_LABELS[Number(vtypeId)] || null;
}

/**
 * Human-readable name (e.g., 'Suspended', 'Prohibited') — for log lines,
 * UI strings, breadcrumb fields.
 *
 * @param {number} vtypeId
 * @returns {string|null}
 */
function disqualificationName(vtypeId) {
  if (vtypeId == null) return null;
  return DISQUALIFIED_NAMES[Number(vtypeId)] || null;
}

module.exports = {
  DISQUALIFIED_VTYPE_IDS,
  DISQUALIFIED_LABELS,
  DISQUALIFIED_NAMES,
  isDisqualified,
  disqualificationLabel,
  disqualificationName,
};
