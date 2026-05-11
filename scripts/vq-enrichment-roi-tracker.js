#!/usr/bin/env node
/**
 * VQ Enrichment ROI Tracker — weekly digest on what the API enricher's VQs
 * produced, on BOTH the procurement and sales sides of the funnel.
 *
 * Two conversion funnels, separated by attribution strength:
 *
 *   Procurement (direct attribution):
 *     bot writes VQ → buyer ticks IsPurchased='Y' → PO cut (issotrx='N')
 *     The buyer explicitly chose this VQ. Strong causal signal.
 *
 *   Sales (correlative attribution):
 *     bot enriches RFQ line → seller writes CQ (often off a different VQ)
 *       → CQ marked IsSold='Y' → SO cut (issotrx='Y')
 *     Bot's enrichment may have *informed* the quote even when not the
 *     winning VQ. The "direct_win" subset (SO line.chuboe_vq_line_id points
 *     at a bot VQ) is the only true causal sales-side signal.
 *
 * Per-line state classification (the misalignment flags):
 *   ✅ Matched               — bot VQ purchased AND CQ sold
 *   🟢 Procurement only      — bought, no sale yet, < 2 days old (normal lag)
 *   🟡 Procurement only stale— bought, no sale yet, ≥ 2 days (stranded risk)
 *   🟡 Sales-only no-bot-proc— CQ sold but no bot VQ ticked (sourced elsewhere)
 *   🔴 Sold but PO voided    — fulfillment risk (highest priority flag)
 *   🔴 PO voided             — bot's purchase reversed
 *   ⚪ No activity           — enriched, neither bought nor sold
 *
 * Breadcrumb: `chuboe_vq_line.createdby = 1049524` (Claude Harris /
 * Tsunami User) identifies API-written VQs.
 *
 * USAGE:
 *   node vq-enrichment-roi-tracker.js                # normal cron
 *   node vq-enrichment-roi-tracker.js --window 60    # trailing 60 days
 *   node vq-enrichment-roi-tracker.js --dry-run      # skip email
 *
 * Cron (weekly Monday 7 AM UTC) — registered in cron-jobs.js.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { Pool } = require('pg');
const { createNotifier } = require('../shared/notifier');
const { getApiCoverageBps } = require('../shared/franchise-api');
const {
  LAM_BP_ID,
  STOCK_RFQ_TYPE_ID,
  SEGMENTS,
  classifySegment,
  isWinningContext,
} = require('../shared/business-segments');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const LOG_FILE = '/tmp/vq-enrichment-roi.log';

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const FROM_EMAIL = 'rfqloading@orangetsunami.com';

const API_WRITER_USER_ID = 1049524;
const DEFAULT_WINDOW_DAYS = 30;
const STALE_PROC_DAYS = 2;          // bought-but-not-sold beyond this = stale
const VOIDED_DOCSTATUS = ['VO', 'RE']; // exclude from "real conversion" counts
// Segment IDs (LAM_BP_ID, STOCK_RFQ_TYPE_ID) are imported from
// shared/business-segments.js — single source of truth for "winning vs
// efficiency" framing across all bot-activity reports.
const UNASSIGNED_USER_ID = 1046201; // OT placeholder user — exclude from "human took over" signal

// Vendor types Claude's franchise APIs should cover. If an alt-route win went
// to one of these but Claude didn't quote that vendor on the line, it's a
// "missed franchise" — a bot coverage gap worth investigating. Anything else
// is broker-side supply (not actionable for the bot).
const FRANCHISE_VENDOR_TYPE_IDS = [
  1000001, // Manufacture Direct Component
  1000002, // Franchise
  1000007, // Manufacture Direct Assemblies
  1000008, // Catalog (DigiKey, Mouser, Newark, Farnell)
  1000009, // Online Distributor (Arrow, Future, Verical)
  1000011, // Manufacture/Franchise w/ no QA accreditation
];

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(...args) {
  const line = `${new Date().toISOString()} - ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─── DB ──────────────────────────────────────────────────────────────────────

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

/**
 * One row per enriched RFQ line in the window, with both procurement and
 * sales metrics joined. Per-line classification happens in aggregate().
 */
async function queryEnrichedLines(windowDays, apiCoverageBps) {
  const sql = `
    WITH api_vq AS (
      SELECT DISTINCT vl.chuboe_rfq_line_id,
             vl.chuboe_vq_line_id,
             vl.ispurchased,
             vl.chuboe_mpn,
             vl.cost,
             vl.qty,
             vl.c_bpartner_id,
             vl.chuboe_buyer_id,
             vl.created AS vq_created
      FROM adempiere.chuboe_vq_line vl
      WHERE vl.createdby = $1
        AND vl.isactive = 'Y'
        AND (vl.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC')
            > NOW() - ($2 || ' days')::interval
        AND vl.chuboe_rfq_line_id IS NOT NULL
    ),
    api_lines AS (
      SELECT chuboe_rfq_line_id,
             COUNT(DISTINCT chuboe_vq_line_id) AS api_vq_count,
             COUNT(DISTINCT chuboe_vq_line_id) FILTER (WHERE ispurchased = 'Y') AS api_vq_purchased,
             SUM(CASE WHEN ispurchased = 'Y' THEN COALESCE(cost,0) * COALESCE(qty,0) ELSE 0 END) AS purchased_extended,
             -- Buyer-field signal on Claude Harris's purchased VQs:
             --   purchased_buyer_self  = ticked while Claude is still the buyer (no human took over)
             --   purchased_buyer_human = a human took over the buyer assignment, then ticked
             BOOL_OR(ispurchased = 'Y' AND chuboe_buyer_id = 1049524) AS purchased_buyer_self,
             BOOL_OR(ispurchased = 'Y' AND chuboe_buyer_id IS NOT NULL AND chuboe_buyer_id NOT IN (1049524, 1046201)) AS purchased_buyer_human,
             MIN(vq_created) AS first_vq_created
      FROM api_vq
      GROUP BY chuboe_rfq_line_id
    ),
    -- POs cut from bot's VQs (procurement, issotrx='N')
    po_agg AS (
      SELECT av.chuboe_rfq_line_id,
             COUNT(DISTINCT ol.c_orderline_id) FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS po_lines,
             COUNT(DISTINCT o.c_order_id)    FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS po_count,
             SUM(ol.linenetamt)              FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS po_net,
             COUNT(DISTINCT ol.c_orderline_id) FILTER (WHERE o.docstatus IN ('VO','RE')) AS po_voided_lines,
             SUM(ol.linenetamt)              FILTER (WHERE o.docstatus IN ('VO','RE')) AS po_voided_net,
             MAX(o.dateordered) FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS last_po_date
      FROM api_vq av
      JOIN adempiere.c_orderline ol ON ol.chuboe_vq_line_id = av.chuboe_vq_line_id
      JOIN adempiere.c_order o ON o.c_order_id = ol.c_order_id
      WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
        AND o.issotrx = 'N'
      GROUP BY av.chuboe_rfq_line_id
    ),
    -- CQs on enriched lines (sales activity, regardless of who wrote the VQ)
    cq_agg AS (
      SELECT chuboe_rfq_line_id,
             COUNT(*) AS cq_count,
             SUM(CASE WHEN issold = 'Y' THEN 1 ELSE 0 END) AS cq_sold,
             SUM(CASE WHEN issold = 'Y' THEN COALESCE(priceentered,0) * COALESCE(qty,0) ELSE 0 END) AS cq_sold_net,
             MIN(created) AS first_cq_created,
             MIN(created) FILTER (WHERE issold = 'Y') AS first_sold_cq_created
      FROM adempiere.chuboe_cq_line
      WHERE isactive = 'Y'
        AND chuboe_rfq_line_id IN (SELECT chuboe_rfq_line_id FROM api_lines)
      GROUP BY chuboe_rfq_line_id
    ),
    -- SOs via the CQs above (sales side, issotrx='Y')
    so_via_cq AS (
      SELECT cql.chuboe_rfq_line_id,
             COUNT(DISTINCT ol.c_orderline_id) FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS so_lines,
             SUM(ol.linenetamt)               FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS so_net
      FROM adempiere.chuboe_cq_line cql
      JOIN adempiere.c_orderline ol ON ol.chuboe_cq_line_id = cql.chuboe_cq_line_id
      JOIN adempiere.c_order o ON o.c_order_id = ol.c_order_id
      WHERE cql.chuboe_rfq_line_id IN (SELECT chuboe_rfq_line_id FROM api_lines)
        AND ol.isactive = 'Y' AND o.isactive = 'Y'
        AND o.issotrx = 'Y'
      GROUP BY cql.chuboe_rfq_line_id
    ),
    -- Subset of sales attribution where SO line *directly* points at API VQ
    direct_win AS (
      SELECT av.chuboe_rfq_line_id,
             COUNT(DISTINCT ol.c_orderline_id) FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS direct_so_lines,
             SUM(ol.linenetamt)               FILTER (WHERE o.docstatus NOT IN ('VO','RE')) AS direct_so_net
      FROM api_vq av
      JOIN adempiere.c_orderline ol ON ol.chuboe_vq_line_id = av.chuboe_vq_line_id
      JOIN adempiere.c_order o ON o.c_order_id = ol.c_order_id
      WHERE ol.isactive = 'Y' AND o.isactive = 'Y'
        AND o.issotrx = 'Y'
      GROUP BY av.chuboe_rfq_line_id
    ),
    -- Pull MPN for the line (RFQ Line MPN, primary alt)
    line_mpn AS (
      SELECT DISTINCT ON (chuboe_rfq_line_id)
             chuboe_rfq_line_id,
             chuboe_mpn,
             chuboe_mfr_text
      FROM adempiere.chuboe_rfq_line_mpn
      WHERE isactive = 'Y'
        AND chuboe_rfq_line_id IN (SELECT chuboe_rfq_line_id FROM api_lines)
      ORDER BY chuboe_rfq_line_id, chuboe_rfq_line_mpn_id
    ),
    -- Distinct vendors quoted by the bot, per line
    bot_vendors_by_line AS (
      SELECT chuboe_rfq_line_id, c_bpartner_id
      FROM api_vq
      WHERE c_bpartner_id IS NOT NULL
      GROUP BY 1, 2
    ),
    -- Human VQ supply-route classification per line.
    -- Notable patterns:
    --   mirror_vendor  = human VQ on same vendor as bot (= duplicate quote)
    --   alternate      = human VQ on vendor bot didn't quote
    --   stub           = human VQ with no vendor (started writing, didn't finish)
    --   *_won          = same patterns but limited to VQs ticked IsPurchased
    human_vqs_by_line AS (
      SELECT vq.chuboe_rfq_line_id,
             COUNT(*) AS human_vq_count,
             COUNT(*) FILTER (WHERE vq.c_bpartner_id IS NULL) AS stub_count,
             COUNT(DISTINCT vq.c_bpartner_id) FILTER (WHERE vq.c_bpartner_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM bot_vendors_by_line bv
               WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                 AND bv.c_bpartner_id = vq.c_bpartner_id
             )) AS mirror_vendors,
             COUNT(DISTINCT vq.c_bpartner_id) FILTER (WHERE vq.c_bpartner_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM bot_vendors_by_line bv
               WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                 AND bv.c_bpartner_id = vq.c_bpartner_id
             )) AS alternate_vendors,
             BOOL_OR(vq.ispurchased = 'Y' AND vq.c_bpartner_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM bot_vendors_by_line bv
               WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                 AND bv.c_bpartner_id = vq.c_bpartner_id
             )) AS mirror_won,
             BOOL_OR(vq.ispurchased = 'Y' AND vq.c_bpartner_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM bot_vendors_by_line bv
               WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                 AND bv.c_bpartner_id = vq.c_bpartner_id
             )) AS alternate_won,
             -- "Missed franchise": alt-route IsPurchased VQ on a vendor type
             -- Claude's franchise APIs should have covered, but didn't quote.
             BOOL_OR(vq.ispurchased = 'Y' AND vq.c_bpartner_id IS NOT NULL
               AND vq.chuboe_vendortype_id IN (1000001,1000002,1000007,1000008,1000009,1000011)
               AND NOT EXISTS (
                 SELECT 1 FROM bot_vendors_by_line bv
                 WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                   AND bv.c_bpartner_id = vq.c_bpartner_id
               )) AS alternate_won_franchise,
             -- "Claude calls this vendor but missed": alt-route IsPurchased VQ
             -- on a vendor in Claude's API coverage set ($3). Means Claude has
             -- an API for this distributor but didn't surface the part —
             -- quota exhausted, timeout, or response didn't include this MPN.
             BOOL_OR(vq.ispurchased = 'Y' AND vq.c_bpartner_id IS NOT NULL
               AND vq.c_bpartner_id = ANY($3::int[])
               AND NOT EXISTS (
                 SELECT 1 FROM bot_vendors_by_line bv
                 WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                   AND bv.c_bpartner_id = vq.c_bpartner_id
               )) AS alternate_won_api_covered,
             -- "Mirror won on franchise vendor": human's mirror VQ that was
             -- ticked is on a franchise vendortype. Used to gate "Claude was
             -- late" — broker mirrors are excluded.
             BOOL_OR(vq.ispurchased = 'Y' AND vq.c_bpartner_id IS NOT NULL
               AND vq.chuboe_vendortype_id IN (1000001,1000002,1000007,1000008,1000009,1000011)
               AND EXISTS (
                 SELECT 1 FROM bot_vendors_by_line bv
                 WHERE bv.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
                   AND bv.c_bpartner_id = vq.c_bpartner_id
               )) AS mirror_won_franchise,
             MIN(vq.created) AS first_human_vq_created
      FROM adempiere.chuboe_vq_line vq
      WHERE vq.isactive = 'Y'
        AND vq.createdby <> $1
        AND vq.chuboe_rfq_line_id IN (SELECT chuboe_rfq_line_id FROM api_lines)
      GROUP BY 1
    )
    SELECT rl.chuboe_rfq_line_id,
           r.chuboe_rfq_id,
           r.value AS rfq_value,
           r.c_bpartner_id AS bp_id,
           r.chuboe_rfq_type_id AS rfq_type_id,
           rt.name AS rfq_type,
           bp.name AS customer,
           r.salesrep_id AS salesrep_id,
           sru.name AS salesrep_name,
           r.created AS rfq_created,
           lm.chuboe_mpn AS mpn,
           lm.chuboe_mfr_text AS mfr,
           rl.chuboe_cpc AS cpc,
           rl.qty AS rfq_qty,
           al.api_vq_count,
           al.api_vq_purchased,
           COALESCE(al.purchased_extended, 0) AS purchased_extended,
           COALESCE(al.purchased_buyer_self, false) AS purchased_buyer_self,
           COALESCE(al.purchased_buyer_human, false) AS purchased_buyer_human,
           al.first_vq_created,
           COALESCE(po.po_lines, 0)        AS po_lines,
           COALESCE(po.po_count, 0)        AS po_count,
           COALESCE(po.po_net, 0)          AS po_net,
           COALESCE(po.po_voided_lines, 0) AS po_voided_lines,
           COALESCE(po.po_voided_net, 0)   AS po_voided_net,
           po.last_po_date,
           COALESCE(cq.cq_count, 0)        AS cq_count,
           COALESCE(cq.cq_sold, 0)         AS cq_sold,
           COALESCE(cq.cq_sold_net, 0)     AS cq_sold_net,
           cq.first_cq_created             AS first_cq_created,
           cq.first_sold_cq_created        AS first_sold_cq_created,
           COALESCE(sc.so_lines, 0)        AS so_lines,
           COALESCE(sc.so_net, 0)          AS so_net,
           COALESCE(dw.direct_so_lines, 0) AS direct_so_lines,
           COALESCE(dw.direct_so_net, 0)   AS direct_so_net,
           COALESCE(hv.human_vq_count, 0)    AS human_vq_count,
           COALESCE(hv.stub_count, 0)        AS stub_count,
           COALESCE(hv.mirror_vendors, 0)    AS mirror_vendors,
           COALESCE(hv.alternate_vendors, 0) AS alternate_vendors,
           COALESCE(hv.mirror_won, false)    AS mirror_won,
           COALESCE(hv.alternate_won, false) AS alternate_won,
           COALESCE(hv.alternate_won_franchise, false) AS alternate_won_franchise,
           COALESCE(hv.alternate_won_api_covered, false) AS alternate_won_api_covered,
           COALESCE(hv.mirror_won_franchise, false) AS mirror_won_franchise,
           hv.first_human_vq_created           AS first_human_vq_created
    FROM api_lines al
    JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id = rl.chuboe_rfq_id
    LEFT JOIN adempiere.chuboe_rfq_type rt ON rt.chuboe_rfq_type_id = r.chuboe_rfq_type_id
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = r.c_bpartner_id
    LEFT JOIN adempiere.ad_user sru ON sru.ad_user_id = r.salesrep_id
    LEFT JOIN line_mpn lm ON lm.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN po_agg po   ON po.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN cq_agg cq   ON cq.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN so_via_cq sc ON sc.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN direct_win dw ON dw.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN human_vqs_by_line hv ON hv.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
  `;
  const { rows } = await pool.query(sql, [API_WRITER_USER_ID, String(windowDays), apiCoverageBps]);
  return rows;
}

