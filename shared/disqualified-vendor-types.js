/**
 * shared/disqualified-vendor-types.js
 *
 * Single source of truth for the vendor-type IDs that mean "restricted —
 * needs management approval before we buy." Loading is data capture and
 * these BPs are NOT skipped at the load layer (changed 2026-05-18 — see
 * `shared/agent-philosophy.md` § "Loading is data capture"). The approval
 * flow downstream is the gate.
 *
 * This module is kept as a **label provider** for anyone who wants to
 * surface vendor status downstream — in an approval R_Request body, an
 * operator alert, an audit view. The previous "hard skip at writer layer"
 * role was retired alongside the load-bulk-summary + offer-writeback gates.
 *
 * To add a restricted-vendor type label:
 *   1. Confirm with operator that the vendor type means "needs approval to buy."
 *   2. Add the chuboe_vendortype_id to the set.
 *   3. Add label + name mappings.
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

// Set name retained for backward compatibility with any downstream consumer
// that imports it. Semantically these are "restricted, needs approval" — NOT
// "auto-skip at load." Consumers should use these labels for display/audit,
// not for blocking writes.
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
