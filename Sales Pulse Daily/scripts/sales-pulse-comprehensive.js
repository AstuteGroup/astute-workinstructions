#!/usr/bin/env node
/**
 * Sales Pulse Daily - V5 Comprehensive (All Sections)
 *
 * Section 1: Global Snapshot ✅
 * Section 2: By Region (in progress)
 * Section 3: Yesterday's Wins
 * Section 4: Needs Attention (5 alert types)
 * Section 5: Week-to-Date
 * Section 6: Market Pulse
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Regional seller mapping (based on actual salesrep data)
const SELLER_REGIONS = {
  'USA': [1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017], // Aaron M, Dan R, Jake M, James D, Josh S, Justin G, Michael S, Thomas H
  'MEX': [1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224], // Alejandro P, Alex P, Alfredo M, Carlos M, Carolina H, Joel F, Ricardo M, Salvador H
  'APAC-Laurel': [1041139, 1023803, 1016958], // Jasper K, Renald/Ray N, Laurel K (manager)
  'APAC-Kris': [1039414, 1009866, 1013042, 1009528, 1009478, 1009210], // James X, Joy/Rotsarin P, Spring T, Wing Z, Winnie L, Silvia M (manager)
  'APAC-Lavanya': [1024444, 1023478, 1017011] // Manikandan, Meenakshi, Lavanya M (manager)
};

// Flatten seller list for easy lookup
const SELLER_TO_REGION = {};
Object.entries(SELLER_REGIONS).forEach(([region, sellers]) => {
  sellers.forEach(sellerId => {
    SELLER_TO_REGION[sellerId] = region;
  });
});

/**
 * Execute PostgreSQL query
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
 * Parse single-row query result
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
 * Parse multi-row query results
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
 * Format date
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

// Import Section 1 functions
const section1Module = require('./sales-pulse-v5-section1.js');

/**
 * Collect Section 2: By Region metrics
 */
async function collectSection2Metrics() {
  console.log('Collecting Section 2: By Region metrics...');

  // Build seller ID lists for SQL
  const usaSellers = SELLER_REGIONS['USA'].join(',');
  const mexSellers = SELLER_REGIONS['MEX'].join(',');
  const apacLaurelSellers = SELLER_REGIONS['APAC-Laurel'].join(',');
  const apacKrisSellers = SELLER_REGIONS['APAC-Kris'].join(',');
  const apacLavanyaSellers = SELLER_REGIONS['APAC-Lavanya'].join(',');

  const regionalQuery = `
    WITH regional_data AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        rl.chuboe_rfq_line_id,
        rl.created AS rfq_created,
        r.salesrep_id
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y'
        AND r.isactive = 'Y'
        AND rl.created::date = CURRENT_DATE - 1
    ),
    response_times AS (
      SELECT
        rd.region,
        rd.chuboe_rfq_line_id,
        EXTRACT(EPOCH FROM (MIN(vq.created) - rd.rfq_created)) / 86400.0 AS response_days
      FROM regional_data rd
      JOIN adempiere.chuboe_vq_line vq ON vq.chuboe_rfq_line_id = rd.chuboe_rfq_line_id
      WHERE vq.isactive = 'Y'
      GROUP BY rd.region, rd.chuboe_rfq_line_id, rd.rfq_created
    ),
    cq_data AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        cq.chuboe_cq_line_id,
        cq.issold
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y'
        AND r.isactive = 'Y'
        AND cq.created::date = CURRENT_DATE - 1
    ),
    so_data AS (
      SELECT
        CASE
          WHEN o.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN o.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN o.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN o.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN o.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        ol.c_orderline_id
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y'
        AND o.isactive = 'Y'
        AND o.issotrx = 'Y'
        AND ol.created::date = CURRENT_DATE - 1
    ),
    quote_age AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        (CURRENT_DATE - 1) - cq.created::date AS age_days
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y'
        AND r.isactive = 'Y'
        AND cq.issold = 'N'
        AND r.chuboe_rfq_type_id IN (1000000, 1000001, 1000007)
        AND (
          (r.chuboe_rfq_type_id = 1000001 AND cq.created >= CURRENT_DATE - 10) OR
          (r.chuboe_rfq_type_id = 1000007 AND cq.created >= CURRENT_DATE - 15) OR
          (r.chuboe_rfq_type_id = 1000000 AND cq.created >= CURRENT_DATE - 30)
        )
    )
    SELECT
      rd.region,
      COUNT(DISTINCT rd.chuboe_rfq_line_id) AS rfq_lines,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_vq_line vq
          WHERE vq.chuboe_rfq_line_id = rd.chuboe_rfq_line_id AND vq.isactive = 'Y'
        ) THEN rd.chuboe_rfq_line_id
      END) AS with_response,
      ROUND(100.0 * COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_vq_line vq
          WHERE vq.chuboe_rfq_line_id = rd.chuboe_rfq_line_id AND vq.isactive = 'Y'
        ) THEN rd.chuboe_rfq_line_id
      END) / NULLIF(COUNT(DISTINCT rd.chuboe_rfq_line_id), 0), 1) AS response_pct,
      COALESCE(ROUND(AVG(rt.response_days), 1), 0) AS avg_response_days,
      COALESCE((SELECT COUNT(DISTINCT chuboe_cq_line_id) FROM cq_data WHERE region = rd.region), 0) AS cq_lines,
      COALESCE((SELECT COUNT(DISTINCT chuboe_cq_line_id) FROM cq_data WHERE region = rd.region AND issold = 'Y'), 0) AS cq_sold,
      COALESCE((SELECT COUNT(DISTINCT c_orderline_id) FROM so_data WHERE region = rd.region), 0) AS so_lines,
      COALESCE((SELECT ROUND(AVG(age_days), 1) FROM quote_age WHERE region = rd.region), 0) AS short_cycle_age
    FROM regional_data rd
    LEFT JOIN response_times rt ON rt.region = rd.region AND rt.chuboe_rfq_line_id = rd.chuboe_rfq_line_id
    WHERE rd.region != 'Other'
    GROUP BY rd.region
    ORDER BY
      CASE rd.region
        WHEN 'USA' THEN 1
        WHEN 'MEX' THEN 2
        WHEN 'APAC-Laurel' THEN 3
        WHEN 'APAC-Kris' THEN 4
        WHEN 'APAC-Lavanya' THEN 5
      END;
  `;

  const regionalData = parseRows(execQuery(regionalQuery),
    ['region', 'rfq_lines', 'with_response', 'response_pct', 'avg_response_days',
     'cq_lines', 'cq_sold', 'so_lines', 'short_cycle_age']);

  console.log('Section 2 metrics collected');
  return regionalData;
}

/**
 * Build Section 2 HTML
 */