// ─── AGGREGATION ─────────────────────────────────────────────────────────────

function classify(r) {
  const purchasedTicked = Number(r.api_vq_purchased) > 0;
  const hasPo          = Number(r.po_lines) > 0;
  const hasPoVoided    = Number(r.po_voided_lines) > 0;
  const hasCqSold      = Number(r.cq_sold) > 0;

  if (hasCqSold && hasPoVoided && !hasPo) return 'soldButPoVoided';
  if (purchasedTicked && hasCqSold)       return 'matched';
  if (purchasedTicked && !hasCqSold) {
    if (hasPo && r.last_po_date) {
      const ageDays = (Date.now() - new Date(r.last_po_date).getTime()) / 86_400_000;
      return ageDays >= STALE_PROC_DAYS ? 'procOnlyStale' : 'procOnlyRecent';
    }
    // ticked but PO not yet cut (or only voided POs exist)
    return hasPoVoided ? 'poVoidedOnly' : 'procPendingPo';
  }
  if (!purchasedTicked && hasCqSold) return 'salesOnlyNoProc';
  if (hasPoVoided)                    return 'poVoidedOnly';
  return 'noActivity';
}

function aggregate(rows) {
  const blankBucket = () => ({
    purchasedLines: 0, poLines: 0, poCount: 0, poNet: 0,
    poVoidedLines: 0, poVoidedNet: 0,
    cqSold: 0, cqSoldNet: 0, linesWithSoldCq: 0, soNet: 0,
  });

  const totals = {
    lines: rows.length,
    rfqs: new Set(),
    // Procurement
    purchasedLines: 0,
    purchasedExtended: 0,
    poLines: 0,
    poCount: 0,
    poNet: 0,
    poVoidedLines: 0,
    poVoidedNet: 0,
    // Sales
    linesWithCq: 0,
    cqSold: 0,
    cqSoldNet: 0,
    linesWithSoldCq: 0,
    soLines: 0,
    soNet: 0,
    directWinLines: 0,
    directWinNet: 0,
    // 3-way segment split (priority: LAM > Stock > Adoption):
    //   lam      = customer = Lam Research (autonomous Mon cron)
    //   stock    = RFQ type = Stock (broker-to-broker sales-from-inventory)
    //   adoption = everything else (true seller-driven sourcing)
    lam:      blankBucket(),
    stock:    blankBucket(),
    adoption: blankBucket(),
    // Sales-side win attribution (sold lines only — based on which VQ was IsPurchased)
    winBotSole: 0,        // Claude Harris VQ was the only purchase
    winMirrorSole: 0,     // human won, on a vendor Claude also quoted
    winAlternateSole: 0,  // human won, on a vendor Claude didn't quote
    winSplit: 0,          // multiple categories co-purchased
    winNoPurchase: 0,     // sold but no IsPurchased VQ on the line
    winBotSoleNet: 0,
    winMirrorSoleNet: 0,
    winAlternateSoleNet: 0,
    winSplitNet: 0,
    winNoPurchaseNet: 0,
    // Claude-sole wins by segment (split first by segment, only Adoption is
    // subject to Adopted/Solo classification — LAM and Stock are handled by us
    // and don't represent adoption progression).
    winBotSoleByLam: 0,        // LAM-segment Claude-sole wins (cron, not adoption)
    winBotSoleByLamNet: 0,
    winBotSoleByStock: 0,      // Stock-segment Claude-sole wins (handled by us)
    winBotSoleByStockNet: 0,
    // Adoption-segment Claude-sole wins, sub-classified:
    //   adopted = human wrote competing VQ OR (non-Stock) human took over buyer.
    //             Strongest adoption signal.
    //   solo    = no human signal at all (likely internal allocation or PPV one-off).
    winBotSoleAdopted: 0,           // parent rollup = handoff + competingVq
    winBotSoleSolo: 0,
    winBotSoleAdoptedNet: 0,
    winBotSoleSoloNet: 0,
    // Split of Adopted: was buyer reassigned (handoff) or did human just write a competing VQ?
    //   handoff       = Claude's VQ ticked AND buyer field switched to a human → Bucket 1b
    //   competingVq   = Claude's VQ ticked AND a human wrote a competing VQ but didn't take buyer
    winBotSoleAdoptedHandoff: 0,
    winBotSoleAdoptedHandoffNet: 0,
    winBotSoleAdoptedCompetingVq: 0,
    winBotSoleAdoptedCompetingVqNet: 0,
    // Mirror-won sub-buckets (parent: winMirrorSole)
    //   claudeFirst   = Claude wrote VQ first, human copied to same vendor and ticked → Bucket 1a (revenue Claude generated)
    //   claudeLate    = human wrote first on a franchise vendor, Claude wrote mirror after, human's won → Bucket 2 (Claude-late miss)
    //   broker        = mirror won on a broker/private vendor — informational, not a Claude-generated win
    //   indeterminate = mirror won but timestamps don't allow ordering (one missing) — show in misc
    winMirrorClaudeFirst: 0,
    winMirrorClaudeFirstNet: 0,
    winMirrorClaudeLate: 0,
    winMirrorClaudeLateNet: 0,
    winMirrorBroker: 0,
    winMirrorBrokerNet: 0,
    winMirrorIndeterminate: 0,
    winMirrorIndeterminateNet: 0,
    // Alternate-won sub-buckets (parent: winAlternateSole)
    //   coverageGap   = winning alt vendor IS in Claude's API set → Bucket 3a (Claude should have surfaced — quota/timeout/API miss)
    //   noApi         = winning alt vendor's vendortype is franchise BUT BP not in Claude's API set → Bucket 3b (need to add the distributor's API)
    //   broker        = winning alt is non-franchise — informational, not a Claude responsibility → Bucket 4
    missCoverageGap: 0,
    missCoverageGapNet: 0,
    missNoApi: 0,
    missNoApiNet: 0,
    altWonBroker: 0,
    altWonBrokerNet: 0,
    // Headline rollup: revenue Claude generated (human took over OR copied Claude's VQ)
    // = winBotSoleAdoptedHandoff + winMirrorClaudeFirst (Adoption segment + Real Sourcing window only)
    revenueClaudeGeneratedLines: 0,
    revenueClaudeGeneratedNet: 0,
    // Sourcing-window classification for Adoption sold lines.
    // Customer sourcing decisions take hours-to-days, NOT minutes. Anything
    // sold within 60 min of RFQ creation = RFQ created to process an order
    // (salesperson workflow, not a Claude-competitive event). 1-24 hr needs
    // operator review. 24+ hr is real sourcing where bot attribution applies.
    processOrderLines: 0,     // <60 min — RFQ created to process an order
    processOrderNet: 0,
    needsReviewLines: 0,      // 1-24 hr — operator review window
    needsReviewNet: 0,
    realSourcingLines: 0,     // 24+ hr — real sourcing event
    realSourcingNet: 0,
    // Procurement-side buyer field rollup (across all Claude-purchased lines)
    purchasedBuyerSelfLines: 0,
    purchasedBuyerSelfNet: 0,
    purchasedBuyerHumanLines: 0,
    purchasedBuyerHumanNet: 0,
    // Mirror activity — humans wrote a VQ on the same vendor as Claude
    // (regardless of whether it was ticked or whether the line sold).
    // "Claude got noticed" signal across the full enriched population.
    mirrorActivityLines: 0,
    mirrorActivitySoldLines: 0,
    mirrorActivitySoldNet: 0,
    // Missed franchise — alt-route sold lines where the winning vendor type
    // is one Claude's franchise APIs should have covered. Bot coverage gap.
    missedFranchiseLines: 0,
    missedFranchiseNet: 0,
    // States
    matched: 0,
    procOnlyRecent: 0,
    procOnlyStale: 0,
    procPendingPo: 0,
    salesOnlyNoProc: 0,
    soldButPoVoided: 0,
    soldButPoVoidedNet: 0,  // sold revenue at risk from supplier-side cancellation
    poVoidedOnly: 0,
    noActivity: 0,
  };

  const flagLists = {
    matched: [],
    procOnlyStale: [],
    salesOnlyNoProc: [],
    soldButPoVoided: [],
    poVoidedOnly: [],
    botSoleAdopted: [],   // Claude won where a human was demonstrably involved (adoption signal) — superseded by handoff + competingVq below
    botSoleAdoptedHandoff: [],   // Bucket 1b: Claude's VQ won AND buyer reassigned to human (revenue Claude generated)
    botSoleAdoptedCompetingVq: [], // Adopted residual: human wrote competing VQ but Claude's row got the tick (no buyer handoff)
    botSoleSolo: [],      // Claude won with no human involvement (internal/autonomous)
    processOrderLines: [], // <60 min window — RFQ created to process an order; seller attribution
    needsReviewLines: [],  // 1-24 hr window — operator review for true classification
    botSoleStock: [],     // Claude won on a Stock RFQ — broker-to-broker, separate from adoption
    splitDetail: [],      // Sold lines with multiple winners — show what was bought
    missedFranchise: [],  // Lines where buyer found a franchise Claude didn't quote — superseded by coverageGap + noApi below
    mirrorActivitySold: [], // Sold lines where humans wrote a mirror VQ (any state) — superseded by mirrorClaudeFirst + mirrorClaudeLate below
    mirrorClaudeFirst: [], // Bucket 1a: human copied Claude's VQ to process the order (revenue Claude generated)
    mirrorClaudeLate: [],  // Bucket 2: Claude was late on a franchise vendor, human's VQ won
    missCoverageGap: [],   // Bucket 3a: Claude calls this vendor but missed it (quota/timeout/surface miss)
    missNoApi: [],         // Bucket 3b: franchise vendor but Claude doesn't have an API for this distributor
  };

  // Per-RFQ rollup: which RFQs had POs cut from bot's VQs (procurement wins)
  // and which had sold CQs (sales wins)
  const rfqRollup = new Map();

  const byCustomer = new Map();
  const byType = new Map();

  for (const r of rows) {
    totals.rfqs.add(r.chuboe_rfq_id);

    const segment = classifySegment(r);
    const isLam   = segment === 'lam';
    const isStock = segment === 'stock';
    const isAdoption = segment === 'adoption';
    const bucket  = totals[segment];

    const purchasedHere = Number(r.api_vq_purchased) > 0;
    const cqSoldHere    = Number(r.cq_sold) > 0;
    const cqSoldNetHere = Number(r.cq_sold_net) || 0;
    const poNetHere     = Number(r.po_net) || 0;

    if (purchasedHere) {
      totals.purchasedLines++;
      totals.purchasedExtended += Number(r.purchased_extended) || 0;
      bucket.purchasedLines++;
    }
    totals.poLines       += Number(r.po_lines) || 0;
    totals.poCount       += Number(r.po_count) || 0;
    totals.poNet         += poNetHere;
    totals.poVoidedLines += Number(r.po_voided_lines) || 0;
    totals.poVoidedNet   += Number(r.po_voided_net) || 0;
    bucket.poLines       += Number(r.po_lines) || 0;
    bucket.poCount       += Number(r.po_count) || 0;
    bucket.poNet         += poNetHere;
    bucket.poVoidedLines += Number(r.po_voided_lines) || 0;
    bucket.poVoidedNet   += Number(r.po_voided_net) || 0;

    if (Number(r.cq_count) > 0) totals.linesWithCq++;
    if (cqSoldHere) {
      totals.linesWithSoldCq++;
      totals.cqSold     += Number(r.cq_sold) || 0;
      totals.cqSoldNet  += cqSoldNetHere;
      bucket.linesWithSoldCq++;
      bucket.cqSold     += Number(r.cq_sold) || 0;
      bucket.cqSoldNet  += cqSoldNetHere;
    }
    totals.soLines       += Number(r.so_lines) || 0;
    totals.soNet         += Number(r.so_net) || 0;
    bucket.soNet         += Number(r.so_net) || 0;
    if (Number(r.direct_so_lines) > 0) {
      totals.directWinLines++;
      totals.directWinNet += Number(r.direct_so_net) || 0;
    }

    // Sales-side win attribution: classify sold lines by WHICH VQ was ticked
    // IsPurchased (the actual procurement winner), not which VQs existed.
    if (cqSoldHere) {
      const botWon    = purchasedHere;
      const mirrorWon = r.mirror_won === true || r.mirror_won === 't';
      const altWon    = r.alternate_won === true || r.alternate_won === 't';
      const winSignals = [botWon, mirrorWon, altWon].filter(Boolean).length;
      // Timestamp ordering — who wrote first on this line?
      const botVqTs   = r.first_vq_created ? new Date(r.first_vq_created).getTime() : null;
      const humVqTs   = r.first_human_vq_created ? new Date(r.first_human_vq_created).getTime() : null;
      const botFirst    = botVqTs && humVqTs && botVqTs < humVqTs;   // Claude wrote first
      const humanFirst  = botVqTs && humVqTs && humVqTs < botVqTs;   // human wrote first
      const humanTookBuyer = r.purchased_buyer_human === true || r.purchased_buyer_human === 't';
      const mirrorWonFranchise   = r.mirror_won_franchise === true || r.mirror_won_franchise === 't';
      const altWonApiCovered     = r.alternate_won_api_covered === true || r.alternate_won_api_covered === 't';
      const altWonFranchise      = r.alternate_won_franchise === true || r.alternate_won_franchise === 't';
      // Sourcing-window classification — see CLAUDE.md memory feedback_check_window_before_miss_narrative.
      // Adoption sold lines fall into three buckets by RFQ→first-sold-CQ delta:
      //   <60 min  → RFQ created to process an order (salesperson workflow, NOT a bot-competitive event)
      //   1-24 hr  → needs review (operator-curated; could be real or paperwork)
      //   24+ hr   → real sourcing event (where Claude attribution actually applies)
      const rfqTs = r.rfq_created ? new Date(r.rfq_created).getTime() : null;
      // Use first SOLD CQ, not first CQ — the sourcing window closes when the
      // sale lands, not when a quote is drafted. OnCore RFQ 1132927 was the
      // bug case: first CQ written quickly, sold 167 hr later.
      const soldCqTs = r.first_sold_cq_created ? new Date(r.first_sold_cq_created).getTime() : null;
      const rfqToSoldMin = (rfqTs && soldCqTs) ? (soldCqTs - rfqTs) / 60_000 : null;
      const isProcessOrder = isAdoption && rfqToSoldMin !== null && rfqToSoldMin < 60;
      // Needs Review is restricted to ACTIONABLE 1-24hr lines — the winning vendor
      // is in Claude's API-coverage set (so Claude could have surfaced it) OR a
      // franchise vendor where Claude was late. Fast broker buys in this window
      // aren't worth review since Claude never had a path to compete.
      const inNeedsReviewWindow = isAdoption && rfqToSoldMin !== null && rfqToSoldMin >= 60 && rfqToSoldMin < 1440;
      const isNeedsReview = inNeedsReviewWindow && (
        altWonApiCovered ||
        (mirrorWon && mirrorWonFranchise && humanFirst)
      );
      const isRealSourcing = isAdoption && rfqToSoldMin !== null && rfqToSoldMin >= 1440;
      if (isAdoption) {
        if (isProcessOrder) {
          totals.processOrderLines++;
          totals.processOrderNet += cqSoldNetHere;
          flagLists.processOrderLines.push(r);
        } else if (isNeedsReview) {
          totals.needsReviewLines++;
          totals.needsReviewNet += cqSoldNetHere;
          flagLists.needsReviewLines.push(r);
        } else if (isRealSourcing) {
          totals.realSourcingLines++;
          totals.realSourcingNet += cqSoldNetHere;
        }
      }
      // If line is in soldButPoVoided state (sold + bot's PO got voided + no
      // live PO), don't count as a win — supplier-side cancellation, not a
      // genuine fulfillment. Already surfaced in the soldButPoVoided flag.
      const isFulfillmentVoided = botWon
        && Number(r.po_voided_lines) > 0
        && Number(r.po_lines) === 0;
      if (isFulfillmentVoided) {
        // Tracked under soldButPoVoided flag, not under wins.
      } else if (winSignals === 0) {
        totals.winNoPurchase++;
        totals.winNoPurchaseNet += cqSoldNetHere;
      } else if (winSignals > 1) {
        totals.winSplit++;
        totals.winSplitNet += cqSoldNetHere;
        flagLists.splitDetail.push(r);
      } else if (botWon) {
        // Claude's VQ was the one ticked for purchase.
        totals.winBotSole++;
        totals.winBotSoleNet += cqSoldNetHere;
        // Segment first — Adopted/Solo only applies to Adoption-segment wins.
        // LAM and Stock segments are autonomous/handled-by-us, not part of
        // adoption progression analysis.
        if (isLam) {
          totals.winBotSoleByLam++;
          totals.winBotSoleByLamNet += cqSoldNetHere;
        } else if (isStock) {
          totals.winBotSoleByStock++;
          totals.winBotSoleByStockNet += cqSoldNetHere;
          flagLists.botSoleStock.push(r);
        } else if (isAdoption) {
          // Adoption segment: split into handoff / competing-VQ / solo. These all
          // count as revenue Claude generated regardless of window — even if the
          // RFQ was created to process an order, the buyer used Claude's VQ to
          // do it. Window classification (processOrder/needsReview/realSourcing)
          // is informational context, not a gate on attribution.
          const humanCompeted = Number(r.human_vq_count) > 0;
          if (humanTookBuyer) {
            // Bucket 1b: human took over Claude's VQ for processing (buyer reassigned).
            // Revenue Claude generated — human ran the order off Claude's research.
            totals.winBotSoleAdopted++;
            totals.winBotSoleAdoptedNet += cqSoldNetHere;
            totals.winBotSoleAdoptedHandoff++;
            totals.winBotSoleAdoptedHandoffNet += cqSoldNetHere;
            totals.revenueClaudeGeneratedLines++;
            totals.revenueClaudeGeneratedNet += cqSoldNetHere;
            flagLists.botSoleAdopted.push(r);
            flagLists.botSoleAdoptedHandoff.push(r);
          } else if (humanCompeted) {
            // Adopted residual: human wrote a competing VQ but Claude's row was ticked,
            // Claude stayed as buyer. Still revenue Claude generated — Claude's VQ won
            // the sourcing decision; human just shadowed.
            totals.winBotSoleAdopted++;
            totals.winBotSoleAdoptedNet += cqSoldNetHere;
            totals.winBotSoleAdoptedCompetingVq++;
            totals.winBotSoleAdoptedCompetingVqNet += cqSoldNetHere;
            totals.revenueClaudeGeneratedLines++;
            totals.revenueClaudeGeneratedNet += cqSoldNetHere;
            flagLists.botSoleAdopted.push(r);
            flagLists.botSoleAdoptedCompetingVq.push(r);
          } else {
            // Solo: Claude's VQ won outright with no human involvement on the line.
            // In Real Sourcing window this is a clean Claude-generated revenue event
            // (vs Adoption inside <24hr which gets reclassified as process-order).
            totals.winBotSoleSolo++;
            totals.winBotSoleSoloNet += cqSoldNetHere;
            totals.revenueClaudeGeneratedLines++;
            totals.revenueClaudeGeneratedNet += cqSoldNetHere;
            flagLists.botSoleSolo.push(r);
          }
        }
        // (else: LAM/Stock — counted in winBotSole parent above, reported under Efficiency.)
      } else if (mirrorWon) {
        // Human's mirror VQ on Claude's vendor was ticked.
        totals.winMirrorSole++;
        totals.winMirrorSoleNet += cqSoldNetHere;
        // Win sub-bucketing: Adoption + mirror won → either Claude wrote first (1a, revenue
        // Claude generated) or human wrote first on franchise vendor (Bucket 2 — Claude was late).
        // Bucket 2 is gated to Real Sourcing only because "Claude was late" only makes sense
        // when there was a real sourcing competition. Bucket 1a fires in any window.
        if (!isAdoption) {
          // No-op: LAM/Stock — counted in parent, reported under Efficiency.
        } else if (!mirrorWonFranchise) {
          // Mirror won on a broker/private vendor — informational only.
          totals.winMirrorBroker++;
          totals.winMirrorBrokerNet += cqSoldNetHere;
        } else if (botFirst) {
          // Bucket 1a: Claude wrote first, human copied to same vendor and ticked.
          // Revenue Claude generated via processing handoff.
          totals.winMirrorClaudeFirst++;
          totals.winMirrorClaudeFirstNet += cqSoldNetHere;
          totals.revenueClaudeGeneratedLines++;
          totals.revenueClaudeGeneratedNet += cqSoldNetHere;
          flagLists.mirrorClaudeFirst.push(r);
        } else if (humanFirst && isRealSourcing) {
          // Bucket 2: Claude wrote a mirror AFTER human, on a franchise vendor.
          // "Claude was late" only makes sense in a Real Sourcing window — if the
          // line was processOrder/needsReview, the customer had already decided
          // and being earlier wouldn't have changed anything.
          totals.winMirrorClaudeLate++;
          totals.winMirrorClaudeLateNet += cqSoldNetHere;
          flagLists.mirrorClaudeLate.push(r);
        } else {
          // Timestamps don't allow ordering (one missing) — show in misc.
          totals.winMirrorIndeterminate++;
          totals.winMirrorIndeterminateNet += cqSoldNetHere;
        }
      } else if (altWon) {
        // Human's VQ on a vendor Claude didn't quote was ticked.
        totals.winAlternateSole++;
        totals.winAlternateSoleNet += cqSoldNetHere;
        // Miss sub-bucketing gated to Adoption + Real Sourcing — you can't "miss"
        // a competitive sourcing opportunity that never existed (processOrder /
        // needsReview windows = customer already decided pre-RFQ).
        if (!isRealSourcing) {
          // No-op: counted in winAlternateSole parent.
        } else if (altWonApiCovered) {
          // Bucket 3a: Claude has an API for this distributor but didn't surface the part.
          // Quota exhausted, API timeout, response didn't include the MPN.
          totals.missCoverageGap++;
          totals.missCoverageGapNet += cqSoldNetHere;
          flagLists.missCoverageGap.push(r);
        } else if (altWonFranchise) {
          // Bucket 3b: winning alt is franchise vendortype but Claude has no API for that distributor.
          // Need to add this distributor to our API integrations.
          totals.missNoApi++;
          totals.missNoApiNet += cqSoldNetHere;
          flagLists.missNoApi.push(r);
        } else {
          // Bucket 4: broker / private / non-API alt win — not a Claude responsibility.
          totals.altWonBroker++;
          totals.altWonBrokerNet += cqSoldNetHere;
        }
      }
    }

    // Procurement-side buyer-field rollup. Restricted to ADOPTION SEGMENT only —
    // LAM cron and Stock RFQ buyer changes are autonomous-flow / commission-routing
    // mechanics, not adoption signals. See shared/business-segments.js and the
    // `feedback_roi_framing_winning_vs_efficiency` memory.
    if (purchasedHere && isAdoption) {
      if (r.purchased_buyer_self === true || r.purchased_buyer_self === 't') {
        totals.purchasedBuyerSelfLines++;
        totals.purchasedBuyerSelfNet += poNetHere;
      }
      if (r.purchased_buyer_human === true || r.purchased_buyer_human === 't') {
        totals.purchasedBuyerHumanLines++;
        totals.purchasedBuyerHumanNet += poNetHere;
      }
    }

    // Mirror activity (across ALL enriched lines, not just sold)
    if (Number(r.mirror_vendors) > 0) {
      totals.mirrorActivityLines++;
      if (cqSoldHere) {
        totals.mirrorActivitySoldLines++;
        totals.mirrorActivitySoldNet += cqSoldNetHere;
        flagLists.mirrorActivitySold.push(r);
      }
    }

    // Missed franchise: sold + alt-route + winning vendor was a franchise type
    // Claude should have surfaced. Coverage-gap signal — ignore broker losses.
    if (cqSoldHere && (r.alternate_won_franchise === true || r.alternate_won_franchise === 't')) {
      totals.missedFranchiseLines++;
      totals.missedFranchiseNet += cqSoldNetHere;
      flagLists.missedFranchise.push(r);
    }

    // Per-RFQ rollup for "wins" detail (procurement-side)
    const rfqKey = r.rfq_value;
    if (purchasedHere || Number(r.po_lines) > 0) {
      if (!rfqRollup.has(rfqKey)) {
        rfqRollup.set(rfqKey, {
          rfq_value: r.rfq_value,
          customer: r.customer || 'UNKNOWN',
          rfq_type: r.rfq_type || 'UNKNOWN',
          segment,
          lines: 0, poLines: 0, poNet: 0, poVoidedLines: 0,
        });
      }
      const w = rfqRollup.get(rfqKey);
      w.lines++;
      w.poLines       += Number(r.po_lines) || 0;
      w.poNet         += poNetHere;
      w.poVoidedLines += Number(r.po_voided_lines) || 0;
    }

    const state = classify(r);
    totals[state] = (totals[state] || 0) + 1;
    if (state === 'soldButPoVoided') totals.soldButPoVoidedNet += cqSoldNetHere;
    if (flagLists[state]) flagLists[state].push(r);

    const cust = r.customer || 'UNKNOWN';
    if (!byCustomer.has(cust)) byCustomer.set(cust, {
      lines: 0, purchased: 0, poNet: 0, soldCq: 0, cqSoldNet: 0, soNet: 0,
    });
    const c = byCustomer.get(cust);
    c.lines++;
    if (purchasedHere) c.purchased++;
    c.poNet     += poNetHere;
    if (cqSoldHere) c.soldCq++;
    c.cqSoldNet += cqSoldNetHere;
    c.soNet     += Number(r.so_net) || 0;

    const t = r.rfq_type || 'UNKNOWN';
    if (!byType.has(t)) byType.set(t, {
      lines: 0, purchased: 0, poNet: 0, soldCq: 0, cqSoldNet: 0, soNet: 0,
    });
    const bt = byType.get(t);
    bt.lines++;
    if (purchasedHere) bt.purchased++;
    bt.poNet     += poNetHere;
    if (cqSoldHere) bt.soldCq++;
    bt.cqSoldNet += cqSoldNetHere;
    bt.soNet     += Number(r.so_net) || 0;
  }

  return { totals, flagLists, byCustomer, byType, rfqRollup };
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────

function fmtInt(n) { return Number(n || 0).toLocaleString(); }
function fmtPct(num, den) { return den ? `${(100 * num / den).toFixed(1)}%` : '—'; }
function fmtUsd(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}
function fmtTimestamp(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
}
// "+10m", "+3h", "+2d 4h" — relative delta from base. Returns '—' on missing data.
function fmtDelta(base, target) {
  if (!base || !target) return '—';
  const ms = new Date(target).getTime() - new Date(base).getTime();
  if (ms < 0) return `−${fmtDelta(target, base).slice(1)}`;
  const mins = Math.round(ms / 60000);
  if (mins < 60)        return `+${mins}m`;
  if (mins < 60 * 24)   return `+${Math.floor(mins/60)}h ${mins%60}m`.replace(' 0m', '');
  const days  = Math.floor(mins / 1440);
  const remH  = Math.floor((mins % 1440) / 60);
  return `+${days}d ${remH}h`.replace(' 0h', '');
}

// Inference text for missed-franchise / mirror-sold lines — heuristic guess
// at why Claude didn't win or didn't quote, based on creation timing.
function diagnoseMissedOrMirror(r) {
  const rfq    = r.rfq_created;
  const botVq  = r.first_vq_created;
  const humVq  = r.first_human_vq_created;
  const cq     = r.first_cq_created;
  const notes  = [];

  // RFQ → first CQ delta (transactional vs sourcing)
  if (cq && rfq) {
    const dMin = (new Date(cq).getTime() - new Date(rfq).getTime()) / 60000;
    if (dMin < 30) notes.push('🏃 Transactional RFQ (CQ < 30 min after RFQ — created to process an order, no sourcing window)');
    else if (dMin < 60 * 4) notes.push('⏱ Short window (CQ within 4h of RFQ)');
  }

  // Did Claude even run on this line?
  if (!botVq) {
    notes.push('⚠️ Claude wrote NO VQ on this line — enricher skipped or timed out');
  } else if (rfq && botVq) {
    const dMin = (new Date(botVq).getTime() - new Date(rfq).getTime()) / 60000;
    if (dMin > 60 * 6) notes.push(`Claude enriched ${Math.floor(dMin/60)}h after RFQ — slow enrichment cycle`);
  }

  // Buyer-first signal
  if (humVq && botVq && new Date(humVq) < new Date(botVq)) {
    notes.push('Buyer wrote VQ before Claude enriched — buyer had the answer');
  }

  // For missed franchise specifically — Claude's enrichment ran but the
  // winning vendor was not in the bot's VQ population. Likely API search miss.
  // (Inferred when bot VQs exist on the line but didn't include the winning vendor.)
  if (botVq && Number(r.api_vq_count) > 0) {
    notes.push(`Claude quoted ${r.api_vq_count} vendor(s) on this line but missed the winning one — likely DigiKey/Mouser API search miss`);
  }

  return notes.join(' · ') || '—';
}

function flagTable(rows, columns) {
  if (!rows || !rows.length) return '<p style="color:#666;font-size:12px">(none)</p>';
  const MAX = 25;
  const shown = rows.slice(0, MAX);
  let html = `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0">`;
  for (const col of columns) html += `<th>${esc(col.label)}</th>`;
  html += `</tr>`;
  for (const r of shown) {
    html += `<tr>`;
    for (const col of columns) {
      const v = col.value(r);
      const align = col.align || 'left';
      html += `<td style="text-align:${align}">${col.raw ? v : esc(v ?? '')}</td>`;
    }
    html += `</tr>`;
  }
  html += `</table>`;
  if (rows.length > MAX) html += `<p style="font-size:12px;color:#666">… and ${rows.length - MAX} more not shown.</p>`;
  return html;
}

function renderEmail({ totals, flagLists, byCustomer, byType, rfqRollup }, windowDays) {
  const rfqCount = totals.rfqs.size;
  const soldLines = totals.linesWithSoldCq;

  let html = `<html><body style="font-family:Arial,sans-serif;max-width:1000px">
<h3>Claude Harris API Enrichment ROI — trailing ${windowDays} days</h3>
<p style="color:#666;font-size:13px">
  "Enriched" = RFQ lines with at least one VQ written by Claude Harris (the API enricher, createdby=1049524).<br/>
  Two funnels are tracked separately because attribution differs:
  <b>procurement</b> is direct (buyer ticked Claude Harris's VQ), <b>sales</b> is correlative
  (Claude Harris enriched the line; CQ may have been written off any VQ — the "direct win"
  subset is where the SO points at Claude Harris's VQ specifically).
</p>

<h4>Overview</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Metric</th><th>Count</th><th>$</th></tr>
<tr><td>RFQs touched by Claude Harris</td><td style="text-align:right">${fmtInt(rfqCount)}</td><td></td></tr>
<tr><td>Enriched lines</td><td style="text-align:right">${fmtInt(totals.lines)}</td><td></td></tr>
<tr style="background:#dfd"><td>🏆 Winning business (Adoption) — revenue Claude generated</td>
    <td style="text-align:right">${fmtInt(totals.revenueClaudeGeneratedLines)}</td>
    <td style="text-align:right"><b>${fmtUsd(totals.revenueClaudeGeneratedNet)}</b></td></tr>
<tr style="background:#eef"><td>⚙️ Process efficiency (LAM + Stock) — POs cut by autonomous flows</td>
    <td style="text-align:right">${fmtInt(totals.lam.poCount + totals.stock.poCount)} POs (${fmtInt(totals.lam.poLines + totals.stock.poLines)} lines)</td>
    <td style="text-align:right">${fmtUsd(totals.lam.poNet + totals.stock.poNet)}</td></tr>
</table>

<p style="color:#666;font-size:12px;margin-top:8px">
  <b>Framing:</b> Standard Astute purchasing only buys when a customer order exists. The Adoption segment is the only one where Claude's quote is competing for a real win. LAM Kitting (autonomous Mon cron) and Stock RFQ (broker-to-broker, sales-from-inventory) are exceptions to the buy-on-customer-order rule — operationally valuable, but reported separately under Process Efficiency, not framed as wins. (Source: <code>shared/business-segments.js</code>.)
</p>

<h3 style="background:#dfd;padding:10px;border-left:6px solid #27ae60;margin-top:24px">🏆 Winning business — Adoption segment</h3>
<p style="color:#666;font-size:12px">
  Non-LAM, non-Stock RFQs — seller sourcing for a real customer ask. Customer decision cycles for sourcing run hours to days, so we split Adoption sold lines by the RFQ→sold-CQ window:
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Sourcing window</th><th>Lines</th><th>Revenue</th><th>Read</th></tr>
<tr style="background:#fee"><td><b>📋 &lt; 60 min — RFQ created to process an order</b></td>
    <td style="text-align:right">${fmtInt(totals.processOrderLines)}</td>
    <td style="text-align:right">${fmtUsd(totals.processOrderNet)}</td>
    <td style="font-size:12px">Salesperson workflow: RFQ landed in OT only to document a buy that was already committed. No real sourcing event — Claude attribution doesn't apply.</td></tr>
<tr style="background:#fff3cd"><td><b>⚠️ 1–24 hr — Needs review</b></td>
    <td style="text-align:right">${fmtInt(totals.needsReviewLines)}</td>
    <td style="text-align:right">${fmtUsd(totals.needsReviewNet)}</td>
    <td style="font-size:12px">Borderline — could be tight legitimate sourcing or paperwork. Operator review to classify properly.</td></tr>
<tr style="background:#dfd"><td><b>🏆 24+ hr — Real sourcing event</b></td>
    <td style="text-align:right">${fmtInt(totals.realSourcingLines)}</td>
    <td style="text-align:right">${fmtUsd(totals.realSourcingNet)}</td>
    <td style="font-size:12px">Real competitive window where Claude's quote was one of several competing for the buy. Win attribution applies below.</td></tr>
</table>

<h4>Procurement (Adoption — direct attribution: buyer ticked Claude Harris's VQ)</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Metric</th><th>Count</th><th>%</th><th>$</th></tr>
<tr><td>Lines with Claude's VQ ticked IsPurchased</td>
    <td style="text-align:right">${fmtInt(totals.adoption.purchasedLines)}</td>
    <td style="text-align:right">${fmtPct(totals.adoption.purchasedLines, totals.lines)}</td>
    <td></td></tr>
<tr><td>POs cut from Claude's VQs</td>
    <td style="text-align:right">${fmtInt(totals.adoption.poCount)} (${fmtInt(totals.adoption.poLines)} lines)</td>
    <td></td>
    <td style="text-align:right">${fmtUsd(totals.adoption.poNet)}</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;↳ 🤝 Buyer-field at tick time: <b>human took over</b> (Bucket 1b leading indicator)</td>
    <td style="text-align:right">${fmtInt(totals.purchasedBuyerHumanLines)} lines</td>
    <td style="text-align:right">${fmtPct(totals.purchasedBuyerHumanLines, totals.adoption.purchasedLines)}</td>
    <td style="text-align:right">${fmtUsd(totals.purchasedBuyerHumanNet)}</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;↳ 🤖 Buyer-field at tick time: <b>Claude still buyer</b></td>
    <td style="text-align:right">${fmtInt(totals.purchasedBuyerSelfLines)} lines</td>
    <td style="text-align:right">${fmtPct(totals.purchasedBuyerSelfLines, totals.adoption.purchasedLines)}</td>
    <td style="text-align:right">${fmtUsd(totals.purchasedBuyerSelfNet)}</td></tr>
<tr style="color:#a00"><td>POs voided (all segments)</td>
    <td style="text-align:right">${fmtInt(totals.poVoidedLines)} lines</td>
    <td></td>
    <td style="text-align:right">${fmtUsd(totals.poVoidedNet)}</td></tr>
</table>

<h4>Sales (Adoption — correlative: bot enriched the line, CQ may be off any VQ)</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Metric</th><th>Count</th><th>$</th></tr>
<tr><td>Lines with a CQ marked sold</td>
    <td style="text-align:right">${fmtInt(totals.adoption.linesWithSoldCq)}</td>
    <td style="text-align:right">${fmtUsd(totals.adoption.cqSoldNet)} (revenue)</td></tr>
<tr><td>SOs opened from those CQs</td>
    <td></td>
    <td style="text-align:right">${fmtUsd(totals.adoption.soNet)}</td></tr>
<tr><td>Direct wins (SO points at Claude's VQ — all segments)</td>
    <td style="text-align:right">${fmtInt(totals.directWinLines)} lines</td>
    <td style="text-align:right">${fmtUsd(totals.directWinNet)}</td></tr>
</table>

<h4>💰 Revenue Claude generated (human took over or copied Claude's work)</h4>
<p style="color:#666;font-size:12px">
  Sold lines where Claude's quote drove the outcome — either a human reassigned the buyer slot on Claude's VQ to process it (handoff), or a human re-keyed Claude's vendor onto a second VQ and ticked that one (copy). Both flows = Claude's research → revenue.
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Path</th><th>Lines</th><th>Revenue</th><th>What it means</th></tr>
<tr style="background:#dfd"><td><b>Total</b></td>
    <td style="text-align:right"><b>${fmtInt(totals.revenueClaudeGeneratedLines)}</b></td>
    <td style="text-align:right"><b>${fmtUsd(totals.revenueClaudeGeneratedNet)}</b></td>
    <td style="font-size:12px">Sum of the two paths below.</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;↳ <b>Human took over Claude's VQ (buyer reassigned)</b></td>
    <td style="text-align:right">${fmtInt(totals.winBotSoleAdoptedHandoff)}</td>
    <td style="text-align:right">${fmtUsd(totals.winBotSoleAdoptedHandoffNet)}</td>
    <td style="font-size:12px">Claude's VQ was ticked. Buyer field was switched from Claude to a human for processing.</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;↳ <b>Human copied Claude's VQ to push the purchase through</b></td>
    <td style="text-align:right">${fmtInt(totals.winMirrorClaudeFirst)}</td>
    <td style="text-align:right">${fmtUsd(totals.winMirrorClaudeFirstNet)}</td>
    <td style="font-size:12px">Claude wrote VQ first. Buyer re-keyed the same vendor onto a second VQ and ticked that one.</td></tr>
</table>

${totals.processOrderLines > 0 ? `
<h4 style="background:#fee;padding:8px;border-left:4px solid #c0392b">📋 RFQ created to process an order — by salesperson</h4>
<p style="color:#666;font-size:12px">
  Adoption sold lines where the entire RFQ→sold-CQ flow completed in under 60 minutes. These aren't sourcing events — the customer had already committed to the buy before the RFQ existed in OT. Surfaced by salesperson so the workflow pattern (RFQ-as-order-documentation) is visible.
</p>
${(() => {
  const bySeller = new Map();
  for (const r of flagLists.processOrderLines) {
    const seller = r.salesrep_name || '(unassigned)';
    if (!bySeller.has(seller)) bySeller.set(seller, { lines: 0, revenue: 0, minWindow: Infinity, maxWindow: 0 });
    const s = bySeller.get(seller);
    const win = (new Date(r.first_sold_cq_created).getTime() - new Date(r.rfq_created).getTime()) / 60000;
    s.lines++;
    s.revenue += Number(r.cq_sold_net) || 0;
    s.minWindow = Math.min(s.minWindow, win);
    s.maxWindow = Math.max(s.maxWindow, win);
  }
  const sorted = Array.from(bySeller.entries()).sort((a, b) => b[1].revenue - a[1].revenue);
  let html = `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th>Salesperson</th><th>Lines</th><th>Revenue</th><th>Window range</th></tr>`;
  for (const [seller, s] of sorted) {
    html += `<tr><td>${esc(seller)}</td><td style="text-align:right">${fmtInt(s.lines)}</td><td style="text-align:right">${fmtUsd(s.revenue)}</td><td style="text-align:right;font-size:11px">${Math.round(s.minWindow)}–${Math.round(s.maxWindow)} min</td></tr>`;
  }
  html += `</table>`;
  return html;
})()}
` : ''}

${totals.needsReviewLines > 0 ? `
<h4 style="background:#fff3cd;padding:8px;border-left:4px solid #d4a017">⚠️ Needs review — 1 to 24-hour windows</h4>
<p style="color:#666;font-size:12px">
  Adoption sold lines with a 1–24 hour RFQ→sold-CQ window. Could be tight legitimate sourcing or order-documentation depending on customer behavior. Operator review needed to classify properly.
</p>
${flagTable(flagLists.needsReviewLines, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'Salesperson',  value: r => r.salesrep_name || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'Window (hr)',  value: r => {
      const mins = (new Date(r.first_sold_cq_created).getTime() - new Date(r.rfq_created).getTime()) / 60000;
      return (mins / 60).toFixed(1);
    }, align: 'right' },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
])}
` : ''}

<h4 style="background:#dfd;padding:8px;border-left:4px solid #27ae60">🏆 Sold-line win attribution (all Adoption sold lines, regardless of window)</h4>
<p style="color:#666;font-size:12px">
  Win attribution applies across both Process-Order and Real-Sourcing windows — if a buyer used Claude's VQ to process an order, that's still Claude-attributable revenue. The Process-Order header above shows the wider 22-line totality for context; this table shows who actually won what (in line counts that match the revenue-Claude-generated headline). "Misses" sub-buckets fire only in Real Sourcing (you can't miss what was already decided).
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Win attribution</th><th>Lines</th><th>Revenue</th><th>Note</th></tr>
<tr style="background:#dfd"><td><b>✅ Claude Harris VQ won — sole purchase (Adoption)</b></td>
    <td style="text-align:right">${fmtInt(totals.winBotSoleAdopted + totals.winBotSoleSolo)}</td>
    <td style="text-align:right">${fmtUsd(totals.winBotSoleAdoptedNet + totals.winBotSoleSoloNet)}</td>
    <td style="font-size:12px">Claude Harris wrote the VQ that buyer ticked. Direct attribution.</td></tr>
<tr style="background:#dfd"><td>&nbsp;&nbsp;&nbsp;↳ 🤝 <b>Adopted — human took over Claude's VQ (buyer reassigned)</b></td>
    <td style="text-align:right">${fmtInt(totals.winBotSoleAdoptedHandoff)}</td>
    <td style="text-align:right">${fmtUsd(totals.winBotSoleAdoptedHandoffNet)}</td>
    <td style="font-size:12px">Bucket 1b — counts toward "revenue Claude generated".</td></tr>
<tr style="background:#dfd"><td>&nbsp;&nbsp;&nbsp;↳ 👥 <b>Adopted — human wrote a competing VQ (no buyer handoff)</b></td>
    <td style="text-align:right">${fmtInt(totals.winBotSoleAdoptedCompetingVq)}</td>
    <td style="text-align:right">${fmtUsd(totals.winBotSoleAdoptedCompetingVqNet)}</td>
    <td style="font-size:12px">Human shadowed Claude but Claude's row got the tick; Claude stayed as buyer. Soft adoption signal.</td></tr>
<tr style="background:#dfd"><td>&nbsp;&nbsp;&nbsp;↳ 📦 <b>Solo</b> (Adoption segment — no human signal)</td>
    <td style="text-align:right">${fmtInt(totals.winBotSoleSolo)}</td>
    <td style="text-align:right">${fmtUsd(totals.winBotSoleSoloNet)}</td>
    <td style="font-size:12px">Claude won with no human engagement on the line (internal allocation / PPV one-off).</td></tr>
<tr style="background:#dfd"><td><b>🟢 Human VQ won — mirror vendor</b></td>
    <td style="text-align:right">${fmtInt(totals.winMirrorSole)}</td>
    <td style="text-align:right">${fmtUsd(totals.winMirrorSoleNet)}</td>
    <td style="font-size:12px">A human's VQ on the same vendor Claude quoted was the one ticked.</td></tr>
<tr style="background:#dfd"><td>&nbsp;&nbsp;&nbsp;↳ 📝 <b>Human copied Claude's VQ to push the order through</b></td>
    <td style="text-align:right">${fmtInt(totals.winMirrorClaudeFirst)}</td>
    <td style="text-align:right">${fmtUsd(totals.winMirrorClaudeFirstNet)}</td>
    <td style="font-size:12px">Bucket 1a — Claude wrote first, human re-keyed and ticked. Counts toward "revenue Claude generated".</td></tr>
<tr style="background:#fee"><td>&nbsp;&nbsp;&nbsp;↳ ⏱ <b>Claude was late — wrote mirror after human, human's won (franchise vendor)</b></td>
    <td style="text-align:right">${fmtInt(totals.winMirrorClaudeLate)}</td>
    <td style="text-align:right">${fmtUsd(totals.winMirrorClaudeLateNet)}</td>
    <td style="font-size:12px">Bucket 2 — Claude eventually called the same vendor but the human had already written the winning VQ. Miss to investigate.</td></tr>
<tr style="color:#888"><td>&nbsp;&nbsp;&nbsp;↳ Mirror won on broker vendor (informational)</td>
    <td style="text-align:right">${fmtInt(totals.winMirrorBroker)}</td>
    <td style="text-align:right">${fmtUsd(totals.winMirrorBrokerNet)}</td>
    <td style="font-size:12px">Both Claude and the human had broker VQs on the same vendor. Not a Claude-revenue signal.</td></tr>
${totals.winMirrorIndeterminate > 0 ? `
<tr style="color:#888"><td>&nbsp;&nbsp;&nbsp;↳ Mirror won, timing indeterminate</td>
    <td style="text-align:right">${fmtInt(totals.winMirrorIndeterminate)}</td>
    <td style="text-align:right">${fmtUsd(totals.winMirrorIndeterminateNet)}</td>
    <td style="font-size:12px">One timestamp missing — can't tell if Claude or human wrote first.</td></tr>` : ''}
