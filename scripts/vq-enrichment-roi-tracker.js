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

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const LOG_FILE = '/tmp/vq-enrichment-roi.log';

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const FROM_EMAIL = 'rfqloading@orangetsunami.com';

const API_WRITER_USER_ID = 1049524;
const DEFAULT_WINDOW_DAYS = 30;
const STALE_PROC_DAYS = 2;          // bought-but-not-sold beyond this = stale
const VOIDED_DOCSTATUS = ['VO', 'RE']; // exclude from "real conversion" counts

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
async function queryEnrichedLines(windowDays) {
  const sql = `
    WITH api_vq AS (
      SELECT DISTINCT vl.chuboe_rfq_line_id,
             vl.chuboe_vq_line_id,
             vl.ispurchased,
             vl.chuboe_mpn,
             vl.cost,
             vl.qty,
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
             SUM(CASE WHEN issold = 'Y' THEN COALESCE(priceentered,0) * COALESCE(qty,0) ELSE 0 END) AS cq_sold_net
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
    )
    SELECT rl.chuboe_rfq_line_id,
           r.chuboe_rfq_id,
           r.value AS rfq_value,
           rt.name AS rfq_type,
           bp.name AS customer,
           r.created AS rfq_created,
           lm.chuboe_mpn AS mpn,
           lm.chuboe_mfr_text AS mfr,
           rl.chuboe_cpc AS cpc,
           rl.qty AS rfq_qty,
           al.api_vq_count,
           al.api_vq_purchased,
           COALESCE(al.purchased_extended, 0) AS purchased_extended,
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
           COALESCE(sc.so_lines, 0)        AS so_lines,
           COALESCE(sc.so_net, 0)          AS so_net,
           COALESCE(dw.direct_so_lines, 0) AS direct_so_lines,
           COALESCE(dw.direct_so_net, 0)   AS direct_so_net
    FROM api_lines al
    JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id = rl.chuboe_rfq_id
    LEFT JOIN adempiere.chuboe_rfq_type rt ON rt.chuboe_rfq_type_id = r.chuboe_rfq_type_id
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = r.c_bpartner_id
    LEFT JOIN line_mpn lm ON lm.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN po_agg po   ON po.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN cq_agg cq   ON cq.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN so_via_cq sc ON sc.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    LEFT JOIN direct_win dw ON dw.chuboe_rfq_line_id = al.chuboe_rfq_line_id
    WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
  `;
  const { rows } = await pool.query(sql, [API_WRITER_USER_ID, String(windowDays)]);
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
    // States
    matched: 0,
    procOnlyRecent: 0,
    procOnlyStale: 0,
    procPendingPo: 0,
    salesOnlyNoProc: 0,
    soldButPoVoided: 0,
    poVoidedOnly: 0,
    noActivity: 0,
  };

  const flagLists = {
    matched: [],
    procOnlyStale: [],
    salesOnlyNoProc: [],
    soldButPoVoided: [],
    poVoidedOnly: [],
  };

  const byCustomer = new Map();
  const byType = new Map();

  for (const r of rows) {
    totals.rfqs.add(r.chuboe_rfq_id);

    if (Number(r.api_vq_purchased) > 0) {
      totals.purchasedLines++;
      totals.purchasedExtended += Number(r.purchased_extended) || 0;
    }
    totals.poLines       += Number(r.po_lines) || 0;
    totals.poCount       += Number(r.po_count) || 0;
    totals.poNet         += Number(r.po_net) || 0;
    totals.poVoidedLines += Number(r.po_voided_lines) || 0;
    totals.poVoidedNet   += Number(r.po_voided_net) || 0;

    if (Number(r.cq_count) > 0) totals.linesWithCq++;
    if (Number(r.cq_sold) > 0) {
      totals.linesWithSoldCq++;
      totals.cqSold     += Number(r.cq_sold) || 0;
      totals.cqSoldNet  += Number(r.cq_sold_net) || 0;
    }
    totals.soLines       += Number(r.so_lines) || 0;
    totals.soNet         += Number(r.so_net) || 0;
    if (Number(r.direct_so_lines) > 0) {
      totals.directWinLines++;
      totals.directWinNet += Number(r.direct_so_net) || 0;
    }

    const state = classify(r);
    totals[state] = (totals[state] || 0) + 1;
    if (flagLists[state]) flagLists[state].push(r);

    const cust = r.customer || 'UNKNOWN';
    if (!byCustomer.has(cust)) byCustomer.set(cust, {
      lines: 0, purchased: 0, poNet: 0, soldCq: 0, cqSoldNet: 0, soNet: 0,
    });
    const c = byCustomer.get(cust);
    c.lines++;
    if (Number(r.api_vq_purchased) > 0) c.purchased++;
    c.poNet     += Number(r.po_net) || 0;
    if (Number(r.cq_sold) > 0) c.soldCq++;
    c.cqSoldNet += Number(r.cq_sold_net) || 0;
    c.soNet     += Number(r.so_net) || 0;

    const t = r.rfq_type || 'UNKNOWN';
    if (!byType.has(t)) byType.set(t, {
      lines: 0, purchased: 0, poNet: 0, soldCq: 0, cqSoldNet: 0, soNet: 0,
    });
    const bt = byType.get(t);
    bt.lines++;
    if (Number(r.api_vq_purchased) > 0) bt.purchased++;
    bt.poNet     += Number(r.po_net) || 0;
    if (Number(r.cq_sold) > 0) bt.soldCq++;
    bt.cqSoldNet += Number(r.cq_sold_net) || 0;
    bt.soNet     += Number(r.so_net) || 0;
  }

  return { totals, flagLists, byCustomer, byType };
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

