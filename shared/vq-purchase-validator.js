/**
 * VQ Purchase Validator — pre-flight gate for ticking IsPurchased='Y' or posting
 * an approve-order R_Request.
 *
 * WHY IT EXISTS:
 *   `shared/r-requests.md` has a Pre-Approval Checklist documenting the fields
 *   that must be populated on the VQ before approval. Prose checklists don't
 *   get followed — we repeatedly posted approvals with missing date/lead-time/
 *   promise fields or with buyer-internal data in the vendor-facing note.
 *   This module turns the checklist into an enforced gate.
 *
 * USAGE (always call before an IsPurchased PATCH or R_Request POST):
 *   const { validateVQForPurchase } = require('../shared/vq-purchase-validator');
 *   const report = await validateVQForPurchase(vqId, { program: 'LAM_KITTING' });
 *   if (!report.ok) {
 *     console.error('VQ cannot be purchased — violations:');
 *     report.violations.forEach(v => console.error(`  - ${v}`));
 *     throw new Error(`Aborting approval for VQ ${vqId}`);
 *   }
 *
 * The 'program' option tailors program-specific expectations (ship-to warehouse,
 * warehouse group, shipper, incoterm). Currently supported: 'LAM_KITTING',
 * 'LAM_EPG'. Pass null (or omit) to skip program-specific checks.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: '/var/run/postgresql',        // Unix socket peer auth — no password needed
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

// Program-specific ship-to expectations. Each program encodes the warehouse,
// warehouse_group, shipper, and incoterm that every tick for that program
// must hit. If any of these is wrong, the validator returns a violation with
// the exact expected value so the buyer sees what needs to change.
//
// Derived from empirical analysis of historical ticks:
//   - LAM Kitting: 912 ticks on warehouse 1000015 + group 1000008 (Brownsville)
//   - LAM EPG    : broker VQ defaults per feedback_lam_epg_broker_vq_defaults.md
//
// Add new programs here as they come online. Keep the list short — the goal is
// to catch program-specific mistakes, not to encode every possible combination.
const PROGRAM_DEFAULTS = {
  LAM_KITTING: {
    chuboe_warehouse_id: { value: 1000015, label: 'W111: LAM KITTING' },
    chuboe_warehouse_group_id: { value: 1000008, label: 'BROWNSVILLE' },
    m_shipper_id: { value: 1000003, label: 'FedEx Ground' },
    chuboe_inco_term_id: { value: 1000000, label: 'EXW' },
  },
  LAM_EPG: {
    chuboe_warehouse_id: { value: 1000015, label: 'W111: LAM KITTING' },
    chuboe_warehouse_group_id: { value: 1000008, label: 'BROWNSVILLE' },
    m_shipper_id: { value: 1000003, label: 'FedEx Ground' },
    chuboe_inco_term_id: { value: 1000000, label: 'EXW' },
  },
};

// Regex markers that betray buyer-internal content in a vendor-facing note.
// Chuboe_Note_Public flows to the POV the vendor receives — it must not
// leak stock counts, internal MOQ/MFR tags, or our enrichment scaffolding.
const INTERNAL_MARKERS = [
  /\b\w+ stock\s*:/i,        // "Master stock: 619" / "TTI stock: 14,000"
  /\bMOQ\s*:/i,              // "MOQ: 5"
  /\bMfr\s*:/i,              // "Mfr: RECOM"
  /\bLead time\s*:/i,        // "Lead time: 3 weeks" (vendor already knows)
];

/**
 * Validate a VQ line for purchase readiness.
 * @param {number} vqId  chuboe_vq_line_id
 * @param {object} opts  { program: 'LAM_KITTING' | 'LAM_EPG' | null,
 *                         allowCompetingTicked: false (set true for legitimate
 *                           split-POV cases where multiple vendors share the
 *                           RFQ line qty, each ticked for their own POV) }
 * @returns {object} { ok: boolean, violations: string[], vq: <row> }
 */