<tr><td>🔵 Split — multiple winners co-purchased</td>
    <td style="text-align:right">${fmtInt(totals.winSplit)}</td>
    <td style="text-align:right">${fmtUsd(totals.winSplitNet)}</td>
    <td style="font-size:12px">Multi-vendor buy across categories. See drill-in below.</td></tr>
<tr><td>🟡 Human VQ won — alternate supply</td>
    <td style="text-align:right">${fmtInt(totals.winAlternateSole)}</td>
    <td style="text-align:right">${fmtUsd(totals.winAlternateSoleNet)}</td>
    <td style="font-size:12px">Claude enriched but seller sourced from a vendor Claude didn't quote.</td></tr>
<tr style="background:#fee"><td>&nbsp;&nbsp;&nbsp;↳ 🎯 <b>Coverage gap — Claude calls this distributor but missed the part</b></td>
    <td style="text-align:right">${fmtInt(totals.missCoverageGap)}</td>
    <td style="text-align:right">${fmtUsd(totals.missCoverageGapNet)}</td>
    <td style="font-size:12px">Bucket 3a — winning vendor is in Claude's API set. Cause: quota exhausted, API timeout, or response didn't include the MPN. Fixable with code/quota.</td></tr>
<tr style="background:#fee"><td>&nbsp;&nbsp;&nbsp;↳ 🆕 <b>No API for this distributor</b></td>
    <td style="text-align:right">${fmtInt(totals.missNoApi)}</td>
    <td style="text-align:right">${fmtUsd(totals.missNoApiNet)}</td>
    <td style="font-size:12px">Bucket 3b — franchise/catalog/authorized vendor but Claude has no API for it (Heilind, RS, Symmetry, etc.). Fix = add the distributor to API integrations.</td></tr>
