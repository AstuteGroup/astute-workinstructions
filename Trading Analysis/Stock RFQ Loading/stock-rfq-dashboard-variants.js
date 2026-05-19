/**
 * Stock RFQ Dashboard — design variants
 * =====================================
 *
 * Generates three different visual treatments of the same data so the
 * operator can pick the shape that lands:
 *
 *   1. Treemap — MPN rectangles, area = total RFQ count, color = recency
 *   2. Bubble matrix — recency (x) × unique customers (y), size = volume
 *   3. Card grid — per-MPN cards with sparkline + summary stats
 *
 * Each variant splits MPNs into Qualified / Unqualified panels.
 * Qualified = ≥1 RFQ from a non-Unqualified-Broker BP in the window.
 *
 * Run: node stock-rfq-dashboard-variants.js [--days=30] [--top=20]
 * Outputs: Trading Analysis/Stock RFQ Loading/output/dashboard-{treemap,bubble,cards}.html
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STOCK_RFQ_TYPE_ID = 1000007;
const UNQUALIFIED_BP_ID = 1006505;
const REPORT_TZ = 'America/New_York';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const DAYS = parseInt(flag('days', '30'), 10);
const TOP_N = parseInt(flag('top', '20'), 10);
const OUT_DIR = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Stock RFQ Loading/output';

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

// ─── DATE WINDOW ─────────────────────────────────────────────────────────────

function etMidnight(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const isoBase = `${parts.year}-${parts.month}-${parts.day}T00:00:00`;
  const naive = new Date(isoBase + 'Z');
  const tzNow = new Date(d.toLocaleString('en-US', { timeZone: REPORT_TZ }));
  const utcNow = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMin = Math.round((utcNow - tzNow) / 60_000);
  return new Date(naive.getTime() + offsetMin * 60_000);
}

const now = new Date();
const todayStart = etMidnight(now);
const fromTs = new Date(todayStart.getTime() - (DAYS - 1) * 24 * 60 * 60 * 1000);
const ymdInEt = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const dayAxis = [];
for (let i = 0; i < DAYS; i++) {
  dayAxis.push(ymdInEt(new Date(fromTs.getTime() + i * 24 * 60 * 60 * 1000)));
}

// ─── DATA ────────────────────────────────────────────────────────────────────

async function fetchData() {
  // Per-MPN summary
  const aggSql = `
    WITH base AS (
      SELECT
        mpn.chuboe_mpn_clean,
        mpn.chuboe_mpn,
        mpn.chuboe_mfr_text,
        r.chuboe_rfq_id,
        r.c_bpartner_id,
        r.created
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line       rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn   mpn ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      WHERE r.chuboe_rfq_type_id = $1
        AND r.created AT TIME ZONE 'America/Chicago' >= $2
        AND r.isactive = 'Y' AND rl.isactive = 'Y' AND mpn.isactive = 'Y'
    )
    SELECT
      chuboe_mpn_clean,
      (ARRAY_AGG(chuboe_mpn ORDER BY chuboe_rfq_id DESC))[1] AS display_mpn,
      (ARRAY_AGG(chuboe_mfr_text ORDER BY chuboe_rfq_id DESC)
         FILTER (WHERE chuboe_mfr_text IS NOT NULL AND chuboe_mfr_text <> ''))[1] AS mfr,
      COUNT(DISTINCT chuboe_rfq_id) AS total_rfqs,
      COUNT(DISTINCT chuboe_rfq_id) FILTER (WHERE c_bpartner_id <> $3) AS qualified_rfqs,
      COUNT(DISTINCT chuboe_rfq_id) FILTER (WHERE c_bpartner_id  = $3) AS unqualified_rfqs,
      COUNT(DISTINCT c_bpartner_id) FILTER (WHERE c_bpartner_id <> $3) AS qualified_customers,
      EXTRACT(EPOCH FROM (NOW() - MAX(created)))/86400 AS days_since_last
    FROM base
    GROUP BY chuboe_mpn_clean
  `;
  const aggRes = await pool.query(aggSql, [STOCK_RFQ_TYPE_ID, fromTs, UNQUALIFIED_BP_ID]);

  // Per-MPN×day counts (for sparklines)
  const dailySql = `
    WITH base AS (
      SELECT
        mpn.chuboe_mpn_clean,
        (r.created AT TIME ZONE 'America/Chicago' AT TIME ZONE $1)::date AS day_et,
        r.chuboe_rfq_id
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line       rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn   mpn ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      WHERE r.chuboe_rfq_type_id = $2
        AND r.created AT TIME ZONE 'America/Chicago' >= $3
        AND r.isactive = 'Y' AND rl.isactive = 'Y' AND mpn.isactive = 'Y'
    )
    SELECT chuboe_mpn_clean, day_et, COUNT(DISTINCT chuboe_rfq_id) AS rfqs
    FROM base
    GROUP BY chuboe_mpn_clean, day_et
  `;
  const dailyRes = await pool.query(dailySql, [REPORT_TZ, STOCK_RFQ_TYPE_ID, fromTs]);

  // Stat band (qualified vs unqualified totals for context)
  const bandSql = `
    SELECT
      COUNT(DISTINCT r.chuboe_rfq_id) AS rfq_count,
      COUNT(DISTINCT r.chuboe_rfq_id) FILTER (WHERE r.c_bpartner_id <> $3) AS qualified,
      COUNT(DISTINCT r.chuboe_rfq_id) FILTER (WHERE r.c_bpartner_id  = $3) AS unqualified,
      COUNT(DISTINCT mpn.chuboe_mpn_clean) AS unique_mpns
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line       rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn   mpn ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE r.chuboe_rfq_type_id = $1
      AND r.created AT TIME ZONE 'America/Chicago' >= $2
      AND r.isactive = 'Y' AND rl.isactive = 'Y' AND mpn.isactive = 'Y'
  `;
  const bandRes = await pool.query(bandSql, [
    STOCK_RFQ_TYPE_ID, fromTs, UNQUALIFIED_BP_ID,
  ]);
  const sevenAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayRes = await pool.query(bandSql, [
    STOCK_RFQ_TYPE_ID, todayStart, UNQUALIFIED_BP_ID,
  ]);
  const sevenRes = await pool.query(bandSql, [
    STOCK_RFQ_TYPE_ID, sevenAgo, UNQUALIFIED_BP_ID,
  ]);

  // Stitch daily into agg
  const dailyByMpn = new Map();
  for (const row of dailyRes.rows) {
    const k = row.chuboe_mpn_clean;
    if (!dailyByMpn.has(k)) dailyByMpn.set(k, new Map());
    const dayStr = row.day_et instanceof Date
      ? row.day_et.toISOString().slice(0, 10)
      : String(row.day_et).slice(0, 10);
    dailyByMpn.get(k).set(dayStr, Number(row.rfqs));
  }

  const mpns = aggRes.rows.map(r => ({
    mpnClean: r.chuboe_mpn_clean,
    displayMpn: r.display_mpn,
    mfr: r.mfr,
    totalRfqs: Number(r.total_rfqs),
    qualifiedRfqs: Number(r.qualified_rfqs),
    unqualifiedRfqs: Number(r.unqualified_rfqs),
    qualifiedCustomers: Number(r.qualified_customers),
    daysSinceLast: parseFloat(r.days_since_last),
    days: dailyByMpn.get(r.chuboe_mpn_clean) || new Map(),
    isQualified: Number(r.qualified_rfqs) > 0,
  }));

  // Daily sparkline series — array of counts per dayAxis bucket (oldest → today)
  for (const m of mpns) {
    m.series = dayAxis.map(d => m.days.get(d) || 0);
  }

  // Split + sort
  const qualified   = mpns.filter(m =>  m.isQualified).sort((a, b) => b.totalRfqs - a.totalRfqs).slice(0, TOP_N);
  const unqualified = mpns.filter(m => !m.isQualified).sort((a, b) => b.totalRfqs - a.totalRfqs).slice(0, TOP_N);

  return {
    qualified, unqualified,
    band: {
      today:    todayRes.rows[0],
      sevenDay: sevenRes.rows[0],
      thirtyDay: bandRes.rows[0],
    },
  };
}

// ─── SHARED HELPERS ──────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }

const genLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ, year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(now);

const COMMON_CSS = `
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#222;margin:20px;background:#fafafa}
  h1{font-size:22px;color:#234;margin:0 0 4px}
  h2{font-size:15px;color:#234;margin:24px 0 10px;border-bottom:1px solid #ddd;padding-bottom:4px;text-transform:uppercase;letter-spacing:0.5px}
  .subtitle{color:#888;font-size:12px;margin-bottom:16px}
  .stat-band{display:flex;gap:12px;margin-bottom:8px;flex-wrap:wrap}
  .stat{flex:0 0 220px;background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px}
  .stat .label{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
  .stat .value{font-size:26px;font-weight:bold;color:#234;margin-top:4px;line-height:1}
  .stat .detail{color:#888;font-size:11px;margin-top:6px}
  .footer{color:#888;font-size:11px;margin-top:24px;padding:8px 0;border-top:1px solid #eee}
`;

function renderStatBand(band) {
  const card = (label, b) => `
    <div class="stat">
      <div class="label">${escHtml(label)}</div>
      <div class="value">${fmtInt(b.rfq_count)}</div>
      <div class="detail">
        <b style="color:#234">${fmtInt(b.qualified)}</b> qualified
        &middot;
        <span style="color:#888">${fmtInt(b.unqualified)} unqualified</span>
        <br/>${fmtInt(b.unique_mpns)} unique MPNs
      </div>
    </div>`;
  return `<div class="stat-band">
    ${card('Today (since 00 ET)', band.today)}
    ${card('Last 7 Days', band.sevenDay)}
    ${card(`Last ${DAYS} Days`, band.thirtyDay)}
  </div>`;
}

function shellHtml(title, extraCss, body) {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>${COMMON_CSS}${extraCss}</style>
</head><body>
  <h1>${escHtml(title)}</h1>
  <div class="subtitle">${escHtml(genLabel)} &middot; ${DAYS}-day window &middot; top ${TOP_N} per panel</div>
  ${body}
  <div class="footer">Window: ${escHtml(dayAxis[0])} → ${escHtml(dayAxis[dayAxis.length - 1])}.
    Qualified = ≥1 RFQ from a non-Unqualified-Broker BP (BP ${UNQUALIFIED_BP_ID}).
    Source: chuboe_rfq + chuboe_rfq_line_mpn, type ${STOCK_RFQ_TYPE_ID}.
  </div>
</body></html>`;
}

// ─── VARIANT 1: TREEMAP ──────────────────────────────────────────────────────
//
// Squarified treemap algorithm (Bruls, Huijgens, van Wijk 1999). Each MPN
// becomes a rectangle whose area is proportional to total RFQ count. Cells
// are packed for low aspect ratio. Color = recency (red=hot, pale=stale).

function squarify(items, x, y, w, h) {
  const sorted = items.slice().sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, i) => s + i.value, 0);
  if (total === 0) return [];
  // Scale values to area
  const scaled = sorted.map(i => ({ ...i, area: (i.value / total) * w * h }));
  const out = [];
  layout(scaled, [], x, y, w, h, out);
  return out;
}

function worst(row, side) {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((s, r) => s + r.area, 0);
  const max = Math.max(...row.map(r => r.area));
  const min = Math.min(...row.map(r => r.area));
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

function layout(remaining, row, x, y, w, h, out) {
  if (remaining.length === 0) {
    placeRow(row, x, y, w, h, out);
    return;
  }
  const side = Math.min(w, h);
  const item = remaining[0];
  const newRow = row.concat(item);
  if (row.length === 0 || worst(newRow, side) <= worst(row, side)) {
    layout(remaining.slice(1), newRow, x, y, w, h, out);
  } else {
    const consumed = placeRow(row, x, y, w, h, out);
    if (w >= h) layout(remaining, [], x + consumed, y, w - consumed, h, out);
    else        layout(remaining, [], x, y + consumed, w, h - consumed, out);
  }
}

function placeRow(row, x, y, w, h, out) {
  if (row.length === 0) return 0;
  const sum = row.reduce((s, r) => s + r.area, 0);
  if (w >= h) {
    const colW = sum / h;
    let yy = y;
    for (const item of row) {
      const itemH = item.area / colW;
      out.push({ ...item, x, y: yy, w: colW, h: itemH });
      yy += itemH;
    }
    return colW;
  } else {
    const rowH = sum / w;
    let xx = x;
    for (const item of row) {
      const itemW = item.area / rowH;
      out.push({ ...item, x: xx, y, w: itemW, h: rowH });
      xx += itemW;
    }
    return rowH;
  }
}

function recencyColor(daysSince, maxDays) {
  // 0d → deep red, maxDays → pale. Logarithmic so today still pops.
  const pct = Math.max(0, Math.min(1, daysSince / maxDays));
  const stops = [
    { p: 0.00, bg: '#b30000', fg: '#fff' },
    { p: 0.10, bg: '#d62727', fg: '#fff' },
    { p: 0.25, bg: '#ff5555', fg: '#fff' },
    { p: 0.50, bg: '#ff9999', fg: '#400' },
    { p: 0.75, bg: '#ffcccc', fg: '#600' },
    { p: 1.00, bg: '#ffe8e8', fg: '#700' },
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    if (pct <= stops[i + 1].p) return stops[i];
  }
  return stops[stops.length - 1];
}

function renderTreemap(data) {
  const css = `
    .treemap-wrap{display:flex;gap:16px;margin-bottom:8px}
    .panel{flex:1;background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;min-width:0}
    .panel h3{margin:0 0 10px;font-size:14px;color:#234}
    .panel .subhdr{color:#888;font-size:11px;margin-bottom:8px}
    .tm-container{position:relative;width:100%;height:520px;background:#f5f5f5;border-radius:4px;overflow:hidden}
    .tm-cell{position:absolute;box-sizing:border-box;border:1px solid rgba(255,255,255,0.7);
      padding:4px 6px;overflow:hidden;font-family:'SF Mono','Monaco','Courier New',monospace;
      font-size:11px;line-height:1.2}
    .tm-cell .mpn{font-weight:bold;display:block;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}
    .tm-cell .mfr{font-size:9px;opacity:0.7;display:block;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}
    .tm-cell .count{font-size:14px;font-weight:bold;display:block;margin-top:2px}
    .tm-legend{margin-top:10px;font-size:11px;color:#666}
    .tm-legend .gradient{display:inline-block;width:200px;height:14px;
      background:linear-gradient(to right,#b30000,#ff5555,#ff9999,#ffcccc,#ffe8e8);
      vertical-align:middle;border:1px solid #ddd;margin:0 6px}
  `;

  function panel(title, mpns, label) {
    if (mpns.length === 0) {
      return `<div class="panel"><h3>${escHtml(title)}</h3><div class="subhdr">${escHtml(label)}</div>
        <div class="tm-container" style="display:flex;align-items:center;justify-content:center;color:#888">No data in this panel.</div></div>`;
    }
    const items = mpns.map(m => ({
      value: m.totalRfqs,
      mpn: m.displayMpn || m.mpnClean,
      mfr: m.mfr || '',
      total: m.totalRfqs,
      days: m.daysSinceLast,
    }));
    // Treemap dimensions: virtual 1000×520. CSS scales by percentage.
    const W = 1000, H = 520;
    const cells = squarify(items, 0, 0, W, H);

    let cellHtml = '';
    for (const c of cells) {
      const { bg, fg } = recencyColor(c.days, DAYS);
      const leftPct = (c.x / W * 100).toFixed(3);
      const topPct  = (c.y / H * 100).toFixed(3);
      const wPct    = (c.w / W * 100).toFixed(3);
      const hPct    = (c.h / H * 100).toFixed(3);
      const showText = c.w > 50 && c.h > 30;
      const tooltip = `${c.mpn} — ${c.total} RFQs, last seen ${c.days.toFixed(1)}d ago`;
      cellHtml += `<div class="tm-cell" style="left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;background:${bg};color:${fg}" title="${escHtml(tooltip)}">`;
      if (showText) {
        cellHtml += `<span class="mpn">${escHtml(c.mpn)}</span>`;
        if (c.w > 80 && c.h > 50) cellHtml += `<span class="mfr">${escHtml(c.mfr)}</span>`;
        cellHtml += `<span class="count">${c.total}</span>`;
      }
      cellHtml += `</div>`;
    }
    return `<div class="panel">
      <h3>${escHtml(title)}</h3>
      <div class="subhdr">${escHtml(label)}</div>
      <div class="tm-container">${cellHtml}</div>
    </div>`;
  }

  const qualSum   = data.qualified.reduce((s, m) => s + m.totalRfqs, 0);
  const unqualSum = data.unqualified.reduce((s, m) => s + m.totalRfqs, 0);

  const body = `
    ${renderStatBand(data.band)}
    <h2>MPN treemap — area = RFQ count, color = recency (red=today, pale=${DAYS}d ago)</h2>
    <div class="treemap-wrap">
      ${panel('Qualified demand', data.qualified, `${data.qualified.length} MPNs · ${qualSum} RFQs`)}
      ${panel('Unqualified (market signal)', data.unqualified, `${data.unqualified.length} MPNs · ${unqualSum} RFQs`)}
    </div>
    <div class="tm-legend">
      Recency: <span class="gradient"></span>
      <span style="font-size:10px">today</span>
      <span style="float:right;font-size:10px;margin-right:0">${DAYS}d ago</span>
    </div>
  `;
  return shellHtml('Stock RFQ — Treemap', css, body);
}

// ─── VARIANT 2: BUBBLE MATRIX ────────────────────────────────────────────────
//
// SVG scatter plot. X axis = days since last RFQ. Y axis = unique customers
// (qualified-only). Bubble size = total RFQs. One chart per panel.

function renderBubble(data) {
  const css = `
    .bubble-wrap{display:flex;gap:16px;margin-bottom:8px}
    .panel{flex:1;background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;min-width:0}
    .panel h3{margin:0 0 10px;font-size:14px;color:#234}
    .panel .subhdr{color:#888;font-size:11px;margin-bottom:8px}
    .bubble-svg{display:block;width:100%;height:auto;background:#fafafa;border-radius:4px}
    .ax-label{fill:#888;font-size:10px;font-family:inherit}
    .ax-tick{fill:#aaa;font-size:9px;font-family:inherit}
    .bubble-label{fill:#222;font-size:9px;font-family:'SF Mono','Monaco',monospace;pointer-events:none}
    .bubble-legend{margin-top:10px;font-size:11px;color:#666;display:flex;gap:24px;flex-wrap:wrap}
    .bubble-legend .swatch{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:6px}
  `;

  function panel(title, mpns, label, color) {
    if (mpns.length === 0) {
      return `<div class="panel"><h3>${escHtml(title)}</h3><div class="subhdr">${escHtml(label)}</div>
        <div style="padding:60px;text-align:center;color:#888">No data in this panel.</div></div>`;
    }
    const W = 620, H = 440;
    const pad = { l: 50, r: 30, t: 20, b: 36 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;

    const xMax = DAYS;
    const yMax = Math.max(3, Math.max(...mpns.map(m => m.qualifiedCustomers || 1)));
    const sizeMax = Math.max(...mpns.map(m => m.totalRfqs));
    // Bubble radius range: 4 .. 24 px
    const rOf = v => 4 + Math.sqrt(v / sizeMax) * 20;
    const xOf = days => pad.l + Math.max(0, Math.min(plotW, (days / xMax) * plotW));
    const yOf = cust  => pad.t + plotH - Math.max(0, Math.min(plotH, (cust / yMax) * plotH));

    // Axes
    let svg = `<svg class="bubble-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
    // grid + axes
    svg += `<line x1="${pad.l}" y1="${pad.t + plotH}" x2="${pad.l + plotW}" y2="${pad.t + plotH}" stroke="#ccc"/>`;
    svg += `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" stroke="#ccc"/>`;
    // x ticks every 7 days
    for (let d = 0; d <= xMax; d += 7) {
      const x = xOf(d);
      svg += `<line x1="${x}" y1="${pad.t + plotH}" x2="${x}" y2="${pad.t + plotH + 4}" stroke="#ccc"/>`;
      svg += `<text class="ax-tick" x="${x}" y="${pad.t + plotH + 14}" text-anchor="middle">${d}d</text>`;
    }
    svg += `<text class="ax-label" x="${pad.l + plotW / 2}" y="${H - 6}" text-anchor="middle">days since last RFQ</text>`;
    // y ticks
    const yStep = Math.max(1, Math.ceil(yMax / 5));
    for (let c = 0; c <= yMax; c += yStep) {
      const y = yOf(c);
      svg += `<line x1="${pad.l - 4}" y1="${y}" x2="${pad.l}" y2="${y}" stroke="#ccc"/>`;
      svg += `<text class="ax-tick" x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${c}</text>`;
    }
    svg += `<text class="ax-label" x="${10}" y="${pad.t + plotH / 2}" text-anchor="middle" transform="rotate(-90 10 ${pad.t + plotH / 2})">unique qualified customers</text>`;

    // Bubbles (back-to-front by size, so smaller bubbles aren't hidden)
    const sorted = mpns.slice().sort((a, b) => b.totalRfqs - a.totalRfqs);
    for (const m of sorted) {
      const cx = xOf(m.daysSinceLast);
      const cy = yOf(m.qualifiedCustomers || 0);
      const r  = rOf(m.totalRfqs);
      svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="1.2">`;
      svg += `<title>${escHtml((m.displayMpn || m.mpnClean) + ' — ' + m.totalRfqs + ' RFQs, ' + (m.qualifiedCustomers || 0) + ' qual cust, ' + m.daysSinceLast.toFixed(1) + 'd ago')}</title>`;
      svg += `</circle>`;
    }
    // Label top 6 bubbles
    for (const m of sorted.slice(0, 6)) {
      const cx = xOf(m.daysSinceLast);
      const cy = yOf(m.qualifiedCustomers || 0);
      const r  = rOf(m.totalRfqs);
      const label = (m.displayMpn || m.mpnClean).slice(0, 16);
      svg += `<text class="bubble-label" x="${(cx + r + 3).toFixed(1)}" y="${(cy + 3).toFixed(1)}">${escHtml(label)}</text>`;
    }
    svg += `</svg>`;

    return `<div class="panel">
      <h3>${escHtml(title)}</h3>
      <div class="subhdr">${escHtml(label)} · bubble size = total RFQs</div>
      ${svg}
    </div>`;
  }

  const qualSum   = data.qualified.reduce((s, m) => s + m.totalRfqs, 0);
  const unqualSum = data.unqualified.reduce((s, m) => s + m.totalRfqs, 0);

  const body = `
    ${renderStatBand(data.band)}
    <h2>Recency × breadth bubble matrix — top-left bubbles = hot AND broadly-asked = sourcing priority</h2>
    <div class="bubble-wrap">
      ${panel('Qualified demand',           data.qualified,   `${data.qualified.length} MPNs · ${qualSum} RFQs`,   '#1f6feb')}
      ${panel('Unqualified (market signal)', data.unqualified, `${data.unqualified.length} MPNs · ${unqualSum} RFQs`, '#888')}
    </div>
    <div class="bubble-legend">
      <span><span class="swatch" style="background:#1f6feb"></span> qualified</span>
      <span><span class="swatch" style="background:#888"></span> unqualified</span>
      <span>X: days since last RFQ (today = 0 on left)</span>
      <span>Y: unique qualified customers asking</span>
      <span>Size: total RFQ count in window</span>
    </div>
  `;
  return shellHtml('Stock RFQ — Bubble Matrix', css, body);
}

// ─── VARIANT 3: CARD GRID + SPARKLINES ───────────────────────────────────────

function sparklineSvg(series, opts) {
  opts = opts || {};
  const W = opts.w || 140;
  const H = opts.h || 32;
  const max = Math.max(1, ...series);
  const stepX = series.length > 1 ? W / (series.length - 1) : 0;
  const points = series.map((v, i) => [
    i * stepX,
    H - (v / max) * (H - 2) - 1,
  ]);
  const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  // Fill below curve
  const area = path + ` L${W},${H} L0,${H} Z`;
  // Highlight today (last value)
  const lastIdx = series.length - 1;
  const lastV = series[lastIdx];
  const lastX = lastIdx * stepX;
  const lastY = H - (lastV / max) * (H - 2) - 1;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">
    <path d="${area}" fill="${opts.fill || '#ffe0e0'}" stroke="none"/>
    <path d="${path}" fill="none" stroke="${opts.stroke || '#d62727'}" stroke-width="1.5"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${opts.stroke || '#d62727'}"/>
  </svg>`;
}

function heatTag(m) {
  if (m.daysSinceLast < 0.5) return { label: '🔥 HOT', bg: '#d62727', fg: '#fff' };
  if (m.daysSinceLast < 2)   return { label: '⬆ RISING', bg: '#ff7777', fg: '#fff' };
  if (m.daysSinceLast < 7)   return { label: '◐ WARM', bg: '#ffb3b3', fg: '#500' };
  return                            { label: '○ COOL', bg: '#eee', fg: '#888' };
}

function renderCards(data) {
  const css = `
    .panel{margin-bottom:24px}
    .panel-hdr{display:flex;align-items:baseline;gap:12px;margin-bottom:10px}
    .panel-hdr h2{margin:0;border:none;padding:0}
    .panel-hdr .totals{color:#888;font-size:11px}
    .card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
    .card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px;min-height:140px;display:flex;flex-direction:column}
    .card .mpn-row{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
    .card .mpn{font-family:'SF Mono','Monaco','Courier New',monospace;font-size:12px;font-weight:bold;color:#234;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .card .tag{font-size:9px;padding:2px 6px;border-radius:3px;font-weight:bold;white-space:nowrap}
    .card .mfr{color:#666;font-size:10px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .card .spark{margin:8px 0 6px 0}
    .card .stats{display:flex;justify-content:space-between;font-size:11px;color:#666;margin-top:auto}
    .card .stats .num{font-weight:bold;color:#234;font-size:14px}
    .card .stats .lbl{display:block;color:#888;font-size:9px;text-transform:uppercase;letter-spacing:0.3px}
    .card .stats div{text-align:center}
    .card .splits{font-size:10px;color:#888;margin-top:6px;padding-top:6px;border-top:1px dashed #eee;text-align:center}
  `;

  function renderCard(m) {
    const tag = heatTag(m);
    const todayCount = m.days.get(dayAxis[dayAxis.length - 1]) || 0;
    const splitsTxt  = m.qualifiedRfqs > 0 && m.unqualifiedRfqs > 0
      ? `${m.qualifiedRfqs} qualified · ${m.unqualifiedRfqs} unqualified`
      : (m.unqualifiedRfqs > 0 ? `${m.unqualifiedRfqs} unqualified · 0 qualified` : `${m.qualifiedRfqs} qualified`);
    return `<div class="card">
      <div class="mpn-row">
        <span class="mpn" title="${escHtml(m.mpnClean)}">${escHtml(m.displayMpn || m.mpnClean)}</span>
        <span class="tag" style="background:${tag.bg};color:${tag.fg}">${tag.label}</span>
      </div>
      <div class="mfr">${escHtml(m.mfr || '—')}</div>
      <div class="spark">${sparklineSvg(m.series)}</div>
      <div class="stats">
        <div><span class="num">${m.totalRfqs}</span><span class="lbl">${DAYS}d total</span></div>
        <div><span class="num">${todayCount}</span><span class="lbl">today</span></div>
        <div><span class="num">${m.qualifiedCustomers}</span><span class="lbl">customers</span></div>
      </div>
      <div class="splits">${escHtml(splitsTxt)}</div>
    </div>`;
  }

  function panel(title, mpns, label) {
    if (mpns.length === 0) {
      return `<div class="panel"><div class="panel-hdr"><h2>${escHtml(title)}</h2><span class="totals">${escHtml(label)}</span></div>
        <div style="padding:40px;text-align:center;color:#888;background:#fff;border:1px solid #ddd;border-radius:6px">No data in this panel.</div></div>`;
    }
    return `<div class="panel">
      <div class="panel-hdr">
        <h2>${escHtml(title)}</h2>
        <span class="totals">${escHtml(label)}</span>
      </div>
      <div class="card-grid">${mpns.map(renderCard).join('')}</div>
    </div>`;
  }

  const qualSum   = data.qualified.reduce((s, m) => s + m.totalRfqs, 0);
  const unqualSum = data.unqualified.reduce((s, m) => s + m.totalRfqs, 0);

  const body = `
    ${renderStatBand(data.band)}
    ${panel('Qualified demand',            data.qualified,   `${data.qualified.length} MPNs · ${qualSum} RFQs · ${DAYS}d window`)}
    ${panel('Unqualified (market signal)', data.unqualified, `${data.unqualified.length} MPNs · ${unqualSum} RFQs · ${DAYS}d window`)}
  `;
  return shellHtml('Stock RFQ — Card Grid', css, body);
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const data = await fetchData();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const variants = [
      { key: 'treemap', label: 'Treemap',       html: renderTreemap(data) },
      { key: 'bubble',  label: 'Bubble Matrix', html: renderBubble(data) },
      { key: 'cards',   label: 'Card Grid',     html: renderCards(data) },
    ];
    for (const v of variants) {
      const out = path.join(OUT_DIR, `dashboard-${v.key}.html`);
      fs.writeFileSync(out, v.html);
      console.log(`Wrote ${v.label.padEnd(15)} → ${out}  (${v.html.length} bytes)`);
    }
    console.log(`Qualified MPNs: ${data.qualified.length}, Unqualified MPNs: ${data.unqualified.length}`);
  } catch (e) {
    console.error('Variants generation failed:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
