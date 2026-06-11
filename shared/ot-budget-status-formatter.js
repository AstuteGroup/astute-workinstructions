/**
 * shared/ot-budget-status-formatter.js
 *
 * Formats global OT API budget status for inclusion in ops digests.
 * Can be embedded in any digest email (Stock RFQ, VQ loading, etc.)
 *
 * Usage:
 *   const { getOTBudgetStatusHTML, getOTBudgetStatusText } = require('../shared/ot-budget-status-formatter');
 *
 *   // For HTML emails
 *   const budgetSection = getOTBudgetStatusHTML();
 *   const html = `<html><body>...<br/>${budgetSection}</body></html>`;
 *
 *   // For plain text emails/logs
 *   const budgetText = getOTBudgetStatusText();
 *   console.log(budgetText);
 */

'use strict';

const otBudget = require('./ot-api-budget');

/**
 * Get budget status as HTML (for email digests)
 */
function getOTBudgetStatusHTML() {
  const status = otBudget.getStatus();
  const budget = status.globalBudget;

  // Parse counts (format: "123/800")
  const parse = (str) => {
    const [used, limit] = str.split('/').map(Number);
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return { used, limit, pct };
  };

  const min5 = parse(budget.last5Min);
  const min15 = parse(budget.last15Min);
  const hour = parse(budget.lastHour);

  // Color based on usage
  const getColor = (pct) => {
    if (pct >= 90) return '#d32f2f'; // Red - very high
    if (pct >= 75) return '#f57c00'; // Orange - high
    if (pct >= 50) return '#fbc02d'; // Yellow - moderate
    return '#388e3c';                // Green - low
  };

  const circuitStatus = status.circuitBreaker === 'OPEN'
    ? `<span style="color:#d32f2f;font-weight:bold">⚠️ OPEN</span> - ${status.circuitBreakerReason}`
    : '<span style="color:#388e3c">✓ Closed</span>';

  const backfillStatus = status.activeBackfills.length > 0
    ? status.activeBackfills.map(b => `${b.caller} (${b.minutesAgo}m ago)`).join(', ')
    : '<span style="color:#999">None</span>';

  return `
<div style="border:1px solid #ddd;padding:12px;margin:10px 0;border-radius:4px;background:#f9f9f9;font-family:monospace;font-size:12px">
  <h3 style="margin:0 0 8px 0;color:#333;font-size:14px">🔒 Global OT API Budget</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee"><b>5-min window:</b></td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">
        <span style="color:${getColor(min5.pct)};font-weight:bold">${min5.used}/${min5.limit}</span>
        <span style="color:#666;margin-left:8px">(${min5.pct}%)</span>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee"><b>15-min window:</b></td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">
        <span style="color:${getColor(min15.pct)};font-weight:bold">${min15.used}/${min15.limit}</span>
        <span style="color:#666;margin-left:8px">(${min15.pct}%)</span>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Hourly window:</b></td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">
        <span style="color:${getColor(hour.pct)};font-weight:bold">${hour.used}/${hour.limit}</span>
        <span style="color:#666;margin-left:8px">(${hour.pct}%)</span>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Circuit breaker:</b></td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${circuitStatus}</td>
    </tr>
    <tr>
      <td style="padding:4px 8px"><b>Active backfills:</b></td>
      <td style="padding:4px 8px;text-align:right">${backfillStatus}</td>
    </tr>
  </table>
  <div style="margin-top:8px;font-size:10px;color:#666">
    <i>Limits prevent June 1 repeat (2,933 VQs crashed API). 5-min burst limit is critical protection.</i>
  </div>
</div>
`;
}

/**
 * Get budget status as plain text (for console/logs)
 */
function getOTBudgetStatusText() {
  const status = otBudget.getStatus();
  const budget = status.globalBudget;

  const lines = [
    '=== Global OT API Budget ===',
    `5-min window:   ${budget.last5Min}`,
    `15-min window:  ${budget.last15Min}`,
    `Hourly window:  ${budget.lastHour}`,
    `Daily window:   ${budget.lastDay}`,
    `Circuit breaker: ${status.circuitBreaker}${status.circuitBreakerReason ? ' - ' + status.circuitBreakerReason : ''}`,
    `Active backfills: ${status.activeBackfills.length > 0 ? status.activeBackfills.map(b => `${b.caller} (${b.minutesAgo}m)`).join(', ') : 'None'}`,
    `Active reservations: ${status.activeReservations}`,
  ];

  return lines.join('\n');
}

/**
 * Get budget status as compact summary (for subject lines/alerts)
 */
function getOTBudgetSummary() {
  const status = otBudget.getStatus();
  const budget = status.globalBudget;

  const parse = (str) => {
    const [used, limit] = str.split('/').map(Number);
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return { used, limit, pct };
  };

  const min5 = parse(budget.last5Min);

  if (status.circuitBreaker === 'OPEN') {
    return '⚠️ CIRCUIT BREAKER OPEN';
  }

  if (min5.pct >= 90) {
    return `⚠️ API BUDGET HIGH (${min5.pct}% of 5-min limit)`;
  }

  if (min5.pct >= 75) {
    return `⚡ API budget ${min5.pct}% (elevated)`;
  }

  return `✓ API budget ${min5.pct}%`;
}

module.exports = {
  getOTBudgetStatusHTML,
  getOTBudgetStatusText,
  getOTBudgetSummary,
};