<tr style="color:#888"><td>&nbsp;&nbsp;&nbsp;↳ Broker / private alt (informational)</td>
    <td style="text-align:right">${fmtInt(totals.altWonBroker)}</td>
    <td style="text-align:right">${fmtUsd(totals.altWonBrokerNet)}</td>
    <td style="font-size:12px">Bucket 4 — non-franchise vendor; not a Claude responsibility.</td></tr>
<tr style="color:#666"><td>⚪ No purchased VQ on sold line</td>
    <td style="text-align:right">${fmtInt(totals.winNoPurchase)}</td>
    <td style="text-align:right">${fmtUsd(totals.winNoPurchaseNet)}</td>
    <td style="font-size:12px">Sold without IsPurchased flag. Procurement-side process gap.</td></tr>
</table>

<h4 style="background:#fffbe6;padding:8px;border-left:4px solid #d4a017">🪞 Mirror visibility — Claude getting noticed (informational)</h4>
<p style="color:#666;font-size:12px">
  Count of enriched lines where a human wrote a VQ on the same vendor as Claude.
  Doesn't decide who won — just shows that humans engaged with Claude's vendor choice.
  Revenue attribution lives in the buckets above.
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Mirror visibility scope</th><th>Lines</th><th>Note</th></tr>
<tr><td>Lines with any human mirror VQ</td>
    <td style="text-align:right">${fmtInt(totals.mirrorActivityLines)}</td>
    <td style="font-size:12px">Out of ${fmtInt(totals.lines)} enriched (${fmtPct(totals.mirrorActivityLines, totals.lines)})</td></tr>
