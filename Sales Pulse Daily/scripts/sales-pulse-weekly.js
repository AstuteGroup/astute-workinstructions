#!/usr/bin/env node
/**
 * Sales Pulse Weekly - Friday Special Edition
 *
 * Full week summary (Mon-Fri) sent every Friday at 6:00 AM PT
 *
 * Sections:
 * 1. Week Summary - Full week vs prior week comparison
 * 2. By Region - Week totals and rankings
 * 3. Week's Wins - All bookings Mon-Fri with highlights
 * 4. Persistent Issues - Items that appeared 3+ days this week
 * 5. Week vs Targets - Final results vs weekly targets
 * 6. Market Pulse - Week trends and insights
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Regional seller mapping (same as daily)
const SELLER_REGIONS = {
  'USA': [1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017],
  'MEX': [1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224],
  'APAC-Laurel': [1041139, 1023803, 1016958],
  'APAC-Kris': [1039414, 1009866, 1013042, 1009528, 1009478, 1009210],
  'APAC-Lavanya': [1024444, 1023478, 1017011]
};

// Weekly targets (from README)
const WEEKLY_TARGETS = {
  'USA': { rfq: 180, cq: 135, cq_sold: 41 },
  'MEX': { rfq: 180, cq: 135, cq_sold: 41 },
  'APAC': { rfq: 220, cq: 165, cq_sold: 50 },
  'GLOBAL': { rfq: 580, cq: 435, cq_sold: 132 }
};

// Flatten seller list for lookup
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

/**
 * Get Monday of current week
 */
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

/**
 * Get date range for "last week" (the completed Mon-Fri week)
 * When run on Friday, returns the week that just completed (Mon-Fri of current week)
 * When run on other days, returns the previous completed Mon-Fri week
 */
function getLastWeekRange() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sunday, 5=Friday

  // If today is Friday (5) or later in week, "last week" = current Mon-Fri (just completing)
  // If today is before Friday, "last week" = previous Mon-Fri (already completed)
  const daysToSubtract = dayOfWeek >= 5 ? 0 : 7; // If Fri or later, use current week; else previous week

  const lastWeekMonday = getMonday(today);
  lastWeekMonday.setDate(lastWeekMonday.getDate() - daysToSubtract);

  const lastWeekFriday = new Date(lastWeekMonday);
  lastWeekFriday.setDate(lastWeekFriday.getDate() + 4); // Friday = Monday + 4 days

  return { start: lastWeekMonday, end: lastWeekFriday };
}

/**
 * Get date range for "prior week" (the week before last week)
 */
function getPriorWeekRange(lastWeekStart) {
  const priorWeekMonday = new Date(lastWeekStart);
  priorWeekMonday.setDate(priorWeekMonday.getDate() - 7);

  const priorWeekFriday = new Date(priorWeekMonday);
  priorWeekFriday.setDate(priorWeekFriday.getDate() + 4);

  return { start: priorWeekMonday, end: priorWeekFriday };
}

/**
 * Section 1: Week Summary
 * Last completed week (Mon-Fri) vs prior week comparison
 */
