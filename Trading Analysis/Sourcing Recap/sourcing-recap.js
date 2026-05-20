#!/usr/bin/env node
/**
 * Sourcing Recap — per-RFQ "best option" sourcing summary.
 *
 * Output mirrors the Vortex idea (sourcing artifact, one xlsx, emailed back)
 * but with a different lens: rank the VQs gathered for THIS RFQ, plus any
 * better-priced VQs from OTHER RFQs in the last 14 days on the same CPC.
 *
 * Difference from Vortex Matches (savings):
 *   - Vortex = "where can we beat the customer's target"
 *   - Recap  = "what are the best sourcing options for this RFQ, with
 *              context from recent same-CPC activity"
 *
 * Two entry points:
 *
 *   1. CLI:     node sourcing-recap.js <rfq_number>
 *               Writes xlsx to ./output/ and prints a summary.
 *
 *   2. Library: const { runSourcingRecapForRFQ, buildSummaryHtml } =
 *                 require('./sourcing-recap');
 *               Used by vortex-poller.js (subject-routed) for email-driven path.
 *
 * Routing into this module from vortex-poller is by subject keyword "BEST"
 * + a 7-digit RFQ#. Stock RFQs (type 1000007) bounce with a redirect note.
 *
 * RFQ-type ranking rules (verified from live DB 2026-05-20):
 *   Shortage   (1000000) → in_stock_full > in_stock_partial > lead_time > unknown
 *   Hot Parts  (1000013) → same as Shortage
 *   PPV        (1000001) → unit cost asc, in_stock breaks ties
 *   3PL/VMI    (1000004) → PPV-style
 *   EOL/LTB    (1000003) → PPV-style
 *   Proactive Offer    (1000005) → PPV-style
 *   Astute Franchised  (1000002) → PPV-style
 *   Import     (1000006) → PPV-style
 *   Unqualified Spot   (1000012) → PPV-style
 *   Stock      (1000007) → REJECTED (has its own workflow)
 */

const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { computeMfrMatch, prenormalizeMfr } = require('../../shared/mfr-equivalence');
const sharedMfrLookup = require('../../shared/mfr-lookup');
const { fmtCT, fmtCTShort } = require('../../shared/time-format');

/**
 * Pretty MFR display: resolve through the alias file (mfr-aliases.json,
 * 200+ curated entries) so "TI" / "TEXAS INSTRUMENTS INC" both render as
 * "Texas Instruments", "ON SEMI" as "On Semiconductor", etc. Falls back
 * to the raw input if no alias entry exists. Does NOT walk the acquisitions
 * chain — display preserves the brand the vendor actually quoted.
 */
function displayMfr(s) {
  if (!s) return '';
  const pre = prenormalizeMfr(s);
  if (!pre) return s;
  const resolved = sharedMfrLookup.normalizeMfr(pre);
  return resolved || pre;
}

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user'
});

const STOCK_RFQ_TYPE_ID = 1000007;

// Ranking-rule keys keyed by chuboe_rfq_type_id
const STOCK_FIRST_TYPES  = new Set([1000000, 1000013]); // Shortage, Hot Parts
// All other non-Stock types use the "cost-first" rule (PPV-style).

const TYPE_NAMES = {
  1000000: 'Shortage',
  1000001: 'PPV',
  1000002: 'Astute Franchised',
  1000003: 'EOL/LTB',
  1000004: '3PL/VMI',
  1000005: 'Proactive Offer',
  1000006: 'Import',
  1000007: 'Stock',
  1000012: 'Unqualified Spot RFQ',
  1000013: 'Hot Parts'
};

// ─── SUPPLY STATE CLASSIFIER ────────────────────────────────────────────────
// Same shape as Vortex's computeSupplyState but emits the 4 tier strings the
// ranking comparator works on. Single source of truth for "is this VQ stock
// or lead-time?" so the same VQ gets classified consistently across reports.
const STOCK_LIKE_LT = /^(stock|in[\s-]*stock|stk|ready[\s-]*stock|ready|available|asap|ship[\s-]*now)\s*$/i;