</table>

${(totals.winBotSoleAdoptedHandoff + totals.winMirrorClaudeFirst) > 0 ? `
<h4 style="background:#dfd;padding:8px;border-left:4px solid #27ae60">✅ Revenue Claude generated — drill-in</h4>` : ''}

${totals.winBotSoleAdoptedHandoff > 0 ? `
<p style="margin-top:14px;color:#666;font-size:12px"><b>Bucket 1b — Human took over Claude's VQ (buyer reassigned):</b></p>
${flagTable(flagLists.botSoleAdoptedHandoff, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Claude VQ',    value: r => fmtDelta(r.rfq_created, r.first_vq_created) },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
])}` : ''}

${totals.winMirrorClaudeFirst > 0 ? `
<p style="margin-top:14px;color:#666;font-size:12px"><b>Bucket 1a — Human copied Claude's VQ to push the order through:</b></p>
${flagTable(flagLists.mirrorClaudeFirst, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Claude VQ',    value: r => fmtDelta(r.rfq_created, r.first_vq_created) },
  { label: 'Human mirror', value: r => fmtDelta(r.rfq_created, r.first_human_vq_created) },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
])}` : ''}

${(totals.winMirrorClaudeLate + totals.missCoverageGap + totals.missNoApi) > 0 ? `
<h4 style="background:#ffe6e6;padding:8px;border-left:4px solid #c0392b">⚠️ Misses — investigate</h4>` : ''}