async function collectSection1Metrics() {
  console.log('Collecting Section 1: Week Summary metrics...');

  const lastWeek = getLastWeekRange();
  const priorWeek = getPriorWeekRange(lastWeek.start);

  const allSellers = Object.values(SELLER_REGIONS).flat().join(',');

  console.log(`Last week: ${lastWeek.start.toISOString().split('T')[0]} to ${lastWeek.end.toISOString().split('T')[0]}`);
  console.log(`Prior week: ${priorWeek.start.toISOString().split('T')[0]} to ${priorWeek.end.toISOString().split('T')[0]}`);

  // Break into separate queries to avoid shell command length limits

  // Last week (the completed week) RFQ
  const lwRfqQuery = `SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) AS cnt, COUNT(DISTINCT r.c_bpartner_id) AS cust FROM adempiere.chuboe_rfq_line rl JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id WHERE rl.isactive = 'Y' AND r.isactive = 'Y' AND r.salesrep_id IN (${allSellers}) AND rl.created::date >= '${lastWeek.start.toISOString().split('T')[0]}' AND rl.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'`;
  const lwRfq = parseRow(execQuery(lwRfqQuery), ['cnt', 'cust']);

  // Last week CQ
  const lwCqQuery = `SELECT COUNT(DISTINCT cq.chuboe_cq_line_id) AS cnt, COUNT(DISTINCT r.c_bpartner_id) AS cust, COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) AS sold FROM adempiere.chuboe_cq_line cq JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id WHERE cq.isactive = 'Y' AND r.isactive = 'Y' AND r.salesrep_id IN (${allSellers}) AND cq.created::date >= '${lastWeek.start.toISOString().split('T')[0]}' AND cq.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'`;
  const lwCq = parseRow(execQuery(lwCqQuery), ['cnt', 'cust', 'sold']);

  // Last week SO
  const lwSoQuery = `SELECT COUNT(DISTINCT ol.c_orderline_id) AS cnt, COALESCE(SUM(ol.linenetamt), 0) AS amt FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y' AND o.salesrep_id IN (${allSellers}) AND ol.created::date >= '${lastWeek.start.toISOString().split('T')[0]}' AND ol.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'`;
  const lwSo = parseRow(execQuery(lwSoQuery), ['cnt', 'amt']);

  // Prior week RFQ
  const pwRfqQuery = `SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) AS cnt, COUNT(DISTINCT r.c_bpartner_id) AS cust FROM adempiere.chuboe_rfq_line rl JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id WHERE rl.isactive = 'Y' AND r.isactive = 'Y' AND r.salesrep_id IN (${allSellers}) AND rl.created::date >= '${priorWeek.start.toISOString().split('T')[0]}' AND rl.created::date <= '${priorWeek.end.toISOString().split('T')[0]}'`;
  const pwRfq = parseRow(execQuery(pwRfqQuery), ['cnt', 'cust']);

  // Prior week CQ
  const pwCqQuery = `SELECT COUNT(DISTINCT cq.chuboe_cq_line_id) AS cnt, COUNT(DISTINCT r.c_bpartner_id) AS cust, COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) AS sold FROM adempiere.chuboe_cq_line cq JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id WHERE cq.isactive = 'Y' AND r.isactive = 'Y' AND r.salesrep_id IN (${allSellers}) AND cq.created::date >= '${priorWeek.start.toISOString().split('T')[0]}' AND cq.created::date <= '${priorWeek.end.toISOString().split('T')[0]}'`;
  const pwCq = parseRow(execQuery(pwCqQuery), ['cnt', 'cust', 'sold']);

  // Prior week SO
  const pwSoQuery = `SELECT COUNT(DISTINCT ol.c_orderline_id) AS cnt, COALESCE(SUM(ol.linenetamt), 0) AS amt FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y' AND o.salesrep_id IN (${allSellers}) AND ol.created::date >= '${priorWeek.start.toISOString().split('T')[0]}' AND ol.created::date <= '${priorWeek.end.toISOString().split('T')[0]}'`;
  const pwSo = parseRow(execQuery(pwSoQuery), ['cnt', 'amt']);

  const result = {
    lw_rfq_lines: lwRfq.cnt,
    lw_rfq_customers: lwRfq.cust,
    lw_rfq_with_response: 0, // Skip for now - complex subquery
    lw_cq_lines: lwCq.cnt,
    lw_cq_customers: lwCq.cust,
    lw_cq_sold: lwCq.sold,
    lw_so_lines: lwSo.cnt,
    lw_so_amount: lwSo.amt,
    pw_rfq_lines: pwRfq.cnt,
    pw_rfq_customers: pwRfq.cust,
    pw_rfq_with_response: 0,
    pw_cq_lines: pwCq.cnt,
    pw_cq_customers: pwCq.cust,
    pw_cq_sold: pwCq.sold,
    pw_so_lines: pwSo.cnt,
    pw_so_amount: pwSo.amt,
    // Store date ranges for display
    lastWeekStart: lastWeek.start,
    lastWeekEnd: lastWeek.end
  };

  console.log('Section 1 metrics collected');
  return result;
}

/**
 * Section 2: By Region
 * Last completed week performance by region (with prior week comparison)
 */