function buildSection2HTML(regionalData) {
  // Calculate APAC total
  const apacData = regionalData.filter(r => r.region.startsWith('APAC'));
  const apacTotal = {
    rfq_lines: apacData.reduce((sum, r) => sum + parseInt(r.rfq_lines || 0), 0),
    with_response: apacData.reduce((sum, r) => sum + parseInt(r.with_response || 0), 0),
    cq_lines: apacData.reduce((sum, r) => sum + parseInt(r.cq_lines || 0), 0),
    cq_sold: apacData.reduce((sum, r) => sum + parseInt(r.cq_sold || 0), 0),
    so_lines: apacData.reduce((sum, r) => sum + parseInt(r.so_lines || 0), 0),
    total_response_days: apacData.reduce((sum, r) => sum + parseFloat(r.avg_response_days || 0), 0),
    short_cycle_age_total: apacData.reduce((sum, r) => sum + parseFloat(r.short_cycle_age || 0), 0)
  };
  apacTotal.response_pct = apacTotal.rfq_lines > 0 ?
    Math.round((apacTotal.with_response / apacTotal.rfq_lines) * 1000) / 10 : 0;
  apacTotal.avg_response_days = apacData.length > 0 ?
    Math.round((apacTotal.total_response_days / apacData.length) * 10) / 10 : 0;
  apacTotal.short_cycle_age = apacData.length > 0 ?
    Math.round((apacTotal.short_cycle_age_total / apacData.length) * 10) / 10 : 0;

  // Build subregion rows
  const subregionRows = apacData.map(r => `
    <tr class="subregion-row">
      <td>${r.region === 'APAC-Laurel' ? '↳ Laurel (SGP, 3)' :
            r.region === 'APAC-Kris' ? '↳ Silvia (PHL/China, 6)' :
            r.region === 'APAC-Lavanya' ? '↳ Lavanya (IND, 3)' : r.region}</td>
      <td>${r.rfq_lines}</td>
      <td>${r.with_response} (${r.response_pct}%)</td>
      <td>${r.avg_response_days}d</td>
      <td>${r.cq_lines}</td>
      <td>${r.cq_sold}</td>
      <td>${r.so_lines}</td>
      <td>${r.short_cycle_age}d</td>
    </tr>
  `).join('');

  // Get USA and MEX rows
  const usaRow = regionalData.find(r => r.region === 'USA');
  const mexRow = regionalData.find(r => r.region === 'MEX');

  return `
    <!-- BY REGION -->
    <div class="section">
      <div class="section-title">📍 By Region (Yesterday's Activity)</div>
      <div class="footnote" style="margin-bottom: 8px;">
        Seller counts reflect total team size, not just sellers active yesterday
      </div>
      <table>
        <thead>
          <tr>
            <th>Region, Sales Team Manager,<br>Active Sellers</th>
            <th>RFQ Lines<br>Entered</th>
            <th>RFQ Lines<br>w/ Response</th>
            <th>Total Resp.<br>Time</th>
            <th>CQ Lines<br>Entered</th>
            <th>CQ Lines<br>Sold</th>
            <th>SO Lines<br>Booked</th>
            <th>Quote Age<br>(Short)</th>
          </tr>
        </thead>
        <tbody>
          <tr class="region-row">
            <td><strong>USA</strong> (Jeff, 8)</td>
            <td>${usaRow ? usaRow.rfq_lines : 0}</td>
            <td>${usaRow ? usaRow.with_response + ' (' + usaRow.response_pct + '%)' : '0 (0%)'}</td>
            <td>${usaRow ? usaRow.avg_response_days + 'd' : '0d'}</td>
            <td>${usaRow ? usaRow.cq_lines : 0}</td>
            <td>${usaRow ? usaRow.cq_sold : 0}</td>
            <td>${usaRow ? usaRow.so_lines : 0}</td>
            <td>${usaRow ? usaRow.short_cycle_age + 'd' : '0d'}</td>
          </tr>
          <tr class="region-row">
            <td><strong>MEX</strong> (Joel, 8)</td>
            <td>${mexRow ? mexRow.rfq_lines : 0}</td>
            <td>${mexRow ? mexRow.with_response + ' (' + mexRow.response_pct + '%)' : '0 (0%)'}</td>
            <td>${mexRow ? mexRow.avg_response_days + 'd' : '0d'}</td>
            <td>${mexRow ? mexRow.cq_lines : 0}</td>
            <td>${mexRow ? mexRow.cq_sold : 0}</td>
            <td>${mexRow ? mexRow.so_lines : 0}</td>
            <td>${mexRow ? mexRow.short_cycle_age + 'd' : '0d'}</td>
          </tr>
          <tr class="region-row">
            <td><strong>APAC TOTAL</strong> (12)</td>
            <td>${apacTotal.rfq_lines}</td>
            <td>${apacTotal.with_response} (${apacTotal.response_pct}%)</td>
            <td>${apacTotal.avg_response_days}d</td>
            <td>${apacTotal.cq_lines}</td>
            <td>${apacTotal.cq_sold}</td>
            <td>${apacTotal.so_lines}</td>
            <td>${apacTotal.short_cycle_age}d</td>
          </tr>
          ${subregionRows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Collect Section 3: Yesterday's Wins
 */
async function collectSection3Metrics() {
  console.log('Collecting Section 3: Yesterday\'s Wins metrics...');

  // Build seller ID lists for SQL
  const usaSellers = SELLER_REGIONS['USA'].join(',');
  const mexSellers = SELLER_REGIONS['MEX'].join(',');
  const apacLaurelSellers = SELLER_REGIONS['APAC-Laurel'].join(',');
  const apacKrisSellers = SELLER_REGIONS['APAC-Kris'].join(',');
  const apacLavanyaSellers = SELLER_REGIONS['APAC-Lavanya'].join(',');

  const winsQuery = `
    WITH wins AS (
      SELECT
        CASE
          WHEN o.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN o.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN o.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN o.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN o.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        bp.name AS customer,
        u.name AS seller,
        ol.linenetamt AS amount,
        ol.c_orderline_id
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
      JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id
      WHERE ol.isactive = 'Y'
        AND o.isactive = 'Y'
        AND bp.isactive = 'Y'
        AND o.issotrx = 'Y'
        AND ol.created::date = CURRENT_DATE - 1
      ORDER BY region, amount DESC
    )
    SELECT
      region,
      customer,
      seller,
      COUNT(DISTINCT c_orderline_id) AS lines,
      SUM(amount) AS amount
    FROM wins
    WHERE region != 'Other'
    GROUP BY region, customer, seller
    ORDER BY region, amount DESC;
  `;

  const winsData = parseRows(execQuery(winsQuery), ['region', 'customer', 'seller', 'lines', 'amount']);

  console.log('Section 3 metrics collected');
  return winsData;
}

/**
 * Build Section 3 HTML
 */
function buildSection3HTML(winsData) {
  if (!winsData || winsData.length === 0) {
    return `
      <!-- YESTERDAY'S WINS -->
      <div class="section">
        <div class="section-title">🎉 Yesterday's Wins</div>
        <div class="footnote">No orders booked yesterday</div>
      </div>
    `;
  }

  // Group by region
  const usaWins = winsData.filter(w => w.region === 'USA');
  const mexWins = winsData.filter(w => w.region === 'MEX');
  const apacWins = winsData.filter(w => w.region.startsWith('APAC'));

  const buildRegionWins = (wins, regionName) => {
    if (wins.length === 0) return '';

    const totalLines = wins.reduce((sum, w) => sum + parseInt(w.lines), 0);
    const totalAmount = wins.reduce((sum, w) => sum + parseFloat(w.amount), 0);

    const items = wins.map(w =>
      `• ${w.customer} — ${w.lines} lines, ${formatCurrency(w.amount)}<br>
        &nbsp;&nbsp;Seller: ${w.seller}`
    ).join('<br>\n        ');

    return `
    <div class="win-item">
      <div class="win-title">✅ ${regionName}: ${formatCurrency(totalAmount)} across ${totalLines} lines</div>
      <div>
        ${items}
      </div>
    </div>`;
  };

  return `
    <!-- YESTERDAY'S WINS -->
    <div class="section">
      <div class="section-title">🎉 Yesterday's Wins</div>
      ${buildRegionWins(usaWins, 'USA')}
      ${buildRegionWins(mexWins, 'MEX')}
      ${buildRegionWins(apacWins, 'APAC')}
    </div>
  `;
}

/**
 * Collect Section 4: Needs Attention
 */
async function collectSection4Metrics() {
  console.log('Collecting Section 4: Needs Attention metrics...');

  // Build seller ID lists for SQL
  const usaSellers = SELLER_REGIONS['USA'].join(',');
  const mexSellers = SELLER_REGIONS['MEX'].join(',');
  const apacLaurelSellers = SELLER_REGIONS['APAC-Laurel'].join(',');
  const apacKrisSellers = SELLER_REGIONS['APAC-Kris'].join(',');
  const apacLavanyaSellers = SELLER_REGIONS['APAC-Lavanya'].join(',');

  // Alert 1: High-Value Quotes (>$10K, created in last 5 business days)
  const highValueQuery = `
    WITH RECURSIVE business_days_5 AS (
      SELECT CURRENT_DATE - 1 AS day, 1 AS day_count
      UNION ALL
      SELECT day - 1, day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
      FROM business_days_5 WHERE day_count <= 5
    ),
    last_5_bdays AS (
      SELECT day FROM business_days_5
      WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
      ORDER BY day DESC LIMIT 5
    )
    SELECT
      r.chuboe_rfq_id AS rfq_id,
      bp.name AS customer,
      SUM(cq.priceentered * cq.qty) AS quote_value,
      COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_line_count,
      MIN(CURRENT_DATE - cq.created::date) AS days_ago,
      rt.name AS rfq_type,
      u.name AS seller,
      CASE
        WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
        WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
        WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
        WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
        WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
        ELSE 'Other'
      END AS region
    FROM adempiere.chuboe_cq_line cq
    JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
    WHERE cq.isactive = 'Y'
      AND r.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND cq.created::date IN (SELECT day FROM last_5_bdays)
      AND cq.issold = 'N'
    GROUP BY r.chuboe_rfq_id, bp.name, rt.name, u.name, region
    HAVING SUM(cq.priceentered * cq.qty) > 10000
    ORDER BY quote_value DESC
    LIMIT 5;
  `;

  // Alert 2: High-Probability Customers (30-50% win rate, quoted in last 5 days)
  const highProbabilityQuery = `
    WITH RECURSIVE business_days_5 AS (
      SELECT CURRENT_DATE - 1 AS day, 1 AS day_count
      UNION ALL
      SELECT day - 1, day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
      FROM business_days_5 WHERE day_count <= 5
    ),
    last_5_bdays AS (
      SELECT day FROM business_days_5
      WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
      ORDER BY day DESC LIMIT 5
    ),
    customer_win_rates AS (
      SELECT
        r.c_bpartner_id,
        COUNT(DISTINCT cq.chuboe_cq_line_id) AS total_quotes,
        COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) AS wins,
        ROUND(100.0 * COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) /
              NULLIF(COUNT(DISTINCT cq.chuboe_cq_line_id), 0), 1) AS win_rate
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y' AND r.isactive = 'Y'
      GROUP BY r.c_bpartner_id
      HAVING COUNT(DISTINCT cq.chuboe_cq_line_id) >= 10
    ),
    recent_quotes AS (
      SELECT
        r.chuboe_rfq_id,
        r.c_bpartner_id,
        bp.name AS customer,
        SUM(cq.priceentered * cq.qty) AS quote_value,
        COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_line_count,
        MIN(CURRENT_DATE - cq.created::date) AS days_ago,
        rt.name AS rfq_type,
        u.name AS seller,
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
      JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
      JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
      WHERE cq.isactive = 'Y'
        AND r.isactive = 'Y'
        AND bp.isactive = 'Y'
        AND cq.created::date IN (SELECT day FROM last_5_bdays)
      GROUP BY r.chuboe_rfq_id, r.c_bpartner_id, bp.name, rt.name, u.name, region
    )
    SELECT
      rq.chuboe_rfq_id AS rfq_id,
      rq.customer,
      rq.quote_value,
      rq.cq_line_count,
      rq.days_ago,
      rq.rfq_type,
      rq.seller,
      rq.region,
      wr.win_rate
    FROM recent_quotes rq
    JOIN customer_win_rates wr ON rq.c_bpartner_id = wr.c_bpartner_id
    WHERE wr.win_rate BETWEEN 30 AND 50
      AND rq.region != 'Other'
    ORDER BY wr.win_rate DESC, rq.quote_value DESC
    LIMIT 5;
  `;

  // Alert 3: New Customer Opportunities (first-time RFQs, no quotes yet)
  const newCustomersQuery = `
    WITH RECURSIVE business_days_5 AS (
      SELECT CURRENT_DATE - 1 AS day, 1 AS day_count
      UNION ALL
      SELECT day - 1, day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
      FROM business_days_5 WHERE day_count <= 5
    ),
    last_5_bdays AS (
      SELECT day FROM business_days_5
      WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
      ORDER BY day DESC LIMIT 5
    )
    SELECT
      bp.name AS customer,
      COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_lines,
      MIN(CURRENT_DATE - rl.created::date) AS days_ago,
      u.name AS seller,
      CASE
        WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
        WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
        WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
        WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
        WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
        ELSE 'Other'
      END AS region
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
    WHERE rl.isactive = 'Y'
      AND r.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND rl.created::date IN (SELECT day FROM last_5_bdays)
      AND NOT EXISTS (
        SELECT 1 FROM adempiere.chuboe_cq_line cq
        JOIN adempiere.chuboe_rfq r2 ON cq.chuboe_rfq_id = r2.chuboe_rfq_id
        WHERE cq.isactive = 'Y'
          AND r2.isactive = 'Y'
          AND r2.c_bpartner_id = r.c_bpartner_id
      )
    GROUP BY bp.name, u.name,
      CASE
        WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
        WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
        WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
        WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
        WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
        ELSE 'Other'
      END
    HAVING CASE
      WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
      WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
      WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
      WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
      WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
      ELSE 'Other'
    END != 'Other'
    ORDER BY days_ago DESC, rfq_lines DESC
    LIMIT 5;
  `;

  // Alert 4: Pricing Benchmarks (last 30 days: 30+ lines quoted, <10% win rate)
  const pricingBenchmarksQuery = `
    SELECT
      bp.name AS customer,
      COUNT(DISTINCT cq.chuboe_cq_line_id) AS lines_quoted,
      COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) AS lines_won,
      ROUND(100.0 * COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) /
            NULLIF(COUNT(DISTINCT cq.chuboe_cq_line_id), 0), 1) AS win_rate
    FROM adempiere.chuboe_cq_line cq
    JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    WHERE cq.isactive = 'Y'
      AND r.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND cq.created::date >= CURRENT_DATE - 30
    GROUP BY bp.name
    HAVING COUNT(DISTINCT cq.chuboe_cq_line_id) >= 30
      AND ROUND(100.0 * COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) /
                NULLIF(COUNT(DISTINCT cq.chuboe_cq_line_id), 0), 1) < 10
    ORDER BY lines_quoted DESC
    LIMIT 5;
  `;

  // Alert 5: Sourcing Stuck (routed RFQ lines 3-5 days ago, no VQ response - matches V5 format)
  const sourcingStuckQuery = `
    WITH routed_rfqs AS (
      SELECT
        rq.record_id AS chuboe_rfq_line_id,
        rq.created AS routed_at,
        rq.ad_user_id AS buyer_user_id,
        rq.r_request_id
      FROM adempiere.r_request rq
      WHERE rq.isactive = 'Y'
        AND rq.r_requesttype_id = 1000001
        AND rq.ad_user_id IS NOT NULL
        AND rq.created::date >= CURRENT_DATE - 5
        AND rq.created::date <= CURRENT_DATE - 3
    )
    SELECT
      bp.name AS customer,
      rlm.chuboe_mpn AS mpn,
      m.name AS manufacturer,
      rl.qty,
      rr.routed_at::date AS routed_date,
      CURRENT_DATE - rr.routed_at::date AS days_ago,
      buyer.name AS buyer,
      seller.name AS seller,
      CASE
        WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
        WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
        WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
        WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
        WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
        ELSE 'Other'
      END AS region
    FROM routed_rfqs rr
    JOIN adempiere.chuboe_rfq_line rl ON rr.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    JOIN adempiere.ad_user seller ON r.salesrep_id = seller.ad_user_id
    JOIN adempiere.ad_user buyer ON rr.buyer_user_id = buyer.ad_user_id
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
      AND rlm.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
    WHERE rl.isactive = 'Y'
      AND r.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND NOT EXISTS (
        SELECT 1 FROM adempiere.chuboe_vq_line vq
        WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND vq.isactive = 'Y'
      )
      AND CASE
        WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
        WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
        WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
        WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
        WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
        ELSE 'Other'
      END != 'Other'
    ORDER BY region, days_ago DESC;
  `;

  const highValue = parseRows(execQuery(highValueQuery),
    ['rfq_id', 'customer', 'quote_value', 'cq_line_count', 'days_ago', 'rfq_type', 'seller', 'region']);
  const highProbability = parseRows(execQuery(highProbabilityQuery),
    ['rfq_id', 'customer', 'quote_value', 'cq_line_count', 'days_ago', 'rfq_type', 'seller', 'region', 'win_rate']);
  const newCustomers = parseRows(execQuery(newCustomersQuery),
    ['customer', 'rfq_lines', 'days_ago', 'seller', 'region']);
  const pricingBenchmarks = parseRows(execQuery(pricingBenchmarksQuery),
    ['customer', 'lines_quoted', 'lines_won', 'win_rate']);
  const sourcingStuck = parseRows(execQuery(sourcingStuckQuery),
    ['customer', 'mpn', 'manufacturer', 'qty', 'routed_date', 'days_ago', 'buyer', 'seller', 'region']);

  console.log('Section 4 metrics collected');
  return {
    highValue,
    highProbability,
    newCustomers,
    pricingBenchmarks,
    sourcingStuck
  };
}

/**
 * Build Section 4 HTML
 */
function buildSection4HTML(alerts) {
  const highValueItems = alerts.highValue.map((item, i) =>
    `<div class="alert-item">${i+1}. ${item.customer} - <strong>${formatCurrency(item.quote_value)}</strong> (${item.cq_line_count} CQ lines), created ${item.days_ago} days ago <span class="rfq-type">(${item.rfq_type}, RFQ #${item.rfq_id})</span> (${item.region} - ${item.seller})</div>`
  ).join('\n      ');

  const highProbabilityItems = alerts.highProbability.map((item, i) =>
    `<div class="alert-item">${i+1}. ${item.customer} - ${formatCurrency(item.quote_value)} (${item.cq_line_count} CQ lines), quoted ${item.days_ago} days ago <span class="rfq-type">(${item.rfq_type}, RFQ #${item.rfq_id})</span> (${item.region} - ${item.seller}) <em>← ${item.win_rate}% win rate</em></div>`
  ).join('\n      ');

  const newCustomerItems = alerts.newCustomers.map((item, i) =>
    `<div class="alert-item">${i+1}. ${item.customer} - ${item.rfq_lines} RFQ lines, <strong>entered ${item.days_ago} days ago</strong> (${item.region} - ${item.seller})</div>`
  ).join('\n      ');

  const pricingBenchmarkItems = alerts.pricingBenchmarks.map(item =>
    `<div class="alert-item">• ${item.customer} - ${item.lines_quoted} lines quoted, ${item.lines_won} won (${item.win_rate}% win rate)</div>`
  ).join('\n      ');

  // Group sourcing stuck items by region (V5 format)
  const sourcingStuckByRegion = alerts.sourcingStuck.reduce((acc, item) => {
    if (!acc[item.region]) acc[item.region] = [];
    acc[item.region].push(item);
    return acc;
  }, {});

  const sourcingStuckItems = Object.entries(sourcingStuckByRegion)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, items]) => {
      const lineWord = items.length === 1 ? 'line' : 'lines';
      const itemList = items.map((item, i) => `
        <div style="margin-left: 20px; margin-bottom: 8px;">
          ${i+1}. <strong>${item.mpn || 'N/A'}</strong> ${item.manufacturer ? `(${item.manufacturer})` : ''} | QTY: ${item.qty || 'N/A'}<br>
          <span style="font-size: 13px; color: #666;">
            Customer: ${item.customer} | Seller: ${item.seller} | Buyer: ${item.buyer} | Routed: ${item.routed_date} (${item.days_ago} days ago)
          </span>
        </div>
      `).join('');
      return `<div style="margin-bottom: 12px;"><strong>${region} (${items.length} ${lineWord}):</strong>${itemList}</div>`;
    }).join('\n      ');

  const highValueTotal = alerts.highValue.reduce((sum, item) => sum + parseFloat(item.quote_value || 0), 0);
  const highProbabilityTotal = alerts.highProbability.reduce((sum, item) => sum + parseFloat(item.quote_value || 0), 0);

  return `
    <!-- NEEDS ATTENTION -->
    <div class="section">
      <div class="section-title">🚨 Needs Attention (Quotes/RFQs Created in Last 5 Business Days)</div>
      <div class="footnote" style="margin-bottom: 12px;">
        Showing only items created in last 5 business days — keeps focus on fresh, actionable opportunities
      </div>

      ${alerts.highValue.length > 0 ? `
      <div class="alert-box critical">
        <div class="alert-title">🔥 HIGH-VALUE QUOTES (>$10K, created in last 5 days) — Top 5</div>
        ${highValueItems}
        <div class="alert-detail"><strong>ACTION:</strong> Prioritize high-value quotes — combined <strong>${formatCurrency(highValueTotal)} pipeline</strong></div>
      </div>
      ` : ''}

      ${alerts.highProbability.length > 0 ? `
      <div class="alert-box opportunity">
        <div class="alert-title">💎 HIGH-PROBABILITY CUSTOMERS (30-50% win rate, quoted in last 5 business days) — Top 5</div>
        ${highProbabilityItems}
        <div class="alert-detail"><strong>ACTION:</strong> Follow up today — reliable customers, likely to close with nudge (combined ${formatCurrency(highProbabilityTotal)})</div>
      </div>
      ` : ''}

      ${alerts.newCustomers.length > 0 ? `
      <div class="alert-box opportunity">
        <div class="alert-title">🆕 NEW CUSTOMER OPPORTUNITIES (first-time RFQs in last 5 days, no quotes yet) — Top 5</div>
        ${newCustomerItems}
        <div class="alert-detail"><strong>ACTION:</strong> Prioritize for fast response — first impression matters, oldest RFQs need quotes today (${alerts.newCustomers.reduce((sum, item) => sum + parseInt(item.rfq_lines), 0)} lines total)</div>
      </div>
      ` : ''}

      ${alerts.pricingBenchmarks.length > 0 ? `
      <div class="alert-box">
        <div class="alert-title">⚠️ PRICING BENCHMARKS (last 30 days: 30+ lines quoted, <10% win rate)</div>
        ${pricingBenchmarkItems}
        <div class="alert-detail"><strong>ACTION:</strong> Review pricing strategy — consistently losing suggests price not competitive or wrong fit</div>
      </div>
      ` : ''}

      ${alerts.sourcingStuck.length > 0 ? `
      <div class="alert-box warning">
        <div class="alert-title">⏱️ SOURCING STUCK (routed RFQ lines with no response after 3+ days) — ${alerts.sourcingStuck.length} lines</div>
        ${sourcingStuckItems}
        <div class="alert-detail"><strong>ACTION:</strong> Escalate to sourcing team — customer waiting for response</div>
      </div>
      ` : ''}

      ${alerts.highValue.length === 0 && alerts.highProbability.length === 0 && alerts.newCustomers.length === 0 && alerts.pricingBenchmarks.length === 0 && alerts.sourcingStuck.length === 0 ? `
      <div class="footnote">No urgent items requiring attention today</div>
      ` : ''}
    </div>
  `;
}