${totals.winMirrorClaudeLate > 0 ? `
<p style="margin-top:14px;color:#666;font-size:12px"><b>Bucket 2 — Claude was late: wrote mirror AFTER human, on a franchise vendor:</b></p>
${flagTable(flagLists.mirrorClaudeLate, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Human VQ',     value: r => fmtDelta(r.rfq_created, r.first_human_vq_created) },
  { label: 'Claude VQ (late)', value: r => fmtDelta(r.rfq_created, r.first_vq_created) },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
  { label: 'Inferred reason', value: r => diagnoseMissedOrMirror(r) },
])}` : ''}

${totals.missCoverageGap > 0 ? `
<p style="margin-top:14px;color:#666;font-size:12px"><b>Bucket 3a — Coverage gap (Claude calls this distributor but didn't surface the part):</b><br/>
<span style="font-size:11px">Causes: API quota exhausted, timeout, response didn't include the MPN. Fixable with code/quota.</span></p>
${flagTable(flagLists.missCoverageGap, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Claude VQ',    value: r => r.first_vq_created ? fmtDelta(r.rfq_created, r.first_vq_created) : '(none)' },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
  { label: 'Inferred reason', value: r => diagnoseMissedOrMirror(r) },
])}
<p style="font-size:12px;color:#888">Coverage-gap revenue lost: <b>${fmtUsd(totals.missCoverageGapNet)}</b></p>` : ''}

