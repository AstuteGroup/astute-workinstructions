/**
 * shared/customer-excess-intent.js — Step 2 of the Customer Excess Analysis
 * workflow (per `Trading Analysis/Customer Excess Analysis/customer-excess-
 * analysis.md` § Step 2: Infer Intent).
 *
 * Rules-based, first-match-wins. The classifier itself is pure — caller
 * pre-loads the offer object via `loadOfferForClassification()` (or builds
 * the same shape from data they already have).
 *
 * Returns `{intent, ruleFired, confidence, evidence}`:
 *   intent      — 'consignment' | 'spec_buy' | 'reactive'
 *   ruleFired   — short label of which rule matched
 *   confidence  — 'high' | 'medium' | 'low' (low when broker heuristic is uncertain)
 *   evidence    — object summarizing the inputs that mattered
 *
 * The intent labels match the analyzer's downstream renderer dispatch (Step 5).
 *
 * KNOWN GAPS (flagged for operator follow-up):
 *   - Rule 5 "broker" indicator is a placeholder. No clean broker flag exists
 *     in c_bpartner; current proxy is `IsVendor='Y' AND IsCustomer='N'`. This
 *     will under-fire for brokers we've also sold to (rare) and over-fire for
 *     pure vendors who aren't brokers (manufacturers, franchise distys).
 *     Confidence is downgraded to 'low' when this rule fires so a downstream
 *     review can catch false positives.
 */

'use strict';

const CONSIGNMENT_DESC_REGEX = /(?:rev[\s-]?share|revshare|e\s*&\s*o|\bbuyback\b)/i;
const LAM_KITTING_INVENTORY_TYPE = 1000025;

/**
 * Classify an offer's intent per the .md spec rules.
 *
 * @param {object} offer — pre-loaded offer with the fields below
 *   offer.offerId          — chuboe_offer_id (for error messages)
 *   offer.searchKey        — chuboe_offer.value (for breadcrumbs)
 *   offer.offerTypeId      — chuboe_offer_type_id
 *   offer.description      — chuboe_offer.description
 *   offer.partner          — { id, name, isCustomer, isVendor, soCount, poCount }
 *   offer.lineCount        — total active offer_line count
 *   offer.nullPricedLines  — count of lines with priceentered NULL or 0
 * @param {object} [opts]
 *   opts.overrideIntent    — operator override ('consignment'|'spec_buy'|'reactive')
 */