function classifyVQ(vq, rfqQty) {
  const q = Number(vq.qty) || 0;
  const lt = String(vq.lead_time || '').trim();
  const ltIsStockLike = lt === '' || lt === '0' || STOCK_LIKE_LT.test(lt);
  const askedQty = Number(rfqQty) || 0;

  if (q > 0 && ltIsStockLike) {
    return q >= askedQty ? 'in_stock_full' : 'in_stock_partial';
  }
  if (q === 0 && ltIsStockLike) return 'unknown';   // vendor told us neither
  if (q > 0 && !ltIsStockLike)  return 'in_stock_partial'; // STOCK+LT — treat as partial
  return 'lead_time';                                      // qty=0 + lt set
}

// Ranking tier order — lower number wins. Used by both ranking rules.
const TIER_ORDER = { in_stock_full: 0, in_stock_partial: 1, lead_time: 2, unknown: 3 };

function compareVQs(a, b, rule) {
  // rule = 'stock_first' (Shortage/Hot Parts) or 'cost_first' (PPV-style)
  if (rule === 'stock_first') {
    // 1. Tier (in-stock beats lead-time, no exceptions — that's the whole
    //    point of the rule for an allocation hunt).
    const ta = TIER_ORDER[a._tier];
    const tb = TIER_ORDER[b._tier];
    if (ta !== tb) return ta - tb;
    // 2. Within the tier, under-target promotes ahead of at/over-target.
    //    Rationale (per operator 2026-05-20): on a Shortage, having stock
    //    AND beating the customer's target is an exceptional outcome —
    //    surface it before "just a tiny bit cheaper but over target".
    const aUT = a._underTarget ? 0 : 1;
    const bUT = b._underTarget ? 0 : 1;
    if (aUT !== bUT) return aUT - bUT;
    // 3. Tiebreaker: cheapest.
    return (a.cost_usd || Infinity) - (b.cost_usd || Infinity);
  }
  // cost_first
  const ca = a.cost_usd || Infinity;
  const cb = b.cost_usd || Infinity;
  if (ca !== cb) return ca - cb;
  // tiebreak: prefer in-stock
  return TIER_ORDER[a._tier] - TIER_ORDER[b._tier];
}

function rankingRuleForType(typeId) {
  // pg may return chuboe_rfq_type_id as a string (numeric column); coerce.
  return STOCK_FIRST_TYPES.has(Number(typeId)) ? 'stock_first' : 'cost_first';
}

// ─── FETCH HELPERS ─────────────────────────────────────────────────────────

async function fetchRfqHeader(rfqNumber) {
  const q = `
    SELECT r.chuboe_rfq_id   AS rfq_id,
           r.value            AS rfq_number,
           r.chuboe_rfq_type_id AS type_id,
           r.created          AS rfq_created,
           bp.name            AS customer_name,
           bp.c_bpartner_id   AS customer_id
    FROM adempiere.chuboe_rfq r
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = r.c_bpartner_id
    WHERE r.value = $1 AND r.isactive = 'Y'
    LIMIT 1
  `;
  const result = await pool.query(q, [rfqNumber]);
  return result.rows[0] || null;
}

// Pull this RFQ's lines + their CPCs. We pull the MPN/MFR from chuboe_rfq_line_mpn
// (where MPN/MFR authoritatively lives), but key the CPC pool off the line's CPC.
async function fetchRfqLines(rfqId) {
  const q = `
    SELECT rl.chuboe_rfq_line_id   AS rfq_line_id,
           rl.chuboe_cpc            AS cpc,
           rl.qty                   AS rfq_qty,
           rl.priceentered          AS rfq_target,
           string_agg(DISTINCT NULLIF(rlm.chuboe_mpn, ''), ', ' ORDER BY NULLIF(rlm.chuboe_mpn,'')) AS rfq_mpns,
           string_agg(DISTINCT NULLIF(COALESCE(mfr.name, rlm.chuboe_mfr_text), ''), ', ') AS rfq_mfrs
    FROM adempiere.chuboe_rfq_line rl
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm
      ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      AND rlm.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_mfr mfr
      ON mfr.chuboe_mfr_id = rlm.chuboe_mfr_id
    WHERE rl.chuboe_rfq_id = $1 AND rl.isactive = 'Y'
    GROUP BY rl.chuboe_rfq_line_id, rl.chuboe_cpc, rl.qty, rl.priceentered
    ORDER BY rl.chuboe_rfq_line_id
  `;
  const result = await pool.query(q, [rfqId]);
  return result.rows;
}

