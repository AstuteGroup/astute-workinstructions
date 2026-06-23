#!/usr/bin/env node
/**
 * Sales Pulse Daily - V5 Section 1 Only
 *
 * Testing Section 1: Global Snapshot with 5-day rolling averages
 * Incremental build - will add more sections after this works
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Execute a PostgreSQL query and return results
 */
function execQuery(sql) {
  try {
    const output = execSync(
      `psql idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return output.trim();
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
  }
}

/**
 * Parse single-row query result into object
 */
function parseRow(output, columnNames) {
  if (!output) return null;
  const values = output.split('|');
  const result = {};
  columnNames.forEach((name, i) => {
    result[name] = values[i] || null;
  });
  return result;
}

/**
 * Format date for email header
 */
function formatDate(date) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Format currency
 */
function formatCurrency(amount) {
  if (!amount || amount === '0' || amount === 0) return '$0';
  const num = parseFloat(amount);
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return '$' + (num / 1000).toFixed(0) + 'K';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Format change indicator
 */
function formatChange(value, isImprovement) {
  if (!value || value === 0) return '';
  const sign = value > 0 ? '↑' : '↓';
  const absVal = Math.abs(value);
  const icon = isImprovement ? '✅' : (Math.abs(value) > 10 ? '⚠️' : '');
  return `<span class="metric-change ${value > 0 ? 'up' : 'down'}">${sign} ${value > 0 ? '+' : ''}${absVal}% ${icon}</span>`;
}

/**
 * Collect Section 1 metrics
 */
async function collectSection1Metrics() {
  console.log('Collecting Section 1: Global Snapshot metrics...');
  const metrics = { pipelineInput: {}, quotingActivity: {}, wins: {}, systemDiscipline: {} };

  // Helper CTE that's reused in all queries
  const businessDaysCTE = `
    WITH RECURSIVE business_days_5 AS (
      SELECT CURRENT_DATE - 1 AS day, 1 AS day_count
      UNION ALL
      SELECT day - 1, day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
      FROM business_days_5 WHERE day_count < 5
    ),
    last_5_bdays AS (
      SELECT day FROM business_days_5
      WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
      ORDER BY day DESC LIMIT 5
    )
  `;

  // 1.1 RFQ Lines Entered
  const q11 = `${businessDaysCTE},
    yesterday AS (
      SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) AS lines, COUNT(DISTINCT r.c_bpartner_id) AS customers
      FROM adempiere.chuboe_rfq_line rl JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y' AND r.isactive = 'Y' AND rl.created::date = CURRENT_DATE - 1
    ),
    five_day AS (
      SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
      FROM (
        SELECT rl.created::date, COUNT(DISTINCT rl.chuboe_rfq_line_id) AS daily_lines
        FROM adempiere.chuboe_rfq_line rl JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
        CROSS JOIN last_5_bdays bd
        WHERE rl.isactive = 'Y' AND r.isactive = 'Y' AND rl.created::date IN (SELECT day FROM last_5_bdays)
        GROUP BY rl.created::date
      ) daily
    )
    SELECT y.lines, y.customers, f.avg_lines, ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
    FROM yesterday y CROSS JOIN five_day f;
  `;
  const rfqData = parseRow(execQuery(q11), ['lines', 'customers', 'avg_lines', 'pct_change']);
  metrics.pipelineInput.rfqLines = parseInt(rfqData.lines) || 0;
  metrics.pipelineInput.rfqCustomers = parseInt(rfqData.customers) || 0;
  metrics.pipelineInput.rfqAvg = parseFloat(rfqData.avg_lines) || 0;
  metrics.pipelineInput.rfqChange = parseFloat(rfqData.pct_change) || 0;

  // 1.2 RFQ Lines with Response
  const q12 = `${businessDaysCTE},
    yesterday AS (
      SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) AS total_lines,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_vq_line vq
          WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND vq.isactive = 'Y'
        ) THEN rl.chuboe_rfq_line_id END) AS with_response
      FROM adempiere.chuboe_rfq_line rl JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y' AND r.isactive = 'Y' AND rl.created::date = CURRENT_DATE - 1
    ),
    five_day AS (
      SELECT ROUND(AVG(daily_response)::numeric, 1) AS avg_response
      FROM (
        SELECT rl.created::date, COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_vq_line vq
          WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND vq.isactive = 'Y'
        ) THEN rl.chuboe_rfq_line_id END) AS daily_response
        FROM adempiere.chuboe_rfq_line rl JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
        CROSS JOIN last_5_bdays bd
        WHERE rl.isactive = 'Y' AND r.isactive = 'Y' AND rl.created::date IN (SELECT day FROM last_5_bdays)
        GROUP BY rl.created::date
      ) daily
    )
    SELECT y.with_response, ROUND(100.0 * y.with_response / NULLIF(y.total_lines, 0), 1) AS pct,
      f.avg_response, ROUND(100.0 * (y.with_response - f.avg_response) / NULLIF(f.avg_response, 0), 1) AS pct_change
    FROM yesterday y CROSS JOIN five_day f;
  `;
  const respData = parseRow(execQuery(q12), ['with_response', 'pct', 'avg_response', 'pct_change']);
  metrics.pipelineInput.responseLines = parseInt(respData.with_response) || 0;
  metrics.pipelineInput.responsePct = parseFloat(respData.pct) || 0;
  metrics.pipelineInput.responseAvg = parseFloat(respData.avg_response) || 0;
  metrics.pipelineInput.responseChange = parseFloat(respData.pct_change) || 0;

  // 2.1 CQ Lines Entered
  const q21 = `${businessDaysCTE},
    yesterday AS (
      SELECT COUNT(DISTINCT cq.chuboe_cq_line_id) AS lines, COUNT(DISTINCT cq.c_bpartner_id) AS customers
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y' AND cq.created::date = CURRENT_DATE - 1
    ),
    five_day AS (
      SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
      FROM (
        SELECT cq.created::date, COUNT(DISTINCT cq.chuboe_cq_line_id) AS daily_lines
        FROM adempiere.chuboe_cq_line cq CROSS JOIN last_5_bdays bd
        WHERE cq.isactive = 'Y' AND cq.created::date IN (SELECT day FROM last_5_bdays)
        GROUP BY cq.created::date
      ) daily
    )
    SELECT y.lines, y.customers, f.avg_lines, ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
    FROM yesterday y CROSS JOIN five_day f;
  `;
  const cqData = parseRow(execQuery(q21), ['lines', 'customers', 'avg_lines', 'pct_change']);
  metrics.quotingActivity.cqLines = parseInt(cqData.lines) || 0;
  metrics.quotingActivity.cqCustomers = parseInt(cqData.customers) || 0;
  metrics.quotingActivity.cqAvg = parseFloat(cqData.avg_lines) || 0;
  metrics.quotingActivity.cqChange = parseFloat(cqData.pct_change) || 0;

  // 2.2 CQ Lines Sold
  const q22 = `${businessDaysCTE},
    yesterday AS (
      SELECT COUNT(DISTINCT cq.chuboe_cq_line_id) AS lines
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y' AND cq.issold = 'Y' AND cq.updated::date = CURRENT_DATE - 1
    ),
    five_day AS (
      SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
      FROM (
        SELECT cq.updated::date, COUNT(DISTINCT cq.chuboe_cq_line_id) AS daily_lines
        FROM adempiere.chuboe_cq_line cq CROSS JOIN last_5_bdays bd
        WHERE cq.isactive = 'Y' AND cq.issold = 'Y' AND cq.updated::date IN (SELECT day FROM last_5_bdays)
        GROUP BY cq.updated::date
      ) daily
    )
    SELECT y.lines, f.avg_lines, ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
    FROM yesterday y CROSS JOIN five_day f;
  `;
  const cqSoldData = parseRow(execQuery(q22), ['lines', 'avg_lines', 'pct_change']);
  metrics.quotingActivity.cqSold = parseInt(cqSoldData.lines) || 0;
  metrics.quotingActivity.cqSoldAvg = parseFloat(cqSoldData.avg_lines) || 0;
  metrics.quotingActivity.cqSoldChange = parseFloat(cqSoldData.pct_change) || 0;

  // 2.3 Avg Quote Age - Short Cycle
  const q23 = `${businessDaysCTE},
    short_cycle_types AS (SELECT chuboe_rfq_type_id FROM (VALUES (1000000), (1000001), (1000007)) AS t(chuboe_rfq_type_id)),
    yesterday_age AS (
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (CURRENT_DATE - cq.created)) / 86400)::numeric, 1) AS avg_days
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y' AND cq.issold = 'N'
        AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM short_cycle_types)
        AND (
          (r.chuboe_rfq_type_id = 1000001 AND cq.created >= CURRENT_DATE - 10) OR
          (r.chuboe_rfq_type_id = 1000007 AND cq.created >= CURRENT_DATE - 15) OR
          (r.chuboe_rfq_type_id = 1000000 AND cq.created >= CURRENT_DATE - 30)
        )
    ),
    five_day_avg AS (
      SELECT ROUND(AVG(daily_avg)::numeric, 1) AS avg_days
      FROM (
        SELECT bd.day, AVG(EXTRACT(EPOCH FROM (bd.day - cq.created)) / 86400) AS daily_avg
        FROM adempiere.chuboe_cq_line cq
        JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
        JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
        CROSS JOIN last_5_bdays bd
        WHERE cq.isactive = 'Y' AND cq.issold = 'N'
          AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM short_cycle_types)
          AND cq.created < bd.day
          AND (
            (r.chuboe_rfq_type_id = 1000001 AND cq.created >= bd.day - 10) OR
            (r.chuboe_rfq_type_id = 1000007 AND cq.created >= bd.day - 15) OR
            (r.chuboe_rfq_type_id = 1000000 AND cq.created >= bd.day - 30)
          )
        GROUP BY bd.day
      ) daily
    )
    SELECT COALESCE(y.avg_days, 0) AS yesterday_days, COALESCE(f.avg_days, 0) AS five_day_days,
      ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
    FROM yesterday_age y CROSS JOIN five_day_avg f;
  `;
  const shortCycleData = parseRow(execQuery(q23), ['yesterday_days', 'five_day_days', 'pct_change']);
  metrics.quotingActivity.shortCycleDays = parseFloat(shortCycleData.yesterday_days) || 0;
  metrics.quotingActivity.shortCycleAvg = parseFloat(shortCycleData.five_day_days) || 0;
  metrics.quotingActivity.shortCycleChange = parseFloat(shortCycleData.pct_change) || 0;

  // 2.4 Avg Quote Age - Long Cycle
  const q24 = `${businessDaysCTE},
    long_cycle_types AS (SELECT chuboe_rfq_type_id FROM (VALUES (1000003)) AS t(chuboe_rfq_type_id)),
    yesterday_age AS (
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (CURRENT_DATE - cq.created)) / 86400)::numeric, 1) AS avg_days
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y' AND cq.issold = 'N'
        AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM long_cycle_types)
        AND cq.created >= CURRENT_DATE - 64
    ),
    five_day_avg AS (
      SELECT ROUND(AVG(daily_avg)::numeric, 1) AS avg_days
      FROM (
        SELECT bd.day, AVG(EXTRACT(EPOCH FROM (bd.day - cq.created)) / 86400) AS daily_avg
        FROM adempiere.chuboe_cq_line cq
        JOIN adempiere.chuboe_rfq_line rl ON cq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
        JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
        CROSS JOIN last_5_bdays bd
        WHERE cq.isactive = 'Y' AND cq.issold = 'N'
          AND r.chuboe_rfq_type_id IN (SELECT chuboe_rfq_type_id FROM long_cycle_types)
          AND cq.created < bd.day AND cq.created >= bd.day - 64
        GROUP BY bd.day
      ) daily
    )
    SELECT COALESCE(y.avg_days, 0) AS yesterday_days, COALESCE(f.avg_days, 0) AS five_day_days,
      ROUND(100.0 * (COALESCE(y.avg_days, 0) - COALESCE(f.avg_days, 0)) / NULLIF(COALESCE(f.avg_days, 1), 0), 1) AS pct_change
    FROM yesterday_age y CROSS JOIN five_day_avg f;
  `;
  const longCycleData = parseRow(execQuery(q24), ['yesterday_days', 'five_day_days', 'pct_change']);
  metrics.quotingActivity.longCycleDays = parseFloat(longCycleData.yesterday_days) || 0;
  metrics.quotingActivity.longCycleAvg = parseFloat(longCycleData.five_day_days) || 0;
  metrics.quotingActivity.longCycleChange = parseFloat(longCycleData.pct_change) || 0;

  // 3.1 SO Lines Booked
  const q31 = `${businessDaysCTE},
    yesterday AS (
      SELECT COUNT(DISTINCT ol.c_orderline_id) AS lines
      FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y' AND o.dateordered::date = CURRENT_DATE - 1
    ),
    five_day AS (
      SELECT ROUND(AVG(daily_lines)::numeric, 1) AS avg_lines
      FROM (
        SELECT o.dateordered::date, COUNT(DISTINCT ol.c_orderline_id) AS daily_lines
        FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
        CROSS JOIN last_5_bdays bd
        WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y' AND o.dateordered::date IN (SELECT day FROM last_5_bdays)
        GROUP BY o.dateordered::date
      ) daily
    )
    SELECT y.lines, f.avg_lines, ROUND(100.0 * (y.lines - f.avg_lines) / NULLIF(f.avg_lines, 0), 1) AS pct_change
    FROM yesterday y CROSS JOIN five_day f;
  `;
  const soData = parseRow(execQuery(q31), ['lines', 'avg_lines', 'pct_change']);
  metrics.wins.soLines = parseInt(soData.lines) || 0;
  metrics.wins.soAvg = parseFloat(soData.avg_lines) || 0;
  metrics.wins.soChange = parseFloat(soData.pct_change) || 0;

  // 3.2 $ Booked
  const q32 = `${businessDaysCTE},
    yesterday AS (
      SELECT ROUND(SUM(ol.linenetamt)::numeric, 2) AS amount
      FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y' AND o.dateordered::date = CURRENT_DATE - 1
    ),
    five_day AS (
      SELECT ROUND(AVG(daily_amount)::numeric, 2) AS avg_amount
      FROM (
        SELECT o.dateordered::date, SUM(ol.linenetamt) AS daily_amount
        FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
        CROSS JOIN last_5_bdays bd
        WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y' AND o.dateordered::date IN (SELECT day FROM last_5_bdays)
        GROUP BY o.dateordered::date
      ) daily
    )
    SELECT y.amount, f.avg_amount, ROUND(100.0 * (y.amount - f.avg_amount) / NULLIF(f.avg_amount, 0), 1) AS pct_change
    FROM yesterday y CROSS JOIN five_day f;
  `;
  const amountData = parseRow(execQuery(q32), ['amount', 'avg_amount', 'pct_change']);
  metrics.wins.amount = parseFloat(amountData.amount) || 0;
  metrics.wins.amountAvg = parseFloat(amountData.avg_amount) || 0;
  metrics.wins.amountChange = parseFloat(amountData.pct_change) || 0;

  // 4.1 CQs within 2hrs
  const q41 = `${businessDaysCTE},
    sold_yesterday AS (
      SELECT cq.chuboe_cq_line_id, cq.created AS cq_created, cq.updated AS sold_at
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y' AND cq.issold = 'Y' AND cq.updated::date = CURRENT_DATE - 1
    ),
    yesterday_stats AS (
      SELECT COUNT(*) AS total_sold,
        COUNT(CASE WHEN cq_created <= sold_at AND EXTRACT(EPOCH FROM (sold_at - cq_created)) / 3600 <= 2 THEN 1 END) AS within_2hrs
      FROM sold_yesterday
    ),
    five_day_avg AS (
      SELECT ROUND(AVG(daily_pct)::numeric, 1) AS avg_pct
      FROM (
        SELECT cq.updated::date,
          100.0 * COUNT(CASE WHEN cq.created <= cq.updated AND EXTRACT(EPOCH FROM (cq.updated - cq.created)) / 3600 <= 2 THEN 1 END) / NULLIF(COUNT(*), 0) AS daily_pct
        FROM adempiere.chuboe_cq_line cq CROSS JOIN last_5_bdays bd
        WHERE cq.isactive = 'Y' AND cq.issold = 'Y' AND cq.updated::date IN (SELECT day FROM last_5_bdays)
        GROUP BY cq.updated::date
      ) daily
    )
    SELECT ys.total_sold, ys.within_2hrs, ROUND(100.0 * ys.within_2hrs / NULLIF(ys.total_sold, 0), 1) AS yesterday_pct,
      f.avg_pct, ROUND((100.0 * ys.within_2hrs / NULLIF(ys.total_sold, 0)) - f.avg_pct, 1) AS pts_change
    FROM yesterday_stats ys CROSS JOIN five_day_avg f;
  `;
  const within2Data = parseRow(execQuery(q41), ['total_sold', 'within_2hrs', 'yesterday_pct', 'avg_pct', 'pts_change']);
  metrics.systemDiscipline.totalSold = parseInt(within2Data.total_sold) || 0;
  metrics.systemDiscipline.within2hrs = parseInt(within2Data.within_2hrs) || 0;
  metrics.systemDiscipline.within2hrsPct = parseFloat(within2Data.yesterday_pct) || 0;
  metrics.systemDiscipline.within2hrsAvg = parseFloat(within2Data.avg_pct) || 0;
  metrics.systemDiscipline.within2hrsChange = parseFloat(within2Data.pts_change) || 0;

  // 4.2 Retroactive CQ entry
  const q42 = `${businessDaysCTE},
    sold_yesterday AS (
      SELECT cq.chuboe_cq_line_id, cq.created AS cq_created, cq.updated AS sold_at
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y' AND cq.issold = 'Y' AND cq.updated::date = CURRENT_DATE - 1
    ),
    yesterday_stats AS (
      SELECT COUNT(*) AS total_sold, COUNT(CASE WHEN cq_created > sold_at THEN 1 END) AS retroactive
      FROM sold_yesterday
    ),
    five_day_avg AS (
      SELECT ROUND(AVG(daily_pct)::numeric, 1) AS avg_pct
      FROM (
        SELECT cq.updated::date,
          100.0 * COUNT(CASE WHEN cq.created > cq.updated THEN 1 END) / NULLIF(COUNT(*), 0) AS daily_pct
        FROM adempiere.chuboe_cq_line cq CROSS JOIN last_5_bdays bd
        WHERE cq.isactive = 'Y' AND cq.issold = 'Y' AND cq.updated::date IN (SELECT day FROM last_5_bdays)
        GROUP BY cq.updated::date
      ) daily
    )
    SELECT ys.retroactive, ROUND(100.0 * ys.retroactive / NULLIF(ys.total_sold, 0), 1) AS yesterday_pct,
      f.avg_pct, ROUND((100.0 * ys.retroactive / NULLIF(ys.total_sold, 0)) - f.avg_pct, 1) AS pts_change
    FROM yesterday_stats ys CROSS JOIN five_day_avg f;
  `;
  const retroData = parseRow(execQuery(q42), ['retroactive', 'yesterday_pct', 'avg_pct', 'pts_change']);
  metrics.systemDiscipline.retroactive = parseInt(retroData.retroactive) || 0;
  metrics.systemDiscipline.retroactivePct = parseFloat(retroData.yesterday_pct) || 0;
  metrics.systemDiscipline.retroactiveAvg = parseFloat(retroData.avg_pct) || 0;
  metrics.systemDiscipline.retroactiveChange = parseFloat(retroData.pts_change) || 0;

  console.log('Section 1 (all subsections) metrics collected');
  return metrics;
}

/**
 * Build Section 1 HTML
 */
function buildSection1HTML(metrics) {
  const m = metrics;
  return `
    <!-- GLOBAL SNAPSHOT -->
    <div class="section">
      <div class="section-title">Global Snapshot — Yesterday vs. 5-Day Rolling Avg</div>

      <!-- PIPELINE INPUT -->
      <div class="subsection">
        <div class="subsection-title">Pipeline Input</div>
        <div class="metric-row">
          <div class="metric-label">RFQ Lines Entered in OT</div>
          <div>
            <span class="metric-value">${m.pipelineInput.rfqLines} lines (${m.pipelineInput.rfqCustomers} customers)</span>
            <span class="metric-change">5-day avg: ${m.pipelineInput.rfqAvg}</span>
            ${formatChange(m.pipelineInput.rfqChange, m.pipelineInput.rfqChange > 0)}
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-label">RFQ Lines with 1+ Response (VQ or No-Bid)</div>
          <div>
            <span class="metric-value">${m.pipelineInput.responseLines} lines (${m.pipelineInput.responsePct}% sourced)</span>
            <span class="metric-change">5-day avg: ${m.pipelineInput.responseAvg}</span>
            ${formatChange(m.pipelineInput.responseChange, m.pipelineInput.responseChange > 0)}
          </div>
        </div>
      </div>

      <!-- QUOTING ACTIVITY -->
      <div class="subsection">
        <div class="subsection-title">Quoting Activity</div>
        <div class="metric-row">
          <div class="metric-label">CQ Lines Entered in OT</div>
          <div>
            <span class="metric-value">${m.quotingActivity.cqLines} lines (${m.quotingActivity.cqCustomers} customers)</span>
            <span class="metric-change">5-day avg: ${m.quotingActivity.cqAvg}</span>
            ${formatChange(m.quotingActivity.cqChange, m.quotingActivity.cqChange > 0)}
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-label">CQ Lines Selected as 'Sold'</div>
          <div>
            <span class="metric-value">${m.quotingActivity.cqSold} lines</span>
            <span class="metric-change">5-day avg: ${m.quotingActivity.cqSoldAvg}</span>
            ${formatChange(m.quotingActivity.cqSoldChange, m.quotingActivity.cqSoldChange > 0)}
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-label">Avg Quote Age - Short-cycle (Shortage/PPV/Stock)</div>
          <div>
            <span class="metric-value">${m.quotingActivity.shortCycleDays} days</span>
            <span class="metric-change">5-day avg: ${m.quotingActivity.shortCycleAvg}d</span>
            <span class="metric-change ${m.quotingActivity.shortCycleChange > 0 ? 'warning' : 'up'}">${m.quotingActivity.shortCycleChange > 0 ? '⚠️' : '✅'} ${m.quotingActivity.shortCycleChange > 0 ? '+' : ''}${m.quotingActivity.shortCycleChange}%</span>
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-label">Avg Quote Age - Long-cycle (EOL/LTB)</div>
          <div>
            <span class="metric-value">${m.quotingActivity.longCycleDays} days</span>
            <span class="metric-change">5-day avg: ${m.quotingActivity.longCycleAvg}d</span>
            <span class="metric-change ${m.quotingActivity.longCycleChange > 0 ? 'warning' : 'up'}">${m.quotingActivity.longCycleChange > 0 ? '⚠️' : '✅'} ${m.quotingActivity.longCycleChange > 0 ? '+' : ''}${m.quotingActivity.longCycleChange}%</span>
          </div>
        </div>
        <div class="footnote">
          * Short-cycle: Shortage (10d auto-close), PPV/Cost Saving (15d), Stock (30d)<br>
          * Long-cycle: EOL/LTB (64d auto-close)
        </div>
      </div>

      <!-- WINS -->
      <div class="subsection">
        <div class="subsection-title">Wins</div>
        <div class="metric-row">
          <div class="metric-label">SO Lines Booked</div>
          <div>
            <span class="metric-value">${m.wins.soLines} lines</span>
            <span class="metric-change">5-day avg: ${m.wins.soAvg}</span>
            ${formatChange(m.wins.soChange, m.wins.soChange > 0)}
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-label">$ Booked</div>
          <div>
            <span class="metric-value">${formatCurrency(m.wins.amount)}</span>
            <span class="metric-change">5-day avg: ${formatCurrency(m.wins.amountAvg)}</span>
            ${formatChange(m.wins.amountChange, m.wins.amountChange > 0)}
          </div>
        </div>
      </div>

      <!-- SYSTEM DISCIPLINE -->
      <div class="subsection">
        <div class="subsection-title">System Discipline</div>
        <div class="metric-row">
          <div class="metric-label">CQs entered within 2hrs of marking 'sold'</div>
          <div>
            <span class="metric-value">${m.systemDiscipline.within2hrs} of ${m.systemDiscipline.totalSold} (${m.systemDiscipline.within2hrsPct}%)</span>
            <span class="metric-change">5-day avg: ${m.systemDiscipline.within2hrsAvg}%</span>
            <span class="metric-change ${m.systemDiscipline.within2hrsChange < 0 ? 'down' : 'up'}">${m.systemDiscipline.within2hrsChange > 0 ? '↑' : '↓'} ${m.systemDiscipline.within2hrsChange > 0 ? '+' : ''}${m.systemDiscipline.within2hrsChange}pts</span>
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-label">Retroactive CQ entry rate (entered after sold)</div>
          <div>
            <span class="metric-value">${m.systemDiscipline.retroactivePct}%</span>
            <span class="metric-change">5-day avg: ${m.systemDiscipline.retroactiveAvg}%</span>
            <span class="metric-change ${m.systemDiscipline.retroactiveChange > 0 ? 'warning' : 'up'}">${m.systemDiscipline.retroactiveChange > 0 ? '⚠️' : '✅'} ${m.systemDiscipline.retroactiveChange > 0 ? '+' : ''}${m.systemDiscipline.retroactiveChange}pts</span>
          </div>
        </div>
        <div class="footnote">
          Note: These numbers reflect OT activity only. Actual pipeline may be higher due to off-system work.
        </div>
      </div>

    </div>
  `;
}

/**
 * Build complete HTML email
 */
function buildEmail(metrics) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const html = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #333; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
  .container { background: white; padding: 24px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px 0; color: #1a1a1a; }
  .subtitle { font-size: 11px; color: #666; margin-bottom: 20px; }
  .section { margin-bottom: 24px; padding-bottom: 24px; border-bottom: 2px solid #e0e0e0; }
  .section:last-child { border-bottom: none; }
  .section-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #1a1a1a; }
  .subsection { margin-bottom: 16px; }
  .subsection-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #e0e0e0; }
  .metric-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
  .metric-row:last-child { border-bottom: none; }
  .metric-label { font-size: 13px; color: #333; }
  .metric-value { font-size: 13px; font-weight: 600; color: #1a1a1a; }
  .metric-change { font-size: 12px; margin-left: 12px; }
  .up { color: #16a34a; }
  .down { color: #dc2626; }
  .footnote { font-size: 11px; color: #999; margin-top: 8px; font-style: italic; }
  .footer { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #999; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>📊 Sales Pulse — ${formatDate(today)}</h1>
  <div class="subtitle">Data as of 6:00am PT | Reflects activity through EOD ${formatDate(yesterday)}</div>

  ${buildSection1HTML(metrics)}

  <div class="footer">
    ✅ Section 1 (Global Snapshot) Complete - All 4 subsections, 11 metrics<br>
    Next: Section 2 (By Region), Section 3 (Yesterday's Wins), etc.
  </div>
</div>
</body>
</html>
  `;

  return html;
}

/**
 * Main execution
 */
async function main() {
  console.log('Sales Pulse V5 - Section 1 Test');

  try {
    const metrics = await collectSection1Metrics();

    const html = buildEmail(metrics);

    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `sales-pulse-v5-section1-${timestamp}.html`);
    const jsonPath = path.join(outputDir, `sales-pulse-v5-section1-${timestamp}.json`);

    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify(metrics, null, 2));

    console.log(`✅ Section 1 complete`);
    console.log(`HTML: ${htmlPath}`);
    console.log(`JSON: ${jsonPath}`);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { collectSection1Metrics, buildSection1HTML };
