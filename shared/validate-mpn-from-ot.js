/**
 * Candidate-MPN validator: "is this string actually a part number we know?"
 *
 * Built to recover from a recurring agent miss where the operator's email
 * (subject or body) contains a token that LOOKS like a vendor-internal
 * reference (e.g., a Sourceability RFQ# "1553019") but is actually a real MPN
 * with extensive OT trading history. The agent dismisses it; we bounce
 * needlessly. Validating the token against OT trading history + active stock
 * + our own recent quote activity recovers these cases cheaply.
 *
 * Concrete case that motivated this (UID 3164, 2026-05-15):
 *   - Email subject: "FW: 1553019"
 *   - Operator quote: qty 1800 @ $11.724/ea, no MPN parseable
 *   - Agent: routed needs_review with reason "Sourceability internal RFQ ref"
 *   - Reality: 1553019 IS Phoenix Contact's MPN. OT shows:
 *       * 1,800 pcs in our Austin warehouse (matches operator's qty to the unit)
 *       * 30+ historical CQs by us
 *       * Active RFQ from Classic Components the same day
 *       * Many purchased VQs over the years
 *
 * USAGE:
 *
 *   const { validateCandidateMPN, extractCandidateTokens } =
 *     require('../shared/validate-mpn-from-ot');
 *
 *   const tokens = extractCandidateTokens(subject + ' ' + body);
 *   for (const t of tokens) {
 *     const v = validateCandidateMPN(t);
 *     if (v.isMPN) console.log(t, '->', v);
 *   }
 *
 * RETURN SHAPE:
 *   {
 *     isMPN: true|false,
 *     confidence: 'high'|'medium'|'low',
 *     mpn: '<the validated MPN, in OT's canonical clean form>',
 *     mfr: '<majority MFR string from OT, if any>',
 *     score: <integer; sum of weighted signals>,
 *     signals: {
 *       sold_cq:      <count of active CQs with issold='Y'>,
 *       any_cq:       <count of all active CQs>,
 *       purchased_vq: <count of active VQs with ispurchased='Y'>,
 *       any_vq:       <count of all active VQs>,
 *       rfq_30d:      <count of distinct active RFQs in last 30 days>,
 *       astute_stock_qty: <total qty across our own inventory offers>,
 *       astute_stock_offers: <count of active inventory offers from Astute Inc/Ltd>,
 *       distinct_partners: <count of distinct BPs that have an active row>,
 *     }
 *   }
 *
 * CONFIDENCE LADDER:
 *   high   — score >= 10 (e.g., 1+ sold CQ + 1+ recent RFQ; or stock + history)
 *   medium — score >=  4 (some trading history, not money-changes-hands)
 *   low    — score >=  1 but below medium (one stale RFQ, etc.)
 *   isMPN:false — score 0 (nothing matches, token is not a known MPN)
 */

'use strict';

const { psqlQuery, cleanMpn } = require('./db-helpers');

// Sellable vs non-sellable inventory: driven by the canonical
// `c_bpartner.ischuboestock` flag — same flag the chuboe_mpn Stock tab uses.
// 'Y' = part of our sellable inventory (Astute Inc, Franchise Stock, GE Excess,
// Spartronics Excess, Taxan Excess, Eaton Consignment).
// 'N' = excluded from sellable (LAM Consignment, Astute Group holding BPs).
// To re-classify a BP, flip its ischuboestock value in OT — this module
// re-reads the flag every call (no caching), so changes take effect instantly.
const RECENT_RFQ_DAYS = 30;
const LOOKBACK_YEARS = 3;

// Weighting:
//   sold/purchased  = 4 each (money changed hands; strongest signal)
//   recent RFQ      = 3 each (active demand right now)
//   astute stock    = 3 (we are sitting on inventory of it)
//   any cq          = 1 (we've quoted it)
//   any vq          = 1 (we've sourced it)
//   distinct ptnrs  = 1 each over 1 (multiple buyers/sellers know it)
const WEIGHTS = {
  sold_cq: 4,
  purchased_vq: 4,
  rfq_30d: 3,
  astute_stock_offers: 3,
  any_cq: 1,
  any_vq: 1,
  partner_breadth: 1,
};