// All in-RFQ VQs. We don't restrict by CPC because every VQ on this RFQ is
// in-scope by definition. Includes deactivated-filter via inner join.
async function fetchInRfqVQs(rfqId) {
  const q = `
    SELECT vq.chuboe_vq_line_id     AS vq_id,
           vq.chuboe_rfq_line_id    AS rfq_line_id,
           rl.chuboe_cpc             AS cpc,
           rl.qty                    AS rfq_qty,
           vq.chuboe_mpn             AS supplier_mpn,
           COALESCE(mfr.name, vq.chuboe_mfr_text, '') AS supplier_mfr,
           bp.name                   AS supplier_partner,
           vq.qty                    AS qty,
           vq.cost                   AS cost,
           COALESCE(cur.iso_code, 'USD') AS currency,
           vq.chuboe_lead_time       AS lead_time,
           vq.chuboe_date_code       AS date_code,
           vq.created                AS created,
           vq.ispurchased            AS ispurchased
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl
      ON rl.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = vq.chuboe_mfr_id
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vq.c_bpartner_id
    LEFT JOIN adempiere.c_currency cur ON cur.c_currency_id = vq.c_currency_id
    WHERE vq.chuboe_rfq_id = $1
      AND vq.isactive = 'Y'
    ORDER BY rl.chuboe_rfq_line_id, vq.cost ASC NULLS LAST
  `;
  const result = await pool.query(q, [rfqId]);
  return result.rows;
}

// Out-of-RFQ VQs on the same CPCs, last 14 days, any RFQ type, excluding this RFQ.
// We carry the source RFQ# so the buyer can see where each comparison came from.
async function fetchOutOfRfqVQs(rfqId, cpcs) {
  const cpcList = cpcs.filter(c => c && c.trim() !== '');
  if (cpcList.length === 0) return [];

  const q = `
    SELECT vq.chuboe_vq_line_id     AS vq_id,
           src_rfq.value             AS src_rfq_number,
           src_rfq.chuboe_rfq_type_id AS src_rfq_type_id,
           src_bp.name               AS src_customer_name,
           rl.chuboe_cpc             AS cpc,
           rl.qty                    AS src_rfq_qty,
           vq.chuboe_mpn             AS supplier_mpn,
           COALESCE(mfr.name, vq.chuboe_mfr_text, '') AS supplier_mfr,
           bp.name                   AS supplier_partner,
           vq.qty                    AS qty,
           vq.cost                   AS cost,
           COALESCE(cur.iso_code, 'USD') AS currency,
           vq.chuboe_lead_time       AS lead_time,
           vq.chuboe_date_code       AS date_code,
           vq.created                AS created,
           vq.ispurchased            AS ispurchased
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl
      ON rl.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
      AND rl.isactive = 'Y'
    JOIN adempiere.chuboe_rfq src_rfq
      ON src_rfq.chuboe_rfq_id = vq.chuboe_rfq_id
      AND src_rfq.isactive = 'Y'
    LEFT JOIN adempiere.c_bpartner src_bp
      ON src_bp.c_bpartner_id = src_rfq.c_bpartner_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = vq.chuboe_mfr_id
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vq.c_bpartner_id
    LEFT JOIN adempiere.c_currency cur ON cur.c_currency_id = vq.c_currency_id
    WHERE vq.chuboe_rfq_id <> $1
      AND vq.isactive = 'Y'
      AND vq.created >= NOW() - INTERVAL '14 days'
      AND rl.chuboe_cpc = ANY($2)
    ORDER BY rl.chuboe_cpc, vq.cost ASC NULLS LAST
  `;
  const result = await pool.query(q, [rfqId, cpcList]);
  return result.rows;
}