/**
 * Collect Section 5: Week-to-Date
 */
async function collectSection5Metrics() {
  console.log('Collecting Section 5: Week-to-Date metrics...');

  // Build seller ID lists for SQL
  const usaSellers = SELLER_REGIONS['USA'].join(',');
  const mexSellers = SELLER_REGIONS['MEX'].join(',');
  const apacLaurelSellers = SELLER_REGIONS['APAC-Laurel'].join(',');
  const apacKrisSellers = SELLER_REGIONS['APAC-Kris'].join(',');
  const apacLavanyaSellers = SELLER_REGIONS['APAC-Lavanya'].join(',');

  // Simplified WTD queries - separate for performance
  const wtdQuery = `
    WITH week_start AS (
      SELECT CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int + 1 AS monday
    ),
    rfq_wtd AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_lines_wtd
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y'
        AND r.isactive = 'Y'
        AND rl.created >= (SELECT monday FROM week_start)
      GROUP BY region
    ),
    cq_wtd AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines_wtd,
        COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) AS cq_sold_wtd
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y'
        AND r.isactive = 'Y'
        AND cq.created >= (SELECT monday FROM week_start)
      GROUP BY region
    ),
    so_wtd AS (
      SELECT
        CASE
          WHEN o.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN o.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN o.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN o.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN o.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        COUNT(DISTINCT ol.c_orderline_id) AS so_lines_wtd,
        COALESCE(SUM(ol.linenetamt), 0) AS so_amount_wtd
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y'
        AND o.isactive = 'Y'
        AND o.issotrx = 'Y'
        AND ol.created >= (SELECT monday FROM week_start)
      GROUP BY region
    )
    SELECT
      COALESCE(rfq_wtd.region, cq_wtd.region, so_wtd.region) AS region,
      COALESCE(rfq_wtd.rfq_lines_wtd, 0) AS rfq_lines_wtd,
      COALESCE(cq_wtd.cq_lines_wtd, 0) AS cq_lines_wtd,
      COALESCE(cq_wtd.cq_sold_wtd, 0) AS cq_sold_wtd,
      COALESCE(so_wtd.so_lines_wtd, 0) AS so_lines_wtd,
      COALESCE(so_wtd.so_amount_wtd, 0) AS so_amount_wtd
    FROM rfq_wtd
    FULL OUTER JOIN cq_wtd ON rfq_wtd.region = cq_wtd.region
    FULL OUTER JOIN so_wtd ON COALESCE(rfq_wtd.region, cq_wtd.region) = so_wtd.region
    WHERE COALESCE(rfq_wtd.region, cq_wtd.region, so_wtd.region) != 'Other'
    ORDER BY
      CASE COALESCE(rfq_wtd.region, cq_wtd.region, so_wtd.region)
        WHEN 'USA' THEN 1
        WHEN 'MEX' THEN 2
        WHEN 'APAC-Laurel' THEN 3
        WHEN 'APAC-Kris' THEN 4
        WHEN 'APAC-Lavanya' THEN 5
      END;
  `;

  const wtdData = parseRows(execQuery(wtdQuery),
    ['region', 'rfq_lines_wtd', 'cq_lines_wtd', 'cq_sold_wtd', 'so_lines_wtd', 'so_amount_wtd']);

  console.log('Section 5 metrics collected');
  return wtdData;
}