async function collectSection2Metrics() {
  console.log('Collecting Section 2: By Region metrics...');

  const lastWeek = getLastWeekRange();
  const priorWeek = getPriorWeekRange(lastWeek.start);
  const usaSellers = SELLER_REGIONS['USA'].join(',');
  const mexSellers = SELLER_REGIONS['MEX'].join(',');
  const apacLaurelSellers = SELLER_REGIONS['APAC-Laurel'].join(',');
  const apacKrisSellers = SELLER_REGIONS['APAC-Kris'].join(',');
  const apacLavanyaSellers = SELLER_REGIONS['APAC-Lavanya'].join(',');

  const regionalQuery = `
    WITH regional_rfq AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_lines,
        COUNT(DISTINCT CASE
          WHEN EXISTS (
            SELECT 1 FROM adempiere.chuboe_vq_line vq
            WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND vq.isactive = 'Y'
          ) THEN rl.chuboe_rfq_line_id
        END) AS with_response
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y'
        AND r.isactive = 'Y'
        AND rl.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND rl.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
      GROUP BY 1
    ),
    regional_cq AS (
      SELECT
        CASE
          WHEN r.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN r.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN r.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN r.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN r.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines,
        COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) AS cq_sold
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y'
        AND r.isactive = 'Y'
        AND cq.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND cq.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
      GROUP BY 1
    ),
    regional_so AS (
      SELECT
        CASE
          WHEN o.salesrep_id IN (${usaSellers}) THEN 'USA'
          WHEN o.salesrep_id IN (${mexSellers}) THEN 'MEX'
          WHEN o.salesrep_id IN (${apacLaurelSellers}) THEN 'APAC-Laurel'
          WHEN o.salesrep_id IN (${apacKrisSellers}) THEN 'APAC-Kris'
          WHEN o.salesrep_id IN (${apacLavanyaSellers}) THEN 'APAC-Lavanya'
          ELSE 'Other'
        END AS region,
        COUNT(DISTINCT ol.c_orderline_id) AS so_lines,
        SUM(ol.linenetamt) AS so_amount
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y'
        AND o.isactive = 'Y'
        AND o.issotrx = 'Y'
        AND ol.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND ol.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
      GROUP BY 1
    )
    SELECT
      rfq.region,
      COALESCE(rfq.rfq_lines, 0) AS rfq_lines,
      COALESCE(rfq.with_response, 0) AS with_response,
      ROUND(100.0 * COALESCE(rfq.with_response, 0) / NULLIF(rfq.rfq_lines, 0), 1) AS response_pct,
      COALESCE(cq.cq_lines, 0) AS cq_lines,
      COALESCE(cq.cq_sold, 0) AS cq_sold,
      COALESCE(so.so_lines, 0) AS so_lines,
      COALESCE(so.so_amount, 0) AS so_amount
    FROM regional_rfq rfq
    LEFT JOIN regional_cq cq ON rfq.region = cq.region
    LEFT JOIN regional_so so ON rfq.region = so.region
    WHERE rfq.region != 'Other'
    ORDER BY
      CASE rfq.region
        WHEN 'USA' THEN 1
        WHEN 'MEX' THEN 2
        WHEN 'APAC-Laurel' THEN 3
        WHEN 'APAC-Kris' THEN 4
        WHEN 'APAC-Lavanya' THEN 5
      END;
  `;

  const regionalData = parseRows(execQuery(regionalQuery),
    ['region', 'rfq_lines', 'with_response', 'response_pct', 'cq_lines', 'cq_sold', 'so_lines', 'so_amount']);

  // Now get prior week data for comparison
  const priorWeekQuery = regionalQuery.replace(
    new RegExp(lastWeek.start.toISOString().split('T')[0], 'g'),
    priorWeek.start.toISOString().split('T')[0]
  ).replace(
    new RegExp(lastWeek.end.toISOString().split('T')[0], 'g'),
    priorWeek.end.toISOString().split('T')[0]
  );

  const priorWeekData = parseRows(execQuery(priorWeekQuery),
    ['region', 'rfq_lines', 'with_response', 'response_pct', 'cq_lines', 'cq_sold', 'so_lines', 'so_amount']);

  // Merge prior week data into regional data for comparison
  const mergedData = regionalData.map(lastWeekRegion => {
    const priorWeekRegion = priorWeekData.find(r => r.region === lastWeekRegion.region) || {};
    return {
      ...lastWeekRegion,
      pw_rfq_lines: priorWeekRegion.rfq_lines || 0,
      pw_cq_lines: priorWeekRegion.cq_lines || 0,
      pw_cq_sold: priorWeekRegion.cq_sold || 0,
      pw_so_lines: priorWeekRegion.so_lines || 0,
      pw_so_amount: priorWeekRegion.so_amount || 0
    };
  });

  console.log('Section 2 metrics collected');
  return mergedData;
}

/**
 * Section 3: Week's Wins
 * All bookings from last completed week (Mon-Fri)
 */
async function collectSection3Metrics() {
  console.log('Collecting Section 3: Week\'s Wins metrics...');

  const lastWeek = getLastWeekRange();
  const allSellers = Object.values(SELLER_REGIONS).flat().join(',');

  const winsQuery = `
    SELECT
      bp.name AS customer,
      COUNT(DISTINCT ol.c_orderline_id) AS line_count,
      SUM(ol.linenetamt) AS amount,
      u.name AS seller,
      CASE
        WHEN o.salesrep_id IN (${SELLER_REGIONS['USA'].join(',')}) THEN 'USA'
        WHEN o.salesrep_id IN (${SELLER_REGIONS['MEX'].join(',')}) THEN 'MEX'
        ELSE 'APAC'
      END AS region,
      MIN(ol.created::date) AS first_line_date,
      MAX(ol.created::date) AS last_line_date
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id
    WHERE ol.isactive = 'Y'
      AND o.isactive = 'Y'
      AND o.issotrx = 'Y'
      AND o.salesrep_id IN (${allSellers})
      AND ol.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
      AND ol.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
    GROUP BY bp.name, u.name, o.salesrep_id
    ORDER BY SUM(ol.linenetamt) DESC
    LIMIT 20;
  `;

  const wins = parseRows(execQuery(winsQuery),
    ['customer', 'line_count', 'amount', 'seller', 'region', 'first_line_date', 'last_line_date']);

  console.log('Section 3 metrics collected');
  return wins;
}

/**
 * Section 4: Persistent Issues
 * High-value quotes from last week that are still open
 */
