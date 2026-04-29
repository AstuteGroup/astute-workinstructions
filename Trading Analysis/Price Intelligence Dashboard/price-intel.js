#!/usr/bin/env node
/**
 * Price Intelligence Dashboard generator
 *
 * Standardized version of the MT40A1G16TB-062E IT:F dashboard (Mar 2026).
 * Pulls VQ + Market Offer + Customer-target history for a given MPN and
 * renders an interactive HTML chart matching the IT:F look, with the
 * customer-target overlay added from the IT:E iteration.
 *
 * Usage:
 *   node price-intel.js --mpn "MT40A1G16TB-062E IT:F"
 *   node price-intel.js --mpn "MT40A1G8SA-062E IT:E" --from 2024-01-01
 *   node price-intel.js --mpn "MT40A1G16TB-062E" --loose          # prefix match (catches TR variants)
 *   node price-intel.js --mpn "..." --email                       # also email the dashboard
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'output');

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(flag, fallback = null) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

const MPN_RAW = arg('--mpn');
if (!MPN_RAW) {
  console.error('Usage: node price-intel.js --mpn "<MPN>" [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--loose] [--email]');
  process.exit(1);
}

const FROM = arg('--from', null);                       // ISO date or null = all-time
const TO   = arg('--to', null);
const LOOSE = !!arg('--loose', false);                  // prefix match on chuboe_mpn_clean
const EMAIL = !!arg('--email', false);

const MPN_CLEAN = String(MPN_RAW).toUpperCase().replace(/[^A-Z0-9]/g, '');
if (MPN_CLEAN.length < 5) {
  console.error(`MPN clean form too short: "${MPN_CLEAN}". Refusing to run (would over-match).`);
  process.exit(2);
}

const matchSql = (col) => LOOSE
  ? `${col} LIKE '${MPN_CLEAN}%'`
  : `${col} = '${MPN_CLEAN}'`;

// ── psql ─────────────────────────────────────────────────────────────────────
function psql(sql) {
  const cmd = `psql -U analytics_user -t -A -F '' -c "${sql.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 * 64 });
  return out.split('\n').filter(Boolean).map(line => line.split(''));
}

// ── Date filter clauses ──────────────────────────────────────────────────────
function dateRange(col) {
  const parts = [];
  if (FROM) parts.push(`${col} >= '${FROM}'::date`);
  if (TO)   parts.push(`${col} <= '${TO}'::date`);
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}

// ── Queries ──────────────────────────────────────────────────────────────────
console.log(`Pulling data for "${MPN_RAW}" (clean: ${MPN_CLEAN}, loose=${LOOSE})...`);

const vqDateCol = `COALESCE(vq.chuboe_datequotetrx, vq.created)`;
const vqRows = psql(`
  SELECT
    TO_CHAR(${vqDateCol}, 'YYYY-MM-DD'),
    COALESCE(NULLIF(TRIM(vq.bpname),''), bp.name, ''),
    COALESCE(vq.qty, 0),
    vq.cost,
    COALESCE(NULLIF(TRIM(vq.chuboe_date_code),''), ''),
    COALESCE(rfq.value, ''),
    COALESCE(cust.name, ''),
    COALESCE(NULLIF(TRIM(vq.chuboe_mfr_text),''), mfr.name, '')
  FROM adempiere.chuboe_vq_line vq
  LEFT JOIN adempiere.c_bpartner bp   ON bp.c_bpartner_id   = vq.c_bpartner_id
  LEFT JOIN adempiere.chuboe_rfq rfq  ON rfq.chuboe_rfq_id  = vq.chuboe_rfq_id
  LEFT JOIN adempiere.c_bpartner cust ON cust.c_bpartner_id = rfq.c_bpartner_id
  LEFT JOIN adempiere.chuboe_mfr mfr  ON mfr.chuboe_mfr_id  = vq.chuboe_mfr_id
  WHERE vq.isactive = 'Y'
    AND vq.cost > 0
    AND ${matchSql('vq.chuboe_mpn_clean')}
    ${dateRange(vqDateCol)}
  ORDER BY 1
`);

const offerDateCol = `COALESCE(o.datetrx, o.created)`;
const moRows = psql(`
  SELECT
    TO_CHAR(${offerDateCol}, 'YYYY-MM-DD'),
    COALESCE(bp.name, ''),
    COALESCE(ol.qty, 0),
    ol.priceentered,
    COALESCE(NULLIF(TRIM(ol.chuboe_date_code),''), ''),
    COALESCE(ot.name, ''),
    COALESCE(NULLIF(TRIM(ol.chuboe_mfr_text),''), mfr.name, '')
  FROM adempiere.chuboe_offer_line ol
  JOIN adempiere.chuboe_offer o     ON o.chuboe_offer_id = ol.chuboe_offer_id
  LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id  = o.c_bpartner_id
  LEFT JOIN adempiere.chuboe_offer_type ot ON ot.chuboe_offer_type_id = o.chuboe_offer_type_id
  LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = ol.chuboe_mfr_id
  WHERE ol.isactive = 'Y'
    AND o.isactive  = 'Y'
    AND ol.priceentered > 0
    AND ${matchSql('ol.chuboe_mpn_clean')}
    ${dateRange(offerDateCol)}
  ORDER BY 1
`);

// Customer targets = customer's stated target on the RFQ line (priceentered on chuboe_rfq_line)
const tgtDateCol = `COALESCE(rfq.chuboe_co_orderdate, rfq.created)`;
const tgtRows = psql(`
  SELECT
    TO_CHAR(${tgtDateCol}, 'YYYY-MM-DD'),
    COALESCE(cust.name, ''),
    COALESCE(rl.qty, 0),
    rl.priceentered,
    COALESCE(rfq.value, '')
  FROM adempiere.chuboe_rfq_line rl
  JOIN adempiere.chuboe_rfq rfq      ON rfq.chuboe_rfq_id  = rl.chuboe_rfq_id
  LEFT JOIN adempiere.c_bpartner cust ON cust.c_bpartner_id = rfq.c_bpartner_id
  WHERE rl.isactive = 'Y'
    AND rfq.isactive = 'Y'
    AND rl.priceentered > 0
    AND EXISTS (
      SELECT 1 FROM adempiere.chuboe_rfq_line_mpn rlm
      WHERE rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
        AND ${matchSql('rlm.chuboe_mpn_clean')}
    )
    ${dateRange(tgtDateCol)}
  ORDER BY 1
`);

const vqData = vqRows.map(r => ({
  date: r[0], vendor: r[1], qty: parseFloat(r[2]) || 0, cost: parseFloat(r[3]) || 0,
  dc: r[4], rfq: r[5], customer: r[6], mfr: r[7],
})).filter(d => d.cost > 0 && d.date);

const moData = moRows.map(r => ({
  date: r[0], vendor: r[1], qty: parseFloat(r[2]) || 0, cost: parseFloat(r[3]) || 0,
  dc: r[4], offerType: r[5], mfr: r[6],
})).filter(d => d.cost > 0 && d.date);

const tgtData = tgtRows.map(r => ({
  date: r[0], customer: r[1], qty: parseFloat(r[2]) || 0, price: parseFloat(r[3]) || 0,
  rfq: r[4],
})).filter(d => d.price > 0 && d.date);

console.log(`VQ: ${vqData.length}  |  MO: ${moData.length}  |  Customer Targets: ${tgtData.length}`);

if (vqData.length === 0 && moData.length === 0 && tgtData.length === 0) {
  console.error(`No data found for "${MPN_RAW}". Try --loose for prefix match.`);
  process.exit(3);
}

// ── Stats ────────────────────────────────────────────────────────────────────
const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
const fmt$ = v => '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const vqCosts = vqData.map(d => d.cost);
const moCosts = moData.map(d => d.cost);
const tgtPrices = tgtData.map(d => d.price);
const customers = [...new Set(vqData.map(d => d.customer).filter(Boolean))].sort();

const allDates = [...vqData, ...moData, ...tgtData].map(d => d.date).filter(Boolean).sort();
const dateMin = FROM || (allDates[0] || '2024-01-01');
const dateMax = TO   || (allDates[allDates.length - 1] || new Date().toISOString().slice(0, 10));

// ── HTML ─────────────────────────────────────────────────────────────────────
const subtitle = `${vqData.length} VQs + ${moData.length} MOs + ${tgtData.length} customer targets | ${dateMin} → ${dateMax}`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(MPN_RAW)} — Price Intelligence Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f5f6fa; color: #333; }
  .header { background: linear-gradient(135deg, #1a237e, #283593); color: white; padding: 20px 30px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header .subtitle { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  .stats-bar { display: flex; gap: 16px; padding: 16px 30px; background: white; border-bottom: 1px solid #e0e0e0; flex-wrap: wrap; }
  .stat-card { flex: 1; min-width: 140px; padding: 12px 16px; border-radius: 8px; background: #f8f9ff; border: 1px solid #e8eaf6; }
  .stat-card.mo { background: #fff8f0; border-color: #ffe0b2; }
  .stat-card.tgt { background: #e8f5e9; border-color: #a5d6a7; }
  .stat-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-card .value { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .stat-card.vq .value { color: #1565c0; }
  .stat-card.mo .value { color: #e65100; }
  .stat-card.tgt .value { color: #2e7d32; }
  .controls { padding: 12px 30px; background: white; border-bottom: 1px solid #e0e0e0; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .controls label { font-size: 13px; font-weight: 600; }
  .controls select, .controls input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
  .controls button { padding: 6px 14px; border: 1px solid #1565c0; background: #1565c0; color: white; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .controls button:hover { background: #0d47a1; }
  .controls button.secondary { background: white; color: #1565c0; }
  .controls button.secondary:hover { background: #e8eaf6; }
  .chart-container { padding: 20px 30px; }
  canvas { background: white; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .table-section { padding: 0 30px 30px; }
  .table-section h3 { font-size: 15px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  th { background: #1a237e; color: white; padding: 8px 10px; text-align: left; position: sticky; top: 0; }
  th.mo-header { background: #e65100; }
  td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; }
  tr:hover td { background: #f5f5f5; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .tag-vq { background: #e3f2fd; color: #1565c0; }
  .tag-mo { background: #fff3e0; color: #e65100; }
  .tag-tgt { background: #e8f5e9; color: #2e7d32; }
  .zoom-hint { font-size: 12px; color: #999; padding: 4px 30px 0; }
  .customer-filter { max-width: 220px; }
  .footnote { padding: 0 30px 30px; font-size: 11px; color: #888; }
</style>
</head>
<body>

<div class="header">
  <h1>${escapeHtml(MPN_RAW)} — Price Intelligence Dashboard</h1>
  <div class="subtitle">${escapeHtml(subtitle)}</div>
</div>

<div class="stats-bar">
  <div class="stat-card vq"><div class="label">VQ Quotes</div><div class="value">${vqData.length}</div></div>
  <div class="stat-card vq"><div class="label">VQ Avg</div><div class="value">${fmt$(avg(vqCosts))}</div></div>
  <div class="stat-card vq"><div class="label">VQ Range</div><div class="value">${vqCosts.length ? fmt$(Math.min(...vqCosts)) + ' – ' + fmt$(Math.max(...vqCosts)) : '—'}</div></div>
  <div class="stat-card mo"><div class="label">MO Offers</div><div class="value">${moData.length}</div></div>
  <div class="stat-card mo"><div class="label">MO Avg</div><div class="value">${fmt$(avg(moCosts))}</div></div>
  <div class="stat-card mo"><div class="label">MO Range</div><div class="value">${moCosts.length ? fmt$(Math.min(...moCosts)) + ' – ' + fmt$(Math.max(...moCosts)) : '—'}</div></div>
  <div class="stat-card tgt"><div class="label">Customer Targets</div><div class="value">${tgtData.length}</div></div>
  <div class="stat-card tgt"><div class="label">Target Avg</div><div class="value">${fmt$(avg(tgtPrices))}</div></div>
  <div class="stat-card" style="background:#f3e5f5; border-color:#ce93d8;"><div class="label">Unique Customers</div><div class="value" style="color:#6a1b9a;">${customers.length}</div></div>
</div>

<div class="controls">
  <label>Chart Type:</label>
  <select id="chartType">
    <option value="scatter">Scatter</option>
    <option value="line" selected>Line (Bi-weekly Avg)</option>
  </select>
  <label>Customer:</label>
  <select id="customerFilter" class="customer-filter">
    <option value="">All Customers</option>
    ${customers.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('\n    ')}
  </select>
  <label>Date From:</label>
  <input type="date" id="dateFrom" value="${dateMin}">
  <label>To:</label>
  <input type="date" id="dateTo" value="${dateMax}">
  <button onclick="updateChart()">Apply</button>
  <button class="secondary" onclick="resetZoom()">Reset Zoom</button>
</div>
<div class="zoom-hint">Scroll to zoom, click+drag to pan. Hover over points for details.</div>

<div class="chart-container">
  <canvas id="mainChart" height="500"></canvas>
</div>

<div class="table-section">
  <h3 id="tableTitle">Recent Data</h3>
  <div style="max-height:400px; overflow-y:auto;">
    <table id="dataTable">
      <thead><tr>
        <th>Type</th><th>Date</th><th>Vendor / Customer</th><th>Cost / Target</th><th>Qty</th><th>DC</th><th>Context</th>
      </tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
</div>

<div class="footnote">
  Match: ${LOOSE ? '<b>LOOSE</b> (chuboe_mpn_clean LIKE \'' + MPN_CLEAN + '%\')' : '<b>EXACT</b> on chuboe_mpn_clean = \'' + MPN_CLEAN + '\''}.
  Generated ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC.
</div>

<script>
const vqRaw  = ${JSON.stringify(vqData)};
const moRaw  = ${JSON.stringify(moData)};
const tgtRaw = ${JSON.stringify(tgtData)};

let mainChart = null;

function getBiweek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const start = new Date('2024-01-01T00:00:00');
  const days = Math.floor((d - start) / 86400000);
  const period = Math.floor(days / 14);
  return new Date(start.getTime() + period * 14 * 86400000).toISOString().slice(0, 10);
}

function groupForLine(data, priceField) {
  const groups = {};
  data.forEach(d => {
    const p = getBiweek(d.date);
    const v = d[priceField];
    if (!v) return;
    if (!groups[p]) groups[p] = [];
    groups[p].push(v);
  });
  return Object.entries(groups).sort(([a],[b]) => a.localeCompare(b)).map(([date, vals]) => ({
    x: date,
    y: +(vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(2),
    count: vals.length,
    low: Math.min(...vals),
    high: Math.max(...vals),
  }));
}

function filterData(raw, dateFrom, dateTo, customer) {
  return raw.filter(d => {
    if (d.date < dateFrom || d.date > dateTo) return false;
    if (customer && d.customer !== customer) return false;
    return true;
  });
}

function updateChart() {
  const chartType = document.getElementById('chartType').value;
  const customer  = document.getElementById('customerFilter').value;
  const dateFrom  = document.getElementById('dateFrom').value;
  const dateTo    = document.getElementById('dateTo').value;

  const vqFiltered  = filterData(vqRaw, dateFrom, dateTo, customer);
  const tgtFiltered = filterData(tgtRaw, dateFrom, dateTo, customer);
  // MO has no customer attribution — date filter only
  const moFiltered  = moRaw.filter(d => d.date >= dateFrom && d.date <= dateTo);

  if (mainChart) mainChart.destroy();
  const ctx = document.getElementById('mainChart').getContext('2d');

  let datasets;
  if (chartType === 'scatter') {
    datasets = [
      { label: 'VQ Quotes',
        data: vqFiltered.map(d => ({ x: d.date, y: d.cost, vendor: d.vendor, qty: d.qty, dc: d.dc, rfq: d.rfq, customer: d.customer, mfr: d.mfr })),
        backgroundColor: 'rgba(68,114,196,0.65)', borderColor: 'rgba(68,114,196,1)',
        pointRadius: 5, pointHoverRadius: 8, pointStyle: 'circle', showLine: false },
      { label: 'Market Offers',
        data: moFiltered.map(d => ({ x: d.date, y: d.cost, vendor: d.vendor, qty: d.qty, dc: d.dc, offerType: d.offerType, mfr: d.mfr })),
        backgroundColor: 'rgba(237,125,49,0.55)', borderColor: 'rgba(237,125,49,1)',
        pointRadius: 4, pointHoverRadius: 7, pointStyle: 'rectRot', showLine: false },
      { label: 'Customer Targets',
        data: tgtFiltered.map(d => ({ x: d.date, y: d.price, customer: d.customer, qty: d.qty, rfq: d.rfq })),
        backgroundColor: 'rgba(46,125,50,0.6)', borderColor: 'rgba(46,125,50,1)',
        pointRadius: 6, pointHoverRadius: 9, pointStyle: 'triangle', showLine: false },
    ];
  } else {
    datasets = [
      { label: 'VQ Avg',
        data: groupForLine(vqFiltered, 'cost'),
        borderColor: 'rgba(68,114,196,1)', backgroundColor: 'rgba(68,114,196,0.1)',
        borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 8, tension: 0.2, fill: false, spanGaps: true },
      { label: 'MO Avg',
        data: groupForLine(moFiltered, 'cost'),
        borderColor: 'rgba(237,125,49,1)', backgroundColor: 'rgba(237,125,49,0.1)',
        borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 8, tension: 0.2, fill: false, spanGaps: true },
      { label: 'Customer Target Avg',
        data: groupForLine(tgtFiltered, 'price'),
        borderColor: 'rgba(46,125,50,1)', backgroundColor: 'rgba(46,125,50,0.1)',
        borderWidth: 2.5, borderDash: [6, 4], pointRadius: 5, pointStyle: 'triangle',
        pointHoverRadius: 9, tension: 0.2, fill: false, spanGaps: true },
    ];
  }

  mainChart = new Chart(ctx, {
    type: chartType === 'scatter' ? 'scatter' : 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        title: { display: true,
          text: ${JSON.stringify(MPN_RAW)} + ' — ' + (chartType === 'scatter' ? 'All Data Points' : 'Bi-weekly Average') + (customer ? ' [' + customer + ']' : ''),
          font: { size: 16, weight: 'bold' } },
        legend: { position: 'bottom', labels: { font: { size: 13 }, usePointStyle: true, padding: 20 } },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)', titleFont: { size: 13 }, bodyFont: { size: 12 },
          padding: 12, cornerRadius: 6,
          callbacks: {
            title: items => items[0].dataset.label + ' — ' + items[0].raw.x,
            label: function(ctx) {
              const d = ctx.raw;
              const lines = ['Price: $' + d.y.toFixed(2)];
              if (d.vendor)    lines.push('Vendor: ' + d.vendor);
              if (d.qty)       lines.push('Qty: ' + d.qty.toLocaleString());
              if (d.dc)        lines.push('DC: ' + d.dc);
              if (d.mfr)       lines.push('MFR: ' + d.mfr);
              if (d.customer)  lines.push('Customer: ' + d.customer);
              if (d.rfq)       lines.push('RFQ: ' + d.rfq);
              if (d.offerType) lines.push('Type: ' + d.offerType);
              if (d.count)     lines.push('Points: ' + d.count + ' | Low: $' + d.low.toFixed(2) + ' | High: $' + d.high.toFixed(2));
              return lines;
            }
          }
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'xy' },
          pan: { enabled: true, mode: 'xy' },
        },
      },
      scales: {
        x: { type: 'time', time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
             title: { display: true, text: 'Date', font: { size: 13 } }, grid: { color: '#f0f0f0' } },
        y: { title: { display: true, text: 'Unit Price ($)', font: { size: 13 } },
             ticks: { callback: v => '$' + v }, grid: { color: '#f0f0f0' }, beginAtZero: true },
      },
    },
  });

  // Recent data table — interleave all three sources
  const recent = [
    ...vqFiltered.map(d => ({ ...d, _kind: 'VQ', _price: d.cost })),
    ...moFiltered.map(d => ({ ...d, _kind: 'MO', _price: d.cost })),
    ...tgtFiltered.map(d => ({ ...d, _kind: 'TGT', _price: d.price })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);

  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = recent.map(d => {
    const tag = d._kind === 'VQ'  ? '<span class="tag tag-vq">VQ</span>'
              : d._kind === 'MO'  ? '<span class="tag tag-mo">MO</span>'
              :                     '<span class="tag tag-tgt">TGT</span>';
    const counterparty = d._kind === 'TGT' ? d.customer : d.vendor;
    const ctx = d._kind === 'VQ'  ? (d.customer ? d.customer + (d.rfq ? ' (RFQ ' + d.rfq + ')' : '') : '—')
              : d._kind === 'MO'  ? (d.offerType || '—')
              :                     (d.rfq ? 'RFQ ' + d.rfq : '—');
    return '<tr><td>' + tag + '</td><td>' + d.date + '</td><td>' + (counterparty || '—') + '</td><td>$' + d._price.toFixed(2) + '</td><td>' + (d.qty ? d.qty.toLocaleString() : '—') + '</td><td>' + (d.dc || '—') + '</td><td>' + ctx + '</td></tr>';
  }).join('');

  document.getElementById('tableTitle').textContent = 'Recent Data (' + recent.length + ' of ' + (vqFiltered.length + moFiltered.length + tgtFiltered.length) + ' total)';
}

function resetZoom() { if (mainChart) mainChart.resetZoom(); }
updateChart();
</script>
</body>
</html>`;

// ── Write file ───────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const safeMpn = MPN_RAW.replace(/[^A-Za-z0-9-]+/g, '_');
const today = new Date().toISOString().slice(0, 10);
const outPath = path.join(OUT_DIR, `${safeMpn}_${today}.html`);
fs.writeFileSync(outPath, html);
console.log('\nDashboard written:', outPath);
console.log(`File size: ${(html.length / 1024).toFixed(1)} KB`);
console.log(`Top customers: ${customers.slice(0, 5).join(', ')}${customers.length > 5 ? '...' : ''}`);

// ── Optional email ───────────────────────────────────────────────────────────
if (EMAIL) {
  const notifier = require(path.join(ROOT, 'shared', 'notifier'));
  const recipient = process.env.OPERATOR_EMAIL || 'jake.harris@Astutegroup.com';
  const subject = `${MPN_RAW} — Price Intelligence Dashboard (${today})`;
  const body = `<p>Price intelligence for <b>${escapeHtml(MPN_RAW)}</b>:</p>
    <ul>
      <li>${vqData.length} VQ quotes (avg ${fmt$(avg(vqCosts))})</li>
      <li>${moData.length} market offers (avg ${fmt$(avg(moCosts))})</li>
      <li>${tgtData.length} customer targets (avg ${fmt$(avg(tgtPrices))})</li>
      <li>${customers.length} unique customers</li>
    </ul>
    <p>Open the attached HTML in a browser for the interactive dashboard.</p>`;
  notifier.send({
    to: recipient, subject, html: body,
    attachments: [{ filename: path.basename(outPath), path: outPath }],
  }).then(() => console.log('Emailed to', recipient))
    .catch(err => { console.error('Email failed:', err.message); process.exitCode = 4; });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
