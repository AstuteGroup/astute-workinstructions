#!/usr/bin/env node
/**
 * Generate API Budget Dashboard HTML
 * Shows 2-week write history + current budget state + rate limit events
 *
 * Output is a self-contained HTML file that can be shared/emailed.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { psqlQuery } = require('/home/analytics_user/workspace/astute-workinstructions/shared/db-helpers');
const otBudget = require('/home/analytics_user/workspace/astute-workinstructions/shared/ot-api-budget');

// Cache Chart.js locally for embedding
const CHARTJS_CACHE = path.join(process.env.HOME, 'workspace', '.chartjs-cache.js');
const CHARTJS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

function fetchChartJS() {
  return new Promise((resolve, reject) => {
    // Use cached version if available and recent (< 7 days)
    if (fs.existsSync(CHARTJS_CACHE)) {
      const stat = fs.statSync(CHARTJS_CACHE);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 7 * 24 * 60 * 60 * 1000) {
        return resolve(fs.readFileSync(CHARTJS_CACHE, 'utf8'));
      }
    }

    console.log('  Fetching Chart.js from CDN...');
    https.get(CHARTJS_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        fs.writeFileSync(CHARTJS_CACHE, data);
        resolve(data);
      });
    }).on('error', (e) => {
      // Fall back to cached version if fetch fails
      if (fs.existsSync(CHARTJS_CACHE)) {
        resolve(fs.readFileSync(CHARTJS_CACHE, 'utf8'));
      } else {
        reject(e);
      }
    });
  });
}

// ─── Query Historical Data ───────────────────────────────────────────────────

function getHistoricalWrites() {
  const tables = [
    'chuboe_rfq',
    'chuboe_rfq_line',
    'chuboe_rfq_line_mpn',
    'chuboe_vq_line',
    'chuboe_cq_line',
    'chuboe_offer_line',
    'chuboe_offer_line_mpn',
    'chuboe_pricing_api_result',
  ];

  // Aggregate POST + PATCH per table per day
  const byTableDay = {};

  for (const table of tables) {
    // POSTs (new rows)
    const sqlCreate = `SELECT date_trunc('day', created)::date as day, count(*) as writes FROM ${table} WHERE created >= NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1`;
    const resultCreate = psqlQuery(sqlCreate);
    if (resultCreate) {
      resultCreate.split('\n').filter(Boolean).forEach(line => {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const day = parts[0].trim();
          const writes = parseInt(parts[1].trim(), 10);
          if (day && !isNaN(writes)) {
            const key = `${table}|${day}`;
            byTableDay[key] = (byTableDay[key] || 0) + writes;
          }
        }
      });
    }

    // PATCHes (updates to existing rows)
    const sqlUpdate = `SELECT date_trunc('day', updated)::date as day, count(*) as writes FROM ${table} WHERE updated >= NOW() - INTERVAL '14 days' AND updated != created GROUP BY 1 ORDER BY 1`;
    const resultUpdate = psqlQuery(sqlUpdate);
    if (resultUpdate) {
      resultUpdate.split('\n').filter(Boolean).forEach(line => {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const day = parts[0].trim();
          const writes = parseInt(parts[1].trim(), 10);
          if (day && !isNaN(writes)) {
            const key = `${table}|${day}`;
            byTableDay[key] = (byTableDay[key] || 0) + writes;
          }
        }
      });
    }
  }

  // Convert to rows format
  const rows = [];
  for (const [key, writes] of Object.entries(byTableDay)) {
    const [table, day] = key.split('|');
    rows.push({ day, table, writes });
  }

  return rows;
}

function getHourlyWrites() {
  const tables = [
    'chuboe_rfq_line',
    'chuboe_vq_line',
    'chuboe_cq_line',
    'chuboe_offer_line',
    'chuboe_pricing_api_result',
  ];

  // Aggregate POST + PATCH per table per hour
  const byTableHour = {};

  for (const table of tables) {
    // POSTs
    const sqlCreate = `SELECT date_trunc('hour', created) as hour, count(*) as writes FROM ${table} WHERE created >= NOW() - INTERVAL '48 hours' GROUP BY 1 ORDER BY 1`;
    const resultCreate = psqlQuery(sqlCreate);
    if (resultCreate) {
      resultCreate.split('\n').filter(Boolean).forEach(line => {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const hour = parts[0].trim();
          const writes = parseInt(parts[1].trim(), 10);
          if (hour && !isNaN(writes)) {
            const key = `${table}|${hour}`;
            byTableHour[key] = (byTableHour[key] || 0) + writes;
          }
        }
      });
    }

    // PATCHes
    const sqlUpdate = `SELECT date_trunc('hour', updated) as hour, count(*) as writes FROM ${table} WHERE updated >= NOW() - INTERVAL '48 hours' AND updated != created GROUP BY 1 ORDER BY 1`;
    const resultUpdate = psqlQuery(sqlUpdate);
    if (resultUpdate) {
      resultUpdate.split('\n').filter(Boolean).forEach(line => {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const hour = parts[0].trim();
          const writes = parseInt(parts[1].trim(), 10);
          if (hour && !isNaN(writes)) {
            const key = `${table}|${hour}`;
            byTableHour[key] = (byTableHour[key] || 0) + writes;
          }
        }
      });
    }
  }

  // Convert to rows format
  const rows = [];
  for (const [key, writes] of Object.entries(byTableHour)) {
    const [table, hour] = key.split('|');
    rows.push({ hour, table, writes });
  }

  return rows;
}

function getCurrentBudgetState() {
  const budgetFile = path.join(process.env.HOME, 'workspace', '.ot-api-budget.json');
  try {
    return JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  } catch (e) {
    return { writes: [], reservations: [], backfills: [], circuitBreaker: {} };
  }
}

function getQueueStatus() {
  const workspace = process.env.HOME + '/workspace';
  const result = {
    rfqLoad: { pending: [], loading: [], stats: {} },
    rfqEnrich: { pending: [], stats: {} },
    deferredApi: { pending: 0, success: 0, failed: 0 },
    other: []
  };

  // RFQ Load Queue
  try {
    const data = JSON.parse(fs.readFileSync(path.join(workspace, '.rfq-load-queue.json'), 'utf8'));
    const items = data.items || [];
    const pending = items.filter(i => i.status === 'queued');
    const loading = items.filter(i => i.status === 'loading');
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const completedLast24h = items.filter(i =>
      i.status === 'loaded' && i.completedAt && new Date(i.completedAt).getTime() > dayAgo
    );
    result.rfqLoad = {
      pending,
      loading,
      stats: {
        pendingCount: pending.length,
        pendingLines: pending.reduce((sum, i) => sum + (i.lineCount || 0), 0),
        loadingCount: loading.length,
        loadingLines: loading.reduce((sum, i) => sum + (i.lineCount || 0), 0),
        completedLast24h: completedLast24h.length,
        linesLast24h: completedLast24h.reduce((sum, i) => sum + (i.linesWritten || 0), 0),
      }
    };
  } catch (e) { /* ignore */ }

  // RFQ Enrichment Backlog
  try {
    const data = JSON.parse(fs.readFileSync(path.join(workspace, '.rfq-enrichment-backlog.json'), 'utf8'));
    const items = data.items || [];
    const pending = items.filter(i => i.status === 'pending');
    result.rfqEnrich = {
      pending,
      stats: {
        pendingCount: pending.length,
        pendingLines: pending.reduce((sum, i) => sum + (i.line_mpns || 0), 0),
      }
    };
  } catch (e) { /* ignore */ }

  // Deferred API Queue (large file - count via grep-like approach)
  try {
    const content = fs.readFileSync(path.join(workspace, '.deferred-api-queue.json'), 'utf8');
    result.deferredApi = {
      pending: (content.match(/"status":\s*"pending"/g) || []).length,
      success: (content.match(/"status":\s*"success"/g) || []).length,
      failed: (content.match(/"status":\s*"failed"/g) || []).length,
    };
  } catch (e) { /* ignore */ }

  // Delisted Parts Queue
  try {
    const data = JSON.parse(fs.readFileSync(path.join(workspace, '.delisted-parts-queue.json'), 'utf8'));
    const unsourced = (data.parts || []).filter(p => !p.sourced);
    if (unsourced.length > 0) {
      result.other.push({ name: 'Delisted Parts', count: unsourced.length });
    }
  } catch (e) { /* ignore */ }

  return result;
}