function classifyIntent(offer, opts = {}) {
  if (!offer || typeof offer !== 'object') {
    throw new Error('classifyIntent: offer object required');
  }

  // ── Rule 1: explicit override ──
  if (opts.overrideIntent) {
    return {
      intent: opts.overrideIntent,
      ruleFired: 'override',
      confidence: 'high',
      evidence: { override: opts.overrideIntent },
    };
  }

  const partner = offer.partner || {};
  const lineCount = Number(offer.lineCount || 0);
  const nullPriced = Number(offer.nullPricedLines || 0);
  const nullPct = lineCount > 0 ? (nullPriced / lineCount) : 0;

  // ── Rule 2: offer type = LAM Kitting Inventory ──
  if (Number(offer.offerTypeId) === LAM_KITTING_INVENTORY_TYPE) {
    return {
      intent: 'consignment',
      ruleFired: 'rule_2_lam_kitting_type',
      confidence: 'high',
      evidence: { offerTypeId: offer.offerTypeId },
    };
  }

  // ── Rule 3: description contains consignment markers ──
  const descHit = CONSIGNMENT_DESC_REGEX.test(String(offer.description || ''));
  if (descHit) {
    return {
      intent: 'consignment',
      ruleFired: 'rule_3_description_marker',
      confidence: 'high',
      evidence: {
        description: offer.description,
        match: String(offer.description || '').match(CONSIGNMENT_DESC_REGEX)?.[0],
      },
    };
  }

  // ── Rule 4: existing customer + ≥50 lines + ≥30% null prices ──
  const isCustomer = partner.isCustomer === 'Y' || partner.isCustomer === true;
  const hasSoHistory = Number(partner.soCount || 0) > 0;
  if (isCustomer && hasSoHistory && lineCount >= 50 && nullPct >= 0.30) {
    return {
      intent: 'consignment',
      ruleFired: 'rule_4_customer_bulk_unpriced',
      confidence: 'high',
      evidence: {
        soCount: partner.soCount,
        lineCount,
        nullPricedLines: nullPriced,
        nullPricePct: Math.round(nullPct * 1000) / 10,
      },
    };
  }

  // ── Rule 5: broker + ≥5 lines (PLACEHOLDER — see KNOWN GAPS in header) ──
  const isBrokerProxy = (partner.isVendor === 'Y' || partner.isVendor === true)
    && (partner.isCustomer !== 'Y' && partner.isCustomer !== true);
  if (isBrokerProxy && lineCount >= 5) {
    return {
      intent: 'spec_buy',
      ruleFired: 'rule_5_broker_proxy',
      // Low confidence: broker proxy is just IsVendor∧¬IsCustomer; not a real
      // broker flag. Operator should review classifications hitting this rule.
      confidence: 'low',
      evidence: {
        proxy: 'isVendor=Y AND isCustomer=N',
        isVendor: partner.isVendor,
        isCustomer: partner.isCustomer,
        lineCount,
        warning: 'broker heuristic is a placeholder; needs operator-defined indicator',
      },
    };
  }

  // ── Rule 6: default ──
  return {
    intent: 'reactive',
    ruleFired: 'rule_6_default',
    confidence: 'medium',
    evidence: {
      lineCount,
      nullPricePct: Math.round(nullPct * 1000) / 10,
      isCustomer,
      hasSoHistory,
    },
  };
}

/**
 * Load an offer + the fields needed for classification.
 *
 * @param {Pool} pool — pg pool (caller-owned so the script controls lifecycle)
 * @param {number} offerId — chuboe_offer_id
 */
async function loadOfferForClassification(pool, offerId) {
  const r = await pool.query(`
    WITH offer AS (
      SELECT
        o.chuboe_offer_id, o.value AS search_key, o.chuboe_offer_type_id,
        o.description, o.c_bpartner_id,
        bp.name AS partner_name, bp.iscustomer, bp.isvendor
      FROM adempiere.chuboe_offer o
      LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id
      WHERE o.chuboe_offer_id = $1
    ),
    lines AS (
      SELECT
        COUNT(*) AS line_count,
        COUNT(*) FILTER (WHERE priceentered IS NULL OR priceentered = 0) AS null_priced
      FROM adempiere.chuboe_offer_line
      WHERE chuboe_offer_id = $1 AND isactive='Y'
    ),
    so_hist AS (
      SELECT COUNT(*) AS so_count
      FROM adempiere.c_order
      WHERE issotrx='Y' AND isactive='Y'
        AND c_bpartner_id = (SELECT c_bpartner_id FROM offer)
    ),
    po_hist AS (
      SELECT COUNT(*) AS po_count
      FROM adempiere.c_order
      WHERE issotrx='N' AND isactive='Y'
        AND c_bpartner_id = (SELECT c_bpartner_id FROM offer)
    )
    SELECT o.*, l.line_count, l.null_priced, s.so_count, p.po_count
    FROM offer o, lines l, so_hist s, po_hist p
  `, [offerId]);
  if (r.rows.length === 0) throw new Error(`offer ${offerId} not found`);
  const row = r.rows[0];
  return {
    offerId: row.chuboe_offer_id,
    searchKey: row.search_key,
    offerTypeId: row.chuboe_offer_type_id,
    description: row.description,
    partner: {
      id: row.c_bpartner_id,
      name: row.partner_name,
      isCustomer: row.iscustomer,
      isVendor: row.isvendor,
      soCount: Number(row.so_count || 0),
      poCount: Number(row.po_count || 0),
    },
    lineCount: Number(row.line_count || 0),
    nullPricedLines: Number(row.null_priced || 0),
  };
}

module.exports = { classifyIntent, loadOfferForClassification };