// Tokens that look like an MPN: alphanumeric core, may include - _ . / ;
// length 5-25; must contain at least one digit OR be all-uppercase letters
// (e.g., "NCP5050PBR4G", "LM358", "1553019", "PMV450ENEAR"). Tokens that are
// pure-numeric AND short (< 5 chars) get filtered as more likely qty/price.
//
// Reject patterns that almost-never indicate an MPN:
//   - obvious dates (2024, 2025, 2026, MM/DD/YYYY fragments)
//   - currency amounts ($ prefix or trailing .XX)
//   - email/URL fragments (containing @, http)
//   - prefix-followed-by-#-only patterns ("RFQ#", "PO#", "Ref#")
const TOKEN_REGEX = /[A-Z0-9][A-Z0-9._\-\/]{3,23}[A-Z0-9]/gi;
const STOP_TOKENS = new Set([
  'RE','FW','FWD','FYI',
  'RFQ','PO','REF','MFR','MPN','QTY','PRICE','USD','EUR','PCS','EA',
  'STOCK','LEAD','TIME','DELIVERY','PROMO','URGENT','URGENTLY',
  'CONFIDENTIAL','REGARDS','SINCERELY','THANKS','THANK',
  'EMAIL','PHONE','MOBILE','PAGE','OFFICE','ADDRESS',
  'ASTUTE','ELECTRONICS','GROUP','LIMITED','CORP','CORPORATION',
  'OUTLOOK','GMAIL','YAHOO','HOTMAIL','ALIYUN','QQ',
]);

/**
 * Extract candidate MPN-shaped tokens from free text. Deduplicates;
 * preserves order of first occurrence.
 */