async function collectSection4Metrics() {
  console.log('Collecting Section 4: Persistent Issues metrics...');

  const lastWeek = getLastWeekRange();
  const allSellers = Object.values(SELLER_REGIONS).flat().join(',');

  // High-value quotes created during last week that are still open
  // Simplified: just use priceentered which is the line total
  const persistentQuotesQuery = `
    SELECT
      bp.name AS customer,
      SUM(cq.priceentered) AS total_value,
      MIN(cq.created::date) AS created_date,
      CURRENT_DATE - MIN(cq.created::date) AS days_open,
      rt.name AS rfq_type,
      u.name AS seller,
      COUNT(DISTINCT cq.chuboe_cq_line_id) AS line_count
    FROM adempiere.chuboe_cq_line cq
    JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
    WHERE cq.isactive = 'Y'
      AND r.isactive = 'Y'
      AND cq.issold = 'N'
      AND r.salesrep_id IN (${allSellers})
      AND cq.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
      AND cq.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
    GROUP BY bp.name, rt.name, u.name
    HAVING SUM(cq.priceentered) > 10000
    ORDER BY SUM(cq.priceentered) DESC
    LIMIT 10;
  `;

  const persistentQuotes = parseRows(execQuery(persistentQuotesQuery),
    ['customer', 'total_value', 'created_date', 'days_open', 'rfq_type', 'seller', 'line_count']);

  console.log('Section 4 metrics collected');
  return { persistentQuotes };
}

/**
 * Section 5: Week vs Targets
 * Regional and global performance vs weekly targets
 */
async function collectSection5Metrics() {
  console.log('Collecting Section 5: Week vs Targets metrics...');

  // Already have regional data from Section 2, just need to add target comparison
  const section2Data = await collectSection2Metrics();

  const withTargets = section2Data.map(region => {
    let regionKey = region.region.startsWith('APAC') ? 'APAC' : region.region;
    const target = WEEKLY_TARGETS[regionKey] || { rfq: 0, cq: 0, cq_sold: 0 };

    return {
      ...region,
      target_rfq: target.rfq,
      target_cq: target.cq,
      target_cq_sold: target.cq_sold,
      rfq_vs_target: Math.round(100 * parseInt(region.rfq_lines) / target.rfq),
      cq_vs_target: Math.round(100 * parseInt(region.cq_lines) / target.cq),
      cq_sold_vs_target: Math.round(100 * parseInt(region.cq_sold) / target.cq_sold)
    };
  });

  console.log('Section 5 metrics collected');
  return withTargets;
}

/**
 * Section 6: Conversion Funnel
 * Track conversion rates through the sales funnel
 */
async function collectSection6Metrics() {
  console.log('Collecting Section 6: Conversion Funnel metrics...');

  const lastWeek = getLastWeekRange();
  const priorWeek = getPriorWeekRange(lastWeek.start);
  const allSellers = Object.values(SELLER_REGIONS).flat().join(',');

  // Last week funnel
  const lwFunnelQuery = `
    WITH rfq_base AS (
      SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_lines
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
        AND r.salesrep_id IN (${allSellers})
        AND rl.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND rl.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
    ),
    rfq_with_vq AS (
      SELECT COUNT(DISTINCT rl.chuboe_rfq_line_id) AS rfq_with_response
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE rl.isactive = 'Y' AND r.isactive = 'Y'
        AND r.salesrep_id IN (${allSellers})
        AND rl.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND rl.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
        AND EXISTS (SELECT 1 FROM adempiere.chuboe_vq_line vq WHERE vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND vq.isactive = 'Y')
    ),
    cq_base AS (
      SELECT COUNT(DISTINCT cq.chuboe_cq_line_id) AS cq_lines
      FROM adempiere.chuboe_cq_line cq
      JOIN adempiere.chuboe_rfq r ON cq.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE cq.isactive = 'Y' AND r.isactive = 'Y'
        AND r.salesrep_id IN (${allSellers})
        AND cq.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND cq.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
    ),
    so_base AS (
      SELECT COUNT(DISTINCT ol.c_orderline_id) AS so_lines
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
      WHERE ol.isactive = 'Y' AND o.isactive = 'Y' AND o.issotrx = 'Y'
        AND o.salesrep_id IN (${allSellers})
        AND ol.created::date >= '${lastWeek.start.toISOString().split('T')[0]}'
        AND ol.created::date <= '${lastWeek.end.toISOString().split('T')[0]}'
    )
    SELECT
      rfq.rfq_lines,
      vq.rfq_with_response,
      cq.cq_lines,
      so.so_lines
    FROM rfq_base rfq
    CROSS JOIN rfq_with_vq vq
    CROSS JOIN cq_base cq
    CROSS JOIN so_base so;
  `;

  const lwFunnel = parseRow(execQuery(lwFunnelQuery), ['rfq_lines', 'rfq_with_response', 'cq_lines', 'so_lines']);

  // Prior week funnel (reuse query with date substitution)
  const pwFunnelQuery = lwFunnelQuery.replace(
    new RegExp(lastWeek.start.toISOString().split('T')[0], 'g'),
    priorWeek.start.toISOString().split('T')[0]
  ).replace(
    new RegExp(lastWeek.end.toISOString().split('T')[0], 'g'),
    priorWeek.end.toISOString().split('T')[0]
  );

  const pwFunnel = parseRow(execQuery(pwFunnelQuery), ['rfq_lines', 'rfq_with_response', 'cq_lines', 'so_lines']);

  console.log('Section 6 metrics collected');
  return { lastWeek: lwFunnel, priorWeek: pwFunnel };
}