// ─── CORE ──────────────────────────────────────────────────────────────────

/**
 * Run sourcing recap for an RFQ number (search_key).
 * Returns { ok, rfqNumber, customer, rfqType, attachments, summary, error? }
 *
 * If the RFQ is Stock type, returns { ok: false, error: 'stock_rfq', message }
 * so the email path can craft a polite redirect reply.
 */
async function runSourcingRecapForRFQ(rfqNumber, { log = () => {} } = {}) {
  log(`fetching RFQ ${rfqNumber}`);
  const header = await fetchRfqHeader(rfqNumber);
  if (!header) {
    return { ok: false, error: 'not_found',
             message: `RFQ ${rfqNumber} not found (or inactive).` };
  }

  if (Number(header.type_id) === STOCK_RFQ_TYPE_ID) {
    return { ok: false, error: 'stock_rfq',
             rfqNumber,
             customer: header.customer_name,
             message: `RFQ ${rfqNumber} is a Stock RFQ. Sourcing Recap doesn't cover Stock RFQs — see the Stock RFQ Loading workflow. For market context on this CPC, reply with the RFQ# only (no BEST keyword) to get Vortex Matches instead.` };
  }

  const rule = rankingRuleForType(header.type_id);
  log(`type=${TYPE_NAMES[Number(header.type_id)] || header.type_id}  rule=${rule}`);

  const lines = await fetchRfqLines(header.rfq_id);
  log(`lines: ${lines.length}`);
  const cpcs = lines.map(l => l.cpc).filter(Boolean);

  const inRfqVQs    = await fetchInRfqVQs(header.rfq_id);
  const outOfRfqVQs = cpcs.length ? await fetchOutOfRfqVQs(header.rfq_id, cpcs) : [];
  log(`in-RFQ VQs: ${inRfqVQs.length}, out-of-RFQ VQs (candidates): ${outOfRfqVQs.length}`);

  // Tag each VQ with its tier (against the relevant rfq_qty) + a normalized USD cost.
  // We rank in USD only — multi-currency is rare on broker quotes and the FX
  // detour costs more than it's worth for a quick recap. Non-USD rows still
  // show in the file but are tier-ranked by raw cost (operator can eyeball).
  // _underTarget = cost is strictly under the CPC's target. For stock_first
  // rule, this promotes the row within its tier (see compareVQs).
  const tagVQ = (vq, rfqQty, rfqTarget) => {
    vq._tier = classifyVQ(vq, rfqQty);
    const c = Number(vq.cost);
    vq.cost_usd = Number.isFinite(c) && c > 0 ? c : null;
    const t = Number(rfqTarget);
    vq._underTarget = Number.isFinite(t) && t > 0 && vq.cost_usd != null && vq.cost_usd < t;
    vq._source = 'in_rfq';
    return vq;
  };

  // Bucket in-RFQ by CPC (the CPC is on the rfq_line we already joined to).
  const cpcBuckets = new Map();
  for (const line of lines) {
    const key = line.cpc || `__noCPC_${line.rfq_line_id}__`;
    cpcBuckets.set(key, {
      cpc: line.cpc || '(no CPC)',
      rfqQty: Number(line.rfq_qty) || 0,
      rfqTarget: line.rfq_target,
      rfqMpns: line.rfq_mpns || '',
      rfqMfrs: line.rfq_mfrs || '',
      inRfq: [],
      outOfRfq: []
    });
  }

  for (const vq of inRfqVQs) {
    const key = vq.cpc || `__noCPC_${vq.rfq_line_id}__`;
    const bucket = cpcBuckets.get(key);
    if (!bucket) continue;
    bucket.inRfq.push(tagVQ(vq, bucket.rfqQty, bucket.rfqTarget));
  }

  for (const vq of outOfRfqVQs) {
    const key = vq.cpc;
    const bucket = cpcBuckets.get(key);
    if (!bucket) continue;
    // Compare to THIS RFQ's qty + target for tier/under-target purposes
    // (not the source RFQ's — we're ranking under the live RFQ's lens).
    vq._tier = classifyVQ(vq, bucket.rfqQty);
    const c = Number(vq.cost);
    vq.cost_usd = Number.isFinite(c) && c > 0 ? c : null;
    const t = Number(bucket.rfqTarget);
    vq._underTarget = Number.isFinite(t) && t > 0 && vq.cost_usd != null && vq.cost_usd < t;
    vq._source = 'out_of_rfq';
    bucket.outOfRfq.push(vq);
  }

  // Rank each bucket. Filter out_of_rfq to those that would rank above at
  // least one in_rfq row under the live rule. If there are no in_rfq rows at
  // all, surface ALL out_of_rfq rows ranked (gives the buyer market context).
  let totalIn = 0, totalOutShown = 0, totalOutPool = 0;
  const ranked = [];

  for (const [, bucket] of cpcBuckets) {
    bucket.inRfq.sort((a, b) => compareVQs(a, b, rule));
    bucket.outOfRfq.sort((a, b) => compareVQs(a, b, rule));
    totalIn += bucket.inRfq.length;
    totalOutPool += bucket.outOfRfq.length;

    let outShown;
    if (bucket.inRfq.length === 0) {
      outShown = bucket.outOfRfq;   // no in-RFQ to compare; show everything
    } else {
      // worst in-RFQ row = last after sort; out-of-RFQ row qualifies if
      // it would beat it (i.e., compareVQs returns < 0).
      const worstIn = bucket.inRfq[bucket.inRfq.length - 1];
      outShown = bucket.outOfRfq.filter(vq => compareVQs(vq, worstIn, rule) < 0);
    }
    totalOutShown += outShown.length;

    // Star the #1 row in the combined ranked list (if any rows at all)
    const combined = [...bucket.inRfq, ...outShown].sort((a, b) => compareVQs(a, b, rule));
    if (combined.length > 0) combined[0]._isBest = true;

    bucket._ranked = combined;
    ranked.push(bucket);
  }

  log(`buckets=${ranked.length}  in-RFQ rows=${totalIn}  out-of-RFQ candidates=${totalOutPool}  out-of-RFQ shown=${totalOutShown}`);

  const xlsxBuf = await buildXlsx({
    header,
    typeName: TYPE_NAMES[Number(header.type_id)] || `Type ${header.type_id}`,
    rule,
    rankedBuckets: ranked
  });

  const filename = `sourcing-recap-${rfqNumber}-${tsForFilename()}.xlsx`;

  return {
    ok: true,
    rfqNumber,
    customer: header.customer_name,
    rfqType: TYPE_NAMES[Number(header.type_id)] || `Type ${header.type_id}`,
    rule,
    summary: {
      buckets: ranked.length,
      inRfqRows: totalIn,
      outOfRfqPool: totalOutPool,
      outOfRfqShown: totalOutShown
    },
    attachments: [{ filename, content: xlsxBuf }]
  };
}

function tsForFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── XLSX WRITER ───────────────────────────────────────────────────────────

// Column definitions, indexed by key. Two presentation orders below:
// SHORTAGE/Hot-Parts uses STOCK_FIRST_COLUMNS (foregrounds Tier/Qty/Cost so
// the report reads as a stock-hunt). All other types use COST_FIRST_COLUMNS
// (foregrounds Cost — PPV-style).
const COL_DEFS = {
  best:             { header: '★',          width: 4  },
  source:           { header: 'Source',     width: 30 },
  cpc:              { header: 'CPC',        width: 18 },
  rfq_qty:          { header: 'RFQ Qty',    width: 10, format: '#,##0' },
  rfq_mpns:         { header: 'RFQ MPN',    width: 24 },
  rfq_mfrs:         { header: 'RFQ MFR',    width: 18 },
  rfq_target:       { header: 'RFQ Target', width: 12, format: '$#,##0.0000' },
  vs_target:        { header: 'Vs Target',  width: 10, format: '0.0%' },
  supplier_mpn:     { header: 'Supplier MPN', width: 22 },
  supplier_mfr:     { header: 'Supplier MFR', width: 18 },
  mfr_match:        { header: 'MFR Match',  width: 11 },
  supplier_partner: { header: 'Supplier',   width: 28 },
  qty:              { header: 'Vendor Qty', width: 11, format: '#,##0' },
  cost:             { header: 'Cost',       width: 12, format: '$#,##0.0000' },
  currency:         { header: 'Curr',       width: 7  },
  tier:             { header: 'Tier',       width: 18 },
  lead_time:        { header: 'Lead Time',  width: 14 },
  date_code:        { header: 'Date Code',  width: 12 },
  created:          { header: 'VQ Created', width: 18 }
};

