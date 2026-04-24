#!/usr/bin/env node
/**
 * Leah's BOS Report — Weekly BOS (CSE) open-order report
 *
 * Reads the Infor "AST Open Orders" export (same columns as `Metrics needs.xlsx`)
 * and emails Jake a three-graph HTML summary + xlsx drill-down.
 *
 * Three buckets:
 *   1) Query Date        — Promise Date = 7/7/2700  (BOS flagged for issue resolution)
 *   2) Placeholder CPO   — Promise Date = 8/8/2800  (awaiting customer PO)
 *   3) Past Due          — Promise Date < today AND Qty Ordered > Invoiced
 *                          (excludes sentinel dates + blanket 12/25/2012)
 *
 * For each bucket we show: team total, per-BOS (Customer CSE), per-BOS × ISE.
 *
 * Usage:
 *   node bos-metrics.js <path-to-infor-export.xlsx> [--to jake.harris@astutegroup.com]
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { createNotifier } = require('../../shared/notifier');

const DEFAULT_RECIPIENT = 'jake.harris@Astutegroup.com';
const TODAY = new Date();
const TODAY_UTC = new Date(Date.UTC(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate()));

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, mo, d, y] = m;
  y = parseInt(y, 10);
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, parseInt(mo, 10) - 1, parseInt(d, 10)));
}

function isQueryDate(s) {
  // 7/7/00 → 2000-07-07 (Excel echo of Infor's 7/7/2700 sentinel)
  const d = parseDate(s);
  if (!d) return false;
  return d.getUTCMonth() === 6 && d.getUTCDate() === 7 && (d.getUTCFullYear() === 2000 || d.getUTCFullYear() === 2700);
}
function isPlaceholderDate(s) {
  // 8/8/00 → 2000-08-08 (Infor 8/8/2800 sentinel)
  const d = parseDate(s);
  if (!d) return false;
  return d.getUTCMonth() === 7 && d.getUTCDate() === 8 && (d.getUTCFullYear() === 2000 || d.getUTCFullYear() === 2800);
}
function isBlanketDate(s) {
  // 12/25/12 → 2012-12-25 (blanket order filler)
  const d = parseDate(s);
  if (!d) return false;
  return d.getUTCMonth() === 11 && d.getUTCDate() === 25 && d.getUTCFullYear() === 2012;
}

// Region mapping (ISE login → region). Loaded from ise-regions.json at module init.
const REGION_MAP_PATH = path.join(__dirname, 'ise-regions.json');
let REGION_MAP = {};
let REGION_ORDER = ['APAC', 'US', 'MX', 'EMEA', '(Unmapped)'];
let DEFAULT_REGION = '(Unmapped)';
try {
  const raw = JSON.parse(fs.readFileSync(REGION_MAP_PATH, 'utf-8'));
  REGION_MAP = raw.regions || {};
  if (Array.isArray(raw._regions) && raw._regions.length) REGION_ORDER = [...raw._regions, '(Unmapped)'];
  DEFAULT_REGION = raw.default_region || '(Unmapped)';
} catch (e) {
  console.warn(`Could not load ${REGION_MAP_PATH}; all ISEs will be (Unmapped)`);
}
const REGION_COLORS = { APAC: '#4e79a7', US: '#59a14f', MX: '#f28e2b', EMEA: '#b07aa1', '(Unmapped)': '#bab0ac' };
function regionFor(iseLogin) {
  const key = String(iseLogin || '').trim();
  return REGION_MAP[key] || DEFAULT_REGION;
}

// Aging bands for past-due (Fresh / Stale / Chronic)
const AGING_BANDS = [
  { label: 'Fresh (0-7d)',    min: 0,  max: 7,        color: '#59a14f' },
  { label: 'Stale (8-30d)',   min: 8,  max: 30,       color: '#edc948' },
  { label: 'Chronic (30+d)',  min: 31, max: Infinity, color: '#e15759' },
];
const AGING_LABELS = AGING_BANDS.map(b => b.label);

function agingBand(daysPast) {
  for (const b of AGING_BANDS) if (daysPast >= b.min && daysPast <= b.max) return b.label;
  return AGING_BANDS[0].label;
}

function bucketize(rows) {
  const b = { query: [], placeholder: [], pastDue: [] };
  for (const r of rows) {
    r._region = regionFor(r['Internal Salesperson']);
    const prom = r['Promise Date'];
    const qty = Number(r['Qty Ordered'] || 0);
    const inv = Number(r['Invoiced'] || 0);
    const open = qty > inv;
    if (isQueryDate(prom)) { b.query.push(r); continue; }
    if (isPlaceholderDate(prom)) { b.placeholder.push(r); continue; }
    const pd = parseDate(prom);
    if (open && pd && pd < TODAY_UTC && !isBlanketDate(prom)) {
      const daysPast = Math.floor((TODAY_UTC - pd) / 86400000);
      r._daysPast = daysPast;
      r._agingBand = agingBand(daysPast);
      b.pastDue.push(r);
    }
  }
  return b;
}

function byKey(rows, col) {
  const m = new Map();
  for (const r of rows) {
    const k = (r[col] || '(blank)').toString().trim() || '(blank)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function byKeyKey(rows, outerCol, innerCol) {
  // Returns { outer: Map<inner, count> }
  const m = new Map();
  for (const r of rows) {
    const o = (r[outerCol] || '(blank)').toString().trim() || '(blank)';
    const i = (r[innerCol] || '(blank)').toString().trim() || '(blank)';
    if (!m.has(o)) m.set(o, new Map());
    m.get(o).set(i, (m.get(o).get(i) || 0) + 1);
  }
  return m;
}

// -- QuickChart PNG fetcher (POST → PNG buffer; avoids GET URL length + external-image blocks) ---
async function quickChartPng(config, w = 720, h = 360) {
  const body = JSON.stringify({ width: w, height: h, backgroundColor: 'white', format: 'png', chart: config });
  const resp = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`QuickChart HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

function barChartConfig(title, pairs) {
  return {
    type: 'bar',
    data: {
      labels: pairs.map(p => p[0]),
      datasets: [{ label: 'Open lines', data: pairs.map(p => p[1]), backgroundColor: '#1f77b4' }]
    },
    options: {
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        legend: { display: false }
      },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Lines' } } }
    }
  };
}

function regionByBucketConfig(title, buckets) {
  // X = region, 3 datasets (Query/Placeholder/PastDue)
  const regions = REGION_ORDER.slice();
  const countRegion = (rows, reg) => rows.filter(r => r._region === reg).length;
  // Drop regions with 0 lines to avoid empty bars
  const active = regions.filter(r =>
    countRegion(buckets.query, r) + countRegion(buckets.placeholder, r) + countRegion(buckets.pastDue, r) > 0
  );
  return {
    type: 'bar',
    data: {
      labels: active,
      datasets: [
        { label: 'Query (7/7)',       data: active.map(r => countRegion(buckets.query, r)),       backgroundColor: '#4e79a7' },
        { label: 'Placeholder (8/8)', data: active.map(r => countRegion(buckets.placeholder, r)), backgroundColor: '#f28e2b' },
        { label: 'Past Due',          data: active.map(r => countRegion(buckets.pastDue, r)),     backgroundColor: '#e15759' },
      ]
    },
    options: {
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        legend: { position: 'right', labels: { font: { size: 10 } } }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Lines' } }
      }
    }
  };
}

function bosByAgingConfig(title, pastDueRows) {
  // X = BOS, stacked by aging band
  const bosSet = new Map();
  for (const r of pastDueRows) {
    const bos = (r['Customer CSE'] || '(blank)').toString().trim() || '(blank)';
    if (!bosSet.has(bos)) bosSet.set(bos, { total: 0, bands: Object.fromEntries(AGING_LABELS.map(l => [l, 0])) });
    bosSet.get(bos).bands[r._agingBand]++;
    bosSet.get(bos).total++;
  }
  const bosList = [...bosSet.entries()].sort((a, b) => b[1].total - a[1].total).map(([k]) => k);
  const datasets = AGING_BANDS.map(band => ({
    label: band.label,
    data: bosList.map(bos => bosSet.get(bos).bands[band.label]),
    backgroundColor: band.color
  }));
  return {
    type: 'bar',
    data: { labels: bosList, datasets },
    options: {
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        legend: { position: 'right', labels: { font: { size: 10 } } }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Lines' } }
      }
    }
  };
}

function agingByBosMiniConfig(title, bosPastDue) {
  // For per-BOS tab: single-series bar across the 3 aging bands
  const counts = AGING_BANDS.map(b => bosPastDue.filter(r => r._agingBand === b.label).length);
  return {
    type: 'bar',
    data: {
      labels: AGING_LABELS,
      datasets: [{
        label: 'Past Due',
        data: counts,
        backgroundColor: AGING_BANDS.map(b => b.color)
      }]
    },
    options: {
      plugins: {
        title: { display: true, text: title, font: { size: 13 } },
        legend: { display: false }
      },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Lines' } } }
    }
  };
}

function stackedBarConfig(title, nestedMap) {
  const bosList = [...nestedMap.keys()].sort((a, b) => {
    const sa = [...nestedMap.get(a).values()].reduce((x, y) => x + y, 0);
    const sb = [...nestedMap.get(b).values()].reduce((x, y) => x + y, 0);
    return sb - sa;
  });
  const iseSet = new Set();
  for (const m of nestedMap.values()) for (const k of m.keys()) iseSet.add(k);
  const iseList = [...iseSet];

  const palette = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'];
  const datasets = iseList.map((ise, i) => ({
    label: ise,
    data: bosList.map(b => nestedMap.get(b).get(ise) || 0),
    backgroundColor: palette[i % palette.length]
  }));

  return {
    type: 'bar',
    data: { labels: bosList, datasets },
    options: {
      plugins: {
        title: { display: true, text: title, font: { size: 14 } },
        legend: { position: 'right', labels: { font: { size: 10 } } }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Lines' } }
      }
    }
  };
}

// -- Signal detection -------------------------------------------------------------
// Returns a list of { severity, title, detail } flags auto-detected from the buckets.
// Thresholds are tuned conservatively so only real signals surface (not statistical noise).
function detectSignals(buckets) {
  const signals = [];
  const flagged = buckets.query.length + buckets.placeholder.length + buckets.pastDue.length;
  if (flagged === 0) return signals;

  const teamQpct = buckets.query.length / flagged;
  const teamPpct = buckets.placeholder.length / flagged;
  const teamPDpct = buckets.pastDue.length / flagged;

  // --- 1. Region bucket-mix skew ---
  // Min 15 flagged lines in region, min 10pp delta from team on any one bucket's share.
  const byRegion = {};
  for (const reg of REGION_ORDER) {
    const q = buckets.query.filter(r => r._region === reg).length;
    const p = buckets.placeholder.filter(r => r._region === reg).length;
    const pd = buckets.pastDue.filter(r => r._region === reg).length;
    const tot = q + p + pd;
    if (tot >= 15) byRegion[reg] = { q, p, pd, tot };
  }
  for (const [reg, d] of Object.entries(byRegion)) {
    const qPct = d.q / d.tot;
    const pPct = d.p / d.tot;
    const pdPct = d.pd / d.tot;
    const checks = [
      { bucket: 'placeholder (awaiting CPO)', pct: pPct, teamPct: teamPpct, count: d.p,
        implication: "Sales-side — bottleneck pulling customer POs in after quoting. Watch for CSE/BOS follow-up cadence on placeholder COVs." },
      { bucket: 'past-due', pct: pdPct, teamPct: teamPDpct, count: d.pd,
        implication: "Delivery-side — commitments are slipping. Watch supplier promise reliability and BOS expediting cadence." },
      { bucket: 'query (flagged for resolution)', pct: qPct, teamPct: teamQpct, count: d.q,
        implication: "BOS triage-side — unresolved data/CPO/MPN issues piling up. Watch root cause: integration? customer-data quality?" },
    ];
    for (const c of checks) {
      const delta = c.pct - c.teamPct;
      if (delta >= 0.10) {
        signals.push({
          severity: 'warn',
          title: `${reg} is ${c.bucket.split(' ')[0]}-heavy`,
          detail: `${(c.pct * 100).toFixed(0)}% of ${reg}'s flagged lines are ${c.bucket} (team avg ${(c.teamPct * 100).toFixed(0)}%). ${c.count} of ${d.tot} lines. ${c.implication}`
        });
      }
    }
  }

  // --- 2. BOS aging outlier (Julie signal) ---
  // Min 10 past-due lines, fresh% ≤ team fresh% - 15pp.
  const teamFresh = buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[0].label).length;
  const teamFreshPct = teamFresh / (buckets.pastDue.length || 1);
  const bosGroups = new Map();
  for (const r of buckets.pastDue) {
    const bos = (r['Customer CSE'] || '(blank)').toString().trim() || '(blank)';
    if (!bosGroups.has(bos)) bosGroups.set(bos, []);
    bosGroups.get(bos).push(r);
  }
  for (const [bos, rows] of bosGroups) {
    if (rows.length < 10) continue;
    const fresh = rows.filter(r => r._agingBand === AGING_BANDS[0].label).length;
    const stale = rows.filter(r => r._agingBand === AGING_BANDS[1].label).length;
    const chronic = rows.filter(r => r._agingBand === AGING_BANDS[2].label).length;
    const freshPct = fresh / rows.length;
    if (freshPct <= teamFreshPct - 0.15) {
      signals.push({
        severity: 'alert',
        title: `${bos}'s past-due is stale-heavy`,
        detail: `Only ${(freshPct * 100).toFixed(0)}% fresh vs team ${(teamFreshPct * 100).toFixed(0)}%. ${fresh} Fresh · ${stale} Stale · ${chronic} Chronic. Past-due is aging faster here than anywhere else on the team — worth a conversation on expediting cadence or supplier reliability.`
      });
    }
  }

  // --- 3. BOS concentration within a bucket ---
  // One BOS owns >40% of a bucket with bucket size >= 20.
  for (const bkt of ['query', 'placeholder', 'pastDue']) {
    const rows = buckets[bkt];
    if (rows.length < 20) continue;
    const byBos = {};
    for (const r of rows) {
      const bos = (r['Customer CSE'] || '(blank)').toString().trim() || '(blank)';
      byBos[bos] = (byBos[bos] || 0) + 1;
    }
    const [topBos, topCount] = Object.entries(byBos).sort((a, b) => b[1] - a[1])[0];
    if (topCount / rows.length > 0.40) {
      const label = bkt === 'query' ? 'query-date' : bkt === 'placeholder' ? 'placeholder (awaiting CPO)' : 'past-due';
      signals.push({
        severity: 'info',
        title: `${topBos} owns the bulk of ${label} lines`,
        detail: `${topCount} of ${rows.length} (${(topCount * 100 / rows.length).toFixed(0)}%). If persistent, consider balancing the load across BOS or investigating whether these share a root-cause customer/program.`
      });
    }
  }

  // --- 4. Chronic past-due summary ---
  const chronicLines = buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[2].label);
  if (chronicLines.length > 0) {
    const oldest = chronicLines.reduce((a, b) => (a._daysPast >= b._daysPast ? a : b));
    signals.push({
      severity: 'alert',
      title: `${chronicLines.length} chronic past-due line${chronicLines.length > 1 ? 's' : ''} (30+ days)`,
      detail: `Oldest is ${oldest._daysPast} days past promise: ${oldest['Order']} · ${oldest['Name']} · ${oldest['Item']} (BOS=${oldest['Customer CSE']}, ISE=${oldest['Internal Salesperson']}). Either close/invoice or escalate — these skew the team's metrics and tend to get invisible past the first week.`
    });
  }

  // --- 5. Unmapped ISEs (data hygiene) ---
  const unmappedCount = { q: 0, p: 0, pd: 0 };
  const unmappedIses = new Set();
  for (const [bkt, rows] of Object.entries(buckets)) {
    for (const r of rows) {
      if (r._region === '(Unmapped)') {
        unmappedCount[bkt === 'query' ? 'q' : bkt === 'placeholder' ? 'p' : 'pd']++;
        unmappedIses.add((r['Internal Salesperson'] || '').toString().trim());
      }
    }
  }
  const totalUnmapped = unmappedCount.q + unmappedCount.p + unmappedCount.pd;
  if (totalUnmapped > 0) {
    signals.push({
      severity: 'info',
      title: 'Unmapped ISEs — region mapping needs an update',
      detail: `${totalUnmapped} flagged line${totalUnmapped > 1 ? 's' : ''} from ${unmappedIses.size} ISE login${unmappedIses.size > 1 ? 's' : ''} not in the region map: ${[...unmappedIses].sort().join(', ')}. Edit <code>Trading Analysis/Leah's BOS Report/ise-regions.json</code> to assign.`
    });
  }

  return signals;
}

function renderSignalsHtml(signals) {
  if (signals.length === 0) {
    return '<p style="color:#888;margin:6px 0 24px 0;font-style:italic">No unusual signals this week — metrics are within team-norm tolerances.</p>';
  }
  const colors = {
    alert: { bg: '#fdecea', border: '#e0bab5', tag: '#c0392b', label: 'ALERT' },
    warn:  { bg: '#fff8e1', border: '#e0d082', tag: '#a67c00', label: 'WATCH' },
    info:  { bg: '#eef5fb', border: '#c8dff0', tag: '#2874a6', label: 'INFO'  },
  };
  const items = signals.map(s => {
    const c = colors[s.severity] || colors.info;
    return `
    <li style="margin-bottom:10px">
      <span style="display:inline-block;padding:2px 7px;border-radius:3px;background:${c.tag};color:#fff;font-size:10px;font-weight:bold;margin-right:8px;vertical-align:middle">${c.label}</span>
      <b>${s.title}</b><br/>
      <span style="color:#444;font-size:13px">${s.detail}</span>
    </li>`;
  }).join('');
  return `
  <div style="background:#fffaf0;border:1px solid #e0d082;padding:14px 18px;margin:10px 0 26px 0;border-radius:4px">
    <h3 style="margin:0 0 10px 0">Signals worth watching</h3>
    <ul style="margin:0;padding-left:20px">${items}</ul>
  </div>`;
}

// -- HTML builder -----------------------------------------------------------------
async function buildPastDueSection(rows, attachments) {
  const label = '3 · Past Due';
  const sentinelDesc = 'Promise date in the past and qty ordered > qty invoiced. Aged into Fresh (0-7d), Stale (8-30d), Chronic (30+d). Excludes sentinel dates + blanket-order filler.';
  const total = rows.length;
  const byBos = byKey(rows, 'Customer CSE');
  const nested = byKeyKey(rows, 'Customer CSE', 'Internal Salesperson');
  const bandCounts = AGING_BANDS.map(b => rows.filter(r => r._agingBand === b.label).length);
  const chronic = rows.filter(r => r._agingBand === AGING_BANDS[2].label).sort((a, b) => b._daysPast - a._daysPast);

  const [barPng, iseStackedPng, agingPng] = await Promise.all([
    quickChartPng(barChartConfig(`${label}: lines by BOS`, byBos), 720, 320),
    quickChartPng(stackedBarConfig(`${label}: BOS × ISE breakdown`, nested), 900, 420),
    quickChartPng(bosByAgingConfig(`${label}: BOS × aging band`, rows), 900, 340),
  ]);
  attachments.push(
    { filename: 'pastdue-by-bos.png', content: barPng, cid: 'bos-pastdue-bar', contentDisposition: 'inline' },
    { filename: 'pastdue-by-bos-ise.png', content: iseStackedPng, cid: 'bos-pastdue-stacked', contentDisposition: 'inline' },
    { filename: 'pastdue-by-aging.png', content: agingPng, cid: 'bos-pastdue-aging', contentDisposition: 'inline' },
  );

  const bosRows = byBos.map(([k, v]) =>
    `<tr><td style="padding:4px 10px;border:1px solid #eee">${k}</td><td style="padding:4px 10px;border:1px solid #eee;text-align:right">${v}</td></tr>`
  ).join('');

  const bandStrip = AGING_BANDS.map((b, i) => `
    <div style="display:inline-block;min-width:140px;padding:10px 14px;margin-right:10px;border-left:4px solid ${b.color};background:#fafafa">
      <div style="font-size:11px;color:#666">${b.label}</div>
      <div style="font-size:20px;font-weight:bold">${bandCounts[i]}</div>
    </div>
  `).join('');

  const chronicHtml = chronic.length === 0 ? '' : `
    <h3 style="margin:18px 0 6px 0;color:#c0392b">Chronic lines (30+ days past due)</h3>
    <table style="border-collapse:collapse;font-size:12px;width:100%;max-width:920px">
      <thead><tr style="background:#fdecea">
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:right">Days Past</th>
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:left">COV</th>
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:left">Customer</th>
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:left">ISE</th>
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:left">BOS</th>
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:left">Item</th>
        <th style="padding:4px 8px;border:1px solid #e0bab5;text-align:right">Qty</th>
      </tr></thead>
      <tbody>${chronic.map(r => `
        <tr>
          <td style="padding:3px 8px;border:1px solid #eed;text-align:right"><b>${r._daysPast}</b></td>
          <td style="padding:3px 8px;border:1px solid #eed">${r['Order']}</td>
          <td style="padding:3px 8px;border:1px solid #eed">${r['Name']}</td>
          <td style="padding:3px 8px;border:1px solid #eed">${r['Internal Salesperson']}</td>
          <td style="padding:3px 8px;border:1px solid #eed">${r['Customer CSE']}</td>
          <td style="padding:3px 8px;border:1px solid #eed">${r['Item']}</td>
          <td style="padding:3px 8px;border:1px solid #eed;text-align:right">${r['Qty Ordered']}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  return `
  <section style="margin-bottom:36px;padding-bottom:24px;border-bottom:1px solid #ccc">
    <h2 style="margin:0 0 4px 0">${label} <span style="color:#888;font-weight:normal">— ${total} open lines</span></h2>
    <p style="color:#666;margin:0 0 12px 0;font-size:13px">${sentinelDesc}</p>
    <div style="margin:10px 0 14px 0">${bandStrip}</div>
    ${chronicHtml}
    <div style="margin-top:14px"><img src="cid:bos-pastdue-aging" alt="BOS × aging" style="max-width:100%;border:1px solid #eee"/></div>
    <div style="margin-top:12px"><img src="cid:bos-pastdue-bar" alt="by BOS" style="max-width:100%;border:1px solid #eee"/></div>
    <div style="margin-top:12px"><img src="cid:bos-pastdue-stacked" alt="BOS × ISE" style="max-width:100%;border:1px solid #eee"/></div>
    <table style="border-collapse:collapse;margin-top:14px;font-size:13px;width:100%;max-width:720px">
      <thead><tr style="background:#f4f4f4">
        <th style="text-align:left;padding:6px 10px;border:1px solid #ddd">BOS (Customer CSE)</th>
        <th style="text-align:right;padding:6px 10px;border:1px solid #ddd">Open lines</th>
      </tr></thead>
      <tbody>${bosRows}</tbody>
    </table>
  </section>`;
}

async function buildBucketSection(label, sentinelDesc, rows, slug, attachments) {
  const total = rows.length;
  const byBos = byKey(rows, 'Customer CSE');
  const nested = byKeyKey(rows, 'Customer CSE', 'Internal Salesperson');

  // Fetch charts in parallel
  const [barPng, stackedPng] = await Promise.all([
    quickChartPng(barChartConfig(`${label}: lines by BOS`, byBos), 720, 320),
    quickChartPng(stackedBarConfig(`${label}: BOS × ISE breakdown`, nested), 900, 420),
  ]);

  const barCid = `bos-${slug}-bar`;
  const stackedCid = `bos-${slug}-stacked`;
  attachments.push(
    { filename: `${slug}-by-bos.png`, content: barPng, cid: barCid, contentDisposition: 'inline' },
    { filename: `${slug}-by-bos-ise.png`, content: stackedPng, cid: stackedCid, contentDisposition: 'inline' }
  );

  const bosRows = byBos.map(([k, v]) =>
    `<tr><td style="padding:4px 10px;border:1px solid #eee">${k}</td><td style="padding:4px 10px;border:1px solid #eee;text-align:right">${v}</td></tr>`
  ).join('');

  return `
  <section style="margin-bottom:36px;padding-bottom:24px;border-bottom:1px solid #ccc">
    <h2 style="margin:0 0 4px 0">${label} <span style="color:#888;font-weight:normal">— ${total} open lines</span></h2>
    <p style="color:#666;margin:0 0 12px 0;font-size:13px">${sentinelDesc}</p>
    <div><img src="cid:${barCid}" alt="by BOS" style="max-width:100%;border:1px solid #eee"/></div>
    <div style="margin-top:12px"><img src="cid:${stackedCid}" alt="BOS × ISE" style="max-width:100%;border:1px solid #eee"/></div>
    <table style="border-collapse:collapse;margin-top:14px;font-size:13px;width:100%;max-width:720px">
      <thead>
        <tr style="background:#f4f4f4">
          <th style="text-align:left;padding:6px 10px;border:1px solid #ddd">BOS (Customer CSE)</th>
          <th style="text-align:right;padding:6px 10px;border:1px solid #ddd">Open lines</th>
        </tr>
      </thead>
      <tbody>${bosRows}</tbody>
    </table>
  </section>`;
}

async function buildHtml(buckets, fileName, attachments) {
  const runDate = isoDate(TODAY_UTC);

  // Region summary strip + chart (fetched in parallel with section charts)
  const regionChartPromise = quickChartPng(regionByBucketConfig('Open lines by region × bucket', buckets), 820, 320);
  const sections = await Promise.all([
    buildBucketSection('1 · Query Date (7/7/2700)', 'BOS has flagged these lines for resolution — MPN suffix mismatch, missing CPO, vendor stock lost, bill-to missing, etc.', buckets.query, 'query', attachments),
    buildBucketSection('2 · Placeholder CPO (8/8/2800)', 'Placeholder COV created; awaiting customer PO. Promise date will update once CPO is received.', buckets.placeholder, 'placeholder', attachments),
    buildPastDueSection(buckets.pastDue, attachments),
  ]);
  const regionPng = await regionChartPromise;
  attachments.push({ filename: 'region-overview.png', content: regionPng, cid: 'bos-region-overview', contentDisposition: 'inline' });

  // Region summary table
  const regionRows = REGION_ORDER.map(reg => {
    const q = buckets.query.filter(r => r._region === reg).length;
    const p = buckets.placeholder.filter(r => r._region === reg).length;
    const pd = buckets.pastDue.filter(r => r._region === reg).length;
    return { reg, q, p, pd, tot: q + p + pd };
  }).filter(r => r.tot > 0);
  const regionTableHtml = `
    <table style="border-collapse:collapse;margin:6px 0 20px 0;font-size:13px">
      <thead><tr style="background:#eef5fb">
        <th style="padding:6px 10px;border:1px solid #c8dff0;text-align:left">Region</th>
        <th style="padding:6px 10px;border:1px solid #c8dff0;text-align:right">Query (7/7)</th>
        <th style="padding:6px 10px;border:1px solid #c8dff0;text-align:right">Placeholder (8/8)</th>
        <th style="padding:6px 10px;border:1px solid #c8dff0;text-align:right">Past Due</th>
        <th style="padding:6px 10px;border:1px solid #c8dff0;text-align:right">Total</th>
      </tr></thead>
      <tbody>${regionRows.map(r => `
        <tr>
          <td style="padding:4px 10px;border:1px solid #eed"><b>${r.reg}</b></td>
          <td style="padding:4px 10px;border:1px solid #eed;text-align:right">${r.q}</td>
          <td style="padding:4px 10px;border:1px solid #eed;text-align:right">${r.p}</td>
          <td style="padding:4px 10px;border:1px solid #eed;text-align:right">${r.pd}</td>
          <td style="padding:4px 10px;border:1px solid #eed;text-align:right"><b>${r.tot}</b></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#222;max-width:960px;margin:0 auto;padding:16px">
  <h1 style="margin-bottom:4px">BOS Weekly Metrics — ${runDate}</h1>
  <p style="color:#666;margin-top:0">Source: <code>${fileName}</code> · ${buckets.query.length + buckets.placeholder.length + buckets.pastDue.length} flagged lines across three buckets.</p>
  <table style="border-collapse:collapse;margin:10px 0 28px 0;font-size:13px">
    <thead><tr style="background:#fffbe6"><th style="padding:6px 10px;border:1px solid #e0d082;text-align:left">Bucket</th><th style="padding:6px 10px;border:1px solid #e0d082;text-align:right">Open lines</th></tr></thead>
    <tbody>
      <tr><td style="padding:6px 10px;border:1px solid #eed">1 · Query Date (7/7/2700)</td><td style="padding:6px 10px;border:1px solid #eed;text-align:right">${buckets.query.length}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #eed">2 · Placeholder CPO (8/8/2800)</td><td style="padding:6px 10px;border:1px solid #eed;text-align:right">${buckets.placeholder.length}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #eed">3 · Past Due</td><td style="padding:6px 10px;border:1px solid #eed;text-align:right">${buckets.pastDue.length}</td></tr>
    </tbody>
  </table>
  <h2 style="margin:18px 0 4px 0">Region overview</h2>
  ${regionTableHtml}
  <div style="margin:6px 0 20px 0"><img src="cid:bos-region-overview" alt="region overview" style="max-width:100%;border:1px solid #eee"/></div>
  ${renderSignalsHtml(detectSignals(buckets))}
  ${sections.join('\n')}
  <hr style="margin-top:28px"/>
  <p style="color:#888;font-size:12px">xlsx attachment has one sheet per bucket with full line detail for drill-through.</p>
</body></html>`;
}

// -- xlsx attachment builder (ExcelJS: per-BOS tabs w/ embedded chart images) -----
const DETAIL_COLS = ['Name', 'Order', 'Customer Order', 'Customer Order Recorded Date', 'Internal Salesperson', 'Line', 'Item', 'Due Date', 'Promise Date', 'Qty Ordered', 'Invoiced', 'CO Buyer', 'Comments', 'Customer CSE'];
const BUCKET_LABELS = { query: '1 · Query (7/7/2700)', placeholder: '2 · Placeholder (8/8/2800)', pastDue: '3 · Past Due' };
const BUCKET_ORDER = ['query', 'placeholder', 'pastDue'];

function sanitizeSheetName(name, suffix = '') {
  // Excel: max 31 chars, forbidden: \ / ? * [ ] :
  let s = String(name).replace(/[\\/?*\[\]:]/g, '_');
  const maxBody = 31 - suffix.length;
  if (s.length > maxBody) s = s.slice(0, maxBody);
  return s + suffix;
}

function stackedBarForBos(bosName, bosBuckets) {
  // X axis: 3 buckets; stacked by ISE
  const iseSet = new Set();
  for (const k of BUCKET_ORDER) {
    for (const r of bosBuckets[k]) iseSet.add((r['Internal Salesperson'] || '(blank)').trim() || '(blank)');
  }
  const iseList = [...iseSet].sort();
  const palette = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'];
  const datasets = iseList.map((ise, i) => ({
    label: ise,
    data: BUCKET_ORDER.map(b => bosBuckets[b].filter(r => ((r['Internal Salesperson'] || '(blank)').trim() || '(blank)') === ise).length),
    backgroundColor: palette[i % palette.length]
  }));
  return {
    type: 'bar',
    data: { labels: BUCKET_ORDER.map(k => BUCKET_LABELS[k]), datasets },
    options: {
      plugins: {
        title: { display: true, text: `${bosName} — open lines by bucket × ISE`, font: { size: 14 } },
        legend: { position: 'right', labels: { font: { size: 10 } } }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Lines' } }
      }
    }
  };
}

async function buildXlsxBuffer(buckets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Leah's BOS Report";
  wb.created = new Date();

  // Group all rows by BOS (Customer CSE)
  const bosList = new Set();
  for (const k of BUCKET_ORDER) for (const r of buckets[k]) bosList.add((r['Customer CSE'] || '(blank)').toString().trim() || '(blank)');

  // Per-BOS bucket split
  const bosMap = new Map(); // bos → { query: [], placeholder: [], pastDue: [] }
  for (const bos of bosList) bosMap.set(bos, { query: [], placeholder: [], pastDue: [] });
  for (const k of BUCKET_ORDER) {
    for (const r of buckets[k]) {
      const bos = (r['Customer CSE'] || '(blank)').toString().trim() || '(blank)';
      bosMap.get(bos)[k].push(r);
    }
  }

  // Order BOS tabs by total desc
  const bosOrdered = [...bosMap.entries()]
    .map(([bos, b]) => ({ bos, total: b.query.length + b.placeholder.length + b.pastDue.length, b }))
    .sort((a, b) => b.total - a.total);

  // --- Tab 1: All BOS rollup ---
  const summary = wb.addWorksheet('All BOS');
  summary.columns = [
    { header: 'BOS (Customer CSE)', key: 'bos', width: 22 },
    { header: 'Query (7/7)', key: 'q', width: 12 },
    { header: 'Placeholder (8/8)', key: 'p', width: 18 },
    { header: 'Past Due (total)', key: 'pd', width: 16 },
    { header: 'PD Fresh (0-7d)', key: 'pdf', width: 16 },
    { header: 'PD Stale (8-30d)', key: 'pds', width: 16 },
    { header: 'PD Chronic (30+d)', key: 'pdc', width: 18 },
    { header: 'Total', key: 'tot', width: 10 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8C6' } };
  for (const { bos, total, b } of bosOrdered) {
    const pdf = b.pastDue.filter(r => r._agingBand === AGING_BANDS[0].label).length;
    const pds = b.pastDue.filter(r => r._agingBand === AGING_BANDS[1].label).length;
    const pdc = b.pastDue.filter(r => r._agingBand === AGING_BANDS[2].label).length;
    const row = summary.addRow({ bos, q: b.query.length, p: b.placeholder.length, pd: b.pastDue.length, pdf, pds, pdc, tot: total });
    if (pdc > 0) row.getCell('pdc').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
    if (pds > 0) row.getCell('pds').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
  }
  const totalRow = summary.addRow({
    bos: 'TOTAL',
    q: buckets.query.length,
    p: buckets.placeholder.length,
    pd: buckets.pastDue.length,
    tot: buckets.query.length + buckets.placeholder.length + buckets.pastDue.length,
  });
  totalRow.font = { bold: true };
  totalRow.border = { top: { style: 'thin' } };

  // --- Per-BOS tabs (fetch both charts for each BOS in parallel) ---
  const chartFetches = bosOrdered.map(async ({ bos, total, b }) => {
    const [bucketIsePng, agingPng] = await Promise.all([
      quickChartPng(stackedBarForBos(bos, b), 720, 360),
      b.pastDue.length > 0
        ? quickChartPng(agingByBosMiniConfig(`${bos} — past-due aging split`, b.pastDue), 600, 280)
        : Promise.resolve(null),
    ]);
    return { bos, total, b, bucketIsePng, agingPng };
  });
  const chartResults = await Promise.all(chartFetches);

  for (const { bos, total, b, bucketIsePng, agingPng } of chartResults) {
    const ws = wb.addWorksheet(sanitizeSheetName(bos));

    // Title
    ws.mergeCells('A1:K1');
    const title = ws.getCell('A1');
    title.value = `BOS: ${bos}   —   ${total} open lines`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(1).height = 22;

    let cursorRow = 3;

    // Escalation strip — Chronic past-due lines (30+ days)
    const chronic = b.pastDue.filter(r => r._agingBand === AGING_BANDS[2].label).sort((x, y) => y._daysPast - x._daysPast);
    if (chronic.length > 0) {
      ws.mergeCells(`A${cursorRow}:K${cursorRow}`);
      const h = ws.getCell(`A${cursorRow}`);
      h.value = `⚠ ESCALATION — ${chronic.length} chronic past-due line${chronic.length > 1 ? 's' : ''} (30+ days past promise)`;
      h.font = { bold: true, color: { argb: 'FFC0392B' }, size: 12 };
      h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
      cursorRow++;
      const hdrs = ['Days Past', 'COV', 'Customer', 'ISE', 'Item', 'Qty Ordered', 'Promise Date', 'Comments'];
      hdrs.forEach((v, i) => {
        const c = ws.getCell(cursorRow, i + 1);
        c.value = v; c.font = { bold: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
        c.border = { bottom: { style: 'thin' } };
      });
      cursorRow++;
      for (const r of chronic) {
        const vals = [r._daysPast, r['Order'], r['Name'], r['Internal Salesperson'], r['Item'], r['Qty Ordered'], r['Promise Date'], r['Comments']];
        vals.forEach((v, i) => { ws.getCell(cursorRow, i + 1).value = v ?? ''; });
        cursorRow++;
      }
      cursorRow += 1;
    }

    // Bucket summary (with aging split for past-due)
    const bucketHdrRow = cursorRow;
    ws.getCell(`A${bucketHdrRow}`).value = 'Bucket';
    ws.getCell(`B${bucketHdrRow}`).value = 'Lines';
    ws.getRow(bucketHdrRow).font = { bold: true };
    cursorRow++;
    ws.getCell(`A${cursorRow}`).value = BUCKET_LABELS.query;
    ws.getCell(`B${cursorRow}`).value = b.query.length;
    cursorRow++;
    ws.getCell(`A${cursorRow}`).value = BUCKET_LABELS.placeholder;
    ws.getCell(`B${cursorRow}`).value = b.placeholder.length;
    cursorRow++;
    ws.getCell(`A${cursorRow}`).value = BUCKET_LABELS.pastDue;
    ws.getCell(`B${cursorRow}`).value = b.pastDue.length;
    cursorRow++;
    // Aging sub-rows under Past Due
    AGING_BANDS.forEach(band => {
      const cnt = b.pastDue.filter(r => r._agingBand === band.label).length;
      ws.getCell(`A${cursorRow}`).value = `    ${band.label}`;
      ws.getCell(`A${cursorRow}`).font = { italic: true, color: { argb: 'FF666666' } };
      ws.getCell(`B${cursorRow}`).value = cnt;
      ws.getCell(`B${cursorRow}`).font = { italic: true, color: { argb: 'FF666666' } };
      cursorRow++;
    });
    ws.getColumn(1).width = 30;
    ws.getColumn(2).width = 10;

    // ISE breakdown (expanded with region + aging columns, grouped by region)
    const iseHdrRow = bucketHdrRow;
    ws.getCell(`D${iseHdrRow}`).value = 'Region';
    ws.getCell(`E${iseHdrRow}`).value = 'ISE (Internal Salesperson)';
    ws.getCell(`F${iseHdrRow}`).value = 'Query';
    ws.getCell(`G${iseHdrRow}`).value = 'Placeholder';
    ws.getCell(`H${iseHdrRow}`).value = 'PD Fresh';
    ws.getCell(`I${iseHdrRow}`).value = 'PD Stale';
    ws.getCell(`J${iseHdrRow}`).value = 'PD Chronic';
    ws.getCell(`K${iseHdrRow}`).value = 'Total';
    ws.getRow(iseHdrRow).font = { bold: true };
    const iseSet = new Set();
    for (const k of BUCKET_ORDER) for (const r of b[k]) iseSet.add((r['Internal Salesperson'] || '(blank)').trim() || '(blank)');
    const iseRows = [...iseSet].map(ise => {
      const matchIse = (r) => ((r['Internal Salesperson'] || '(blank)').trim() || '(blank)') === ise;
      const region = regionFor(ise);
      const q = b.query.filter(matchIse).length;
      const p = b.placeholder.filter(matchIse).length;
      const pdf = b.pastDue.filter(r => matchIse(r) && r._agingBand === AGING_BANDS[0].label).length;
      const pds = b.pastDue.filter(r => matchIse(r) && r._agingBand === AGING_BANDS[1].label).length;
      const pdc = b.pastDue.filter(r => matchIse(r) && r._agingBand === AGING_BANDS[2].label).length;
      return { region, ise, q, p, pdf, pds, pdc, tot: q + p + pdf + pds + pdc };
    }).sort((x, y) => {
      const ra = REGION_ORDER.indexOf(x.region);
      const rb = REGION_ORDER.indexOf(y.region);
      if (ra !== rb) return ra - rb;
      return y.tot - x.tot;
    });
    let iseR = iseHdrRow + 1;
    for (const row of iseRows) {
      ws.getCell(`D${iseR}`).value = row.region;
      ws.getCell(`E${iseR}`).value = row.ise;
      ws.getCell(`F${iseR}`).value = row.q;
      ws.getCell(`G${iseR}`).value = row.p;
      ws.getCell(`H${iseR}`).value = row.pdf;
      ws.getCell(`I${iseR}`).value = row.pds;
      ws.getCell(`J${iseR}`).value = row.pdc;
      ws.getCell(`K${iseR}`).value = row.tot;
      if (row.pds > 0) ws.getCell(`I${iseR}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
      if (row.pdc > 0) ws.getCell(`J${iseR}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
      iseR++;
    }
    ws.getColumn(4).width = 10;
    ws.getColumn(5).width = 22;
    for (let c = 6; c <= 11; c++) ws.getColumn(c).width = 12;

    // Embed charts: bucket×ISE (left) + aging mini (right if present)
    cursorRow = Math.max(cursorRow, iseR) + 1;
    const bucketImgId = wb.addImage({ buffer: bucketIsePng, extension: 'png' });
    ws.addImage(bucketImgId, {
      tl: { col: 0, row: cursorRow - 1 },
      ext: { width: 720, height: 360 }
    });
    if (agingPng) {
      const agingImgId = wb.addImage({ buffer: agingPng, extension: 'png' });
      ws.addImage(agingImgId, {
        tl: { col: 11, row: cursorRow - 1 }, // to the right of the bucket chart
        ext: { width: 600, height: 280 }
      });
    }
    cursorRow += 21;

    // Detail tables (one per non-empty bucket) — past-due gets extra Days Past / Aging cols
    for (const k of BUCKET_ORDER) {
      if (b[k].length === 0) continue;
      const hdrCell = ws.getCell(`A${cursorRow}`);
      hdrCell.value = `${BUCKET_LABELS[k]} — ${b[k].length} lines`;
      hdrCell.font = { bold: true, size: 12 };
      ws.mergeCells(`A${cursorRow}:P${cursorRow}`);
      cursorRow++;

      const cols = (k === 'pastDue') ? [...DETAIL_COLS, 'Days Past', 'Aging'] : DETAIL_COLS;
      cols.forEach((col, i) => {
        const cell = ws.getCell(cursorRow, i + 1);
        cell.value = col;
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
        cell.border = { bottom: { style: 'thin' } };
      });
      cursorRow++;

      // Sort past-due lines by days-past desc so the worst surface at the top
      const rowsToWrite = (k === 'pastDue') ? [...b[k]].sort((x, y) => y._daysPast - x._daysPast) : b[k];

      for (const line of rowsToWrite) {
        cols.forEach((col, i) => {
          let val;
          if (col === 'Days Past') val = line._daysPast;
          else if (col === 'Aging') val = line._agingBand;
          else val = line[col];
          ws.getCell(cursorRow, i + 1).value = val ?? '';
        });
        if (k === 'pastDue') {
          if (line._agingBand === AGING_BANDS[2].label) ws.getRow(cursorRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
          else if (line._agingBand === AGING_BANDS[1].label) ws.getRow(cursorRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBE6' } };
        }
        cursorRow++;
      }
      cursorRow += 2;
    }

    // Set widths on detail columns
    const maxCols = DETAIL_COLS.length + 2;
    for (let i = 0; i < maxCols; i++) {
      const name = i < DETAIL_COLS.length ? DETAIL_COLS[i] : (i === DETAIL_COLS.length ? 'Days Past' : 'Aging');
      const existing = ws.getColumn(i + 1).width || 0;
      ws.getColumn(i + 1).width = Math.max(existing, Math.min(36, Math.max(10, name.length + 2)));
    }

    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // --- Reference tabs: full bucket lists (with Region column) ---
  const addListSheet = (name, rows, includeAging = false) => {
    const ws = wb.addWorksheet(sanitizeSheetName(name));
    const cols = ['Region', ...DETAIL_COLS, ...(includeAging ? ['Days Past', 'Aging'] : [])];
    ws.columns = cols.map(c => ({ header: c, key: c, width: Math.min(32, Math.max(10, c.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
    const sorted = includeAging ? [...rows].sort((x, y) => y._daysPast - x._daysPast) : rows;
    for (const r of sorted) {
      const obj = cols.reduce((o, c) => {
        if (c === 'Region') o[c] = r._region;
        else if (c === 'Days Past') o[c] = r._daysPast;
        else if (c === 'Aging') o[c] = r._agingBand;
        else o[c] = r[c] ?? '';
        return o;
      }, {});
      const added = ws.addRow(obj);
      if (includeAging) {
        if (r._agingBand === AGING_BANDS[2].label) added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
        else if (r._agingBand === AGING_BANDS[1].label) added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBE6' } };
      }
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  };
  addListSheet('All Query 7-7', buckets.query);
  addListSheet('All Placeholder 8-8', buckets.placeholder);
  addListSheet('All Past Due', buckets.pastDue, true);

  // --- Signals tab ---
  const signals = detectSignals(buckets);
  const signalsWs = wb.addWorksheet('Signals');
  signalsWs.columns = [
    { header: 'Severity', key: 'sev', width: 10 },
    { header: 'Title', key: 'title', width: 42 },
    { header: 'Detail', key: 'detail', width: 100 },
  ];
  signalsWs.getRow(1).font = { bold: true };
  signalsWs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8C6' } };
  if (signals.length === 0) {
    signalsWs.addRow({ sev: 'info', title: 'No unusual signals', detail: 'Metrics are within team-norm tolerances this week.' });
  } else {
    for (const s of signals) {
      const row = signalsWs.addRow({ sev: s.severity.toUpperCase(), title: s.title, detail: s.detail.replace(/<[^>]+>/g, '') });
      if (s.severity === 'alert') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
      else if (s.severity === 'warn') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
      row.alignment = { wrapText: true, vertical: 'top' };
    }
  }

  // --- By Region rollup tab ---
  const byRegion = wb.addWorksheet('By Region');
  byRegion.columns = [
    { header: 'Region', key: 'region', width: 14 },
    { header: 'Query (7/7)', key: 'q', width: 14 },
    { header: 'Placeholder (8/8)', key: 'p', width: 18 },
    { header: 'Past Due (total)', key: 'pd', width: 16 },
    { header: 'PD Fresh (0-7d)', key: 'pdf', width: 16 },
    { header: 'PD Stale (8-30d)', key: 'pds', width: 16 },
    { header: 'PD Chronic (30+d)', key: 'pdc', width: 18 },
    { header: 'Total', key: 'tot', width: 10 },
  ];
  byRegion.getRow(1).font = { bold: true };
  byRegion.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF5FB' } };
  for (const reg of REGION_ORDER) {
    const q = buckets.query.filter(r => r._region === reg).length;
    const p = buckets.placeholder.filter(r => r._region === reg).length;
    const pd = buckets.pastDue.filter(r => r._region === reg);
    const pdf = pd.filter(r => r._agingBand === AGING_BANDS[0].label).length;
    const pds = pd.filter(r => r._agingBand === AGING_BANDS[1].label).length;
    const pdc = pd.filter(r => r._agingBand === AGING_BANDS[2].label).length;
    if (q + p + pd.length === 0) continue;
    const row = byRegion.addRow({ region: reg, q, p, pd: pd.length, pdf, pds, pdc, tot: q + p + pd.length });
    if (pds > 0) row.getCell('pds').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
    if (pdc > 0) row.getCell('pdc').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
  }
  const totRow = byRegion.addRow({
    region: 'TOTAL',
    q: buckets.query.length,
    p: buckets.placeholder.length,
    pd: buckets.pastDue.length,
    pdf: buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[0].label).length,
    pds: buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[1].label).length,
    pdc: buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[2].label).length,
    tot: buckets.query.length + buckets.placeholder.length + buckets.pastDue.length,
  });
  totRow.font = { bold: true };
  totRow.border = { top: { style: 'thin' } };

  // --- Pivot tab (Region × BOS × ISE × Aging) ---
  const pivot = wb.addWorksheet('Pivot BOS x ISE');
  pivot.columns = [
    { header: 'Bucket', key: 'bucket', width: 18 },
    { header: 'Region', key: 'region', width: 12 },
    { header: 'BOS (CSE)', key: 'bos', width: 20 },
    { header: 'ISE', key: 'ise', width: 16 },
    { header: 'Aging', key: 'aging', width: 16 },
    { header: 'Count', key: 'count', width: 10 },
  ];
  pivot.getRow(1).font = { bold: true };
  pivot.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  const addPivot = (label, rows, useAging = false) => {
    const agg = new Map();
    for (const r of rows) {
      const bos = (r['Customer CSE'] || '(blank)').toString().trim() || '(blank)';
      const ise = (r['Internal Salesperson'] || '(blank)').toString().trim() || '(blank)';
      const region = r._region;
      const aging = useAging ? r._agingBand : '';
      const key = `${region}|${bos}|${ise}|${aging}`;
      agg.set(key, (agg.get(key) || 0) + 1);
    }
    for (const [key, count] of agg) {
      const [region, bos, ise, aging] = key.split('|');
      pivot.addRow({ bucket: label, region, bos, ise, aging, count });
    }
  };
  addPivot('Query', buckets.query);
  addPivot('Placeholder', buckets.placeholder);
  addPivot('Past Due', buckets.pastDue, true);
  pivot.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  return await wb.xlsx.writeBuffer();
}

// -- Main -------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const toFlag = args.indexOf('--to');
  const ccFlag = args.indexOf('--cc');
  const recipient = toFlag >= 0 ? args[toFlag + 1] : DEFAULT_RECIPIENT;
  const cc = ccFlag >= 0 ? args[ccFlag + 1] : null;
  const inputPath = args.find(a => a.endsWith('.xlsx'));
  if (!inputPath) {
    console.error('Usage: node bos-report.js <infor-export.xlsx> [--to email] [--cc email]');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Reading ${inputPath}...`);
  const wb = XLSX.readFile(inputPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  console.log(`Loaded ${rows.length} rows`);

  const buckets = bucketize(rows);
  console.log(`Buckets: query=${buckets.query.length}, placeholder=${buckets.placeholder.length}, pastDue=${buckets.pastDue.length}`);

  const attachments = [];
  console.log('Fetching chart images from quickchart.io...');
  const html = await buildHtml(buckets, path.basename(inputPath), attachments);
  console.log(`Fetched ${attachments.length} chart PNGs`);
  console.log('Building xlsx (per-BOS tabs w/ embedded charts)...');
  const xlsxBuf = await buildXlsxBuffer(buckets);
  console.log(`xlsx ready (${xlsxBuf.length} bytes)`);
  const runDate = isoDate(TODAY_UTC);

  attachments.push({ filename: `BOS_Metrics_${runDate}.xlsx`, content: xlsxBuf });

  const notifier = createNotifier({
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: "Leah's BOS Report"
  });

  const subject = `Leah's BOS Report — ${runDate}`;
  const sendOpts = { html: true };
  if (cc) sendOpts.cc = cc;
  const ok = await notifier.sendWithAttachment(
    recipient,
    subject,
    html,
    attachments,
    sendOpts
  );
  console.log(ok ? `Sent to ${recipient}${cc ? ` (CC: ${cc})` : ''}` : 'Send failed');
}

main().catch(e => { console.error(e); process.exit(1); });