function renderEmail({ totals, flagLists, byCustomer, byType }, windowDays) {
  const rfqCount = totals.rfqs.size;

  let html = `<html><body style="font-family:Arial,sans-serif;max-width:1000px">
<h3>API Enrichment ROI — trailing ${windowDays} days</h3>
<p style="color:#666;font-size:13px">
  "Enriched" = RFQ lines with at least one VQ written by the API enricher (createdby=Claude Harris).<br/>
  Two funnels are tracked separately because attribution differs:
  <b>procurement</b> is direct (buyer ticked the bot's VQ), <b>sales</b> is correlative
  (bot enriched the line; CQ may have been written off any VQ — the "direct win"
  subset is where the SO points at the bot's VQ specifically).
</p>

<h4>Headline</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>Metric</th><th>Count</th><th>%</th><th>$</th></tr>
<tr><td>RFQs touched by enricher</td><td style="text-align:right">${fmtInt(rfqCount)}</td><td></td><td></td></tr>
<tr><td>Enriched lines</td><td style="text-align:right">${fmtInt(totals.lines)}</td><td></td><td></td></tr>
<tr style="background:#eef"><td colspan="4"><b>Procurement (direct)</b></td></tr>
<tr><td>Lines with bot VQ ticked IsPurchased</td>
    <td style="text-align:right">${fmtInt(totals.purchasedLines)}</td>
    <td style="text-align:right">${fmtPct(totals.purchasedLines, totals.lines)}</td>
    <td style="text-align:right">${fmtUsd(totals.purchasedExtended)} (cost)</td></tr>
<tr><td>POs cut from bot's VQs</td>
    <td style="text-align:right">${fmtInt(totals.poCount)} (${fmtInt(totals.poLines)} lines)</td>
    <td></td>
    <td style="text-align:right">${fmtUsd(totals.poNet)}</td></tr>
<tr style="color:#a00"><td>POs voided</td>
    <td style="text-align:right">${fmtInt(totals.poVoidedLines)} lines</td>
    <td></td>
    <td style="text-align:right">${fmtUsd(totals.poVoidedNet)}</td></tr>
<tr style="background:#efe"><td colspan="4"><b>Sales (correlative)</b></td></tr>
<tr><td>Lines with any CQ</td>
    <td style="text-align:right">${fmtInt(totals.linesWithCq)}</td>
    <td style="text-align:right">${fmtPct(totals.linesWithCq, totals.lines)}</td>
    <td></td></tr>
<tr><td>CQs marked sold</td>
    <td style="text-align:right">${fmtInt(totals.cqSold)} (${fmtInt(totals.linesWithSoldCq)} lines)</td>
    <td style="text-align:right">${fmtPct(totals.linesWithSoldCq, totals.lines)}</td>
    <td style="text-align:right">${fmtUsd(totals.cqSoldNet)} (revenue)</td></tr>
<tr><td>SOs opened from those CQs</td>
    <td style="text-align:right">${fmtInt(totals.soLines)} lines</td>
    <td></td>
    <td style="text-align:right">${fmtUsd(totals.soNet)}</td></tr>
<tr><td>Direct wins (SO points at bot's VQ)</td>
    <td style="text-align:right">${fmtInt(totals.directWinLines)} lines</td>
    <td style="text-align:right">${fmtPct(totals.directWinLines, totals.lines)}</td>
    <td style="text-align:right">${fmtUsd(totals.directWinNet)}</td></tr>
</table>

<h4>Per-line state breakdown</h4>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0"><th>State</th><th>Lines</th></tr>
<tr><td>✅ Matched (purchased AND sold)</td><td style="text-align:right">${fmtInt(totals.matched)}</td></tr>
<tr><td>🟢 Procurement only — recent (&lt; ${STALE_PROC_DAYS}d)</td><td style="text-align:right">${fmtInt(totals.procOnlyRecent)}</td></tr>
<tr style="color:#b80"><td>🟡 Procurement only — stale (≥ ${STALE_PROC_DAYS}d)</td><td style="text-align:right">${fmtInt(totals.procOnlyStale)}</td></tr>
<tr><td>🟢 Procurement pending PO (ticked, no PO yet)</td><td style="text-align:right">${fmtInt(totals.procPendingPo)}</td></tr>
<tr style="color:#b80"><td>🟡 Sales only — no bot procurement</td><td style="text-align:right">${fmtInt(totals.salesOnlyNoProc)}</td></tr>
<tr style="color:#a00;font-weight:bold"><td>🔴 Sold but bot's PO voided</td><td style="text-align:right">${fmtInt(totals.soldButPoVoided)}</td></tr>
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

  const rows = await queryEnrichedLines(windowDays);
  log(`Enriched lines in window: ${rows.length}`);

  const agg = aggregate(rows);
  const { totals } = agg;
  log(
    `RFQs=${totals.rfqs.size} lines=${totals.lines} ` +
    `procPurchased=${totals.purchasedLines} POs=${totals.poCount} POnet=${totals.poNet.toFixed(2)} ` +
    `cqSold=${totals.cqSold} cqSoldNet=${totals.cqSoldNet.toFixed(2)} ` +
    `directWin=${totals.directWinLines} ` +
    `flags: matched=${totals.matched} procStale=${totals.procOnlyStale} salesNoProc=${totals.salesOnlyNoProc} ` +
    `soldPoVoided=${totals.soldButPoVoided} poVoidedOnly=${totals.poVoidedOnly}`
  );

  if (dryRun) {
    log('DRY RUN — skipping email');
  } else if (rows.length > 0) {
    const notifier = createNotifier({ fromEmail: FROM_EMAIL, fromName: 'Enrichment ROI' });
    const subject =
      `Enrichment ROI — ${fmtInt(totals.poCount)} POs ${fmtUsd(totals.poNet)} (proc) · ` +
      `${fmtInt(totals.cqSold)} CQs sold ${fmtUsd(totals.cqSoldNet)} (sales)` +
      (totals.soldButPoVoided > 0 ? ` · ⚠️ ${totals.soldButPoVoided} PO-voided fulfillment risks` : '');
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
