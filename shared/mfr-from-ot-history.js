/**
 * MFR resolver: OT trading history path.
 *
 * "What MFR have we historically traded this MPN as?"
 *
 * Aggregates `chuboe_mfr` across active rows on the same `chuboe_mpn_clean`
 * from chuboe_cq_line + chuboe_vq_line + chuboe_offer_line in the last 2 years.
 * Sold CQs and Purchased VQs carry 3x weight (operator-vetted at money-changes-
 * hands), everything else 1x. Returns the majority MFR if it holds >=70% of
 * weighted votes; otherwise returns null (ambiguous → caller falls through).
 *
 * Why this exists:
 *   The mfr-resolver prefix path is a HINT with known overreach (ISO* / ISL*
 *   -> Issi-wrong, XC* -> AMD-wrong, BCM857 -> Broadcom-wrong, CY7C -> Infineon
 *   via acquisition while parts are still branded Cypress). OT history is
 *   operator-vetted ground truth for any MPN we've actually traded. Check it
 *   FIRST; fall back to the prefix path for parts we've never touched.
 *
 * Consumers:
 *   - shared/workflow-actions/stockrfq-cq.js (CQ load path, step 3.7.5)
 *   - shared/cq-writer.js (resolveMfrForCQ — applied before prefix inference)
 */

'use strict';

const { psqlQuery, cleanMpn } = require('./db-helpers');
const { canonicalMfr } = require('./mfr-equivalence');

const LOOKBACK_YEARS = 2;
const MAJORITY_THRESHOLD = 0.70;

/**
 * @param {string} mpn Raw or cleaned MPN. Cleaned internally.
 * @param {object} [opts]
 * @param {number} [opts.lookbackYears=2]
 * @returns {{mfr:string, confidence:'high'|'medium', sources:{cq:number,vq:number,offer:number,sold:number,purchased:number}, totalWeight:number, topWeight:number}|null}
 */
function resolveMfrFromOTHistory(mpn, opts = {}) {
  const mpnClean = cleanMpn(mpn);
  if (!mpnClean) return null;
  const years = opts.lookbackYears || LOOKBACK_YEARS;

  const sql = `
    WITH hits AS (
      SELECT mfr.name AS mfr_name, 'cq' AS src,
             CASE WHEN cq.issold='Y' THEN 3 ELSE 1 END AS weight,
             cq.issold AS sold, 'N' AS purchased
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=cq.chuboe_mfr_id
      WHERE cq.isactive='Y' AND cq.chuboe_mpn_clean='${mpnClean}'
        AND cq.created >= now() - interval '${years} years'
      UNION ALL
      SELECT mfr.name, 'vq',
             CASE WHEN vq.ispurchased='Y' THEN 3 ELSE 1 END,
             'N', vq.ispurchased
      FROM adempiere.chuboe_vq_line vq
      JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=vq.chuboe_mfr_id
      WHERE vq.isactive='Y' AND vq.chuboe_mpn_clean='${mpnClean}'
        AND vq.created >= now() - interval '${years} years'
      UNION ALL
      SELECT mfr.name, 'offer', 1, 'N', 'N'
      FROM adempiere.chuboe_offer_line ol
      JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id=ol.chuboe_mfr_id
      JOIN adempiere.chuboe_offer o ON o.chuboe_offer_id=ol.chuboe_offer_id
      WHERE ol.isactive='Y' AND ol.chuboe_mpn_clean='${mpnClean}'
        AND o.isactive='Y'
        AND o.created >= now() - interval '${years} years'
    )
    SELECT mfr_name,
           SUM(weight) AS w,
           SUM(CASE WHEN src='cq' THEN 1 ELSE 0 END) AS n_cq,
           SUM(CASE WHEN src='vq' THEN 1 ELSE 0 END) AS n_vq,
           SUM(CASE WHEN src='offer' THEN 1 ELSE 0 END) AS n_offer,
           SUM(CASE WHEN sold='Y' THEN 1 ELSE 0 END) AS n_sold,
           SUM(CASE WHEN purchased='Y' THEN 1 ELSE 0 END) AS n_purchased
    FROM hits
    GROUP BY mfr_name
    ORDER BY w DESC
  `.replace(/\n\s+/g, ' ').trim();

  let raw;
  try {
    raw = psqlQuery(sql, 10000);
  } catch (e) {
    if (e.code === 'PSQL_INFRA') throw e;
    return null;
  }
  if (!raw) return null;

  const rawRows = raw.split('\n').map(l => l.split('|')).filter(r => r.length >= 7 && r[0]);
  if (rawRows.length === 0) return null;

  // Canonicalize: "Cypress" / "Cypress Semiconductor Corp" / "Infineon" all
  // collapse to one bucket via mfr-equivalence (aliases + acquisitions). Within
  // each bucket, keep the highest-weight original display string so callers
  // get back a real MFR name, not the canonical key.
  const buckets = new Map();
  let totalWeight = 0;
  for (const r of rawRows) {
    const displayName = r[0];
    const w = Number(r[1] || 0);
    if (w === 0) continue;
    totalWeight += w;
    const key = canonicalMfr(displayName) || displayName.toLowerCase();
    const b = buckets.get(key) || {
      key, displayName, displayWeight: 0,
      weight: 0, cq: 0, vq: 0, offer: 0, sold: 0, purchased: 0,
    };
    b.weight += w;
    b.cq += Number(r[2] || 0);
    b.vq += Number(r[3] || 0);
    b.offer += Number(r[4] || 0);
    b.sold += Number(r[5] || 0);
    b.purchased += Number(r[6] || 0);
    if (w > b.displayWeight) {
      b.displayName = displayName;
      b.displayWeight = w;
    }
    buckets.set(key, b);
  }
  if (totalWeight === 0 || buckets.size === 0) return null;

  const ranked = [...buckets.values()].sort((a, b) => b.weight - a.weight);
  const top = ranked[0];
  const ratio = top.weight / totalWeight;
  if (ratio < MAJORITY_THRESHOLD) return null;

  const confidence = (top.sold + top.purchased) > 0 ? 'high' : 'medium';
  return {
    mfr: top.displayName,
    canonicalKey: top.key,
    confidence,
    sources: {
      cq: top.cq, vq: top.vq, offer: top.offer,
      sold: top.sold, purchased: top.purchased,
    },
    totalWeight,
    topWeight: top.weight,
    ratio: Number(ratio.toFixed(3)),
  };
}

module.exports = { resolveMfrFromOTHistory };

// CLI smoke test: node shared/mfr-from-ot-history.js <MPN>
if (require.main === module) {
  const mpn = process.argv[2];
  if (!mpn) {
    console.error('usage: node mfr-from-ot-history.js <MPN>');
    process.exit(2);
  }
  console.log(JSON.stringify(resolveMfrFromOTHistory(mpn), null, 2));
}
