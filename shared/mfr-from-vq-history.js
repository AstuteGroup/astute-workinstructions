/**
 * shared/mfr-from-vq-history.js
 *
 * Historical-VQ fallback for raw MFR text labels.
 *
 * Counterpart to partner-lookup.resolveBPHistorical() on the MFR axis. When
 * the strict + fuzzy DB lookup can't connect a raw mfr_text label to a
 * canonical chuboe_mfr row, this fallback queries recent VQ + CQ writes for
 * rows that USED that label AND ended up with a non-null, non-system
 * chuboe_mfr_id. Returns the mode ID if it dominates.
 *
 * Why this works
 * --------------
 * The operational history IS the alias map. Example evidence from the live
 * DB on 2026-05-22:
 *   - "Littelfuse"    → 222 rows, only 1 with a resolved ID (1000048)
 *   - "Micron"        → 548 rows, 48 with ID (mode 1000002 — but SYSTEM, see below)
 *   - "Diodes"/"DIODES" → ~95+ rows with the canonical ID 1020197 each
 *
 * Different from mfr-from-ot-history.js (which is MPN-based and returns a
 * canonical MFR NAME). This one is label-based and returns an ID directly,
 * filtered to non-system MFRs only.
 *
 * Hard rule: NEVER return a system MFR_ID. The iDempiere bean callout
 * rejects system IDs in client tables (AD_Client_ID=0). System MFRs are
 * intentionally invisible to client writes.
 */

'use strict';

const { execFileSync } = require('child_process');

const LOOKBACK_DAYS = 180;
const MIN_ROWS = 3;
const MAJORITY_THRESHOLD = 0.70;

function psqlQuery(sql, timeoutMs = 8000) {
  try {
    // execFileSync — no shell interpolation, so newlines inside the SQL stay
    // as proper SQL whitespace instead of becoming escape sequences.
    return execFileSync('psql', ['-At', '-F|', '-c', sql],
      { encoding: 'utf8', timeout: timeoutMs }).trim();
  } catch (_) {
    return '';
  }
}

/**
 * Resolve a raw MFR text label by querying recent VQ + CQ history.
 *
 * @param {string} mfrText  - raw label (e.g., "Littelfuse", "Diodes")
 * @param {object} [opts]
 * @param {number} [opts.lookbackDays=180]
 * @param {number} [opts.minRows=3]            minimum non-null-id rows for the top candidate
 * @param {number} [opts.majorityThreshold=0.70]  required share of non-null-id rows held by the top candidate
 * @returns {{ id:number, name:string, rowCount:number, totalNonNull:number,
 *             ratio:number, source:'historical-vq', lookbackDays:number } | null}
 */
function resolveMfrFromVqHistory(mfrText, opts = {}) {
  if (!mfrText || typeof mfrText !== 'string') return null;
  const lookbackDays = opts.lookbackDays != null ? opts.lookbackDays : LOOKBACK_DAYS;
  const minRows = opts.minRows != null ? opts.minRows : MIN_ROWS;
  const majorityThreshold = opts.majorityThreshold != null ? opts.majorityThreshold : MAJORITY_THRESHOLD;

  const label = mfrText.trim();
  if (!label) return null;
  const escaped = label.replace(/'/g, "''");

  // Match: case-insensitive equality on the raw text. (Aliases handled at
  // the lookupMfr layer; this is the final history-based tier.)
  // Exclude system MFRs (ad_client_id=0) — bean callout rejects them on write.
  const sql = `
    SELECT mfr.chuboe_mfr_id AS id, mfr.name AS name, COUNT(*) AS n
    FROM adempiere.chuboe_vq_line v
    JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = v.chuboe_mfr_id
    WHERE v.isactive = 'Y'
      AND mfr.isactive = 'Y'
      AND mfr.ad_client_id <> 0
      AND v.created >= NOW() - INTERVAL '${lookbackDays} days'
      AND LOWER(v.chuboe_mfr_text) = LOWER('${escaped}')
      AND v.chuboe_mfr_id IS NOT NULL
    GROUP BY mfr.chuboe_mfr_id, mfr.name
    ORDER BY n DESC
    LIMIT 5
  `;

  const raw = psqlQuery(sql);
  if (!raw) return null;
  const rows = raw.split('\n').filter(Boolean).map(line => {
    const [id, name, n] = line.split('|');
    return { id: Number(id), name, n: Number(n) };
  });
  if (rows.length === 0) return null;

  const total = rows.reduce((s, r) => s + r.n, 0);
  const top = rows[0];
  if (top.n < minRows) return null;
  const ratio = top.n / total;
  if (ratio < majorityThreshold) return null;

  return {
    id: top.id,
    name: top.name,
    rowCount: top.n,
    totalNonNull: total,
    ratio: Number(ratio.toFixed(3)),
    source: 'historical-vq',
    lookbackDays,
  };
}

module.exports = { resolveMfrFromVqHistory };