/**
 * Build Section 5 HTML
 */
function buildSection5HTML(wtdData) {
  if (!wtdData || wtdData.length === 0) {
    return `
      <!-- WEEK-TO-DATE -->
      <div class="section">
        <div class="section-title">📅 Week-to-Date</div>
        <div class="footnote">No week-to-date data available</div>
      </div>
    `;
  }

  const rows = wtdData.map(r => `
    <tr class="${r.region.startsWith('APAC') ? 'subregion-row' : 'region-row'}">
      <td>${r.region === 'APAC-Laurel' ? '↳ Laurel (SGP, 3)' :
            r.region === 'APAC-Kris' ? '↳ Silvia (PHL/China, 6)' :
            r.region === 'APAC-Lavanya' ? '↳ Lavanya (IND, 3)' :
            r.region === 'USA' ? '<strong>USA</strong> (Jeff, 8)' :
            r.region === 'MEX' ? '<strong>MEX</strong> (Joel, 8)' : r.region}</td>
      <td>${r.rfq_lines_wtd}</td>
      <td>${r.cq_lines_wtd}</td>
      <td>${r.cq_sold_wtd}</td>
      <td>${r.so_lines_wtd}</td>
      <td>${formatCurrency(r.so_amount_wtd)}</td>
    </tr>
  `).join('');

  // Calculate APAC total
  const apacData = wtdData.filter(r => r.region.startsWith('APAC'));
  const apacTotal = {
    rfq_lines_wtd: apacData.reduce((sum, r) => sum + parseInt(r.rfq_lines_wtd || 0), 0),
    cq_lines_wtd: apacData.reduce((sum, r) => sum + parseInt(r.cq_lines_wtd || 0), 0),
    cq_sold_wtd: apacData.reduce((sum, r) => sum + parseInt(r.cq_sold_wtd || 0), 0),
    so_lines_wtd: apacData.reduce((sum, r) => sum + parseInt(r.so_lines_wtd || 0), 0),
    so_amount_wtd: apacData.reduce((sum, r) => sum + parseFloat(r.so_amount_wtd || 0), 0)
  };

  const usaRow = wtdData.find(r => r.region === 'USA');
  const mexRow = wtdData.find(r => r.region === 'MEX');
  const subregionRows = wtdData.filter(r => r.region.startsWith('APAC')).map(r => `
    <tr class="subregion-row">
      <td>${r.region === 'APAC-Laurel' ? '↳ Laurel (SGP, 3)' :
            r.region === 'APAC-Kris' ? '↳ Silvia (PHL/China, 6)' :
            r.region === 'APAC-Lavanya' ? '↳ Lavanya (IND, 3)' : r.region}</td>
      <td>${r.rfq_lines_wtd}</td>
      <td>${r.cq_lines_wtd}</td>
      <td>${r.cq_sold_wtd}</td>
      <td>${r.so_lines_wtd}</td>
      <td>${formatCurrency(r.so_amount_wtd)}</td>
    </tr>
  `).join('');

  return `
    <!-- WEEK-TO-DATE -->
    <div class="section">
      <div class="section-title">📅 Week-to-Date (Monday - Yesterday)</div>
      <table>
        <thead>
          <tr>
            <th>Region</th>
            <th>RFQ Lines</th>
            <th>CQ Lines</th>
            <th>CQ Sold</th>
            <th>SO Lines</th>
            <th>SO Amount</th>
          </tr>
        </thead>
        <tbody>
          ${usaRow ? `
          <tr class="region-row">
            <td><strong>USA</strong> (Jeff, 8)</td>
            <td>${usaRow.rfq_lines_wtd}</td>
            <td>${usaRow.cq_lines_wtd}</td>
            <td>${usaRow.cq_sold_wtd}</td>
            <td>${usaRow.so_lines_wtd}</td>
            <td>${formatCurrency(usaRow.so_amount_wtd)}</td>
          </tr>
          ` : ''}
          ${mexRow ? `
          <tr class="region-row">
            <td><strong>MEX</strong> (Joel, 8)</td>
            <td>${mexRow.rfq_lines_wtd}</td>
            <td>${mexRow.cq_lines_wtd}</td>
            <td>${mexRow.cq_sold_wtd}</td>
            <td>${mexRow.so_lines_wtd}</td>
            <td>${formatCurrency(mexRow.so_amount_wtd)}</td>
          </tr>
          ` : ''}
          <tr class="region-row">
            <td><strong>APAC TOTAL</strong> (12)</td>
            <td>${apacTotal.rfq_lines_wtd}</td>
            <td>${apacTotal.cq_lines_wtd}</td>
            <td>${apacTotal.cq_sold_wtd}</td>
            <td>${apacTotal.so_lines_wtd}</td>
            <td>${formatCurrency(apacTotal.so_amount_wtd)}</td>
          </tr>
          ${subregionRows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Collect Section 6: Market Pulse
 */
async function collectSection6Metrics() {
  console.log('Collecting Section 6: Market Pulse metrics...');

  // Trending Manufacturers (most RFQ lines in last 10 business days)
  const trendingMfrQuery = `
    WITH RECURSIVE business_days_10 AS (
      SELECT CURRENT_DATE - 1 AS day, 1 AS day_count
      UNION ALL
      SELECT day - 1, day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
      FROM business_days_10 WHERE day_count <= 10
    ),
    last_10_bdays AS (
      SELECT day FROM business_days_10
      WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
      ORDER BY day DESC LIMIT 10
    )
    SELECT
      m.name AS manufacturer,
      COUNT(DISTINCT r.c_bpartner_id) AS customer_count,
      COUNT(DISTINCT rlm.chuboe_rfq_line_mpn_id) AS rfq_count,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_cq_line cq
          JOIN adempiere.chuboe_rfq r2 ON cq.chuboe_rfq_id = r2.chuboe_rfq_id
          WHERE cq.isactive = 'Y'
            AND r2.isactive = 'Y'
            AND cq.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
        ) THEN rlm.chuboe_rfq_line_mpn_id
      END) AS quoted_count,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_cq_line cq
          JOIN adempiere.chuboe_rfq r2 ON cq.chuboe_rfq_id = r2.chuboe_rfq_id
          WHERE cq.isactive = 'Y'
            AND r2.isactive = 'Y'
            AND cq.issold = 'Y'
            AND cq.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
        ) THEN rlm.chuboe_rfq_line_mpn_id
      END) AS sold_count
    FROM adempiere.chuboe_rfq_line_mpn rlm
    JOIN adempiere.chuboe_rfq_line rl ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
    WHERE rlm.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND r.isactive = 'Y'
      AND m.isactive = 'Y'
      AND rl.created::date IN (SELECT day FROM last_10_bdays)
    GROUP BY m.name
    ORDER BY rfq_count DESC
    LIMIT 10;
  `;

  // Trending Parts (most RFQ lines in last 10 business days)
  const trendingPartsQuery = `
    WITH RECURSIVE business_days_10 AS (
      SELECT CURRENT_DATE - 1 AS day, 1 AS day_count
      UNION ALL
      SELECT day - 1, day_count + CASE WHEN EXTRACT(DOW FROM day - 1) NOT IN (0, 6) THEN 1 ELSE 0 END
      FROM business_days_10 WHERE day_count <= 10
    ),
    last_10_bdays AS (
      SELECT day FROM business_days_10
      WHERE EXTRACT(DOW FROM day) NOT IN (0, 6)
      ORDER BY day DESC LIMIT 10
    )
    SELECT
      rlm.chuboe_mpn AS mpn,
      m.name AS manufacturer,
      COUNT(DISTINCT r.c_bpartner_id) AS customer_count,
      COUNT(DISTINCT rlm.chuboe_rfq_line_mpn_id) AS rfq_count,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_cq_line cq
          JOIN adempiere.chuboe_rfq r2 ON cq.chuboe_rfq_id = r2.chuboe_rfq_id
          WHERE cq.isactive = 'Y'
            AND r2.isactive = 'Y'
            AND cq.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
        ) THEN rlm.chuboe_rfq_line_mpn_id
      END) AS quoted_count,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM adempiere.chuboe_cq_line cq
          JOIN adempiere.chuboe_rfq r2 ON cq.chuboe_rfq_id = r2.chuboe_rfq_id
          WHERE cq.isactive = 'Y'
            AND r2.isactive = 'Y'
            AND cq.issold = 'Y'
            AND cq.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
        ) THEN rlm.chuboe_rfq_line_mpn_id
      END) AS sold_count
    FROM adempiere.chuboe_rfq_line_mpn rlm
    JOIN adempiere.chuboe_rfq_line rl ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
    WHERE rlm.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND r.isactive = 'Y'
      AND m.isactive = 'Y'
      AND rl.created::date IN (SELECT day FROM last_10_bdays)
    GROUP BY rlm.chuboe_mpn, m.name
    ORDER BY rfq_count DESC
    LIMIT 10;
  `;

  const trendingManufacturers = parseRows(execQuery(trendingMfrQuery),
    ['manufacturer', 'customer_count', 'rfq_count', 'quoted_count', 'sold_count']);
  const trendingParts = parseRows(execQuery(trendingPartsQuery),
    ['mpn', 'manufacturer', 'customer_count', 'rfq_count', 'quoted_count', 'sold_count']);

  console.log('Section 6 metrics collected');
  return {
    trendingManufacturers,
    trendingParts
  };
}

/**
 * Build Section 6 HTML
 */
function buildSection6HTML(marketData) {
  if (!marketData.trendingManufacturers || marketData.trendingManufacturers.length === 0) {
    return `
      <!-- MARKET PULSE -->
      <div class="section">
        <div class="section-title">📈 Market Pulse (Last 10 Business Days)</div>
        <div class="footnote">No trending activity in last 10 days</div>
      </div>
    `;
  }

  const mfrRows = marketData.trendingManufacturers.map(m => `
    <tr>
      <td>${m.manufacturer}</td>
      <td>${m.customer_count}</td>
      <td>${m.rfq_count}</td>
      <td>${m.quoted_count}</td>
      <td>${m.sold_count}</td>
      <td>${m.rfq_count > 0 ? Math.round((m.sold_count / m.rfq_count) * 100) : 0}%</td>
    </tr>
  `).join('');

  const partRows = marketData.trendingParts.map(p => `
    <tr>
      <td>${p.mpn}</td>
      <td>${p.manufacturer}</td>
      <td>${p.customer_count}</td>
      <td>${p.rfq_count}</td>
      <td>${p.quoted_count}</td>
      <td>${p.sold_count}</td>
      <td>${p.rfq_count > 0 ? Math.round((p.sold_count / p.rfq_count) * 100) : 0}%</td>
    </tr>
  `).join('');

  return `
    <!-- MARKET PULSE -->
    <div class="section">
      <div class="section-title">📈 Market Pulse (Last 10 Business Days)</div>

      <div class="subsection">
        <div class="subsection-title">Trending Manufacturers</div>
        <table>
          <thead>
            <tr>
              <th>Manufacturer</th>
              <th>Customers</th>
              <th>RFQ Count</th>
              <th>Quoted</th>
              <th>Sold</th>
              <th>Conversion</th>
            </tr>
          </thead>
          <tbody>
            ${mfrRows}
          </tbody>
        </table>
      </div>

      ${marketData.trendingParts && marketData.trendingParts.length > 0 ? `
      <div class="subsection">
        <div class="subsection-title">Trending Parts</div>
        <table>
          <thead>
            <tr>
              <th>MPN</th>
              <th>Manufacturer</th>
              <th>Customers</th>
              <th>RFQ Count</th>
              <th>Quoted</th>
              <th>Sold</th>
              <th>Conversion</th>
            </tr>
          </thead>
          <tbody>
            ${partRows}
          </tbody>
        </table>
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * Build complete HTML
 */
function buildEmail(section1Metrics, section2Data, section3Data, section4Data, section5Data, section6Data) {
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
  .warning { color: #ea580c; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px; background: #f8f8f8; font-weight: 600; border-bottom: 2px solid #e0e0e0; font-size: 11px; }
  td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  .region-row { font-weight: 600; }
  .subregion-row { font-weight: normal; color: #666; }
  .subregion-row td:first-child { padding-left: 24px; }
  .footnote { font-size: 11px; color: #999; margin-top: 8px; font-style: italic; }
  .win-item { margin-bottom: 16px; padding: 12px; background: #f8f8f8; border-radius: 4px; }
  .win-title { font-weight: 600; margin-bottom: 8px; }
  .alert-box { margin-bottom: 16px; padding: 12px; border-radius: 4px; border-left: 4px solid #ccc; background: #f8f8f8; }
  .alert-box.critical { border-left-color: #dc2626; background: #fef2f2; }
  .alert-box.opportunity { border-left-color: #16a34a; background: #f0fdf4; }
  .alert-box.warning { border-left-color: #ea580c; background: #fff7ed; }
  .alert-title { font-weight: 600; margin-bottom: 8px; font-size: 13px; }
  .alert-item { padding: 4px 0; font-size: 12px; }
  .alert-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.1); font-size: 12px; font-style: italic; }
  .rfq-type { font-size: 11px; color: #666; }
  .footer { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #999; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>📊 Sales Pulse — ${formatDate(today)}</h1>
  <div class="subtitle">Data as of 6:00am PT | Reflects activity through EOD ${formatDate(yesterday)}</div>

  ${section1Module.buildSection1HTML(section1Metrics)}
  ${buildSection2HTML(section2Data)}
  ${buildSection3HTML(section3Data)}
  ${buildSection4HTML(section4Data)}
  ${buildSection5HTML(section5Data)}
  ${buildSection6HTML(section6Data)}

  <!-- TESTING SUMMARY -->
  <div class="section" style="background: #fffbeb; border: 2px solid #f59e0b; padding: 16px; border-radius: 8px;">
    <div class="section-title" style="color: #92400e;">📋 Report Summary (Testing Version Only)</div>

    <div class="subsection">
      <div class="subsection-title">Why Read This Report? (Key Questions Answered)</div>
      <ul style="margin: 0; padding-left: 20px; font-size: 12px; line-height: 1.8;">
        <li><strong>Pipeline health:</strong> Are we getting enough RFQs? Are buyers responding quickly?</li>
        <li><strong>Quoting efficiency:</strong> How fast are we converting RFQs → CQs → SOs?</li>
        <li><strong>Regional performance:</strong> Which regions are hitting targets? Where are bottlenecks?</li>
        <li><strong>Revenue tracking:</strong> What did we win yesterday? Are we on pace for weekly goals?</li>
        <li><strong>Urgent actions:</strong> What needs immediate attention? (high-value quotes, stuck RFQs, etc.)</li>
        <li><strong>Market trends:</strong> What parts/manufacturers are hot right now?</li>
        <li><strong>System discipline:</strong> Are we following process? (CQ entry timing, retroactive quotes)</li>
      </ul>
    </div>

    <div class="subsection">
      <div class="subsection-title">Section Data Summary</div>
      <table style="background: white;">
        <thead>
          <tr>
            <th>Section</th>
            <th>Data Source</th>
            <th>Key Metrics</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>1. Global Snapshot</strong></td>
            <td>RFQ lines, VQ lines, CQ lines, SO lines<br>(yesterday vs 5-day rolling avg)</td>
            <td>Pipeline input (RFQ count, response %), quoting activity (CQ count, sold), wins ($, lines), system discipline (2hr entry, retroactive %)</td>
          </tr>
          <tr>
            <td><strong>2. By Region</strong></td>
            <td>RFQ/CQ/SO by salesrep_id region mapping<br>(USA, MEX, APAC subregions)</td>
            <td>RFQ lines entered, response coverage, response time, CQ lines, CQ sold, SO lines, quote age (short-cycle)</td>
          </tr>
          <tr>
            <td><strong>3. Yesterday's Wins</strong></td>
            <td>Sales orders (c_order, c_orderline)<br>created yesterday</td>
            <td>Customer name, line count, $ amount, seller name — grouped by region</td>
          </tr>
          <tr>
            <td><strong>4. Needs Attention</strong></td>
            <td>5 alert types from last 5 business days or 30 days</td>
            <td>High-value quotes (>$10K), high-probability customers (30-50% win rate), new customers (no quotes yet), pricing benchmarks (<10% win rate), sourcing stuck (>3 days no response)</td>
          </tr>
          <tr>
            <td><strong>5. Week-to-Date</strong></td>
            <td>RFQ/CQ/SO activity from Monday through yesterday</td>
            <td>Regional tracking: RFQ lines, CQ lines, CQ sold, SO lines, SO $ amount</td>
          </tr>
          <tr>
            <td><strong>6. Market Pulse</strong></td>
            <td>RFQ line MPNs from last 10 business days</td>
            <td>Top 10 trending manufacturers, top 10 trending parts (by RFQ count + quote coverage)</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="subsection">
      <div class="subsection-title">Data Freshness & Coverage</div>
      <ul style="margin: 0; padding-left: 20px; font-size: 12px; line-height: 1.8;">
        <li><strong>Yesterday's data:</strong> All records created on ${formatDate(yesterday)} (sections 1-3)</li>
        <li><strong>Rolling averages:</strong> Last 5 business days (excludes weekends)</li>
        <li><strong>Alert windows:</strong> Last 5 business days (sections 4, 6) or last 30 days (pricing benchmarks)</li>
        <li><strong>Week-to-date:</strong> Monday through yesterday (section 5)</li>
        <li><strong>Active records only:</strong> All queries filter isactive = 'Y'</li>
        <li><strong>Regional mapping:</strong> 28 salesreps across USA (8), MEX (8), APAC (12 in 3 subregions)</li>
      </ul>
    </div>

    <div class="footnote" style="margin-top: 12px; background: white; padding: 8px; border-radius: 4px;">
      <strong>Note:</strong> This summary section is for testing/review only and will be removed in production version
    </div>
  </div>

  <div class="footer">
    ✅ All sections complete (Global Snapshot, By Region, Yesterday's Wins, Needs Attention, Week-to-Date, Market Pulse)<br>
    Generated with Claude Code • ${formatDate(new Date())}<br><br>
    <strong>Questions for Leadership:</strong> Part details and buyer contact information not currently tracked in order line data. Would you like this added?
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
  console.log('Sales Pulse V5 - Comprehensive Build');

  try {
    const section1Metrics = await section1Module.collectSection1Metrics();
    const section2Data = await collectSection2Metrics();
    const section3Data = await collectSection3Metrics();
    const section4Data = await collectSection4Metrics();
    const section5Data = await collectSection5Metrics();
    const section6Data = await collectSection6Metrics();

    const html = buildEmail(section1Metrics, section2Data, section3Data, section4Data, section5Data, section6Data);

    const outputDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `sales-pulse-comprehensive-${timestamp}.html`);
    const jsonPath = path.join(outputDir, `sales-pulse-comprehensive-${timestamp}.json`);

    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
      section1: section1Metrics,
      section2: section2Data,
      section3: section3Data,
      section4: section4Data,
      section5: section5Data,
      section6: section6Data
    }, null, 2));

    console.log(`✅ Sections 1-6 structure complete`);
    console.log(`HTML: ${htmlPath}`);
    console.log(`JSON: ${jsonPath}`);

  } catch (error) {
    console.error('❌ Error:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { collectSection2Metrics, buildSection2HTML };