// Stock-hunt layout: Tier / Vendor Qty / Cost / Lead Time front-loaded so
// the buyer's first scan answers "do we have this in stock?" before anything
// else. Target/Vs Target sit after stock answer.
const STOCK_FIRST_COLUMNS = [
  'best', 'cpc', 'rfq_qty', 'rfq_mpns', 'rfq_mfrs',
  'tier', 'qty', 'cost', 'lead_time',
  'supplier_mfr', 'mfr_match', 'supplier_partner',
  'date_code', 'rfq_target', 'vs_target',
  'supplier_mpn', 'currency', 'source', 'created'
];

// PPV / cost-first layout: Cost / Vs Target front-loaded.
const COST_FIRST_COLUMNS = [
  'best', 'source', 'cpc', 'rfq_qty', 'rfq_mpns', 'rfq_mfrs',
  'rfq_target', 'vs_target', 'cost', 'qty', 'currency',
  'supplier_mpn', 'supplier_mfr', 'mfr_match', 'supplier_partner',
  'tier', 'lead_time', 'date_code', 'created'
];

function columnOrderFor(rule) {
  return rule === 'stock_first' ? STOCK_FIRST_COLUMNS : COST_FIRST_COLUMNS;
}

const TIER_DISPLAY = {
  in_stock_full:    'STOCK ≥ qty',
  in_stock_partial: 'STOCK partial',
  lead_time:        'LEAD TIME',
  unknown:          '? (no signal)'
};