${totals.missNoApi > 0 ? `
<p style="margin-top:14px;color:#666;font-size:12px"><b>Bucket 3b — No API for this distributor (franchise vendor outside Claude's API set):</b><br/>
<span style="font-size:11px">Fix = add the distributor to API integrations.</span></p>
${flagTable(flagLists.missNoApi, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Claude VQ',    value: r => r.first_vq_created ? fmtDelta(r.rfq_created, r.first_vq_created) : '(none)' },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
])}
<p style="font-size:12px;color:#888">No-API revenue lost: <b>${fmtUsd(totals.missNoApiNet)}</b></p>` : ''}

${totals.winBotSoleAdoptedCompetingVq > 0 ? `
<h4 style="background:#e6ffe6;padding:8px;border-left:4px solid #27ae60">👥 Adopted residual — human wrote a competing VQ, Claude's still won</h4>
<p style="color:#666;font-size:12px">
  Adoption-segment lines where Claude's VQ was ticked AND a human wrote a competing VQ (mirror or alternate) but did NOT take over the buyer slot. Soft adoption signal — human engaged with the line but Claude's quote held up as the procurement winner.
</p>
${flagTable(flagLists.botSoleAdoptedCompetingVq, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'Type',         value: r => r.rfq_type || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Claude VQ',    value: r => fmtDelta(r.rfq_created, r.first_vq_created) },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
  { label: 'Human signal', value: r => {
      const parts = [];
      if (Number(r.mirror_vendors) > 0) parts.push(`${r.mirror_vendors} mirror VQ`);
      if (Number(r.alternate_vendors) > 0) parts.push(`${r.alternate_vendors} alt VQ`);
      if (Number(r.stub_count) > 0) parts.push(`${r.stub_count} stub`);
      return parts.join(' · ') || '—';
    }, raw: false },
])}` : ''}

<h3 style="background:#eef;padding:10px;border-left:6px solid #3498db;margin-top:32px">⚙️ Process efficiency — LAM + Stock (NOT framed as wins)</h3>
<p style="color:#666;font-size:12px">
  Activity in the two segments where standard buy-on-customer-order doesn't apply. Claude's involvement here drives process efficiency (autonomous replenishment, broker-to-broker order processing) but isn't competing for a customer-driven win. Tracked separately so it doesn't get conflated with adoption metrics above.
</p>

<h4>💼 LAM Kitting activity (autonomous Mon cron)</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Metric</th><th>Count</th><th>$</th></tr>
<tr><td>Lines with Claude's VQ ticked IsPurchased</td>
    <td style="text-align:right">${fmtInt(totals.lam.purchasedLines)}</td>
    <td></td></tr>
<tr><td>POs cut from Claude's VQs</td>
    <td style="text-align:right">${fmtInt(totals.lam.poCount)} (${fmtInt(totals.lam.poLines)} lines)</td>
    <td style="text-align:right">${fmtUsd(totals.lam.poNet)}</td></tr>
<tr><td>Sold CQs on LAM RFQs (rare — LAM Kitting typically bypasses the CQ flow)</td>
    <td style="text-align:right">${fmtInt(totals.lam.linesWithSoldCq)}</td>
    <td style="text-align:right">${fmtUsd(totals.lam.cqSoldNet)}</td></tr>
</table>

<h4>📋 Stock RFQ activity (broker-to-broker, sales-from-inventory)</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Metric</th><th>Count</th><th>$</th></tr>
<tr><td>Lines with Claude's VQ ticked IsPurchased</td>
    <td style="text-align:right">${fmtInt(totals.stock.purchasedLines)}</td>
    <td></td></tr>
<tr><td>POs cut from Claude's VQs</td>
    <td style="text-align:right">${fmtInt(totals.stock.poCount)} (${fmtInt(totals.stock.poLines)} lines)</td>
    <td style="text-align:right">${fmtUsd(totals.stock.poNet)}</td></tr>
<tr><td>Sold CQs on Stock RFQs</td>
    <td style="text-align:right">${fmtInt(totals.stock.linesWithSoldCq)}</td>
    <td style="text-align:right">${fmtUsd(totals.stock.cqSoldNet)}</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;↳ Claude's VQ ticked AND sold (end-to-end on Stock)</td>
    <td style="text-align:right">${fmtInt(totals.winBotSoleByStock)}</td>
    <td style="text-align:right">${fmtUsd(totals.winBotSoleByStockNet)}</td></tr>
</table>

${totals.winBotSoleByStock > 0 ? `
<p style="margin-top:14px;color:#666;font-size:12px"><b>Stock RFQ end-to-end drill-in:</b></p>
${flagTable(flagLists.botSoleStock, [
  { label: 'RFQ',          value: r => r.rfq_value },
  { label: 'Customer',     value: r => r.customer || '—' },
  { label: 'MPN',          value: r => r.mpn || '—' },
  { label: 'Sold $',       value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'RFQ created',  value: r => fmtTimestamp(r.rfq_created) },
  { label: 'Claude VQ',    value: r => fmtDelta(r.rfq_created, r.first_vq_created) },
  { label: 'First CQ',     value: r => fmtDelta(r.rfq_created, r.first_cq_created) },
])}
` : ''}

${totals.winSplit > 0 ? `
<h4>🔵 Split wins — drill-in (what Claude wrote vs what was actually purchased)</h4>
<p style="color:#666;font-size:12px">
  Lines where multiple categories co-purchased. The signal column shows the win composition (which categories were ticked).
</p>
${flagTable(flagLists.splitDetail, [
  { label: 'RFQ',      value: r => r.rfq_value },
  { label: 'Customer', value: r => r.customer || '—' },
  { label: 'Type',     value: r => r.rfq_type || '—' },
  { label: 'MPN',      value: r => r.mpn || '—' },
  { label: 'Sold $',   value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
  { label: 'Win composition', value: r => {
      const parts = [];
      if (Number(r.api_vq_purchased) > 0) parts.push('✅ Claude');
      if (r.mirror_won === true || r.mirror_won === 't') parts.push('🟢 mirror');
      if (r.alternate_won === true || r.alternate_won === 't') parts.push('🟡 alternate');
      return parts.join(' + ');
    }, raw: false },
])}` : ''}