async function validateVQForPurchase(vqId, opts = {}) {
  const { program = null, allowCompetingTicked = false } = opts;

  const { rows } = await pool.query(`
    SELECT vl.chuboe_vq_line_id, vl.chuboe_mpn, vl.chuboe_rfq_line_id,
           vl.cost, vl.qty, vl.c_bpartner_id, bp.name AS supplier,
           vl.chuboe_mfr_id, vl.c_country_id, vl.c_bpartner_location_id,
           vl.chuboe_date_code, vl.chuboe_lead_time, vl.datepromised,
           vl.chuboe_packaging_id, vl.chuboe_traceability_id,
           vl.chuboe_warehouse_id, vl.chuboe_warehouse_group_id,
           vl.m_shipper_id, vl.chuboe_inco_term_id,
           vl.chuboe_note_public, vl.chuboe_note_private,
           vl.ispurchased, vl.isactive,
           vl.chuboe_buyer_id
    FROM adempiere.chuboe_vq_line vl
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vl.c_bpartner_id
    WHERE vl.chuboe_vq_line_id = $1
  `, [vqId]);

  if (rows.length === 0) {
    return { ok: false, violations: [`VQ ${vqId} not found`], vq: null };
  }
  const vq = rows[0];
  const violations = [];

  // Active record
  if (vq.isactive !== 'Y') violations.push(`VQ ${vqId} is inactive (isactive='${vq.isactive}')`);

  // Core identity
  if (!vq.chuboe_mpn) violations.push('Chuboe_MPN is blank');
  if (!vq.c_bpartner_id) violations.push('C_BPartner_ID is blank (no vendor)');
  if (vq.cost === null || Number(vq.cost) <= 0) violations.push(`Cost is ${vq.cost} (must be > 0)`);
  if (!vq.qty || Number(vq.qty) <= 0) violations.push(`Qty is ${vq.qty} (must be > 0)`);

  // MFR, COO, Partner Location — required for PO processing
  if (!vq.chuboe_mfr_id) violations.push('Chuboe_MFR_ID is blank (required — manufacturer must be set)');
  if (!vq.c_country_id) violations.push('C_Country_ID is blank (required — COO must be set, use PENDING=1000001 if unknown)');
  if (!vq.c_bpartner_location_id) violations.push('C_BPartner_Location_ID is blank (required — vendor ship-from address)');

  // Date fields — the trio that's most often missed
  if (!vq.chuboe_date_code) violations.push('Chuboe_Date_Code is blank (required — vendor-known date stamp on the part)');
  if (!vq.chuboe_lead_time) violations.push('Chuboe_Lead_Time is blank (required — "STOCK", "3 Weeks", "STOCK - 1 WEEK", etc.)');
  if (!vq.datepromised) violations.push('DatePromised is blank (required — when the vendor commits to deliver)');

  // Packaging + traceability
  if (!vq.chuboe_packaging_id) violations.push('Chuboe_Packaging_ID is blank (required — REEL, CUT TAPE, BULK, TRAY, etc.)');
  if (!vq.chuboe_traceability_id) violations.push('Chuboe_Traceability_ID is blank (Franchise=1000001 / Non-Traceable=1000003)');

  // Note-field sanity — catch buyer-internal content in vendor-facing fields.
  // Three note fields exist on chuboe_vq_line, in ascending internal-ness:
  //   chuboe_note_public  → "Public Vendor Order Notes" (flows to POV — vendor sees it)
  //   chuboe_note_private → "Notes to Inspector" (QC/receiving team sees it)
  //   chuboe_note_user    → "Buyer Internal Notes" (correct destination for our enrichment)
  // Stock counts, MOQ tags, MFR names, etc. belong in chuboe_note_user. They
  // must NOT leak into the public note (vendor-visible) and also shouldn't
  // pollute the inspector note (QC doesn't need the sourcing narrative).
  for (const [field, label] of [
    ['chuboe_note_public',  'Chuboe_Note_Public (Public Vendor Order Notes)'],
    ['chuboe_note_private', 'Chuboe_Note_Private (Notes to Inspector)'],
  ]) {
    const content = vq[field];
    if (!content) continue;
    for (const rx of INTERNAL_MARKERS) {
      if (rx.test(content)) {
        violations.push(
          `${label} contains buyer-internal content (pattern ${rx}): ` +
          `"${content.slice(0, 120)}". Move to Chuboe_Note_User (Buyer Internal Notes).`
        );
        break; // one violation per field is enough
      }
    }
  }

  // Program-specific ship-to expectations
  if (program && PROGRAM_DEFAULTS[program]) {
    const expected = PROGRAM_DEFAULTS[program];
    for (const [field, { value, label }] of Object.entries(expected)) {
      const actual = vq[field];
      if (Number(actual) !== value) {
        violations.push(
          `${field} is ${actual ?? 'null'} — expected ${value} (${label}) for program ${program}`
        );
      }
    }
  }

  // Competing VQ check — any other ticked VQ on the same RFQ line?
  // Skipped when the caller explicitly opts in via allowCompetingTicked=true
  // (legitimate split-POV case: line qty split across multiple vendors, each
  // ticked separately for its own POV. Validator can't distinguish this from
  // the "accidentally ticked two" error without caller context.)
  if (vq.chuboe_rfq_line_id && !allowCompetingTicked) {
    const { rows: competing } = await pool.query(`
      SELECT chuboe_vq_line_id, c_bpartner_id
      FROM adempiere.chuboe_vq_line
      WHERE chuboe_rfq_line_id = $1
        AND chuboe_vq_line_id <> $2
        AND isactive = 'Y'
        AND ispurchased = 'Y'
    `, [vq.chuboe_rfq_line_id, vqId]);
    if (competing.length > 0) {
      const ids = competing.map(r => r.chuboe_vq_line_id).join(', ');
      violations.push(
        `Competing VQ(s) on the same RFQ line already ticked IsPurchased=Y: ${ids}. ` +
        `Untick them before proceeding (one winner per line). ` +
        `If this is a legitimate split-POV case, pass allowCompetingTicked=true.`
      );
    }
  }

  return { ok: violations.length === 0, violations, vq };
}

module.exports = {
  validateVQForPurchase,
  PROGRAM_DEFAULTS,
  INTERNAL_MARKERS,
};