// ─── Generate HTML ───────────────────────────────────────────────────────────

function generateHTML(dailyData, hourlyData, budgetState, rateLimitEvents, chartJsCode, queueStatus) {
  // Group tables by loader/workflow
  const loaderGroups = {
    'RFQ Loading': ['chuboe_rfq', 'chuboe_rfq_line', 'chuboe_rfq_line_mpn'],
    'VQ/Enrichment': ['chuboe_vq_line', 'chuboe_pricing_api_result'],
    'CQ Loading': ['chuboe_cq_line'],
    'Offer Writeback': ['chuboe_offer_line', 'chuboe_offer_line_mpn'],
  };

  const loaderColors = {
    'RFQ Loading': '#4CAF50',
    'VQ/Enrichment': '#FF9800',
    'CQ Loading': '#9C27B0',
    'Offer Writeback': '#F44336',
  };

  const loaderPriority = {
    'RFQ Loading': 'P4',
    'VQ/Enrichment': 'P3 (VQ) + P2 (enrich-poller)',
    'CQ Loading': 'P1 (Stock RFQ)',
    'Offer Writeback': 'P0-P2',
  };

  // Aggregate data by loader group
  function aggregateByLoader(data, timeKey) {
    const aggregated = {};
    for (const row of data) {
      // Find which loader group this table belongs to
      let loader = null;
      for (const [name, tables] of Object.entries(loaderGroups)) {
        if (tables.includes(row.table)) {
          loader = name;
          break;
        }
      }
      if (!loader) continue;

      const key = `${loader}|${row[timeKey]}`;
      aggregated[key] = (aggregated[key] || 0) + row.writes;
    }
    return aggregated;
  }

  const loaders = Object.keys(loaderGroups);

  // Aggregate daily data by loader
  const dailyByLoader = aggregateByLoader(dailyData, 'day');
  const days = [...new Set(dailyData.map(d => d.day))].sort();

  // Build datasets by loader group
  const dailyDatasets = loaders.map(loader => ({
    label: loader,
    data: days.map(day => dailyByLoader[`${loader}|${day}`] || 0),
    borderColor: loaderColors[loader],
    backgroundColor: loaderColors[loader] + '40',
    fill: false,
    tension: 0.3,
  }));

  // Daily totals
  const dailyTotals = days.map(day =>
    dailyData.filter(d => d.day === day).reduce((sum, d) => sum + d.writes, 0)
  );

  // Aggregate hourly data by loader
  const hourlyByLoader = aggregateByLoader(hourlyData, 'hour');
  const hours = [...new Set(hourlyData.map(d => d.hour))].sort();

  const hourlyDatasets = loaders.map(loader => ({
    label: loader,
    data: hours.map(hour => hourlyByLoader[`${loader}|${hour}`] || 0),
    borderColor: loaderColors[loader],
    backgroundColor: loaderColors[loader] + '40',
    fill: true,
    tension: 0.3,
  }));

  // Hourly totals
  const hourlyTotals = hours.map(hour =>
    hourlyData.filter(d => d.hour === hour).reduce((sum, d) => sum + d.writes, 0)
  );

  // Current budget summary
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const fifteenMinAgo = now - 15 * 60 * 1000;
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const writes = budgetState.writes || [];
  const budget = {
    last5Min: writes.filter(w => w.timestamp > fiveMinAgo).reduce((s, w) => s + w.count, 0),
    last15Min: writes.filter(w => w.timestamp > fifteenMinAgo).reduce((s, w) => s + w.count, 0),
    lastHour: writes.filter(w => w.timestamp > hourAgo).reduce((s, w) => s + w.count, 0),
    lastDay: writes.filter(w => w.timestamp > dayAgo).reduce((s, w) => s + w.count, 0),
  };

  // Caller breakdown from last 24h
  const callerCounts = {};
  writes.filter(w => w.timestamp > dayAgo).forEach(w => {
    const caller = w.caller || 'unknown';
    callerCounts[caller] = (callerCounts[caller] || 0) + w.count;
  });

  const callerLabels = Object.keys(callerCounts).sort((a, b) => callerCounts[b] - callerCounts[a]);
  const callerValues = callerLabels.map(c => callerCounts[c]);

  // Process rate limit events
  const rateLimitsByDay = {};
  const rateLimitsByCaller = {};
  const rateLimitsByType = {};
  const rateLimitsByTypeByDay = {}; // For colored lines per limit type
  const recentRateLimits = [];

  (rateLimitEvents || []).forEach(e => {
    // By day
    const day = e.timestamp ? e.timestamp.slice(0, 10) : 'unknown';
    rateLimitsByDay[day] = (rateLimitsByDay[day] || 0) + 1;

    // By caller
    const caller = e.caller || 'unknown';
    rateLimitsByCaller[caller] = (rateLimitsByCaller[caller] || 0) + 1;

    // By limit type
    const limitType = e.limitType || 'unknown';
    rateLimitsByType[limitType] = (rateLimitsByType[limitType] || 0) + 1;

    // By type by day (for line chart)
    if (!rateLimitsByTypeByDay[limitType]) rateLimitsByTypeByDay[limitType] = {};
    rateLimitsByTypeByDay[limitType][day] = (rateLimitsByTypeByDay[limitType][day] || 0) + 1;

    // Recent events (last 50)
    if (recentRateLimits.length < 50) {
      recentRateLimits.push(e);
    }
  });

  const rateLimitDays = Object.keys(rateLimitsByDay).sort();
  const rateLimitDayCounts = rateLimitDays.map(d => rateLimitsByDay[d]);

  // Rate limit type colors
  const limitTypeColors = {
    'soft-5min': '#ff6b6b',
    'hard-5min': '#ff0000',
    'soft-15min': '#ff9f43',
    'hard-15min': '#ff6600',
    'soft-hourly': '#f9ca24',
    'hard-hourly': '#ffaa00',
    'soft-daily': '#6ab04c',
    'hard-daily': '#00aa00',
  };

  // Build rate limit datasets per type for daily chart
  const rateLimitTypes = Object.keys(rateLimitsByTypeByDay);
  const rateLimitTypeDatasets = rateLimitTypes.map(type => ({
    label: type,
    data: days.map(d => rateLimitsByTypeByDay[type][d] || 0),
    borderColor: limitTypeColors[type] || '#888',
    backgroundColor: (limitTypeColors[type] || '#888') + '40',
    fill: false,
    tension: 0.3,
    pointRadius: days.map(d => (rateLimitsByTypeByDay[type][d] || 0) > 0 ? 4 : 0),
  }));

  // Rate limits by hour (for overlaying on hourly chart)
  const rateLimitsByHour = {};
  (rateLimitEvents || []).forEach(e => {
    if (e.timestamp) {
      // Truncate to hour
      const hour = e.timestamp.slice(0, 13) + ':00:00';
      rateLimitsByHour[hour] = (rateLimitsByHour[hour] || 0) + 1;
    }
  });

  // Rate limit events per hour (scaled for visibility - multiply by 500 to show on same scale)
  const rateLimitEventsPerHour = hours.map(hour => {
    // Convert hour format to match timestamp format
    const hourKey = hour.replace(' ', 'T').slice(0, 13) + ':00:00';
    const count = rateLimitsByHour[hourKey] || 0;
    return count > 0 ? count * 500 : null; // null = don't show point, scaled for visibility
  });

  // Rate limits by day for daily chart overlay
  const rateLimitCountsByDay = days.map(d => rateLimitsByDay[d] || 0);

  const rateLimitCallerLabels = Object.keys(rateLimitsByCaller).sort((a, b) => rateLimitsByCaller[b] - rateLimitsByCaller[a]);
  const rateLimitCallerCounts = rateLimitCallerLabels.map(c => rateLimitsByCaller[c]);

  const rateLimitTypeLabels = Object.keys(rateLimitsByType);
  const rateLimitTypeCounts = rateLimitTypeLabels.map(t => rateLimitsByType[t]);

  const totalRateLimits = rateLimitEvents ? rateLimitEvents.length : 0;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>OT API Budget Dashboard</title>
  <script>${chartJsCode}</script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      padding: 20px;
    }
    h1 { color: #00d4ff; margin-bottom: 10px; }
    h2 { color: #ff9f43; margin: 20px 0 10px; font-size: 1.2em; }
    .timestamp { color: #888; font-size: 0.9em; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .card {
      background: #16213e;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }
    .card-title { color: #00d4ff; margin-bottom: 15px; font-size: 1.1em; }
    .budget-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #2a3f5f;
    }
    .budget-row:last-child { border-bottom: none; }
    .budget-label { color: #aaa; }
    .budget-value { font-weight: bold; }
    .budget-value.warning { color: #ff9f43; }
    .budget-value.danger { color: #ff6b6b; }
    .budget-value.ok { color: #4ade80; }
    .chart-container {
      background: #16213e;
      border-radius: 12px;
      padding: 20px;
      margin-top: 20px;
    }
    .priority-legend {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 10px;
      margin-top: 15px;
    }
    .priority-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #1a1a2e;
      border-radius: 6px;
    }
    .priority-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .priority-text { font-size: 0.85em; }
    .limits-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    .limits-table th, .limits-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid #2a3f5f;
    }
    .limits-table th { color: #00d4ff; }
    .progress-bar {
      height: 8px;
      background: #2a3f5f;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 4px;
    }
    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s;
    }
  </style>
</head>
<body>
  <h1>OT API Budget Dashboard</h1>
  <div class="timestamp">Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Current Budget Status (Live)</div>
      <div class="budget-row">
        <span class="budget-label">Last 5 min</span>
        <span class="budget-value ${budget.last5Min > 400 ? 'warning' : budget.last5Min > 500 ? 'danger' : 'ok'}">${budget.last5Min.toLocaleString()} / 600</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(100, budget.last5Min/6)}%; background: ${budget.last5Min > 500 ? '#ff6b6b' : budget.last5Min > 400 ? '#ff9f43' : '#4ade80'}"></div></div>

      <div class="budget-row">
        <span class="budget-label">Last 15 min</span>
        <span class="budget-value ${budget.last15Min > 3000 ? 'warning' : budget.last15Min > 3500 ? 'danger' : 'ok'}">${budget.last15Min.toLocaleString()} / 4,000</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(100, budget.last15Min/40)}%; background: ${budget.last15Min > 3500 ? '#ff6b6b' : budget.last15Min > 3000 ? '#ff9f43' : '#4ade80'}"></div></div>

      <div class="budget-row">
        <span class="budget-label">Last Hour</span>
        <span class="budget-value ${budget.lastHour > 12000 ? 'warning' : budget.lastHour > 14000 ? 'danger' : 'ok'}">${budget.lastHour.toLocaleString()} / 15,000</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(100, budget.lastHour/150)}%; background: ${budget.lastHour > 14000 ? '#ff6b6b' : budget.lastHour > 12000 ? '#ff9f43' : '#4ade80'}"></div></div>

      <div class="budget-row">
        <span class="budget-label">Last 24h</span>
        <span class="budget-value ${budget.lastDay > 250000 ? 'warning' : budget.lastDay > 280000 ? 'danger' : 'ok'}">${budget.lastDay.toLocaleString()} / 300,000</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(100, budget.lastDay/3000)}%; background: ${budget.lastDay > 280000 ? '#ff6b6b' : budget.lastDay > 250000 ? '#ff9f43' : '#4ade80'}"></div></div>
    </div>

    <div class="card">
      <div class="card-title">Priority Tiers</div>
      <table class="limits-table">
        <tr><th>Priority</th><th>Callers</th><th>Behavior</th></tr>
        <tr><td style="color:#4CAF50">P4</td><td>rfq-loading-agent</td><td>Bypass all limits</td></tr>
        <tr><td style="color:#2196F3">P3</td><td>vq-loading-agent</td><td>400 reserved</td></tr>
        <tr><td style="color:#FF9800">P2</td><td>enrich-poller, excess-agent</td><td>Normal limits</td></tr>
        <tr><td style="color:#9C27B0">P1</td><td>stockrfq-agent</td><td>Throttled early</td></tr>
        <tr><td style="color:#F44336">P0</td><td>offer-writeback</td><td>Throttled first</td></tr>
      </table>
    </div>

    <div class="card">
      <div class="card-title">Work Queues</div>

      <!-- RFQ Loading -->
      <div style="margin-bottom: 12px;">
        <div style="color: #00d4ff; font-size: 0.9em; margin-bottom: 4px;">RFQ Loading</div>
        <div class="budget-row">
          <span class="budget-label">Pending/Loading</span>
          <span class="budget-value ${(queueStatus.rfqLoad.stats.pendingCount || 0) + (queueStatus.rfqLoad.stats.loadingCount || 0) > 0 ? 'warning' : 'ok'}">
            ${queueStatus.rfqLoad.stats.pendingCount || 0}/${queueStatus.rfqLoad.stats.loadingCount || 0} jobs
            (${((queueStatus.rfqLoad.stats.pendingLines || 0) + (queueStatus.rfqLoad.stats.loadingLines || 0)).toLocaleString()} lines)
          </span>
        </div>
        ${queueStatus.rfqLoad.loading.length > 0 ? `
          <div style="font-size: 0.8em; color: #ff9f43; padding: 2px 0;">
            Loading: ${queueStatus.rfqLoad.loading.map(i => i.lineCount + ' lines').join(', ')}
          </div>
        ` : ''}
      </div>

      <!-- RFQ Enrichment -->
      <div style="margin-bottom: 12px; padding-top: 8px; border-top: 1px solid #2a3f5f;">
        <div style="color: #00d4ff; font-size: 0.9em; margin-bottom: 4px;">RFQ Enrichment (VQ/Pricing)</div>
        <div class="budget-row">
          <span class="budget-label">Backlog</span>
          <span class="budget-value ${(queueStatus.rfqEnrich.stats.pendingCount || 0) > 0 ? 'warning' : 'ok'}">
            ${queueStatus.rfqEnrich.stats.pendingCount || 0} RFQs (${(queueStatus.rfqEnrich.stats.pendingLines || 0).toLocaleString()} MPNs)
          </span>
        </div>
        ${queueStatus.rfqEnrich.pending.slice(0, 2).map(item => `
          <div style="font-size: 0.8em; color: #aaa; padding: 2px 0;">
            ${item.rfq_number} ${item.customer} — ${item.line_mpns} MPNs (${item.priority || 'P?'})
          </div>
        `).join('')}
      </div>

      <!-- Deferred API Retries -->
      <div style="margin-bottom: 12px; padding-top: 8px; border-top: 1px solid #2a3f5f;">
        <div style="color: #00d4ff; font-size: 0.9em; margin-bottom: 4px;">Deferred API Retries</div>
        <div class="budget-row">
          <span class="budget-label">Pending</span>
          <span class="budget-value ${queueStatus.deferredApi.pending > 100 ? 'warning' : 'ok'}">
            ${queueStatus.deferredApi.pending.toLocaleString()} items
          </span>
        </div>
        <div style="font-size: 0.8em; color: #666;">
          ${queueStatus.deferredApi.success.toLocaleString()} completed, ${queueStatus.deferredApi.failed} failed
        </div>
      </div>

      ${queueStatus.other.length > 0 ? `
        <div style="padding-top: 8px; border-top: 1px solid #2a3f5f;">
          <div style="color: #00d4ff; font-size: 0.9em; margin-bottom: 4px;">Other</div>
          ${queueStatus.other.map(q => `
            <div class="budget-row">
              <span class="budget-label">${q.name}</span>
              <span class="budget-value warning">${q.count}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div style="margin-top: 10px; font-size: 0.75em; color: #666;">
        RFQ Load 24h: ${queueStatus.rfqLoad.stats.completedLast24h || 0} jobs, ${(queueStatus.rfqLoad.stats.linesLast24h || 0).toLocaleString()} lines
      </div>
    </div>
  </div>

  <div class="chart-container">
    <div class="card-title">Daily Writes by Loader (2 Weeks)</div>
    <canvas id="dailyChart" height="100"></canvas>
    <div class="priority-legend">
      ${loaders.map(loader => `
        <div class="priority-item">
          <div class="priority-dot" style="background: ${loaderColors[loader]}"></div>
          <span class="priority-text">${loader} — ${loaderPriority[loader]}</span>
        </div>
      `).join('')}
    </div>
    <details style="margin-top: 15px;">
      <summary style="cursor: pointer; color: #00d4ff; font-size: 0.9em;">Table-Level Breakdown (7 days)</summary>
      <table class="limits-table" style="margin-top: 10px; font-size: 0.85em;">
        <tr><th>Table</th><th>Writes (7d)</th><th>Loader Group</th></tr>
        ${(() => {
          // Compute 7-day totals per table
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const tableTotals = {};
          dailyData.filter(d => d.day >= sevenDaysAgo).forEach(d => {
            tableTotals[d.table] = (tableTotals[d.table] || 0) + d.writes;
          });
          return Object.entries(tableTotals)
            .sort((a, b) => b[1] - a[1])
            .map(([table, writes]) => {
              const loader = Object.entries(loaderGroups).find(([name, tables]) => tables.includes(table))?.[0] || '?';
              return '<tr><td>' + table.replace('chuboe_', '') + '</td><td>' + writes.toLocaleString() + '</td><td>' + loader + '</td></tr>';
            }).join('');
        })()}
      </table>
    </details>
  </div>

  <div class="chart-container">
    <div class="card-title">Daily Total Writes + Rate Limit Events by Type</div>
    <canvas id="totalChart" height="80"></canvas>
  </div>

  <div class="chart-container">
    <div class="card-title">Hourly Writes (48h Detail)</div>
    <canvas id="hourlyChart" height="120"></canvas>
    <div style="margin-top: 10px; font-size: 0.85em; color: #888;">
      White line = total writes/hour. Colored fills = individual loaders. Red X = rate limit events hit.
    </div>
  </div>

  <h2 style="color: #ff6b6b; margin-top: 30px;">Rate Limit Events (${totalRateLimits} total in last 14 days)</h2>

  <div class="grid" style="margin-top: 15px;">
    <div class="card">
      <div class="card-title">Rate Limits by Type</div>
      <canvas id="rateLimitTypeChart" height="120"></canvas>
    </div>
    <div class="card">
      <div class="card-title">Rate Limits by Caller</div>
      <canvas id="rateLimitCallerChart" height="120"></canvas>
    </div>
  </div>

  <div class="card" style="margin-top: 20px;">
    <div class="card-title">Recent Rate Limit Events (Last 50)</div>
    <div style="overflow-x: auto;">
      <table class="limits-table">
        <tr>
          <th>Time (CT)</th>
          <th>Caller</th>
          <th>Priority</th>
          <th>Limit Type</th>
          <th>Requested</th>
          <th>Current/Limit</th>
        </tr>
        ${recentRateLimits.slice().reverse().map(e => `
          <tr>
            <td style="font-size: 0.85em;">${e.timestamp ? new Date(e.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?'}</td>
            <td>${e.caller || '?'}</td>
            <td>P${e.priority ?? '?'}</td>
            <td style="color: ${e.limitType?.includes('hard') ? '#ff6b6b' : '#ff9f43'}">${e.limitType || '?'}</td>
            <td>${e.requestedCount?.toLocaleString() || '?'}</td>
            <td>${e.current?.toLocaleString() || '?'} / ${e.limit?.toLocaleString() || '?'}</td>
          </tr>
        `).join('')}
        ${recentRateLimits.length === 0 ? '<tr><td colspan="6" style="text-align: center; color: #4ade80;">No rate limit events recorded yet</td></tr>' : ''}
      </table>
    </div>
  </div>

  <script>
    Chart.defaults.color = '#aaa';
    Chart.defaults.borderColor = '#2a3f5f';

    // Daily chart
    new Chart(document.getElementById('dailyChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(days.map(d => d.slice(5)))},
        datasets: ${JSON.stringify(dailyDatasets)}
      },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { position: 'top' } },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Writes' } }
        }
      }
    });

    // Daily totals with rate limit events by type
    new Chart(document.getElementById('totalChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(days.map(d => d.slice(5)))},
        datasets: [
          {
            label: 'Total Daily Writes',
            data: ${JSON.stringify(dailyTotals)},
            backgroundColor: '#00d4ff60',
            borderColor: '#00d4ff',
            borderWidth: 1,
            yAxisID: 'y'
          },
          ...${JSON.stringify(rateLimitTypeDatasets)}.map(ds => ({
            ...ds,
            type: 'line',
            yAxisID: 'y2'
          }))
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: {
          y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Writes' } },
          y2: { beginAtZero: true, position: 'right', title: { display: true, text: 'Rate Limits' }, grid: { drawOnChartArea: false } }
        }
      }
    });

    // Hourly chart - auto-scales to actual data
    new Chart(document.getElementById('hourlyChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(hours.map(h => h.slice(11, 16)))},
        datasets: [
          ...${JSON.stringify(hourlyDatasets)},
          {
            label: 'Total/Hour',
            data: ${JSON.stringify(hourlyTotals)},
            borderColor: '#ffffff',
            backgroundColor: 'transparent',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
            pointRadius: 0
          },
          {
            label: 'Rate Limit Events',
            data: ${JSON.stringify(rateLimitEventsPerHour)},
            borderColor: '#ff6b6b',
            backgroundColor: '#ff6b6b',
            pointRadius: 8,
            pointStyle: 'crossRot',
            showLine: false
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { position: 'top' } },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Writes/Hour' }
          }
        }
      }
    });

    // Rate limit events by caller
    new Chart(document.getElementById('rateLimitCallerChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(rateLimitCallerLabels)},
        datasets: [{
          label: 'Rate Limits',
          data: ${JSON.stringify(rateLimitCallerCounts)},
          backgroundColor: ['#ff6b6b', '#ff9f43', '#f9ca24', '#6ab04c', '#22a6b3', '#9c88ff'].slice(0, ${JSON.stringify(rateLimitCallerLabels)}.length)
        }]
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } }
      }
    });

    // Rate limit events by type
    new Chart(document.getElementById('rateLimitTypeChart'), {
      type: 'doughnut',
      data: {
        labels: ${JSON.stringify(rateLimitTypeLabels)},
        datasets: [{
          data: ${JSON.stringify(rateLimitTypeCounts)},
          backgroundColor: ['#ff6b6b', '#ff9f43', '#f9ca24', '#6ab04c', '#22a6b3', '#9c88ff', '#eb4d4b', '#7158e2']
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right' }
        }
      }
    });
  </script>
</body>
</html>`;

  return html;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log('Loading Chart.js...');
    const chartJsCode = await fetchChartJS();
    console.log(`  Loaded ${(chartJsCode.length / 1024).toFixed(0)} KB`);

    console.log('Querying historical writes...');
    const dailyData = getHistoricalWrites();
    console.log(`  Found ${dailyData.length} daily rows`);

    console.log('Querying hourly writes...');
    const hourlyData = getHourlyWrites();
    console.log(`  Found ${hourlyData.length} hourly rows`);

    console.log('Loading current budget state...');
    const budgetState = getCurrentBudgetState();
    console.log(`  Found ${(budgetState.writes || []).length} writes in budget file`);

    console.log('Loading rate limit history...');
    const rateLimitEvents = otBudget.getRateLimitHistory(14);
    console.log(`  Found ${rateLimitEvents.length} rate limit events`);

    console.log('Loading queue status...');
    const queueStatus = getQueueStatus();
    console.log(`  RFQ Load: ${queueStatus.rfqLoad.stats.pendingCount || 0} pending, ${queueStatus.rfqLoad.stats.loadingCount || 0} loading`);
    console.log(`  RFQ Enrich: ${queueStatus.rfqEnrich.stats.pendingCount || 0} pending (${queueStatus.rfqEnrich.stats.pendingLines || 0} MPNs)`);
    console.log(`  Deferred API: ${queueStatus.deferredApi.pending} pending, ${queueStatus.deferredApi.success} success`);

    console.log('Generating HTML...');
    const html = generateHTML(dailyData, hourlyData, budgetState, rateLimitEvents, chartJsCode, queueStatus);

    const outputPath = '/home/analytics_user/workspace/ot-api-budget-dashboard.html';
    fs.writeFileSync(outputPath, html);
    console.log(`\nDashboard written to: ${outputPath}`);
    console.log(`File size: ${(fs.statSync(outputPath).size / 1024).toFixed(0)} KB (self-contained, shareable)`);

  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
