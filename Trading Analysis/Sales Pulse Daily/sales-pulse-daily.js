#!/usr/bin/env node
/**
 * Sales Pulse Daily Digest
 *
 * Generates daily email digest tracking:
 * - Global Snapshot: Yesterday's pipeline activity (RFQ/VQ/CQ/SO)
 * - Buyer Queue Effectiveness: 3-day rolling response rate
 *
 * Runs: 6am PT daily, Mon-Fri
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const CLAUDE_HARRIS_ID = 1049524;

/**
 * Execute a PostgreSQL query and return results
 */
function execQuery(sql) {
  try {
    // Use -t (tuples only), -A (unaligned), -F'|' (pipe separator)
    const output = execSync(
      `psql idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8' }
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
 * Parse multi-row query result into array of objects
 */
function parseRows(output, columnNames) {
  if (!output) return [];
  return output.split('\n').map(line => {
    const values = line.split('|');
    const result = {};
    columnNames.forEach((name, i) => {
      result[name] = values[i] || null;
    });
    return result;
  });
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
  if (!amount || amount === '0') return '$0.00';
  return '$' + parseFloat(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/**
 * Collect all metrics from database
 */
async function collectMetrics() {
  console.log('Collecting metrics...');
  const metrics = {
    date: new Date(),
    global: {},
    buyerQueue: {},
    dailyBreakdown: []
  };

  try {
    // 1. RFQ Lines Entered Yesterday
    const q1 = `
      SELECT
        COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_lines_entered,
        COUNT(DISTINCT r.c_bpartner_id) AS distinct_customers
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y'
        AND r.isactive = 'Y'
        AND rl.created::date = CURRENT_DATE - 1;
    `;
    const rfqData = parseRow(execQuery(q1), ['rfq_lines_entered', 'distinct_customers']);
    metrics.global.rfqLinesEntered = parseInt(rfqData.rfq_lines_entered) || 0;
    metrics.global.rfqCustomers = parseInt(rfqData.distinct_customers) || 0;

    // 2. VQ Lines Loaded Yesterday
    const q2 = `
      SELECT
        COUNT(DISTINCT vq.chuboe_vq_line_id) AS vq_lines_loaded,
        COUNT(DISTINCT CASE WHEN vq.chuboe_buyer_id IS NOT NULL THEN vq.chuboe_vq_line_id END) AS with_buyer_assigned,
        COUNT(DISTINCT CASE WHEN vq.createdby = ${CLAUDE_HARRIS_ID} THEN vq.chuboe_vq_line_id END) AS claude_vqs,
        COUNT(DISTINCT CASE WHEN vq.chuboe_buyer_id IS NULL AND vq.createdby != ${CLAUDE_HARRIS_ID} THEN vq.chuboe_vq_line_id END) AS no_buyer_assigned
      FROM adempiere.chuboe_vq_line vq
      WHERE vq.isactive = 'Y'
        AND vq.created::date = CURRENT_DATE - 1;
    `;
    const vqData = parseRow(execQuery(q2), ['vq_lines_loaded', 'with_buyer_assigned', 'claude_vqs', 'no_buyer_assigned']);
    metrics.global.vqLinesLoaded = parseInt(vqData.vq_lines_loaded) || 0;
    metrics.global.vqWithBuyer = parseInt(vqData.with_buyer_assigned) || 0;
    metrics.global.vqClaude = parseInt(vqData.claude_vqs) || 0;
    metrics.global.vqNoBuyer = parseInt(vqData.no_buyer_assigned) || 0;

    // Calculate VQ-to-RFQ ratio
    if (metrics.global.rfqLinesEntered > 0) {
      metrics.global.vqToRfqRatio = Math.round((metrics.global.vqLinesLoaded / metrics.global.rfqLinesEntered) * 100);
    } else {
      metrics.global.vqToRfqRatio = 0;
    }

    // Calculate VQ percentages
    if (metrics.global.vqLinesLoaded > 0) {
      metrics.global.vqBuyerPct = Math.round((metrics.global.vqWithBuyer / metrics.global.vqLinesLoaded) * 1000) / 10;
      metrics.global.vqNoBuyerPct = Math.round((metrics.global.vqNoBuyer / metrics.global.vqLinesLoaded) * 1000) / 10;
    } else {
      metrics.global.vqBuyerPct = 0;
      metrics.global.vqNoBuyerPct = 0;
    }

    // 3. CQ Lines Entered Yesterday
    const q3 = `
      SELECT
        COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_entered,
        COUNT(DISTINCT cq.c_bpartner_id) AS distinct_customers
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y'
        AND cq.created::date = CURRENT_DATE - 1;
    `;
    const cqData = parseRow(execQuery(q3), ['cq_lines_entered', 'distinct_customers']);
    metrics.global.cqLinesEntered = parseInt(cqData.cq_lines_entered) || 0;

    // 4. CQ Lines Sold Yesterday
    const q4 = `
      SELECT
        COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_sold
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y'
        AND cq.issold = 'Y'
        AND cq.updated::date = CURRENT_DATE - 1;
    `;
    const cqSoldData = parseRow(execQuery(q4), ['cq_lines_sold']);
    metrics.global.cqLinesSold = parseInt(cqSoldData.cq_lines_sold) || 0;

    // Calculate CQ close rate
    if (metrics.global.cqLinesEntered > 0) {
      metrics.global.cqCloseRate = Math.round((metrics.global.cqLinesSold / metrics.global.cqLinesEntered) * 1000) / 10;
    } else {
      metrics.global.cqCloseRate = 0;
    }

    // 5. SO Lines Booked Yesterday
    const q5 = `
      SELECT
        COUNT(DISTINCT ol.c_orderline_id) AS so_lines_booked,
        ROUND(SUM(ol.linenetamt)::numeric, 2) AS total_booked
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y'
        AND o.isactive = 'Y'
        AND o.issotrx = 'Y'
        AND o.dateordered::date = CURRENT_DATE - 1;
    `;
    const soData = parseRow(execQuery(q5), ['so_lines_booked', 'total_booked']);
    metrics.global.soLinesBooked = parseInt(soData.so_lines_booked) || 0;
    metrics.global.soTotalBooked = parseFloat(soData.total_booked) || 0;

    // 6. Buyer Queue - Routed Lines (3-day)
    const q6 = `
      WITH RECURSIVE business_days AS (
        SELECT
          CURRENT_DATE - 1 AS day,
          1 AS day_count
        UNION ALL
        SELECT
          day - 1,
          day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
        FROM business_days
        WHERE day_count < 3
      ),
      last_3_bdays AS (
        SELECT day
        FROM business_days
        WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
        ORDER BY day DESC
        LIMIT 3
      )
      SELECT
        COUNT(DISTINCT rq.record_id) AS lines_routed_3day,
        MIN(bd.day) AS earliest_day,
        MAX(bd.day) AS latest_day
      FROM adempiere.r_request rq
      CROSS JOIN last_3_bdays bd
      WHERE rq.isactive = 'Y'
        AND rq.r_requesttype_id = 1000001
        AND rq.created::date IN (SELECT day FROM last_3_bdays);
    `;
    const routedData = parseRow(execQuery(q6), ['lines_routed_3day', 'earliest_day', 'latest_day']);
    metrics.buyerQueue.linesRouted = parseInt(routedData.lines_routed_3day) || 0;
    metrics.buyerQueue.earliestDay = routedData.earliest_day;
    metrics.buyerQueue.latestDay = routedData.latest_day;

    // 7. Buyer Queue - Response Rate
    const q7 = `
      WITH RECURSIVE business_days AS (
        SELECT
          CURRENT_DATE - 1 AS day,
          1 AS day_count
        UNION ALL
        SELECT
          day - 1,
          day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
        FROM business_days
        WHERE day_count < 3
      ),
      last_3_bdays AS (
        SELECT day
        FROM business_days
        WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
        ORDER BY day DESC
        LIMIT 3
      ),
      routed_3day AS (
        SELECT DISTINCT
          rq.record_id AS chuboe_rfq_line_id,
          rq.created AS routed_at
        FROM adempiere.r_request rq
        CROSS JOIN last_3_bdays bd
        WHERE rq.isactive = 'Y'
          AND rq.r_requesttype_id = 1000001
          AND rq.created::date IN (SELECT day FROM last_3_bdays)
      ),
      buyer_vqs AS (
        SELECT DISTINCT vq.chuboe_rfq_line_id
        FROM adempiere.chuboe_vq_line vq
        WHERE vq.isactive = 'Y'
          AND vq.chuboe_buyer_id IS NOT NULL
      )
      SELECT
        COUNT(DISTINCT r3.chuboe_rfq_line_id) AS total_routed,
        COUNT(DISTINCT CASE WHEN bv.chuboe_rfq_line_id IS NOT NULL THEN r3.chuboe_rfq_line_id END) AS with_buyer_vq,
        ROUND(
          100.0 * COUNT(DISTINCT CASE WHEN bv.chuboe_rfq_line_id IS NOT NULL THEN r3.chuboe_rfq_line_id END) /
          NULLIF(COUNT(DISTINCT r3.chuboe_rfq_line_id), 0),
          1
        ) AS buyer_response_pct
      FROM routed_3day r3
      LEFT JOIN buyer_vqs bv ON r3.chuboe_rfq_line_id = bv.chuboe_rfq_line_id;
    `;
    const responseData = parseRow(execQuery(q7), ['total_routed', 'with_buyer_vq', 'buyer_response_pct']);
    metrics.buyerQueue.totalRouted = parseInt(responseData.total_routed) || 0;
    metrics.buyerQueue.withBuyerVQ = parseInt(responseData.with_buyer_vq) || 0;
    metrics.buyerQueue.responsePct = parseFloat(responseData.buyer_response_pct) || 0;

    // 8. Avg Response Time
    const q8 = `
      WITH RECURSIVE business_days AS (
        SELECT
          CURRENT_DATE - 1 AS day,
          1 AS day_count
        UNION ALL
        SELECT
          day - 1,
          day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
        FROM business_days
        WHERE day_count < 3
      ),
      last_3_bdays AS (
        SELECT day
        FROM business_days
        WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
        ORDER BY day DESC
        LIMIT 3
      ),
      routed_3day AS (
        SELECT
          rq.record_id AS chuboe_rfq_line_id,
          rq.created AS routed_at
        FROM adempiere.r_request rq
        CROSS JOIN last_3_bdays bd
        WHERE rq.isactive = 'Y'
          AND rq.r_requesttype_id = 1000001
          AND rq.created::date IN (SELECT day FROM last_3_bdays)
      ),
      first_buyer_vq AS (
        SELECT
          vq.chuboe_rfq_line_id,
          MIN(vq.created) AS first_vq_at
        FROM adempiere.chuboe_vq_line vq
        WHERE vq.isactive = 'Y'
          AND vq.chuboe_buyer_id IS NOT NULL
        GROUP BY vq.chuboe_rfq_line_id
      )
      SELECT
        COUNT(*) AS responded_count,
        ROUND(AVG(EXTRACT(EPOCH FROM (fv.first_vq_at - r3.routed_at)) / 3600)::numeric, 2) AS avg_hrs_to_vq
      FROM routed_3day r3
      JOIN first_buyer_vq fv ON r3.chuboe_rfq_line_id = fv.chuboe_rfq_line_id
      WHERE fv.first_vq_at > r3.routed_at;
    `;
    const avgTimeData = parseRow(execQuery(q8), ['responded_count', 'avg_hrs_to_vq']);
    metrics.buyerQueue.avgResponseHrs = avgTimeData.avg_hrs_to_vq ? parseFloat(avgTimeData.avg_hrs_to_vq) : null;

    // 9. Lines Stuck >48hrs
    const q9 = `
      WITH RECURSIVE business_days AS (
        SELECT
          CURRENT_DATE - 1 AS day,
          1 AS day_count
        UNION ALL
        SELECT
          day - 1,
          day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
        FROM business_days
        WHERE day_count < 3
      ),
      last_3_bdays AS (
        SELECT day
        FROM business_days
        WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
        ORDER BY day DESC
        LIMIT 3
      ),
      routed_3day AS (
        SELECT
          rq.record_id AS chuboe_rfq_line_id,
          rq.created AS routed_at
        FROM adempiere.r_request rq
        CROSS JOIN last_3_bdays bd
        WHERE rq.isactive = 'Y'
          AND rq.r_requesttype_id = 1000001
          AND rq.created::date IN (SELECT day FROM last_3_bdays)
          AND rq.created < NOW() - INTERVAL '48 hours'
      ),
      buyer_vqs AS (
        SELECT DISTINCT vq.chuboe_rfq_line_id
        FROM adempiere.chuboe_vq_line vq
        WHERE vq.isactive = 'Y'
          AND vq.chuboe_buyer_id IS NOT NULL
      )
      SELECT
        COUNT(*) AS stuck_count,
        ROUND(100.0 * COUNT(*) / NULLIF((SELECT COUNT(*) FROM routed_3day), 0), 1) AS stuck_pct
      FROM routed_3day r3
      LEFT JOIN buyer_vqs bv ON r3.chuboe_rfq_line_id = bv.chuboe_rfq_line_id
      WHERE bv.chuboe_rfq_line_id IS NULL;
    `;
    const stuckData = parseRow(execQuery(q9), ['stuck_count', 'stuck_pct']);
    metrics.buyerQueue.stuckCount = parseInt(stuckData.stuck_count) || 0;
    metrics.buyerQueue.stuckPct = parseFloat(stuckData.stuck_pct) || 0;

    // 10. Daily Breakdown
    const q10 = `
      WITH RECURSIVE business_days AS (
        SELECT
          CURRENT_DATE - 1 AS day,
          1 AS day_count
        UNION ALL
        SELECT
          day - 1,
          day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
        FROM business_days
        WHERE day_count < 3
      ),
      last_3_bdays AS (
        SELECT day
        FROM business_days
        WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
        ORDER BY day DESC
        LIMIT 3
      ),
      routed_by_day AS (
        SELECT
          rq.created::date AS day,
          COUNT(DISTINCT rq.record_id) AS routed_count,
          COUNT(DISTINCT CASE
            WHEN EXISTS (
              SELECT 1 FROM adempiere.chuboe_vq_line vq
              WHERE vq.chuboe_rfq_line_id = rq.record_id
                AND vq.isactive = 'Y'
                AND vq.chuboe_buyer_id IS NOT NULL
            ) THEN rq.record_id
          END) AS responded_count
        FROM adempiere.r_request rq
        CROSS JOIN last_3_bdays bd
        WHERE rq.isactive = 'Y'
          AND rq.r_requesttype_id = 1000001
          AND rq.created::date IN (SELECT day FROM last_3_bdays)
        GROUP BY rq.created::date
      )
      SELECT
        day,
        routed_count,
        responded_count,
        ROUND(100.0 * responded_count / NULLIF(routed_count, 0), 1) AS response_pct
      FROM routed_by_day
      ORDER BY day;
    `;
    const dailyData = parseRows(execQuery(q10), ['day', 'routed_count', 'responded_count', 'response_pct']);
    metrics.dailyBreakdown = dailyData.map(row => ({
      day: row.day,
      routed: parseInt(row.routed_count) || 0,
      responded: parseInt(row.responded_count) || 0,
      responsePct: parseFloat(row.response_pct) || 0
    }));

    // Calculate trend
    if (metrics.dailyBreakdown.length >= 2) {
      const first = metrics.dailyBreakdown[0].responsePct;
      const last = metrics.dailyBreakdown[metrics.dailyBreakdown.length - 1].responsePct;
      metrics.buyerQueue.trend = Math.round((last - first) * 10) / 10;
      metrics.buyerQueue.trendDirection = metrics.buyerQueue.trend > 0 ? 'improving' :
                                          metrics.buyerQueue.trend < 0 ? 'declining' : 'flat';
    } else {
      metrics.buyerQueue.trend = 0;
      metrics.buyerQueue.trendDirection = 'flat';
    }

    // Calculate avg lines per day
    if (metrics.dailyBreakdown.length > 0) {
      const totalRouted = metrics.dailyBreakdown.reduce((sum, d) => sum + d.routed, 0);
      metrics.buyerQueue.avgPerDay = Math.round(totalRouted / metrics.dailyBreakdown.length);
    } else {
      metrics.buyerQueue.avgPerDay = 0;
    }

    console.log('Metrics collected successfully');
    return metrics;

  } catch (error) {
    console.error('Error collecting metrics:', error);
    throw error;
  }
}

/**
 * Build HTML email
 */
function buildEmail(metrics) {
  const yesterday = new Date(metrics.date);
  yesterday.setDate(yesterday.getDate() - 1);

  const headerDate = formatDate(metrics.date);
  const dataAsOf = formatDate(yesterday);

  // Format day names for breakdown
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dailyRows = metrics.dailyBreakdown.map(d => {
    const date = new Date(d.day);
    const dayName = dayNames[date.getDay()];
    const monthName = monthNames[date.getMonth()];
    return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${dayName} ${date.getMonth() + 1}/${date.getDate()}</td>
        <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e0e0e0;">${d.routed}</td>
        <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e0e0e0;">${d.responded}</td>
        <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e0e0e0; font-weight: ${d === metrics.dailyBreakdown[metrics.dailyBreakdown.length - 1] ? 'bold' : 'normal'};">${d.responsePct}%</td>
      </tr>
    `;
  }).join('');

  const trendIcon = metrics.buyerQueue.trendDirection === 'improving' ? '✅' :
                    metrics.buyerQueue.trendDirection === 'declining' ? '⚠️' : '➡️';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
    .container { max-width: 800px; margin: 20px auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
    .header p { margin: 8px 0 0 0; font-size: 14px; opacity: 0.9; }
    .section { padding: 24px; border-bottom: 1px solid #e0e0e0; }
    .section h2 { margin: 0 0 16px 0; font-size: 18px; color: #333; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 16px 0; }
    .metric { background: #f8f9fa; padding: 16px; border-radius: 8px; }
    .metric-label { font-size: 12px; color: #666; margin-bottom: 4px; }
    .metric-value { font-size: 24px; font-weight: 600; color: #333; }
    .metric-value.critical { color: #d32f2f; }
    .metric-value.warning { color: #f57c00; }
    .metric-value.good { color: #388e3c; }
    .insight-box { background: #fff3e0; border-left: 4px solid #ff9800; padding: 12px 16px; margin: 16px 0; border-radius: 4px; }
    .insight-box strong { color: #e65100; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th { background: #f8f9fa; padding: 8px; text-align: left; font-size: 12px; color: #666; border-bottom: 2px solid #e0e0e0; }
    td { padding: 8px; border-bottom: 1px solid #e0e0e0; }
    .footer { padding: 16px 24px; text-align: center; font-size: 12px; color: #666; background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Sales Pulse — ${headerDate}</h1>
      <p>Data as of 6:00am PT | Reflects activity through EOD ${dataAsOf}</p>
    </div>

    <!-- Global Snapshot -->
    <div class="section">
      <h2>📈 Global Snapshot — Yesterday's Activity</h2>

      <div class="metric-grid">
        <div class="metric">
          <div class="metric-label">RFQ Lines Entered</div>
          <div class="metric-value">${metrics.global.rfqLinesEntered}</div>
          <div class="metric-label">${metrics.global.rfqCustomers} customers</div>
        </div>
        <div class="metric">
          <div class="metric-label">VQ Lines Loaded</div>
          <div class="metric-value">${metrics.global.vqLinesLoaded}</div>
          <div class="metric-label">${metrics.global.vqToRfqRatio}% VQ-to-RFQ ratio</div>
        </div>
        <div class="metric">
          <div class="metric-label">CQ Lines Entered</div>
          <div class="metric-value">${metrics.global.cqLinesEntered}</div>
        </div>
        <div class="metric">
          <div class="metric-label">CQ Lines Sold</div>
          <div class="metric-value ${metrics.global.cqCloseRate >= 30 ? 'good' : 'warning'}">${metrics.global.cqLinesSold}</div>
          <div class="metric-label">${metrics.global.cqCloseRate}% close rate</div>
        </div>
        <div class="metric">
          <div class="metric-label">SO Lines Booked</div>
          <div class="metric-value">${metrics.global.soLinesBooked}</div>
          <div class="metric-label">${formatCurrency(metrics.global.soTotalBooked)}</div>
        </div>
      </div>

      <div class="insight-box">
        <strong>💡 Insights:</strong>
        <ul style="margin: 8px 0 0 0; padding-left: 20px;">
          <li><strong>${metrics.global.vqToRfqRatio}% VQ-to-RFQ ratio</strong> — ${metrics.global.vqToRfqRatio > 100 ? 'Buyers working on backlog' : 'Keeping up with new work'}</li>
          <li><strong>${metrics.global.vqBuyerPct}% of VQs buyer-assigned</strong> — Proper buyer credit</li>
          ${metrics.global.vqNoBuyerPct > 0 ? `<li><strong>${metrics.global.vqNoBuyerPct}% VQs no buyer</strong> — Possible seller self-sourcing</li>` : ''}
        </ul>
      </div>
    </div>

    <!-- Buyer Queue -->
    <div class="section">
      <h2>📦 Buyer Queue Effectiveness — Last 3 Business Days</h2>

      <div class="metric-grid">
        <div class="metric">
          <div class="metric-label">Lines Routed to Queue</div>
          <div class="metric-value">${metrics.buyerQueue.linesRouted}</div>
          <div class="metric-label">avg ${metrics.buyerQueue.avgPerDay}/day</div>
        </div>
        <div class="metric">
          <div class="metric-label">Buyer Response Rate</div>
          <div class="metric-value critical">${metrics.buyerQueue.responsePct}%</div>
          <div class="metric-label">${metrics.buyerQueue.withBuyerVQ} of ${metrics.buyerQueue.totalRouted} lines ${metrics.buyerQueue.responsePct < 5 ? '🔥 CRITICAL' : '⚠️'}</div>
        </div>
        ${metrics.buyerQueue.avgResponseHrs !== null ? `
        <div class="metric">
          <div class="metric-label">Avg Response Time</div>
          <div class="metric-value">${Math.round(metrics.buyerQueue.avgResponseHrs)}hrs</div>
          <div class="metric-label">${Math.round(metrics.buyerQueue.avgResponseHrs / 24 * 10) / 10} days</div>
        </div>
        ` : ''}
        <div class="metric">
          <div class="metric-label">Lines Stuck &gt;48hrs</div>
          <div class="metric-value ${metrics.buyerQueue.stuckPct > 50 ? 'critical' : 'warning'}">${metrics.buyerQueue.stuckCount}</div>
          <div class="metric-label">${metrics.buyerQueue.stuckPct}% ⚠️</div>
        </div>
      </div>

      <h3 style="font-size: 14px; margin: 24px 0 8px 0; color: #666;">Daily Breakdown</h3>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th style="text-align: right;">Routed</th>
            <th style="text-align: right;">Responded</th>
            <th style="text-align: right;">Rate</th>
          </tr>
        </thead>
        <tbody>
          ${dailyRows}
        </tbody>
      </table>

      <div class="insight-box">
        <strong>💡 Insight:</strong>
        <p style="margin: 8px 0 0 0;">
          <strong>${trendIcon} Trend: ${metrics.buyerQueue.trendDirection}</strong> ${Math.abs(metrics.buyerQueue.trend) > 0 ? `(${metrics.buyerQueue.trend > 0 ? '+' : ''}${metrics.buyerQueue.trend}pts)` : ''}
        </p>
        <p style="margin: 8px 0 0 0;">
          <strong>${100 - metrics.buyerQueue.responsePct}% of routed lines have no buyer response.</strong> This suggests:
        </p>
        <ul style="margin: 4px 0 0 0; padding-left: 20px;">
          <li>Buyers working outside queue system, OR</li>
          <li>Buyers not loading VQs into OT, OR</li>
          <li>Lines need reassignment to secondary buyers</li>
        </ul>
        ${metrics.buyerQueue.stuckCount > 0 ? `<p style="margin: 8px 0 0 0;"><strong>⚠️ Action needed:</strong> Review ${metrics.buyerQueue.stuckCount} lines stuck &gt;48hrs</p>` : ''}
      </div>
    </div>

    <div class="footer">
      <p>Questions? Reply to this email.</p>
      <p>Next digest: Monday 6:00am PT</p>
    </div>
  </div>
</body>
</html>
  `;

  return html;
}

/**
 * Send email via nodemailer
 */
async function sendEmail(html, metrics) {
  // Configure SMTP transport
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  // Recipients
  const recipients = process.env.RECIPIENTS || 'josh.pucci@astutegroup.com';

  const yesterday = new Date(metrics.date);
  yesterday.setDate(yesterday.getDate() - 1);
  const subjectDate = formatDate(yesterday);

  // Send email
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Sales Pulse" <noreply@astutegroup.com>',
    to: recipients,
    subject: `📊 Sales Pulse — ${subjectDate}`,
    html: html
  });

  console.log('Email sent:', info.messageId);
  return info;
}

/**
 * Main execution
 */
async function main() {
  console.log('Sales Pulse Daily - Starting...');

  try {
    // Collect metrics
    const metrics = await collectMetrics();

    // Build HTML
    const html = buildEmail(metrics);

    // Save output for debugging
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `sales-pulse-${timestamp}.html`);
    const jsonPath = path.join(outputDir, `sales-pulse-${timestamp}.json`);

    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify(metrics, null, 2));

    console.log(`HTML saved to: ${htmlPath}`);
    console.log(`Metrics saved to: ${jsonPath}`);

    // Send email (only if SMTP configured)
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await sendEmail(html, metrics);
      console.log('Email sent successfully');
    } else {
      console.log('⚠️  SMTP not configured - email not sent');
      console.log('   Set SMTP_USER, SMTP_PASS, SMTP_HOST in environment to enable');
    }

    console.log('✅ Sales Pulse Daily completed successfully');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { collectMetrics, buildEmail };