<h4>Per-line state breakdown</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>State</th><th>Lines</th></tr>
<tr><td>✅ Matched (purchased AND sold)</td><td style="text-align:right">${fmtInt(totals.matched)}</td></tr>
<tr><td>🟢 Procurement only — recent (&lt; ${STALE_PROC_DAYS}d)</td><td style="text-align:right">${fmtInt(totals.procOnlyRecent)}</td></tr>
<tr style="color:#b80"><td>🟡 Procurement only — stale (≥ ${STALE_PROC_DAYS}d)</td><td style="text-align:right">${fmtInt(totals.procOnlyStale)}</td></tr>
<tr><td>🟢 Procurement pending PO (ticked, no PO yet)</td><td style="text-align:right">${fmtInt(totals.procPendingPo)}</td></tr>
<tr style="color:#b80"><td>🟡 Sales only — no bot procurement</td><td style="text-align:right">${fmtInt(totals.salesOnlyNoProc)}</td></tr>
<tr style="color:#a00;font-weight:bold"><td>🔴 Sold but Claude's PO voided (supplier cancellation)</td><td style="text-align:right">${fmtInt(totals.soldButPoVoided)} (${fmtUsd(totals.soldButPoVoidedNet)} sold revenue at risk)</td></tr>
<tr style="color:#a00"><td>🔴 PO voided (no sale)</td><td style="text-align:right">${fmtInt(totals.poVoidedOnly)}</td></tr>
<tr style="color:#666"><td>⚪ No activity</td><td style="text-align:right">${fmtInt(totals.noActivity)}</td></tr>
</table>`;

  // Flag detail tables
  const detailCols = [
    { label: 'RFQ',      value: r => r.rfq_value },
    { label: 'Customer', value: r => r.customer || '—' },
    { label: 'MPN',      value: r => r.mpn || '—' },
    { label: 'MFR',      value: r => r.mfr || '—' },
    { label: 'Qty',      value: r => fmtInt(r.rfq_qty), align: 'right', raw: true },
  ];

  const procStaleCols = detailCols.concat([
    { label: 'PO Net',   value: r => fmtUsd(r.po_net), align: 'right', raw: true },
    { label: 'PO Date',  value: r => fmtDate(r.last_po_date) },
  ]);
  const salesOnlyCols = detailCols.concat([
    { label: 'CQs Sold', value: r => fmtInt(r.cq_sold), align: 'right', raw: true },
    { label: 'CQ Net',   value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
    { label: 'SO Net',   value: r => fmtUsd(r.so_net), align: 'right', raw: true },
  ]);
  const soldButVoidedCols = detailCols.concat([
    { label: 'CQ Net',     value: r => fmtUsd(r.cq_sold_net), align: 'right', raw: true },
    { label: 'Voided $',   value: r => fmtUsd(r.po_voided_net), align: 'right', raw: true },
    { label: 'Voided lines', value: r => fmtInt(r.po_voided_lines), align: 'right', raw: true },
  ]);
  const poVoidedCols = detailCols.concat([
    { label: 'Voided lines', value: r => fmtInt(r.po_voided_lines), align: 'right', raw: true },
    { label: 'Voided $',     value: r => fmtUsd(r.po_voided_net), align: 'right', raw: true },
  ]);

  if (totals.soldButPoVoided > 0) {
    html += `<h4 style="color:#a00">🔴 Sold but bot's PO voided — ${fmtInt(totals.soldButPoVoided)} line(s) — fulfillment risk</h4>`;
    html += flagTable(flagLists.soldButPoVoided, soldButVoidedCols);
  }
  if (totals.poVoidedOnly > 0) {
    html += `<h4 style="color:#a00">🔴 PO voided (no sale) — ${fmtInt(totals.poVoidedOnly)} line(s)</h4>`;
    html += flagTable(flagLists.poVoidedOnly, poVoidedCols);
  }
  if (totals.procOnlyStale > 0) {
    html += `<h4 style="color:#b80">🟡 Procurement only — stale (≥ ${STALE_PROC_DAYS}d) — ${fmtInt(totals.procOnlyStale)} line(s)</h4>`;
    html += flagTable(flagLists.procOnlyStale, procStaleCols);
  }
  if (totals.salesOnlyNoProc > 0) {
    html += `<h4 style="color:#b80">🟡 Sales only — sold without bot procurement — ${fmtInt(totals.salesOnlyNoProc)} line(s)</h4>`;
    html += `<p style="font-size:12px;color:#666">Bot enriched the line and a sale occurred, but the bot's VQ wasn't ticked IsPurchased — sourced elsewhere or seller picked a non-bot VQ. Adoption-gap signal.</p>`;
    html += flagTable(flagLists.salesOnlyNoProc, salesOnlyCols);
  }

  // RFQ-level procurement wins (where Claude's VQ was actually used end-to-end)
  const wins = [...rfqRollup.values()]
    .filter(w => w.poLines > 0)
    .sort((a, b) => b.poNet - a.poNet);
  const segLabel = s => s === 'lam' ? 'LAM (cron)' : s === 'stock' ? 'Stock RFQ' : 'Adoption';
  const winsLam      = wins.filter(w => w.segment === 'lam');
  const winsStock    = wins.filter(w => w.segment === 'stock');
  const winsAdoption = wins.filter(w => w.segment === 'adoption');
  if (wins.length > 0) {
    html += `<h4>RFQs where Claude Harris's VQ won — POs cut end-to-end (${fmtInt(wins.length)} RFQs)</h4>`;
    html += `<p style="color:#666;font-size:12px">
      Procurement-side direct attribution: Claude wrote the VQ → buyer ticked IsPurchased → support cut a PO.
      ${fmtInt(winsLam.length)} LAM, ${fmtInt(winsStock.length)} Stock, ${fmtInt(winsAdoption.length)} Adoption.
    </p>`;
    const winCols = [
      { label: 'Segment',  value: w => segLabel(w.segment) },
      { label: 'RFQ',      value: w => w.rfq_value },
      { label: 'Customer', value: w => w.customer },
      { label: 'Type',     value: w => w.rfq_type },
      { label: 'Lines',    value: w => fmtInt(w.poLines), align: 'right', raw: true },
      { label: 'PO Net',   value: w => fmtUsd(w.poNet), align: 'right', raw: true },
      { label: 'Voided?',  value: w => w.poVoidedLines > 0 ? `${w.poVoidedLines} ⚠` : '', align: 'right', raw: true },
    ];
    html += flagTable(wins, winCols);
  }

  // Per-customer
  const topCustomers = [...byCustomer.entries()]
    .sort((a, b) => (b[1].purchased + b[1].soldCq) - (a[1].purchased + a[1].soldCq))
    .slice(0, 20);
  html += `<h4>Top 20 customers (by total bot conversion)</h4>
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th>Customer</th><th>Lines</th><th>Purchased</th><th>PO Net</th><th>Sold CQ</th><th>CQ Net</th><th>SO Net</th></tr>`;
  for (const [name, s] of topCustomers) {
    html += `<tr>
      <td>${esc(name)}</td>
      <td style="text-align:right">${fmtInt(s.lines)}</td>
      <td style="text-align:right">${fmtInt(s.purchased)}</td>
      <td style="text-align:right">${fmtUsd(s.poNet)}</td>
      <td style="text-align:right">${fmtInt(s.soldCq)}</td>
      <td style="text-align:right">${fmtUsd(s.cqSoldNet)}</td>
      <td style="text-align:right">${fmtUsd(s.soNet)}</td>
    </tr>`;
  }
  html += `</table>`;

  // Per-RFQ-type
  const types = [...byType.entries()].sort((a, b) => b[1].lines - a[1].lines);
  html += `<h4>By RFQ type</h4>
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th>RFQ Type</th><th>Lines</th><th>Purchased</th><th>PO Net</th><th>Sold CQ</th><th>CQ Net</th><th>SO Net</th></tr>`;
  for (const [name, s] of types) {
    html += `<tr>
      <td>${esc(name)}</td>
      <td style="text-align:right">${fmtInt(s.lines)}</td>
      <td style="text-align:right">${fmtInt(s.purchased)}</td>
      <td style="text-align:right">${fmtUsd(s.poNet)}</td>
      <td style="text-align:right">${fmtInt(s.soldCq)}</td>
      <td style="text-align:right">${fmtUsd(s.cqSoldNet)}</td>
      <td style="text-align:right">${fmtUsd(s.soNet)}</td>
    </tr>`;
  }
  html += `</table>`;

  html += `<p style="font-size:12px;color:#666;margin-top:24px">
    Weekly cron · source: <code>scripts/vq-enrichment-roi-tracker.js</code>
  </p></body></html>`;

  return html;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const windowIdx = argv.indexOf('--window');
  const windowDays = windowIdx >= 0 ? parseInt(argv[windowIdx + 1], 10) : DEFAULT_WINDOW_DAYS;

  log(`VQ Enrichment ROI Tracker starting (window=${windowDays}d${dryRun ? ', DRY RUN' : ''})`);

  const apiCoverageBps = getApiCoverageBps();
  log(`API coverage BPs: ${apiCoverageBps.length} distributors (${apiCoverageBps.join(',')})`);
  const rows = await queryEnrichedLines(windowDays, apiCoverageBps);
  log(`Enriched lines in window: ${rows.length}`);

  const agg = aggregate(rows);
  const { totals } = agg;
  log(
    `RFQs=${totals.rfqs.size} lines=${totals.lines} cqSold=${totals.cqSold}/${totals.cqSoldNet.toFixed(2)} ` +
    `window(processOrder=${totals.processOrderLines}/${totals.processOrderNet.toFixed(2)} ` +
    `needsReview=${totals.needsReviewLines}/${totals.needsReviewNet.toFixed(2)} ` +
    `realSourcing=${totals.realSourcingLines}/${totals.realSourcingNet.toFixed(2)}) ` +
    `revenue-Claude-generated=${totals.revenueClaudeGeneratedLines}/${totals.revenueClaudeGeneratedNet.toFixed(2)} ` +
    `misses(claudeLate=${totals.winMirrorClaudeLate}/${totals.winMirrorClaudeLateNet.toFixed(2)} ` +
    `coverageGap=${totals.missCoverageGap}/${totals.missCoverageGapNet.toFixed(2)} ` +
    `noApi=${totals.missNoApi}/${totals.missNoApiNet.toFixed(2)}) ` +
    `proc(LAM=${totals.lam.poCount}/${totals.lam.poNet.toFixed(2)} ` +
    `Stock=${totals.stock.poCount}/${totals.stock.poNet.toFixed(2)} ` +
    `Adoption=${totals.adoption.poCount}/${totals.adoption.poNet.toFixed(2)})`
  );

  if (dryRun) {
    log('DRY RUN — skipping email');
  } else if (rows.length > 0) {
    const notifier = createNotifier({ fromEmail: FROM_EMAIL, fromName: 'Claude Harris Enrichment ROI' });
    const missTotal = totals.winMirrorClaudeLate + totals.missCoverageGap + totals.missNoApi;
    const missTotalNet = totals.winMirrorClaudeLateNet + totals.missCoverageGapNet + totals.missNoApiNet;
    const efficiencyNet = totals.lam.poNet + totals.stock.poNet;
    const subject =
      `Claude Harris ROI — 🏆 ${fmtUsd(totals.revenueClaudeGeneratedNet)} Claude-driven (${totals.revenueClaudeGeneratedLines} lines) · ` +
      `📋 ${totals.processOrderLines} order-docs (${fmtUsd(totals.processOrderNet)}) · ` +
      `⚙️ ${fmtUsd(efficiencyNet)} efficiency (LAM+Stock)` +
      (totals.needsReviewLines > 0 ? ` · ⚠️ ${totals.needsReviewLines} needs review` : '') +
      (missTotal > 0 ? ` · ⚠️ ${missTotal} misses (${fmtUsd(missTotalNet)})` : '') +
      (totals.soldButPoVoided > 0 ? ` · 🔴 ${totals.soldButPoVoided} PO-voided` : '');
    const html = renderEmail(agg, windowDays);
    try {
      await notifier.sendEmail(NOTIFY_EMAIL, subject, html, { html: true });
      log('Digest email sent');
    } catch (err) {
      log('WARN: email failed:', err.message);
    }
  } else {
    log('No enriched lines in window — skipping email');
  }

  await pool.end();
}

main().catch(async (err) => {
  log('FATAL:', err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