function extractCandidateTokens(text) {
  if (!text) return [];
  const raw = String(text).match(TOKEN_REGEX) || [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const t = r.trim();
    const tUpper = t.toUpperCase();
    if (STOP_TOKENS.has(tUpper)) continue;
    // Pure-year tokens like "2024" / "2026"
    if (/^(19|20)\d{2}$/.test(t)) continue;
    // Trailing currency fragments like "11.724"
    if (/^\d+\.\d+$/.test(t)) continue;
    // Need at least one digit OR be 5+ uppercase letters (typical MPN shape)
    const hasDigit = /\d/.test(t);
    const allUpperLetters = /^[A-Z]{5,}$/.test(t);
    if (!hasDigit && !allUpperLetters) continue;
    const key = cleanMpn(t);
    if (!key || key.length < 4) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Validate a candidate token against OT trading history.
 *
 * @param {string} token Raw candidate token (cleaned internally)
 * @param {object} [opts]
 * @param {string[]} [opts.astuteBpPatterns]
 * @returns {object} validation result (see header docstring)
 */
function validateCandidateMPN(token, opts = {}) {
  const mpnClean = cleanMpn(token);
  if (!mpnClean || mpnClean.length < 4) {
    return _empty(token, mpnClean);
  }

  // Internal-inventory partition: ischuboestock='Y' is sellable (Astute Inc,
  // Franchise Stock, named-excess BPs, Eaton Consignment). 'N' but starting
  // with 'Astute' is consignment held under our umbrella but not freely
  // sellable (LAM Consignment, Astute Group). Other BPs are external partners
  // (customers, brokers) and don't count in either internal bucket.
  const sellableFilter      = "bp.ischuboestock='Y'";
  const consignmentFilter   = "bp.ischuboestock='N' AND bp.name ILIKE 'Astute%'";

  // One combined query — five sub-counts in one round-trip.
  const sql = `
    WITH
      cq_hits AS (
        SELECT cq.chuboe_mfr_id AS mfr_id, mfr.name AS mfr_name,
               CASE WHEN cq.issold='Y' THEN 1 ELSE 0 END AS sold,
               cq.c_bpartner_id AS bp_id
        FROM adempiere.chuboe_cq_line cq
        LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=cq.chuboe_mfr_id
        WHERE cq.isactive='Y'
          AND cq.chuboe_mpn_clean='${mpnClean}'
          AND cq.created >= now() - interval '${LOOKBACK_YEARS} years'
      ),
      vq_hits AS (
        SELECT vq.chuboe_mfr_id AS mfr_id, mfr.name AS mfr_name,
               CASE WHEN vq.ispurchased='Y' THEN 1 ELSE 0 END AS purchased,
               vq.c_bpartner_id AS bp_id
        FROM adempiere.chuboe_vq_line vq
        LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=vq.chuboe_mfr_id
        WHERE vq.isactive='Y'
          AND vq.chuboe_mpn_clean='${mpnClean}'
          AND vq.created >= now() - interval '${LOOKBACK_YEARS} years'
      ),
      rfq_hits AS (
        SELECT DISTINCT r.chuboe_rfq_id, rlm.chuboe_mfr_id AS mfr_id, mfr.name AS mfr_name,
               r.c_bpartner_id AS bp_id
        FROM adempiere.chuboe_rfq_line_mpn rlm
        JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id=rlm.chuboe_rfq_line_id AND rl.isactive='Y'
        JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id=rl.chuboe_rfq_id AND r.isactive='Y'
        LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=rlm.chuboe_mfr_id
        WHERE rlm.isactive='Y'
          AND rlm.chuboe_mpn_clean='${mpnClean}'
          AND r.created >= now() - interval '${RECENT_RFQ_DAYS} days'
      ),
      offer_hits AS (
        SELECT ol.qty, ol.chuboe_mfr_id AS mfr_id, mfr.name AS mfr_name,
               bp.name AS bp_name,
               CASE WHEN ${sellableFilter} THEN 1 ELSE 0 END AS is_astute_sellable,
               CASE WHEN ${consignmentFilter} THEN 1 ELSE 0 END AS is_astute_consignment
        FROM adempiere.chuboe_offer_line ol
        JOIN adempiere.chuboe_offer o ON o.chuboe_offer_id=ol.chuboe_offer_id AND o.isactive='Y'
        JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id=o.c_bpartner_id
        LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=ol.chuboe_mfr_id
        WHERE ol.isactive='Y'
          AND ol.chuboe_mpn_clean='${mpnClean}'
      )
    SELECT
      (SELECT COUNT(*) FROM cq_hits)                    AS any_cq,
      (SELECT COUNT(*) FROM cq_hits WHERE sold=1)       AS sold_cq,
      (SELECT COUNT(*) FROM vq_hits)                    AS any_vq,
      (SELECT COUNT(*) FROM vq_hits WHERE purchased=1)  AS purchased_vq,
      (SELECT COUNT(DISTINCT chuboe_rfq_id) FROM rfq_hits) AS rfq_30d,
      (SELECT COALESCE(SUM(qty),0) FROM offer_hits WHERE is_astute_sellable=1) AS astute_stock_qty,
      (SELECT COUNT(*) FROM offer_hits WHERE is_astute_sellable=1) AS astute_stock_offers,
      (SELECT COALESCE(SUM(qty),0) FROM offer_hits WHERE is_astute_consignment=1) AS astute_consignment_qty,
      (SELECT COUNT(*) FROM offer_hits WHERE is_astute_consignment=1) AS astute_consignment_offers,
      (SELECT COUNT(DISTINCT bp_id) FROM (
         SELECT bp_id FROM cq_hits UNION SELECT bp_id FROM vq_hits UNION SELECT bp_id FROM rfq_hits
      ) bps) AS distinct_partners,
      /* top MFR: majority across CQ+VQ+RFQ; offers excluded from the vote
         since some offer rows are partner-supplied with their own labeling */
      (SELECT mfr_name FROM (
         SELECT mfr_name, COUNT(*) AS n FROM (
           SELECT mfr_name FROM cq_hits WHERE mfr_id IS NOT NULL
           UNION ALL SELECT mfr_name FROM vq_hits WHERE mfr_id IS NOT NULL
           UNION ALL SELECT mfr_name FROM rfq_hits WHERE mfr_id IS NOT NULL
         ) m
         GROUP BY mfr_name ORDER BY n DESC LIMIT 1
      ) topmfr) AS top_mfr
  `.replace(/\n\s+/g, ' ').trim();

  let raw;
  try {
    raw = psqlQuery(sql, 12000);
  } catch (e) {
    if (e && e.code === 'PSQL_INFRA') throw e;
    return _empty(token, mpnClean);
  }
  if (!raw) return _empty(token, mpnClean);

  const cols = raw.split('|');
  if (cols.length < 11) return _empty(token, mpnClean);

  const signals = {
    any_cq:                   Number(cols[0] || 0),
    sold_cq:                  Number(cols[1] || 0),
    any_vq:                   Number(cols[2] || 0),
    purchased_vq:             Number(cols[3] || 0),
    rfq_30d:                  Number(cols[4] || 0),
    astute_stock_qty:         Number(cols[5] || 0),
    astute_stock_offers:      Number(cols[6] || 0),
    astute_consignment_qty:   Number(cols[7] || 0),
    astute_consignment_offers: Number(cols[8] || 0),
    distinct_partners:        Number(cols[9] || 0),
  };
  const topMfr = (cols[10] || '').trim() || null;

  const partnerBreadth = Math.max(0, signals.distinct_partners - 1);

  const score =
    WEIGHTS.sold_cq             * signals.sold_cq +
    WEIGHTS.purchased_vq        * signals.purchased_vq +
    WEIGHTS.rfq_30d             * signals.rfq_30d +
    WEIGHTS.astute_stock_offers * signals.astute_stock_offers +
    WEIGHTS.any_cq              * signals.any_cq +
    WEIGHTS.any_vq              * signals.any_vq +
    WEIGHTS.partner_breadth     * partnerBreadth;

  let confidence;
  if (score >= 10) confidence = 'high';
  else if (score >= 4) confidence = 'medium';
  else if (score >= 1) confidence = 'low';
  else confidence = 'none';

  return {
    isMPN: score > 0,
    confidence,
    mpn: signals.any_cq + signals.any_vq + signals.rfq_30d > 0 ? token : null,
    mpnClean,
    mfr: topMfr,
    score,
    signals,
  };
}

function _empty(token, mpnClean) {
  return {
    isMPN: false,
    confidence: 'none',
    mpn: null,
    mpnClean: mpnClean || null,
    mfr: null,
    score: 0,
    signals: {
      any_cq: 0, sold_cq: 0, any_vq: 0, purchased_vq: 0,
      rfq_30d: 0, astute_stock_qty: 0, astute_stock_offers: 0,
      astute_consignment_qty: 0, astute_consignment_offers: 0,
      distinct_partners: 0,
    },
  };
}

module.exports = { validateCandidateMPN, extractCandidateTokens };

// CLI smoke test:
//   node validate-mpn-from-ot.js "<token-or-free-text>"
if (require.main === module) {
  const input = process.argv.slice(2).join(' ');
  if (!input) {
    console.error('usage: node validate-mpn-from-ot.js "<token-or-free-text>"');
    process.exit(2);
  }
  // If input contains spaces, treat as free text + extract tokens
  const isFreeText = /\s/.test(input);
  const tokens = isFreeText ? extractCandidateTokens(input) : [input];
  console.log(`Tokens: ${JSON.stringify(tokens)}`);
  for (const t of tokens) {
    const v = validateCandidateMPN(t);
    console.log(`\n=== ${t} ===`);
    console.log(JSON.stringify(v, null, 2));
  }
}
