/**
 * Stock RFQ Activity Dashboard
 * ============================
 *
 * One-shot static HTML dashboard summarizing stock RFQ demand. Top N MPNs
 * by RFQ count over the last D days, laid out as a heatmap:
 *
 *   Rows    = MPNs (top N, sorted by total RFQs in window, desc)
 *   Columns = days (oldest → today, in operator's ET timezone)
 *   Cell    = distinct RFQ count for that MPN on that day, colored by
 *             intensity relative to the GRID max (so colors are
 *             comparable across rows).
 *
 * Plus a small stat band at the top: today (since 00 ET), last 7d, last 30d.
 *
 * Usage:
 *   node stock-rfq-dashboard.js
 *   node stock-rfq-dashboard.js --days=14 --top=20
 *   node stock-rfq-dashboard.js --out=/tmp/dash.html
 *
 * Output:
 *   Trading Analysis/Stock RFQ Loading/output/stock-rfq-dashboard.html (default)
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STOCK_RFQ_TYPE_ID = 1000007;
const REPORT_TZ = 'America/New_York';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const DAYS = parseInt(flag('days', '30'), 10);
const TOP_N = parseInt(flag('top', '30'), 10);
const OUT = flag('out',
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Stock RFQ Loading/output/stock-rfq-dashboard.html');

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

// Day axis: YYYY-MM-DD strings (ET local), oldest first, length DAYS.
const ymdInEt = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const dayAxis = [];
for (let i = 0; i < DAYS; i++) {
  dayAxis.push(ymdInEt(new Date(fromTs.getTime() + i * 24 * 60 * 60 * 1000)));
}

// ─── QUERIES ─────────────────────────────────────────────────────────────────

async function queryHeatmap() {
  // Two-stage: rank top N MPNs by total RFQs, then pull daily counts only
  // for that set. Day bucket = ET local date (the column header).
  const sql = `
    WITH base AS (
      SELECT
        mpn.chuboe_mpn_clean,
        mpn.chuboe_mfr_text,
        mpn.chuboe_mpn,
        (r.created AT TIME ZONE 'America/Chicago' AT TIME ZONE $1)::date AS day_et,
        r.chuboe_rfq_id
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line       rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn   mpn ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      WHERE r.chuboe_rfq_type_id = $2
        AND r.created AT TIME ZONE 'America/Chicago' >= $3
        AND r.isactive = 'Y' AND rl.isactive = 'Y' AND mpn.isactive = 'Y'
    ),
    ranks AS (
      SELECT
        chuboe_mpn_clean,
        COUNT(DISTINCT chuboe_rfq_id) AS total_rfqs,
        (ARRAY_AGG(chuboe_mfr_text ORDER BY chuboe_rfq_id DESC)
           FILTER (WHERE chuboe_mfr_text IS NOT NULL AND chuboe_mfr_text <> ''))[1] AS mfr,
        (ARRAY_AGG(chuboe_mpn ORDER BY chuboe_rfq_id DESC))[1] AS display_mpn
      FROM base
      GROUP BY chuboe_mpn_clean
      ORDER BY total_rfqs DESC
      LIMIT $4
    ),
    daily AS (
      SELECT b.chuboe_mpn_clean, b.day_et, COUNT(DISTINCT b.chuboe_rfq_id) AS rfqs
      FROM base b
      WHERE b.chuboe_mpn_clean IN (SELECT chuboe_mpn_clean FROM ranks)
      GROUP BY b.chuboe_mpn_clean, b.day_et
    )
    SELECT
      r.chuboe_mpn_clean,
      r.display_mpn,
      r.mfr,
      r.total_rfqs,
      d.day_et,
      d.rfqs
    FROM ranks r
    LEFT JOIN daily d USING (chuboe_mpn_clean)
    ORDER BY r.total_rfqs DESC, r.chuboe_mpn_clean, d.day_et
  `;
  const res = await pool.query(sql, [REPORT_TZ, STOCK_RFQ_TYPE_ID, fromTs, TOP_N]);

  const mpnMap = new Map();
  for (const row of res.rows) {
    const k = row.chuboe_mpn_clean;
    if (!mpnMap.has(k)) {
      mpnMap.set(k, {
        mpnClean: k,
        displayMpn: row.display_mpn,
        mfr: row.mfr,
        totalRfqs: Number(row.total_rfqs),
        days: new Map(),
      });
    }
    if (row.day_et) {
      // pg returns DATE as a JS Date at UTC midnight; we want the ET date string.
      const dayStr = row.day_et instanceof Date
        ? row.day_et.toISOString().slice(0, 10)
        : String(row.day_et).slice(0, 10);
      mpnMap.get(k).days.set(dayStr, Number(row.rfqs));
    }
  }
  return Array.from(mpnMap.values()).sort((a, b) => b.totalRfqs - a.totalRfqs);
}

async function queryStatBand() {
  async function band(fromTs) {
    const r = await pool.query(`
      SELECT
        COUNT(DISTINCT r.chuboe_rfq_id)               AS rfq_count,
        COUNT(DISTINCT mpn.chuboe_mpn_clean)          AS unique_mpns,
        COUNT(DISTINCT r.c_bpartner_id)               AS unique_bps
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line       rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn   mpn ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      WHERE r.chuboe_rfq_type_id = $1
        AND r.created AT TIME ZONE 'America/Chicago' >= $2
        AND r.isactive = 'Y' AND rl.isactive = 'Y' AND mpn.isactive = 'Y'
    `, [STOCK_RFQ_TYPE_ID, fromTs]);
    return r.rows[0];
  }
  return {
    today:     await band(todayStart),
    sevenDay:  await band(new Date(todayStart.getTime() -  7 * 24 * 60 * 60 * 1000)),
    thirtyDay: await band(new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000)),
  };
}

// ─── RENDERING ───────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }

// Sequential red colormap on a normalized scale. Grid max is computed once
// and used for all cells so colors are comparable across rows.
function cellColor(count, max) {
  if (!count || count === 0 || max === 0) return { bg: '#fafafa', fg: '#bbb' };
  const pct = count / max;
  if (pct <= 0.10) return { bg: '#fff5f5', fg: '#900' };
  if (pct <= 0.25) return { bg: '#ffe0e0', fg: '#700' };
  if (pct <= 0.50) return { bg: '#ffb3b3', fg: '#500' };
  if (pct <= 0.75) return { bg: '#ff7777', fg: '#fff' };
  return                  { bg: '#d62727', fg: '#fff' };
}

function renderHtml(stats, rows) {
  let gridMax = 0;
  for (const r of rows) for (const v of r.days.values()) gridMax = Math.max(gridMax, v);

  const genLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(now);

  const css = `
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#222;margin:20px;background:#fafafa}
    h1{font-size:22px;color:#234;margin:0 0 4px}
    h2{font-size:16px;color:#234;margin:24px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
    .subtitle{color:#888;font-size:12px;margin-bottom:16px}
    .stat-band{display:flex;gap:12px;margin-bottom:8px;flex-wrap:wrap}
    .stat{flex:0 0 220px;background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px}
    .stat .label{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
    .stat .value{font-size:26px;font-weight:bold;color:#234;margin-top:4px;line-height:1}
    .stat .detail{color:#888;font-size:11px;margin-top:6px}
    .heatmap{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px;overflow-x:auto}
    .heatmap table{border-collapse:separate;border-spacing:0;font-size:11px}
    .heatmap th{padding:4px 6px;color:#666;font-weight:normal;border-bottom:1px solid #eee;text-align:center;background:#fff;position:sticky;top:0}
    .heatmap th.mpn-col{text-align:left;min-width:170px;font-weight:bold;color:#444}
    .heatmap th.mfr-col{text-align:left;min-width:90px}
    .heatmap th.total-col{text-align:right;min-width:50px;padding-right:10px;font-weight:bold;color:#444}
    .heatmap th.day-col{font-size:10px;padding:4px 2px}
    .heatmap td{padding:0;border:1px solid #fff}
    .heatmap td.mpn-cell{padding:4px 8px;text-align:left;font-family:'SF Mono','Monaco','Courier New',monospace;background:#fff;font-size:11px;white-space:nowrap}
    .heatmap td.mfr-cell{padding:4px 8px;text-align:left;color:#666;background:#fff;font-size:11px;white-space:nowrap}
    .heatmap td.total-cell{padding:4px 10px 4px 4px;text-align:right;font-weight:bold;background:#fff;color:#234}
    .heatmap td.day-cell{width:26px;height:24px;text-align:center;font-weight:bold;font-size:11px;cursor:default}
    .day-divider{border-left:1px solid #eee !important}
    .legend{margin-top:10px;font-size:11px;color:#666;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .legend .swatch{display:inline-block;width:18px;height:14px;border:1px solid #ddd;vertical-align:middle;margin-right:4px}
    .footer{color:#888;font-size:11px;margin-top:20px;padding:8px 0;border-top:1px solid #eee}
  `;

  let html = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stock RFQ Activity Dashboard</title>
  <style>${css}</style>
</head><body>
  <h1>Stock RFQ Activity Dashboard</h1>
  <div class="subtitle">${escHtml(genLabel)} &middot; ${DAYS}-day window, top ${TOP_N} MPNs</div>

  <div class="stat-band">
    <div class="stat">
      <div class="label">Today (since 00 ET)</div>
      <div class="value">${fmtInt(stats.today.rfq_count)}</div>
      <div class="detail">${fmtInt(stats.today.unique_mpns)} MPNs &middot; ${fmtInt(stats.today.unique_bps)} brokers</div>
    </div>
    <div class="stat">
      <div class="label">Last 7 Days</div>
      <div class="value">${fmtInt(stats.sevenDay.rfq_count)}</div>
      <div class="detail">${fmtInt(stats.sevenDay.unique_mpns)} MPNs &middot; ${fmtInt(stats.sevenDay.unique_bps)} brokers</div>
    </div>
    <div class="stat">
      <div class="label">Last 30 Days</div>
      <div class="value">${fmtInt(stats.thirtyDay.rfq_count)}</div>
      <div class="detail">${fmtInt(stats.thirtyDay.unique_mpns)} MPNs &middot; ${fmtInt(stats.thirtyDay.unique_bps)} brokers</div>
    </div>
  </div>

  <h2>MPN &times; Day heatmap &mdash; distinct RFQs per day</h2>
  <div class="heatmap">
    <table>
      <thead><tr>
        <th class="mpn-col">MPN</th>
        <th class="mfr-col">MFR</th>
        <th class="total-col">${DAYS}d total</th>`;

  // Date column headers — label every 7 days + first + last for orientation.
  for (let i = 0; i < dayAxis.length; i++) {
    const d = new Date(dayAxis[i] + 'T12:00:00Z');
    const showLabel = i === 0 || i === dayAxis.length - 1 || i % 7 === 0;
    const label = showLabel
      ? new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, month: 'short', day: '2-digit' }).format(d)
      : '';
    const cls = (i > 0 && i % 7 === 0) ? 'day-col day-divider' : 'day-col';
    html += `<th class="${cls}" title="${escHtml(dayAxis[i])}">${escHtml(label)}</th>`;
  }
  html += `</tr></thead><tbody>`;

  // Heatmap rows
  for (const r of rows) {
    const mpnLabel = r.displayMpn || r.mpnClean;
    html += `<tr>
      <td class="mpn-cell" title="${escHtml(r.mpnClean)}">${escHtml(mpnLabel)}</td>
      <td class="mfr-cell">${escHtml(r.mfr || '')}</td>
      <td class="total-cell">${fmtInt(r.totalRfqs)}</td>`;
    for (let i = 0; i < dayAxis.length; i++) {
      const d = dayAxis[i];
      const v = r.days.get(d) || 0;
      const { bg, fg } = cellColor(v, gridMax);
      const cls = (i > 0 && i % 7 === 0) ? 'day-cell day-divider' : 'day-cell';
      const title = `${mpnLabel} on ${d}: ${v} RFQ${v === 1 ? '' : 's'}`;
      html += `<td class="${cls}" style="background:${bg};color:${fg}" title="${escHtml(title)}">${v || ''}</td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table></div>

  <div class="legend">
    <span><b>Intensity scale</b> (% of max ${gridMax} RFQs/day):</span>
    <span><span class="swatch" style="background:#fafafa"></span>0</span>
    <span><span class="swatch" style="background:#fff5f5"></span>&le; 10%</span>
    <span><span class="swatch" style="background:#ffe0e0"></span>&le; 25%</span>
    <span><span class="swatch" style="background:#ffb3b3"></span>&le; 50%</span>
    <span><span class="swatch" style="background:#ff7777"></span>&le; 75%</span>
    <span><span class="swatch" style="background:#d62727"></span>&gt; 75%</span>
  </div>

  <div class="footer">
    Window: ${escHtml(dayAxis[0])} &rarr; ${escHtml(dayAxis[dayAxis.length - 1])} (${DAYS} days, ET local).
    Source: chuboe_rfq + chuboe_rfq_line_mpn, type ${STOCK_RFQ_TYPE_ID} (Stock RFQ).
    Counts are distinct RFQs (not lines).
  </div>
</body></html>`;

  return html;
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const [stats, rows] = await Promise.all([
      queryStatBand(),
      queryHeatmap(),
    ]);
    const html = renderHtml(stats, rows);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, html);
    const gridMax = rows.reduce((m, r) => {
      for (const v of r.days.values()) if (v > m) m = v;
      return m;
    }, 0);
    console.log(`Wrote dashboard: ${OUT}`);
    console.log(`  Top MPNs: ${rows.length}, days: ${dayAxis.length}, peak day: ${gridMax} RFQs`);
    console.log(`  Window: ${dayAxis[0]} → ${dayAxis[dayAxis.length - 1]}`);
  } catch (e) {
    console.error('Dashboard failed:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