/**
 * Section 7: Market Pulse
 * Week trends (similar to daily but week-over-week)
 * SIMPLIFIED: Skip for now - manufacturer table schema TBD
 */
async function collectSection7Metrics() {
  console.log('Collecting Section 7: Market Pulse metrics...');

  // Return empty for now - manufacturer schema needs investigation
  const trendingMfrs = [];

  console.log('Section 7 metrics collected (empty - manufacturer schema TBD)');
  return { trendingMfrs };
}

/**
 * Generate Observations/Insights based on data
 */
function generateObservations(section1, section2, section3, section6) {
  const observations = [];

  // Quality over quantity insight
  const rfqChange = section1.lw_rfq_lines - section1.pw_rfq_lines;
  const amountChange = parseFloat(section1.lw_so_amount) - parseFloat(section1.pw_so_amount);
  if (rfqChange < 0 && amountChange > 0) {
    observations.push(`**Quality over quantity:** ${Math.abs(rfqChange)} fewer RFQs but ${formatCurrency(amountChange)} more revenue (${Math.round(100 * amountChange / parseFloat(section1.pw_so_amount))}% increase)`);
  }

  // Regional performance
  const topRegion = section2.reduce((max, r) => parseFloat(r.so_amount) > parseFloat(max.so_amount) ? r : max, section2[0]);
  const topRegionPct = Math.round(100 * parseFloat(topRegion.so_amount) / parseFloat(section1.lw_so_amount));
  if (topRegionPct >= 50) {
    observations.push(`**${topRegion.region} dominated:** ${topRegionPct}% of total revenue ($${formatCurrency(topRegion.so_amount)})`);
  }

  // Conversion concerns
  section2.forEach(region => {
    const conversionRate = region.cq_lines > 0 ? Math.round(100 * region.cq_lines / region.rfq_lines) : 0;
    if (region.rfq_lines > 100 && conversionRate < 5) {
      observations.push(`**${region.region} sourcing concern:** ${region.rfq_lines} RFQs but only ${region.cq_lines} CQs (${conversionRate}% conversion - investigate)`);
    }
  });

  // Target performance
  section2.forEach(region => {
    if (region.cq_sold_vs_target >= 80 && region.rfq_vs_target < 70) {
      observations.push(`**${region.region} close rate strong:** ${region.cq_sold_vs_target}% of CQ Sold target despite ${region.rfq_vs_target}% RFQ volume`);
    }
  });

  // Conversion funnel insight
  const lwConversion = Math.round(100 * section6.lastWeek.so_lines / section6.lastWeek.rfq_lines);
  const pwConversion = Math.round(100 * section6.priorWeek.so_lines / section6.priorWeek.rfq_lines);
  const conversionChange = lwConversion - pwConversion;
  if (Math.abs(conversionChange) >= 3) {
    observations.push(`**Overall funnel ${conversionChange > 0 ? 'improved' : 'declined'}:** RFQ→SO conversion ${lwConversion}% (${conversionChange > 0 ? '+' : ''}${conversionChange}pp vs prior week)`);
  }

  return observations.slice(0, 5); // Max 5 observations
}

/**
 * Build HTML email
 */