async function buildXlsx({ header, typeName, rule, rankedBuckets }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sourcing Recap';
  wb.created = new Date();
  const ws = wb.addWorksheet('Sourcing Recap');

  const order = columnOrderFor(rule);
  const colCount = order.length;
  const lastColLetter = colLetter(colCount);

  // Title block
  ws.mergeCells(`A1:${lastColLetter}1`);
  ws.getCell('A1').value =
    `Sourcing Recap — RFQ ${header.rfq_number}  •  ${header.customer_name || '(no customer)'}  •  Type: ${typeName}  •  Rule: ${rule === 'stock_first' ? 'Stock-first (in-stock beats lead-time, then cheapest)' : 'Cost-first (cheapest wins, in-stock breaks ties)'}`;
  ws.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  ws.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 22;

  ws.mergeCells(`A2:${lastColLetter}2`);
  ws.getCell('A2').value =
    `Generated ${fmtCT(new Date())}.  Rows grouped by CPC, ranked within group. Out-of-RFQ rows (same CPC, last 14 days, other RFQs) shown only when they would beat at least one in-RFQ row. Under-target rows get a light-green Cost cell.`;
  ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF555555' } };
  ws.getRow(2).height = 18;

  // Header row at row 4
  const headerRowIdx = 4;
  order.forEach((key, i) => {
    const def = COL_DEFS[key];
    const cell = ws.getCell(headerRowIdx, i + 1);
    cell.value = def.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
    ws.getColumn(i + 1).width = def.width;
  });
  ws.getRow(headerRowIdx).height = 22;
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];

  let row = headerRowIdx + 1;
  let cpcGroupIdx = 0;

  for (const bucket of rankedBuckets) {
    if (bucket._ranked.length === 0) continue;

    cpcGroupIdx++;
    const groupBandColor = cpcGroupIdx % 2 === 0 ? 'FFF2F2F2' : 'FFFFFFFF';
    const target = bucket.rfqTarget != null ? Number(bucket.rfqTarget) : null;
    const hasTarget = target != null && target > 0;

    for (const vq of bucket._ranked) {
      const isOut  = vq._source === 'out_of_rfq';
      const isBest = vq._isBest === true;
      const cost   = vq.cost != null ? Number(vq.cost) : null;

      // Under-target: cost < target, both positive. % vs target = (target-cost)/target.
      const isUnderTarget = hasTarget && cost != null && cost > 0 && cost < target;
      const vsTarget = (hasTarget && cost != null && cost > 0)
        ? (target - cost) / target
        : null;

      const sourceLabel = isOut
        ? `Other RFQ #${vq.src_rfq_number}${vq.src_customer_name ? ' • ' + vq.src_customer_name : ''} • ${daysAgo(vq.created)}d ago`
        : 'This RFQ';

      const values = {
        best: isBest ? '★' : '',
        source: sourceLabel,
        cpc: bucket.cpc,
        rfq_qty: bucket.rfqQty,
        rfq_mpns: bucket.rfqMpns,
        rfq_mfrs: displayMfr(bucket.rfqMfrs),
        rfq_target: target,
        vs_target: vsTarget,
        supplier_mpn: vq.supplier_mpn || '',
        supplier_mfr: displayMfr(vq.supplier_mfr),
        mfr_match: computeMfrMatch(bucket.rfqMfrs || '', vq.supplier_mfr || ''),
        supplier_partner: vq.supplier_partner || '',
        qty: vq.qty != null ? Number(vq.qty) : null,
        cost: cost,
        currency: vq.currency || 'USD',
        tier: TIER_DISPLAY[vq._tier] || vq._tier,
        lead_time: vq.lead_time || '',
        date_code: vq.date_code || '',
        created: vq.created ? fmtCTShort(new Date(vq.created)) : ''
      };

      order.forEach((key, i) => {
        const def = COL_DEFS[key];
        const cell = ws.getCell(row, i + 1);
        cell.value = values[key];
        if (def.format && values[key] != null && values[key] !== '') {
          cell.numFmt = def.format;
        }
        // Group banding (base layer)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupBandColor } };

        // Out-of-RFQ emphasis: bold + soft orange overlay across the row
        if (isOut) {
          cell.font = { bold: true, color: { argb: 'FF7F4F00' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
        }

        // Under-target emphasis on Cost + Vs Target cells (green tint).
        // Wins over the orange tint for out-of-RFQ rows on these two cells
        // (under-target out-of-RFQ rows should still scream "under target").
        if (isUnderTarget && (key === 'cost' || key === 'vs_target')) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5F5D5' } };
          cell.font = { bold: true, color: { argb: 'FF0F6B0F' } };
        }

        // Tier coloring (stock_first layout — keep stock signals visible at a glance).
        // STOCK-full → green text; STOCK-partial → amber; LEAD TIME → grey; ? → red.
        if (key === 'tier') {
          const colorMap = {
            in_stock_full:    'FF0F6B0F',
            in_stock_partial: 'FFB07700',
            lead_time:        'FF555555',
            unknown:          'FFC00000'
          };
          const fc = colorMap[vq._tier];
          if (fc) cell.font = { ...(cell.font || {}), bold: true, color: { argb: fc } };
        }

        // ★ cell — gold/bold over everything else
        if (isBest && key === 'best') {
          cell.font = { bold: true, size: 14, color: { argb: 'FFB45F06' } };
          cell.alignment = { horizontal: 'center' };
        }
        // MFR mismatch — red text in MFR Match column only
        if (key === 'mfr_match' && values.mfr_match === 'MISMATCH') {
          cell.font = { bold: true, color: { argb: 'FFC00000' } };
        }
        // Currency non-USD — bold orange as a "look here" signal
        if (key === 'currency' && values.currency && values.currency !== 'USD') {
          cell.font = { bold: true, color: { argb: 'FF7F4F00' } };
        }
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFCCCCCC' } } };
      });
      row++;
    }
    // Blank separator row between CPC groups (just height, no fill)
    ws.getRow(row).height = 6;
    row++;
  }

  // Empty-state row if nothing to show
  if (row === headerRowIdx + 1) {
    ws.mergeCells(`A${row}:${lastColLetter}${row}`);
    const c = ws.getCell(`A${row}`);
    c.value = 'No VQs found for this RFQ (and no recent same-CPC activity in other RFQs in the last 14 days).';
    c.font = { italic: true, color: { argb: 'FF666666' } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Excel column letter helper (1 → A, 27 → AA, etc.). Caps at ZZ which is
// plenty for the column counts we emit.
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function daysAgo(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

// ─── EMAIL BODY ────────────────────────────────────────────────────────────

function buildSummaryHtml(result) {
  if (!result.ok && result.error === 'stock_rfq') {
    return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Sourcing Recap — not run</h2>
<p>${escapeHtml(result.message)}</p>
</body></html>`;
  }
  if (!result.ok) {
    return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Sourcing Recap — error</h2>
<p>${escapeHtml(result.message || 'Unknown error')}</p>
</body></html>`;
  }
  const s = result.summary;
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="margin-bottom:4px">Sourcing Recap — RFQ ${escapeHtml(result.rfqNumber)}</h2>
<div style="color:#555;margin-bottom:12px">
  Customer: <b>${escapeHtml(result.customer || '(none)')}</b> &nbsp;•&nbsp;
  Type: <b>${escapeHtml(result.rfqType)}</b> &nbsp;•&nbsp;
  Ranking: <b>${result.rule === 'stock_first' ? 'Stock-first' : 'Cost-first'}</b>
</div>
<p style="font-size:12px;color:#555">Best-option ranking, not savings. xlsx attached. In-RFQ VQs are always shown. Out-of-RFQ rows (same CPC, last 14 days, other RFQs — bolded with an orange tint in the file) only appear when they beat at least one in-RFQ row.</p>
<table cellpadding="4" cellspacing="0" border="1" style="border-collapse:collapse;font-size:12px;margin-top:8px">
  <tr style="background:#305496;color:#fff">
    <th>CPCs</th><th>In-RFQ rows</th><th>Out-of-RFQ candidates</th><th>Out-of-RFQ surfaced</th>
  </tr>
  <tr style="text-align:center">
    <td>${s.buckets}</td><td>${s.inRfqRows}</td><td>${s.outOfRfqPool}</td><td><b>${s.outOfRfqShown}</b></td>
  </tr>
</table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function cliMain() {
  const argv = process.argv.slice(2);
  const rfqNumber = argv.find(a => /^\d{7}$/.test(a));
  if (!rfqNumber) {
    console.error('Usage: node sourcing-recap.js <rfq_number>');
    process.exit(1);
  }
  const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
  const result = await runSourcingRecapForRFQ(rfqNumber, { log });

  if (!result.ok) {
    console.error(`\nRESULT: ${result.error}\n${result.message}`);
    process.exit(result.error === 'stock_rfq' ? 0 : 2);
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, result.attachments[0].filename);
  fs.writeFileSync(outPath, result.attachments[0].content);

  console.log('\n=== Sourcing Recap ===');
  console.log(`RFQ:      ${result.rfqNumber}`);
  console.log(`Customer: ${result.customer || '(none)'}`);
  console.log(`Type:     ${result.rfqType}  (rule: ${result.rule})`);
  console.log(`CPCs:                  ${result.summary.buckets}`);
  console.log(`In-RFQ rows:           ${result.summary.inRfqRows}`);
  console.log(`Out-of-RFQ candidates: ${result.summary.outOfRfqPool}`);
  console.log(`Out-of-RFQ surfaced:   ${result.summary.outOfRfqShown}`);
  console.log(`\nWrote: ${outPath}`);
}

if (require.main === module) {
  cliMain().then(() => process.exit(0)).catch(err => {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = {
  runSourcingRecapForRFQ,
  buildSummaryHtml,
  // exported for tests / introspection
  classifyVQ,
  compareVQs,
  rankingRuleForType,
  STOCK_RFQ_TYPE_ID,
  TYPE_NAMES
};