function buildEmail(section1, section2, section3, section4, section5, section6, section7) {
  const today = new Date();

  // Use the date ranges from section1
  const lastWeekStart = section1.lastWeekStart;
  const lastWeekEnd = section1.lastWeekEnd;

  // Calculate week-over-week changes (last week vs prior week)
  const rfqChange = section1.lw_rfq_lines - section1.pw_rfq_lines;
  const rfqPct = Math.round(100 * rfqChange / section1.pw_rfq_lines);
  const cqChange = section1.lw_cq_lines - section1.pw_cq_lines;
  const cqPct = Math.round(100 * cqChange / section1.pw_cq_lines);
  const soChange = section1.lw_so_lines - section1.pw_so_lines;
  const soPct = Math.round(100 * soChange / section1.pw_so_lines);
  const amountChange = parseFloat(section1.lw_so_amount) - parseFloat(section1.pw_so_amount);
  const amountPct = Math.round(100 * amountChange / parseFloat(section1.pw_so_amount));

  // Calculate conversion rates
  const lwVqRate = Math.round(100 * section6.lastWeek.rfq_with_response / section6.lastWeek.rfq_lines);
  const pwVqRate = Math.round(100 * section6.priorWeek.rfq_with_response / section6.priorWeek.rfq_lines);
  const lwCqRate = section6.lastWeek.rfq_with_response > 0 ? Math.round(100 * section6.lastWeek.cq_lines / section6.lastWeek.rfq_with_response) : 0;
  const pwCqRate = section6.priorWeek.rfq_with_response > 0 ? Math.round(100 * section6.priorWeek.cq_lines / section6.priorWeek.rfq_with_response) : 0;
  const lwSoRate = section6.lastWeek.cq_lines > 0 ? Math.round(100 * section6.lastWeek.so_lines / section6.lastWeek.cq_lines) : 0;
  const pwSoRate = section6.priorWeek.cq_lines > 0 ? Math.round(100 * section6.priorWeek.so_lines / section6.priorWeek.cq_lines) : 0;
  const lwOverallRate = Math.round(100 * section6.lastWeek.so_lines / section6.lastWeek.rfq_lines);
  const pwOverallRate = Math.round(100 * section6.priorWeek.so_lines / section6.priorWeek.rfq_lines);

  // Generate observations
  const observations = generateObservations(section1, section2, section3, section6);

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
  .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  h1 { color: #1a1a1a; margin: 0 0 10px 0; font-size: 28px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 25px; }
  .section { margin-bottom: 35px; }
  .section-title { font-size: 18px; font-weight: 600; color: #2c5282; margin-bottom: 15px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
  th { background-color: #f7fafc; padding: 10px; text-align: left; font-weight: 600; color: #2d3748; border-bottom: 2px solid #e2e8f0; }
  td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
  .metric-card { display: inline-block; background: #f8f9fa; padding: 15px 20px; margin: 8px 8px 8px 0; border-radius: 6px; border-left: 4px solid #4299e1; }
  .metric-label { font-size: 12px; color: #666; text-transform: uppercase; font-weight: 600; }
  .metric-value { font-size: 24px; font-weight: 700; color: #1a1a1a; margin: 5px 0; }
  .metric-change { font-size: 13px; color: #666; }
  .metric-change.positive { color: #48bb78; }
  .metric-change.negative { color: #f56565; }
  .win-item { padding: 12px; background: #f7fafc; margin-bottom: 8px; border-radius: 4px; border-left: 3px solid #48bb78; }
  .alert-item { padding: 12px; background: #fff5f5; margin-bottom: 8px; border-radius: 4px; border-left: 3px solid #fc8181; }
  .region-usa { border-left-color: #4299e1; }
  .region-mex { border-left-color: #48bb78; }
  .region-apac { border-left-color: #ed8936; }
  .target-status { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
  .target-on-track { background: #c6f6d5; color: #22543d; }
  .target-below { background: #fed7d7; color: #742a2a; }
  .target-exceeded { background: #bee3f8; color: #2c5282; }
  .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #718096; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>📊 Sales Pulse — Weekly Edition</h1>
  <div class="subtitle">Week of ${formatDate(lastWeekStart)} - ${formatDate(lastWeekEnd)} | Generated ${formatDate(today)}</div>

  <!-- Section 1: Week Summary -->
  <div class="section">
    <div class="section-title">📈 Last Week Summary (vs Prior Week)</div>

    <div class="metric-card">
      <div class="metric-label">RFQ Lines Entered</div>
      <div class="metric-value">${section1.lw_rfq_lines}</div>
      <div class="metric-change ${rfqChange >= 0 ? 'positive' : 'negative'}">
        ${rfqChange >= 0 ? '▲' : '▼'} ${Math.abs(rfqChange)} (${Math.abs(rfqPct)}%) vs prior week
      </div>
    </div>

    <div class="metric-card">
      <div class="metric-label">CQ Lines Entered</div>
      <div class="metric-value">${section1.lw_cq_lines}</div>
      <div class="metric-change ${cqChange >= 0 ? 'positive' : 'negative'}">
        ${cqChange >= 0 ? '▲' : '▼'} ${Math.abs(cqChange)} (${Math.abs(cqPct)}%) vs prior week
      </div>
    </div>

    <div class="metric-card">
      <div class="metric-label">CQ Lines Sold</div>
      <div class="metric-value">${section1.lw_cq_sold}</div>
    </div>

    <div class="metric-card">
      <div class="metric-label">SO Lines Booked</div>
      <div class="metric-value">${section1.lw_so_lines}</div>
      <div class="metric-change ${soChange >= 0 ? 'positive' : 'negative'}">
        ${soChange >= 0 ? '▲' : '▼'} ${Math.abs(soChange)} (${Math.abs(soPct)}%) vs prior week
      </div>
    </div>

    <div class="metric-card">
      <div class="metric-label">$ Booked</div>
      <div class="metric-value">${formatCurrency(section1.lw_so_amount)}</div>
      <div class="metric-change ${amountChange >= 0 ? 'positive' : 'negative'}">
        ${amountChange >= 0 ? '▲' : '▼'} ${formatCurrency(Math.abs(amountChange))} (${Math.abs(amountPct)}%) vs prior week
      </div>
    </div>
  </div>

  <!-- Section 2: By Region -->
  <div class="section">
    <div class="section-title">🌍 By Region (Week Totals vs Prior Week)</div>
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th>RFQ Lines</th>
          <th>CQ Lines</th>
          <th>CQ Sold</th>
          <th>$ Booked</th>
        </tr>
      </thead>
      <tbody>
        ${section2.map(r => {
          const rfqChange = parseInt(r.rfq_lines) - parseInt(r.pw_rfq_lines);
          const rfqPct = r.pw_rfq_lines > 0 ? Math.round(100 * rfqChange / r.pw_rfq_lines) : 0;
          const cqChange = parseInt(r.cq_lines) - parseInt(r.pw_cq_lines);
          const cqPct = r.pw_cq_lines > 0 ? Math.round(100 * cqChange / r.pw_cq_lines) : 0;
          const amtChange = parseFloat(r.so_amount) - parseFloat(r.pw_so_amount);
          const amtPct = r.pw_so_amount > 0 ? Math.round(100 * amtChange / r.pw_so_amount) : 0;

          return `
          <tr>
            <td><strong>${r.region}</strong></td>
            <td>${r.rfq_lines} <span style="color: ${rfqChange >= 0 ? '#48bb78' : '#f56565'}; font-size: 12px;">(${rfqChange >= 0 ? '▲' : '▼'}${Math.abs(rfqPct)}%)</span></td>
            <td>${r.cq_lines} <span style="color: ${cqChange >= 0 ? '#48bb78' : '#f56565'}; font-size: 12px;">(${cqChange >= 0 ? '▲' : '▼'}${Math.abs(cqPct)}%)</span></td>
            <td>${r.cq_sold}</td>
            <td>${formatCurrency(r.so_amount)} <span style="color: ${amtChange >= 0 ? '#48bb78' : '#f56565'}; font-size: 12px;">(${amtChange >= 0 ? '▲' : '▼'}${Math.abs(amtPct)}%)</span></td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
  </div>

  <!-- Section 3: Week's Wins -->
  <div class="section">
    <div class="section-title">🎉 Week's Wins (Top 20 Orders)</div>
    ${section3.length === 0 ? '<p style="color: #718096;">No orders booked this week</p>' : ''}
    ${section3.slice(0, 10).map(w => `
      <div class="win-item region-${w.region.toLowerCase()}">
        <strong>${w.customer}</strong> — ${formatCurrency(w.amount)} (${w.line_count} lines)<br>
        <span style="color: #718096; font-size: 13px;">Seller: ${w.seller} (${w.region})</span>
      </div>
    `).join('')}
    ${section3.length > 10 ? `<p style="color: #718096; margin-top: 10px;">${section3.length - 10} more wins (${formatCurrency(section3.slice(10).reduce((sum, w) => sum + parseFloat(w.amount), 0))})</p>` : ''}
  </div>

  <!-- Section 4: Persistent Issues -->
  <div class="section">
    <div class="section-title">⚠️ Persistent Issues (3+ Days Open This Week)</div>
    ${section4.persistentQuotes.length === 0 ? '<p style="color: #718096;">No persistent high-value quotes this week</p>' : ''}
    ${section4.persistentQuotes.map(q => `
      <div class="alert-item">
        <strong>${q.customer}</strong> — ${formatCurrency(q.total_value)} (${q.line_count} lines)<br>
        <span style="color: #718096; font-size: 13px;">
          Created ${q.created_date} (${q.days_open} days ago) | ${q.rfq_type || 'Unknown type'} | Seller: ${q.seller}
        </span>
      </div>
    `).join('')}
  </div>

  <!-- Section 5: Week vs Targets -->
  <div class="section">
    <div class="section-title">🎯 Week vs Targets (Regional)</div>
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th>RFQ Lines</th>
          <th>CQ Lines</th>
          <th>CQ Sold</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${section5.map(r => {
          const overallStatus = r.rfq_vs_target >= 90 && r.cq_vs_target >= 90 && r.cq_sold_vs_target >= 90 ? 'on-track' :
                                r.rfq_vs_target >= 100 || r.cq_vs_target >= 100 || r.cq_sold_vs_target >= 100 ? 'exceeded' : 'below';
          return `
          <tr>
            <td><strong>${r.region}</strong></td>
            <td>${r.rfq_lines} / ${r.target_rfq} <span style="color: ${r.rfq_vs_target >= 90 ? '#48bb78' : '#f56565'};">(${r.rfq_vs_target}%)</span></td>
            <td>${r.cq_lines} / ${r.target_cq} <span style="color: ${r.cq_vs_target >= 90 ? '#48bb78' : '#f56565'};">(${r.cq_vs_target}%)</span></td>
            <td>${r.cq_sold} / ${r.target_cq_sold} <span style="color: ${r.cq_sold_vs_target >= 90 ? '#48bb78' : '#f56565'};">(${r.cq_sold_vs_target}%)</span></td>
            <td><span class="target-status target-${overallStatus}">${overallStatus === 'on-track' ? '✅ On Track' : overallStatus === 'exceeded' ? '🎉 Exceeded' : '⚠️ Below'}</span></td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
  </div>

  <!-- Section 6: Conversion Funnel -->
  <div class="section">
    <div class="section-title">📊 Conversion Funnel (Last Week vs Prior Week)</div>
    <table>
      <thead>
        <tr>
          <th>Stage</th>
          <th>Last Week</th>
          <th>Prior Week</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>RFQ Lines → VQ Received</strong></td>
          <td>${lwVqRate}% (${section6.lastWeek.rfq_with_response}/${section6.lastWeek.rfq_lines})</td>
          <td>${pwVqRate}% (${section6.priorWeek.rfq_with_response}/${section6.priorWeek.rfq_lines})</td>
          <td style="color: ${lwVqRate >= pwVqRate ? '#48bb78' : '#f56565'};">
            ${lwVqRate >= pwVqRate ? '▲' : '▼'} ${Math.abs(lwVqRate - pwVqRate)}pp
          </td>
        </tr>
        <tr>
          <td><strong>VQ Received → CQ Created</strong></td>
          <td>${lwCqRate}% (${section6.lastWeek.cq_lines}/${section6.lastWeek.rfq_with_response})</td>
          <td>${pwCqRate}% (${section6.priorWeek.cq_lines}/${section6.priorWeek.rfq_with_response})</td>
          <td style="color: ${lwCqRate >= pwCqRate ? '#48bb78' : '#f56565'};">
            ${lwCqRate >= pwCqRate ? '▲' : '▼'} ${Math.abs(lwCqRate - pwCqRate)}pp
          </td>
        </tr>
        <tr>
          <td><strong>CQ Created → SO Booked</strong></td>
          <td>${lwSoRate}% (${section6.lastWeek.so_lines}/${section6.lastWeek.cq_lines})</td>
          <td>${pwSoRate}% (${section6.priorWeek.so_lines}/${section6.priorWeek.cq_lines})</td>
          <td style="color: ${lwSoRate >= pwSoRate ? '#48bb78' : '#f56565'};">
            ${lwSoRate >= pwSoRate ? '▲' : '▼'} ${Math.abs(lwSoRate - pwSoRate)}pp
          </td>
        </tr>
        <tr style="background: #f7fafc; font-weight: 600;">
          <td><strong>Overall: RFQ → SO</strong></td>
          <td>${lwOverallRate}%</td>
          <td>${pwOverallRate}%</td>
          <td style="color: ${lwOverallRate >= pwOverallRate ? '#48bb78' : '#f56565'};">
            ${lwOverallRate >= pwOverallRate ? '▲' : '▼'} ${Math.abs(lwOverallRate - pwOverallRate)}pp
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Observations -->
  <div class="section">
    <div class="section-title">💡 Key Observations</div>
    ${observations.length > 0 ? observations.map(obs => `
      <div style="padding: 12px; background: #f7fafc; margin-bottom: 8px; border-radius: 4px; border-left: 3px solid #4299e1;">
        ${obs}
      </div>
    `).join('') : '<p style="color: #718096;">No significant observations this week</p>'}
  </div>

  <!-- Section 7: Market Pulse -->
  <div class="section">
    <div class="section-title">📊 Market Pulse (Trending Manufacturers)</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th>RFQ Lines</th>
          <th>Customers</th>
          <th>vs Last Week</th>
        </tr>
      </thead>
      <tbody>
        ${section7.trendingMfrs.map(m => `
          <tr>
            <td><strong>${m.mfr}</strong></td>
            <td>${m.tw_rfq_count}</td>
            <td>${m.tw_customer_count}</td>
            <td style="color: ${parseInt(m.pct_change) >= 0 ? '#48bb78' : '#f56565'};">
              ${parseInt(m.pct_change) >= 0 ? '▲' : '▼'} ${Math.abs(parseInt(m.pct_change) || 0)}%
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">
    📧 Questions? Reply to this email<br>
    Generated with Claude Code • ${formatDate(new Date())}
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
  console.log('Sales Pulse Weekly - Building Friday edition...');

  try {
    const section1 = await collectSection1Metrics();
    const section2 = await collectSection2Metrics();
    const section3 = await collectSection3Metrics();
    const section4 = await collectSection4Metrics();
    const section5 = await collectSection5Metrics();
    const section6 = await collectSection6Metrics();
    const section7 = await collectSection7Metrics();

    const html = buildEmail(section1, section2, section3, section4, section5, section6, section7);

    const outputDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `sales-pulse-weekly-${timestamp}.html`);
    const jsonPath = path.join(outputDir, `sales-pulse-weekly-${timestamp}.json`);

    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
      section1,
      section2,
      section3,
      section4,
      section5,
      section6,
      section7
    }, null, 2));

    console.log(`✅ Weekly Sales Pulse generated`);
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

module.exports = { main };
