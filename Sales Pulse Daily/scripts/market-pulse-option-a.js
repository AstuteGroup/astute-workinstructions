#!/usr/bin/env node
/**
 * Market Pulse Weekly - Option A (Dashboard-Style Format)
 *
 * Generates Market Pulse report in dashboard format with:
 * - Tier 1: Executive Insights (3 cards side-by-side)
 * - Tier 2: Supporting Intelligence (expandable sections with FULL data)
 *
 * Usage:
 *   node market-pulse-option-a.js [week-number]
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Week to analyze (default: 25, can override via command line)
const WEEK_NUM = process.argv[2] ? parseInt(process.argv[2]) : 25;

// Import helper functions from original script
const originalScriptPath = path.join(__dirname, 'market-pulse-week25.js');
const originalScript = fs.readFileSync(originalScriptPath, 'utf8');

// Extract all helper functions and data structures (everything before main())
const functionsCode = originalScript.substring(0, originalScript.indexOf('async function main()'));

// Evaluate to get access to functions
eval(functionsCode);

/**
 * Build Option A HTML with real data
 */
function buildOptionAHTML(snapshot, bookingsData, billingsData, constraintIndicators, temperatureGauge, externalMarketData) {
  const { currentWeek, current, prior, kla } = snapshot;

  // Calculate key metrics (CHANGED: Use current.total instead of current.exKLA for headline numbers)
  const bookingsGP = current.total.bookings.total.gp;
  const billingsGP = current.total.billings.total.gp;
  const bookingsGM = current.total.bookings.total.gm;
  const billingsGM = current.total.billings.total.gm;
  const bbRatio = billingsGP > 0 ? (bookingsGP / billingsGP) : 0;

  // Generate date/time stamp with AM/PM/End of Day indicator
  const now = new Date();
  const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = centralTime.getHours();
  const timeOfDay = hour < 12 ? 'AM' : hour < 18 ? 'PM' : 'End of Day';
  const dateFormatted = centralTime.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const bookingsWoW = prior.total.bookings.total.gp > 0 ?
    ((bookingsGP - prior.total.bookings.total.gp) / prior.total.bookings.total.gp) * 100 : 0;
  const billingsWoW = prior.total.billings.total.gp > 0 ?
    ((billingsGP - prior.total.billings.total.gp) / prior.total.billings.total.gp) * 100 : 0;

  // Temperature gauge info
  const marketState = temperatureGauge.temperature;
  const totalSignals = temperatureGauge.totalSignals;
  const allocatedCount = temperatureGauge.allocatedCount;
  const constrainedCount = temperatureGauge.constrainedCount;
  const shortageCount = temperatureGauge.shortageSignalCount;
  const recoveryCount = temperatureGauge.recoveryCount || 0;

  // Generate top 3 actions
  const actions = generateTopActions(constraintIndicators, temperatureGauge, externalMarketData);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Market Pulse — Week ${currentWeek}</title>
<style>
  * {
    box-sizing: border-box;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
    background: #f5f5f5;
  }
  .container {
    background: white;
    padding: 24px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 4px 0;
    color: #1a1a1a;
  }
  .subtitle {
    font-size: 12px;
    color: #666;
    margin-bottom: 24px;
  }
  .report-timestamp {
    font-size: 13px;
    color: #64748b;
    margin: 8px 0 16px 0;
    font-weight: 500;
  }
  .report-note {
    font-size: 11px;
    color: #64748b;
    margin-bottom: 24px;
    font-style: italic;
    line-height: 1.5;
  }

  /* Tier 1: Executive Insights */
  .tier1 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-bottom: 32px;
    padding-bottom: 32px;
    border-bottom: 3px solid #e0e0e0;
  }
  .insight-card {
    background: #f5f5f5;
    border: 2px solid #cbd5e1;
    border-radius: 8px;
    padding: 20px;
    min-height: 360px;
    display: flex;
    flex-direction: column;
  }
  .insight-card h2 {
    font-size: 14px;
    font-weight: 700;
    margin: 0 0 8px 0;
    padding-bottom: 8px;
    border-bottom: 2px solid #cbd5e1;
    color: #1e293b;
  }
  .insight-card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  /* Market Lifecycle Grid (replacing single state) */
  .lifecycle-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin: 16px 0;
  }
  .lifecycle-item {
    background: white;
    padding: 10px;
    border-radius: 6px;
    border-left: 3px solid #cbd5e1;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .lifecycle-item.allocated {
    border-left-color: #dc2626;
  }
  .lifecycle-item.constrained {
    border-left-color: #ea580c;
  }
  .lifecycle-item.recovery {
    border-left-color: #3b82f6;
  }
  .lifecycle-item.normal {
    border-left-color: #10b981;
  }
  .lifecycle-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
  }
  .lifecycle-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .lifecycle-count {
    font-size: 16px;
    font-weight: 700;
  }
  .overall-state {
    text-align: center;
    padding: 12px;
    background: white;
    border-radius: 6px;
    margin-top: 12px;
  }
  .overall-state-name {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .overall-state-sub {
    font-size: 11px;
    color: #666;
  }

  .breakdown {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #475569;
  }
  .breakdown-items {
    font-size: 11px;
    color: #666;
    line-height: 1.8;
  }
  .metric-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 12px;
    padding: 8px 0;
    border-bottom: 1px solid #e2e8f0;
  }
  .metric-row:last-of-type {
    border-bottom: none;
  }
  .metric-label {
    font-size: 12px;
    font-weight: 600;
    color: #475569;
  }
  .metric-value {
    font-size: 14px;
    font-weight: 700;
    color: #1e293b;
  }
  .metric-sub {
    font-size: 11px;
    color: #666;
    margin-left: 8px;
  }
  .why-matters {
    margin-top: 16px;
    padding: 12px;
    background: white;
    border-left: 3px solid #3b82f6;
    border-radius: 4px;
    font-size: 11px;
    color: #1e40af;
    line-height: 1.5;
  }
  .why-matters strong {
    display: block;
    margin-bottom: 4px;
    color: #1e293b;
  }
  .action-item {
    background: white;
    border-left: 3px solid #3b82f6;
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 10px;
    font-size: 11px;
  }
  .action-item-title {
    font-size: 12px;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 6px;
  }
  .action-item-detail {
    color: #475569;
    margin-bottom: 3px;
    line-height: 1.5;
  }
  .action-expand {
    color: #3b82f6;
    cursor: pointer;
    font-size: 10px;
    margin-top: 6px;
    font-weight: 600;
  }
  .action-expand:hover {
    text-decoration: underline;
  }
  .action-detail-content {
    display: none;
    margin-top: 8px;
    padding: 8px;
    background: #fffbeb;
    border-radius: 4px;
    font-size: 10px;
    line-height: 1.6;
  }
  .action-detail-content.show {
    display: block;
  }
  .warning-box {
    margin-top: 12px;
    padding: 8px;
    background: #fef3c7;
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    font-size: 10px;
    color: #92400e;
    line-height: 1.5;
  }

  /* Tier 2: Supporting Intelligence */
  .tier2-title {
    font-size: 18px;
    font-weight: 700;
    margin: 32px 0 16px 0;
    color: #1e293b;
    padding-bottom: 8px;
    border-bottom: 2px solid #cbd5e1;
  }
  .expandable-section {
    background: #f5f5f5;
    border: 2px solid #cbd5e1;
    border-radius: 8px;
    margin-bottom: 16px;
    overflow: hidden;
  }
  .expandable-header {
    padding: 16px 20px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: white;
    border-bottom: 1px solid #cbd5e1;
  }
  .expandable-header:hover {
    background: #f8fafc;
  }
  .expandable-title {
    font-size: 14px;
    font-weight: 700;
    color: #1e293b;
  }
  .expandable-subtitle {
    font-size: 11px;
    color: #64748b;
    font-style: italic;
    margin-top: 2px;
  }
  .expandable-toggle {
    font-size: 24px;
    color: #3b82f6;
    font-weight: 700;
    line-height: 1;
    user-select: none;
  }
  .expandable-content {
    padding: 20px;
    display: none;
    background: white;
  }
  .expandable-content.expanded {
    display: block;
  }

  /* Reference badge */
  .reference-badge {
    display: inline-block;
    background: #f59e0b;
    color: white;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    margin-left: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    margin: 16px 0;
    background: white;
  }
  th {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    padding: 8px;
    text-align: left;
    font-weight: 600;
    font-size: 10px;
    color: #475569;
  }
  td {
    border: 1px solid #e2e8f0;
    padding: 8px;
    font-size: 11px;
  }
  tr:hover {
    background: #fafafa !important;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    border-bottom: 2px solid #e2e8f0;
  }
  .tab {
    padding: 10px 20px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: #64748b;
    border-bottom: 3px solid transparent;
    margin-bottom: -2px;
    user-select: none;
  }
  .tab:hover {
    color: #3b82f6;
    background: #f8fafc;
  }
  .tab.active {
    color: #3b82f6;
    border-bottom-color: #3b82f6;
  }
  .tab-content {
    display: none;
  }
  .tab-content.active {
    display: block;
  }

  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #e0e0e0;
    font-size: 11px;
    color: #666;
    line-height: 1.6;
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    .tier1 {
      grid-template-columns: 1fr;
    }
    .lifecycle-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
<script>
  function toggleSection(id) {
    const content = document.getElementById(id);
    const toggle = document.getElementById(id + '-toggle');
    if (content.classList.contains('expanded')) {
      content.classList.remove('expanded');
      toggle.textContent = '+';
    } else {
      content.classList.add('expanded');
      toggle.textContent = '−';
    }
  }

  function showTab(sectionId, tabName) {
    const section = document.getElementById(sectionId);
    const tabs = section.querySelectorAll('.tab');
    const contents = section.querySelectorAll('.tab-content');

    tabs.forEach(tab => tab.classList.remove('active'));
    contents.forEach(content => content.classList.remove('active'));

    document.getElementById(sectionId + '-tab-' + tabName).classList.add('active');
    document.getElementById(sectionId + '-content-' + tabName).classList.add('active');
  }

  function toggleActionDetail(id) {
    const content = document.getElementById(id);
    const link = document.getElementById(id + '-link');
    if (content.classList.contains('show')) {
      content.classList.remove('show');
      link.textContent = '[+ View full details]';
    } else {
      content.classList.add('show');
      link.textContent = '[− Hide details]';
    }
  }
</script>
</head>
<body>
<div class="container">
  <h1>📊 Market Pulse — Week ${currentWeek}</h1>
  <div class="subtitle">Executive insights at-a-glance • Deep dive data on demand</div>
  <div class="report-timestamp">Report Generated: ${dateFormatted} — ${timeOfDay}</div>
  <div class="report-note">Note: This report reflects data available at time of generation and may not include complete Week ${currentWeek} activity.</div>

  <!-- TIER 1: EXECUTIVE INSIGHTS -->
  <div class="tier1">

    <!-- Card 1: Executive Brief - WoW Performance, Market Shifts, Top Actions -->
    <div class="insight-card" style="grid-column: 1 / -1; min-height: auto;">
      <h2>📊 WEEK ${currentWeek} EXECUTIVE BRIEF</h2>
      <div class="insight-card-body">
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">

          <!-- Column 1: Performance WoW -->
          <div>
            <div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #cbd5e1;">
              📈 PERFORMANCE vs LAST WEEK
            </div>
            <div style="font-size: 11px; line-height: 2.0;">
              <!-- Bookings GP -->
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px; padding: 6px; background: white; border-radius: 4px;">
                <span style="color: #475569; font-weight: 600;">Bookings GP:</span>
                <div style="text-align: right;">
                  <div style="font-weight: 700; font-size: 12px; color: #1e293b;">${formatCurrency(bookingsGP, true)}</div>
                  <div style="color: ${bookingsWoW >= 0 ? '#10b981' : '#dc2626'}; font-weight: 600; font-size: 10px;">
                    ${bookingsWoW >= 0 ? '↑' : '↓'} ${Math.abs(bookingsWoW).toFixed(0)}% WoW
                  </div>
                </div>
              </div>
              <!-- Bookings GM -->
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px; padding: 6px; background: white; border-radius: 4px;">
                <span style="color: #475569; font-weight: 600;">Bookings GM:</span>
                <div style="text-align: right;">
                  <div style="font-weight: 700; font-size: 12px; color: #1e293b;">${formatPercent(bookingsGM)}</div>
                  <div style="color: ${(bookingsGM - prior.exKLA.bookings.total.gm) >= 0 ? '#10b981' : '#dc2626'}; font-weight: 600; font-size: 10px;">
                    ${(bookingsGM - prior.exKLA.bookings.total.gm) >= 0 ? '↑' : '↓'} ${Math.abs((bookingsGM - prior.exKLA.bookings.total.gm) * 100).toFixed(1)} pts (${prior.exKLA.bookings.total.gm > 0 ? ((bookingsGM - prior.exKLA.bookings.total.gm) / prior.exKLA.bookings.total.gm * 100).toFixed(0) : '0'}%)
                  </div>
                </div>
              </div>
              <!-- Billings GP -->
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px; padding: 6px; background: white; border-radius: 4px;">
                <span style="color: #475569; font-weight: 600;">Billings GP:</span>
                <div style="text-align: right;">
                  <div style="font-weight: 700; font-size: 12px; color: #1e293b;">${formatCurrency(billingsGP, true)}</div>
                  <div style="color: ${billingsWoW >= 0 ? '#10b981' : '#dc2626'}; font-weight: 600; font-size: 10px;">
                    ${billingsWoW >= 0 ? '↑' : '↓'} ${Math.abs(billingsWoW).toFixed(0)}% WoW
                  </div>
                </div>
              </div>
              <!-- Billings GM -->
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px; padding: 6px; background: white; border-radius: 4px;">
                <span style="color: #475569; font-weight: 600;">Billings GM:</span>
                <div style="text-align: right;">
                  <div style="font-weight: 700; font-size: 12px; color: #1e293b;">${formatPercent(billingsGM)}</div>
                  <div style="color: ${(billingsGM - prior.exKLA.billings.total.gm) >= 0 ? '#10b981' : '#dc2626'}; font-weight: 600; font-size: 10px;">
                    ${(billingsGM - prior.exKLA.billings.total.gm) >= 0 ? '↑' : '↓'} ${Math.abs((billingsGM - prior.exKLA.billings.total.gm) * 100).toFixed(1)} pts (${prior.exKLA.billings.total.gm > 0 ? ((billingsGM - prior.exKLA.billings.total.gm) / prior.exKLA.billings.total.gm * 100).toFixed(0) : '0'}%)
                  </div>
                </div>
              </div>
              <!-- B/B Ratio -->
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; padding: 6px; background: white; border-radius: 4px;">
                <span style="color: #475569; font-weight: 600;">B/B Ratio:</span>
                <div style="text-align: right;">
                  <div style="font-weight: 700; font-size: 12px; color: ${bbRatio >= 1.0 ? '#10b981' : '#dc2626'};">${bbRatio.toFixed(2)}x</div>
                  <div style="font-size: 9px; color: #64748b;">${bbRatio >= 1.0 ? 'Building backlog' : 'Consuming backlog'}</div>
                </div>
              </div>
              <!-- Alert box -->
              <div style="padding: 8px; background: ${Math.abs((bookingsGM - prior.exKLA.bookings.total.gm) * 100) > 10 ? '#fef3c7' : '#f0fdf4'}; border-radius: 4px; font-size: 10px; line-height: 1.5; border-left: 3px solid ${Math.abs((bookingsGM - prior.exKLA.bookings.total.gm) * 100) > 10 ? '#f59e0b' : '#10b981'};">
                ${Math.abs((bookingsGM - prior.exKLA.bookings.total.gm) * 100) > 10 ?
                  `🔴 <strong>CRITICAL:</strong> Bookings margin ${(bookingsGM - prior.exKLA.bookings.total.gm) < 0 ? 'dropped' : 'surged'} ${Math.abs((bookingsGM - prior.exKLA.bookings.total.gm) * 100).toFixed(1)} points` :
                  `🟢 <strong>STABLE:</strong> Margins within normal range`
                }
              </div>
              <!-- KLA Business Footer Note -->
              <div style="margin-top: 12px; padding: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 10px; color: #64748b; line-height: 1.5;">
                <strong style="color: #475569;">Note on KLA Business:</strong> Metrics include KLA Research consignment business (C_BPartner_ID: 1000481). Week ${currentWeek} KLA impact: Bookings ${formatCurrency(kla.bookings.gp, true)} (${kla.bookings.gp > 0 && bookingsGP > 0 ? Math.round((kla.bookings.gp / bookingsGP) * 100) : 0}% of total), Billings ${formatCurrency(kla.billings.gp, true)} (${kla.billings.gp > 0 && billingsGP > 0 ? Math.round((kla.billings.gp / billingsGP) * 100) : 0}% of total). Billings spikes reflect consignment shipments, not new sales activity.
              </div>
            </div>
          </div>

          <!-- Column 2: Market Shifts WoW -->
          <div>
            <div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #cbd5e1;">
              🌍 MARKET SHIFTS WoW
            </div>
            <div style="font-size: 11px; line-height: 1.8;">
              ${externalMarketData.map(cat => {
                let icon = '';
                let label = '';
                let color = '';
                if (cat.category.includes('MLCC')) {
                  icon = '🆕';
                  label = 'NEW CONSTRAINT';
                  color = '#dc2626';
                } else if (cat.status === 'Normal' && cat.category.includes('Logic')) {
                  icon = '🟢';
                  label = 'IMPROVED';
                  color = '#10b981';
                } else if (cat.status === 'Allocated' && cat.keySignals.includes('sold out')) {
                  icon = '🔴';
                  label = 'WORSENING';
                  color = '#dc2626';
                }
                if (!icon) return '';
                return `
                <div style="margin-bottom: 10px; padding: 8px; background: white; border-left: 3px solid ${color}; border-radius: 4px;">
                  <div style="font-weight: 700; color: ${color}; font-size: 11px; margin-bottom: 3px;">
                    ${icon} ${cat.category} → ${label}
                  </div>
                  <div style="color: #64748b; font-size: 10px; line-height: 1.4;">
                    ${cat.industryLeadTime} lead times${cat.keySignals.includes('price') ? ', price surge' : ''}
                  </div>
                </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Column 3: Top Actions -->
          <div>
            <div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #cbd5e1;">
              🎯 TOP 3 ACTIONS THIS WEEK
            </div>
            <div style="font-size: 10px; line-height: 1.6;">
              ${actions.slice(0, 3).map((action, i) => `
              <div style="margin-bottom: 12px; padding: 8px; background: #fefce8; border-left: 3px solid #eab308; border-radius: 4px;">
                <div style="font-weight: 700; color: #854d0e; margin-bottom: 4px;">
                  ${i + 1}. ${action.title}
                </div>
                <div style="color: #78716c; margin-bottom: 2px; font-size: 9px;">
                  <strong>Internal:</strong> ${action.internal.substring(0, 80)}${action.internal.length > 80 ? '...' : ''}
                </div>
                <div style="color: #78716c; margin-bottom: 4px; font-size: 9px;">
                  <strong>External:</strong> ${action.external.substring(0, 80)}${action.external.length > 80 ? '...' : ''}
                </div>
                <div id="exec-action-${i}-detail-link" style="color: #3b82f6; cursor: pointer; font-size: 9px; font-weight: 600; margin-top: 4px;" onclick="toggleActionDetail('exec-action-${i}-detail')">
                  [+ View full action details]
                </div>
                <div id="exec-action-${i}-detail" class="action-detail-content" style="margin-top: 8px; padding: 8px; background: #fffbeb; border-radius: 4px; font-size: 9px; line-height: 1.6; color: #78350f;">
                  <strong>ACTION:</strong> ${action.action}
                </div>
              </div>
              `).join('')}
            </div>
          </div>

        </div>
      </div>
    </div>

  </div>

  <!-- TIER 2: SUPPORTING INTELLIGENCE -->
  <div class="tier2-title">📊 SUPPORTING INTELLIGENCE</div>
  <div style="font-size: 11px; color: #64748b; margin-bottom: 20px; font-style: italic;">
    Click any section below to expand detailed data tables and analysis
  </div>

  <!-- Section 1: Constraint Signals (Merged 3a + 4 + 3b) -->
  <div class="expandable-section">
    <div class="expandable-header" onclick="toggleSection('constraint-signals')">
      <div>
        <div class="expandable-title">🚨 Constraint Signals — Market Temperature (30-Day Rolling)</div>
        <div class="expandable-subtitle">
          Early warning signals from OT data: Part families, manufacturers, and franchise lead times
        </div>
      </div>
      <div class="expandable-toggle" id="constraint-signals-toggle">+</div>
    </div>
    <div id="constraint-signals" class="expandable-content">
      <p style="font-size: 11px; color: #666; margin-bottom: 16px; line-height: 1.6;">
        <strong>What this shows:</strong> Three complementary views of supply constraints detected in OT data:<br>
        • <strong>By Part Family:</strong> Which specific part families (TPS*, SN74*, etc.) have 2+ OEM customers requesting in shortage RFQs<br>
        • <strong>By Manufacturer:</strong> Aggregated view showing which manufacturers are driving shortage-related revenue<br>
        • <strong>By Lead Time:</strong> Franchise distributor lead times as early warning indicator of factory constraints
      </p>

      <div id="constraint-tabs">
        <div class="tabs">
          <div class="tab active" id="constraint-tabs-tab-families" onclick="showTab('constraint-tabs', 'families')">
            By Part Family
          </div>
          <div class="tab" id="constraint-tabs-tab-manufacturers" onclick="showTab('constraint-tabs', 'manufacturers')">
            By Manufacturer
          </div>
          <div class="tab" id="constraint-tabs-tab-leadtimes" onclick="showTab('constraint-tabs', 'leadtimes')">
            By Lead Time
          </div>
        </div>

        <!-- Tab 1: By Part Family (FULL DATA) -->
        <div id="constraint-tabs-content-families" class="tab-content active">
          <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">
            🔥 Hot Part Families — Shortage Signals (2+ OEM Customers)
          </h4>
          ${generatePartFamilyTable(constraintIndicators.multiCustomerParts, false)}
        </div>

        <!-- Tab 2: By Manufacturer (FULL DATA) -->
        <div id="constraint-tabs-content-manufacturers" class="tab-content">
          <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">
            📊 Trending Shortage Manufacturers — All Results by Booked GP
          </h4>
          <p style="font-size: 10px; color: #ea580c; font-style: italic; margin-bottom: 12px;">
            <strong>Note:</strong> This is manufacturer-level aggregation of the part family data shown in the previous tab. Same underlying shortage RFQ data, grouped differently.
          </p>
          ${generateManufacturerTable(constraintIndicators.trendingMfrs, false)}
        </div>

        <!-- Tab 3: By Lead Time (FULL DATA) -->
        <div id="constraint-tabs-content-leadtimes" class="tab-content">
          <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">
            📊 Franchise Lead Time Analysis — Market Temperature by Part Type
          </h4>
          ${generateLeadTimeTable(constraintIndicators.franchiseLeadTimes, false)}
        </div>
      </div>
    </div>
  </div>

  <!-- Section 2: External Market Validation -->
  <div class="expandable-section">
    <div class="expandable-header" onclick="toggleSection('external-market')">
      <div>
        <div class="expandable-title">📡 External Market Validation — Industry Lifecycle Check</div>
        <div class="expandable-subtitle">
          How do external industry signals compare to our internal OT data?
        </div>
      </div>
      <div class="expandable-toggle" id="external-market-toggle">+</div>
    </div>
    <div id="external-market" class="expandable-content">
      <p style="font-size: 11px; color: #666; margin-bottom: 12px; line-height: 1.6;">
        <strong>Data Source:</strong> Industry market reports (Sourceability, Avnet, J2 Sourcing, Deloitte)<br>
        <strong>Last Updated:</strong> 7/02/26<br>
        <strong>Purpose:</strong> Validate whether our internal signals match market-wide trends or if we have competitive advantages
      </p>
      ${generateExternalMarketTable(externalMarketData)}

      <div style="margin-top: 16px; padding: 12px; background: white; border-left: 4px solid #3b82f6; border-radius: 4px;">
        <p style="font-size: 11px; color: #1e40af; margin: 0; line-height: 1.6;">
          <strong>💡 Sales Action Guide:</strong><br>
          • ✅ <strong>MATCHES</strong> → Confirmed market-wide shortage; premium pricing justified, proactive customer outreach<br>
          • ⚠️ <strong>BETTER SUPPLY</strong> → Competitive advantage! Market aggressively: "We have what competitors don't"<br>
          • ⚠️ <strong>WATCH</strong> → Monitor for pricing pressure; may need to adjust margins to remain competitive
        </p>
      </div>
    </div>
  </div>

  <!-- Section 3: External Data Sources -->
  <div class="expandable-section">
    <div class="expandable-header" onclick="toggleSection('external-sources')">
      <div>
        <div class="expandable-title">🔗 External Data Sources — Market Intelligence Links</div>
        <div class="expandable-subtitle">
          Direct links to industry sources used for external market validation
        </div>
      </div>
      <div class="expandable-toggle" id="external-sources-toggle">+</div>
    </div>
    <div id="external-sources" class="expandable-content">
      <p style="font-size: 11px; color: #666; margin-bottom: 16px; line-height: 1.6;">
        <strong>Purpose:</strong> These articles and reports informed the Week ${currentWeek} external market intelligence. Click any link to review the source material.<br>
        <strong>Note:</strong> Links are updated weekly as new market intelligence is researched.<br>
        <strong>Week 27 Update (Jul 2, 2026):</strong> Multiple manufacturer price increases effective THIS WEEK (Jul 1-6) + comprehensive market research on memory, MLCCs, and MCU constraints.
      </p>

      <!-- MANUFACTURER PRICE INCREASES (This Week) -->
      <div style="background: #fffbeb; border-left: 3px solid #f59e0b; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #92400e; margin-bottom: 8px;">
          🚨 MANUFACTURER PRICE INCREASES — EFFECTIVE THIS WEEK (Jul 1-6, 2026)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <strong>Infineon:</strong> 2nd increase of 2026 on power devices (effective Jul 1, 2026) — <a href="https://www.trendforce.com/news/2026/05/27/news-infineon-announces-second-2026-price-hike-effective-july-1-amid-rising-supply-chain-costs-strong-demand/" target="_blank" style="color: #3b82f6; text-decoration: none;">TrendForce (May 27, 2026)</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Texas Instruments:</strong> 2nd increase of 2026 on PMICs and MOSFETs (effective Jul 1, 2026) — <a href="https://blog.win-source.net/q-a/why-are-semiconductor-suppliers-raising-prices-again-in-q2-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">WIN SOURCE BLOG (Q2 2026)</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Molex:</strong> 5-30% increase depending on product (effective Jul 1, 2026) — <a href="https://blog.win-source.net/q-a/why-are-semiconductor-suppliers-raising-prices-again-in-q2-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">WIN SOURCE BLOG (Q2 2026)</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>TE Connectivity:</strong> All authorized distributors globally (effective Jul 6, 2026) — <a href="https://blog.win-source.net/q-a/why-are-semiconductor-suppliers-raising-prices-again-in-q2-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">WIN SOURCE BLOG (Q2 2026)</a>
          </div>
          <div style="margin-bottom: 8px;">
            • <strong>Microchip:</strong> Selective increases, 65% data center revenue growth in 2026 — <a href="https://www.stocktitan.net/news/MCHP/microchip-provides-data-center-solutions-business-unit-revenue-k4wb0dlbheds.html" target="_blank" style="color: #3b82f6; text-decoration: none;">StockTitan</a> | <a href="https://www.aetrixelec.com/blog/semiconductor-price-increases-2026-st-nxp-ti-infineon" target="_blank" style="color: #3b82f6; text-decoration: none;">Aetrix</a>
          </div>
          <div style="margin-bottom: 4px; padding-top: 8px; border-top: 1px solid #fbbf24;">
            <strong>Recent June Increases:</strong>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>STMicroelectronics:</strong> 2nd increase of 2026 on MCUs (effective Jun 28, 2026) — <a href="https://www.linkedin.com/posts/elecomponents_st-to-raise-prices-across-product-lines-from-activity-7442536156619075584-HszV" target="_blank" style="color: #3b82f6; text-decoration: none;">LinkedIn - ELEComponents</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>NXP:</strong> Individual pricing per part number (effective Jun 1, 2026) — <a href="https://blog.win-source.net/q-a/why-are-semiconductor-suppliers-raising-prices-again-in-q2-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">WIN SOURCE BLOG (Q2 2026)</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Walsin:</strong> All resistors + select capacitors (effective Jun 1, 2026) — <a href="https://blog.win-source.net/q-a/why-are-semiconductor-suppliers-raising-prices-again-in-q2-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">WIN SOURCE BLOG (Q2 2026)</a>
          </div>
          <div>
            • <strong>April 2026 Wave:</strong> 14 suppliers raised prices in April 2026 — <a href="https://j2sourcing.com/blog/semiconductor-price-hikes-lead-times-april-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">J2 Sourcing (April 2026)</a>
          </div>
        </div>
      </div>

      <!-- MARKET EVENTS (This Week) -->
      <div style="background: #f0f9ff; border-left: 3px solid #3b82f6; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #1e40af; margin-bottom: 8px;">
          📰 KEY MARKET EVENTS — WEEK 27 (Jun 24 - Jul 2, 2026)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <strong>Jun 25:</strong> Apple announces immediate price increases on iPads, Macs, HomePods, Vision Pro, Apple TV amid memory shortage pressures
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jun 29:</strong> Samsung, SK Hynix, and Micron sued for alleged DRAM price-fixing
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jun 30:</strong> AMD hits record high of $579.73; Wells Fargo raises price target to $615 — <a href="https://www.tradingkey.com/news/market-movers/262004408-market-movers-tsm-20260701" target="_blank" style="color: #3b82f6; text-decoration: none;">TradingKey (Jul 1, 2026)</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jul 1:</strong> TSMC stock down 3.51% on demand concerns; Q2 revenue at risk vs. Wall Street expectations — <a href="https://www.tradingkey.com/news/market-movers/262004408-market-movers-tsm-20260701" target="_blank" style="color: #3b82f6; text-decoration: none;">TradingKey (Jul 1, 2026)</a>
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jun 2026:</strong> Supermicro secures $7B equity financing for AI server component purchases
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jun 30:</strong> AMD-Rackspace partnership: 30 MW footprint for AMD compute through 2028 — <a href="https://www.globenewswire.com/news-release/2026/06/29/3318947/0/en/ai-infrastructure-spending-creates-new-wave-of-semiconductor-ecosystem-winners.html" target="_blank" style="color: #3b82f6; text-decoration: none;">GlobeNewswire (Jun 29, 2026)</a>
          </div>
          <div>
            • <strong>Jun 2026:</strong> Micron CEO Sanjay Mehrotra: Memory shortage will last through 2027, gradual relief by 2028
          </div>
        </div>
      </div>

      <!-- Memory (DRAM/NAND/HBM) Sources -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🔴 MEMORY (DRAM/NAND/HBM) — ALLOCATED (Shortage Through 2027)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://tech-insider.org/memory-chip-shortage-2026-ai-consumer-electronics/" target="_blank" style="color: #3b82f6; text-decoration: none;">Tech Insider (Jul 2, 2026): "Memory Chip Shortage 2026: AI vs. Consumer Electronics"</a> — DRAM prices +80-90% in Q1, +70% expected Q2; 70% of memory chips go to data centers
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://www.idc.com/resource-center/blog/global-memory-shortage-crisis-market-analysis-and-the-potential-impact-on-the-smartphone-and-pc-markets-in-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">IDC (Jul 2, 2026): "Global Memory Shortage Crisis"</a> — Market analysis and smartphone/PC impact
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://www.tomshardware.com/pc-components/ram/hbm-is-eating-your-ram" target="_blank" style="color: #3b82f6; text-decoration: none;">Tom's Hardware (Jul 2, 2026): "HBM Is Eating Your RAM"</a> — HBM uses 3-4x the wafer capacity of DDR5 per gigabyte
          </div>
          <div>
            • <a href="https://sourceability.com/post/the-memory-shortage-is-set-to-grow-through-2026" target="_blank" style="color: #3b82f6; text-decoration: none;">Sourceability (Jul 2, 2026): "Memory Shortage Set to Grow Through 2026"</a> — DRAM revenues projected to triple to $418.6B
          </div>
        </div>
      </div>

      <!-- MLCCs Sources -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🆕 MLCCs (PASSIVES) — NEW CONSTRAINT (ALLOCATED)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://www.astutegroup.com/news/general/mlcc-shortages-deepen-as-ai-demand-extends-lead-times/" target="_blank" style="color: #3b82f6; text-decoration: none;">Astute Group (Jul 2, 2026): "MLCC Shortages Deepen as AI Demand Extends Lead Times"</a> — NVIDIA GB200: ~6,500 MLCCs per server; Rubin (H2 2026): 12,000 MLCCs
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://www.773grp.com/blogs/news/the-2026-passive-components-crunch-mlcc-capacitor-lead-times" target="_blank" style="color: #3b82f6; text-decoration: none;">773 GROUP (Jul 2, 2026): "The 2026 Passive Components Crunch"</a> — Lead times: 8-12 weeks (late 2024) → now 26-40 weeks
          </div>
          <div>
            • <a href="https://www.eenewseurope.com/en/ai-drives-mlcc-shortage/" target="_blank" style="color: #3b82f6; text-decoration: none;">EE News Europe (Jul 2, 2026): "AI Drives MLCC Shortage"</a> — AI-server-grade MLCCs up 50-60% by May 2026
          </div>
        </div>
      </div>

      <!-- MCUs Sources -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🔴 MCUs (STM32, RENESAS) — CONSTRAINED (30-31 Week Lead Times)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://www.773grp.com/blogs/news/mcu-market-2026-microcontroller-lead-times-shortage" target="_blank" style="color: #3b82f6; text-decoration: none;">773 GROUP (Jul 2, 2026): "MCU Market 2026: Are Microcontroller Lead Times About to Surge"</a> — STM32 lead time research
          </div>
          <div>
            • <a href="https://blog.findchips.com/mcu-mpu-shortage-watch-q2-2026/" target="_blank" style="color: #3b82f6; text-decoration: none;">FindChips (Jul 2, 2026): "MCU & MPU Shortage Watch Q2 2026"</a> — 30-31 week lead times
          </div>
        </div>
      </div>

      <!-- Power ICs Sources -->
      <div style="background: #fff7ed; border-left: 3px solid #ea580c; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #9a3412; margin-bottom: 8px;">
          🟠 POWER ICs (VISHAY, ONSEMI, INFINEON) — CONSTRAINED
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div>
            • <a href="https://www.microchipusa.com/manufacturer-articles/electronic-component-shortage-2026-vishay-onsemi--infineon-risks" target="_blank" style="color: #3b82f6; text-decoration: none;">Microchip USA (Jul 2, 2026): "Electronic Component Shortage 2026: Vishay, Onsemi & Infineon Risks"</a> — Allocation programs active
          </div>
        </div>
      </div>

      <!-- Mature-Node Capacity Sources -->
      <div style="background: #fff7ed; border-left: 3px solid #ea580c; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #9a3412; margin-bottom: 8px;">
          🟠 MATURE-NODE CAPACITY (28nm+) — "SILENT SHORTAGE"
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://randtech.com/mature-node-semiconductor-capacity-shortage/" target="_blank" style="color: #3b82f6; text-decoration: none;">Rand Tech (Jul 2, 2026): "Mature-Node Semiconductor Capacity Shortage"</a> — The "silent shortage" affecting analog ICs, power management, MCUs
          </div>
          <div>
            • <a href="https://www.forbes.com/sites/tiriasresearch/2026/02/16/2026-is-the-year-of-semiconductor-capacity-constraints/" target="_blank" style="color: #3b82f6; text-decoration: none;">Forbes (Feb 16, 2026): "2026 Is The Year Of Semiconductor Capacity Constraints"</a> — Industry analysis
          </div>
        </div>
      </div>

      <!-- Logic ICs Sources -->
      <div style="background: #f0fdf4; border-left: 3px solid #10b981; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #065f46; margin-bottom: 8px;">
          🟢 LOGIC ICs (COMMODITY) — NORMAL / IMPROVED
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div>
            • <a href="https://www.ti.com/ordering-resources/faqs/inventory-product-availability.html" target="_blank" style="color: #3b82f6; text-decoration: none;">Texas Instruments: "Inventory & Product Availability"</a> — TI inventory at 222 days (based on 2025 Annual Report investor materials)
          </div>
        </div>
      </div>

      <!-- Aggregator Sites for Weekly Monitoring -->
      <div style="background: #f0f9ff; border-left: 3px solid #3b82f6; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #1e40af; margin-bottom: 8px;">
          📡 INDUSTRY AGGREGATOR SITES (Weekly Monitoring)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://www.trendforce.com/" target="_blank" style="color: #3b82f6; text-decoration: none;">TrendForce</a> — Publishes manufacturer price increase notices as news
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://j2sourcing.com/blog/" target="_blank" style="color: #3b82f6; text-decoration: none;">J2 Sourcing Blog</a> — Monthly price increase roundups
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://www.semicone.com/" target="_blank" style="color: #3b82f6; text-decoration: none;">Semicon Electronics</a> — Manufacturer announcements
          </div>
          <div>
            • <a href="https://blog.win-source.net/" target="_blank" style="color: #3b82f6; text-decoration: none;">WIN SOURCE Blog</a> — Price increase tracking
          </div>
        </div>
      </div>

      <div style="margin-top: 16px; padding: 12px; background: #f0f9ff; border-left: 4px solid #3b82f6; border-radius: 4px;">
        <p style="font-size: 11px; color: #1e40af; margin: 0; line-height: 1.6;">
          <strong>💡 How to Use:</strong><br>
          • Click any link to review the latest market intelligence from that source<br>
          • Cross-reference external signals with our internal OT data (Section 2: External Market Validation)<br>
          • Share relevant market updates with sales team to align on allocation risks and opportunities
        </p>
      </div>
    </div>
  </div>

  <!-- Section 4: Data Sources & Methodology (BLUEPRINT/REFERENCE) -->
  <div class="expandable-section" style="opacity: 0.7;">
    <div class="expandable-header" onclick="toggleSection('methodology')">
      <div>
        <div class="expandable-title">
          📋 Data Sources & Methodology
          <span class="reference-badge">Blueprint / Reference</span>
        </div>
        <div class="expandable-subtitle">
          Background information for understanding report construction (testing/build-out only)
        </div>
      </div>
      <div class="expandable-toggle" id="methodology-toggle">+</div>
    </div>
    <div id="methodology" class="expandable-content">
      <div style="background: #fffbeb; border-left: 3px solid #f59e0b; padding: 12px; margin-bottom: 16px; border-radius: 4px;">
        <p style="font-size: 11px; color: #92400e; margin: 0; line-height: 1.6;">
          <strong>📝 Note:</strong> This section provides blueprint/reference information for understanding how the report is constructed.
          It is included for testing and development purposes and may not be a permanent section in the final report.
        </p>
      </div>
      ${generateMethodologyContent()}
    </div>
  </div>

  <div class="footer">
    <strong>Questions or feedback?</strong> Contact Melissa Bojar (Sales Productivity Analyst)<br>
    Report generated for Josh Pucci (VP Sales) and regional sales leadership<br>
    Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })} CT
  </div>
</div>
</body>
</html>`;
}

/**
 * Generate top 3 actions (simplified version)
 */
function generateTopActions(constraintIndicators, temperatureGauge, externalMarketData) {
  const actions = [];

  // Action 1: Allocation alert (if any Allocated manufacturers exist)
  if (temperatureGauge.allocatedCount > 0 && constraintIndicators.franchiseLeadTimes && constraintIndicators.franchiseLeadTimes.length > 0) {
    const allocated = constraintIndicators.franchiseLeadTimes.filter(lt => lt.status === 'Allocated').sort((a, b) => (parseFloat(b.current_avg_lt) || 0) - (parseFloat(a.current_avg_lt) || 0))[0];
    if (allocated && allocated.current_avg_lt) {
      const currentLT = parseFloat(allocated.current_avg_lt) || 0;
      const partFamilyList = constraintIndicators.franchiseLeadTimes
        .filter(lt => lt.status === 'Allocated')
        .map(lt => lt.part_family)
        .slice(0, 3)
        .join(', ');
      actions.push({
        title: `${allocated.manufacturer || 'Unknown'} Allocation Alert`,
        internal: `${currentLT.toFixed(1)}w lead time, ${allocated.vq_count || 0} VQ responses, ${partFamilyList}* parts`,
        internal_short: `${currentLT.toFixed(1)}w LT, ${allocated.vq_count || 0} VQs`,
        external: `Industry reports show ALLOCATED status (40+w lead times)`,
        external_short: 'ALLOCATED (40+w LT)',
        action: `Verify with sourcing on current availability and pricing for ${allocated.part_family || 'these'}* parts. Premium pricing justified by market-wide shortage. Multiple OEMs requesting = high demand signal.`
      });
    }
  }

  // Action 2: Competitive advantage (if any BETTER SUPPLY alignment exists)
  const betterSupply = externalMarketData.find(item => item.alignment === 'BETTER SUPPLY');
  if (betterSupply) {
    actions.push({
      title: `${betterSupply.category} Competitive Advantage`,
      internal: betterSupply.otSignal,
      internal_short: betterSupply.otSignal.substring(0, 50) + '...',
      external: `Industry: ${betterSupply.status} (${betterSupply.industryLeadTime})`,
      external_short: `${betterSupply.status} (${betterSupply.industryLeadTime})`,
      action: `Market aggressively with "in-stock when competitors are out" messaging. Our internal lead times are significantly better than industry. Verify current supply with sourcing and capture margin opportunity.`
    });
  }

  // Action 3: Rising constraint watch (if any significant WoW increases)
  if (constraintIndicators.franchiseLeadTimes && constraintIndicators.franchiseLeadTimes.length > 0) {
    const rising = constraintIndicators.franchiseLeadTimes
      .filter(lt => lt.lt_change_pct && parseFloat(lt.lt_change_pct) >= 15)
      .sort((a, b) => (parseFloat(b.lt_change_pct) || 0) - (parseFloat(a.lt_change_pct) || 0))[0];
    if (rising && rising.current_avg_lt) {
      const currentLT = parseFloat(rising.current_avg_lt) || 0;
      const changePct = parseFloat(rising.lt_change_pct) || 0;
      const allocatedPct = rising.bucket_allocated && rising.vq_count ? Math.round((rising.bucket_allocated / rising.vq_count) * 100) : 0;
      actions.push({
        title: `Watch ${rising.manufacturer || 'Unknown'} Parts Rising`,
        internal: `${currentLT.toFixed(1)}w LT (+${changePct.toFixed(0)}% WoW), ${rising.bucket_allocated || 0} of ${rising.vq_count || 0} VQs at 40+w`,
        internal_short: `+${changePct.toFixed(0)}% WoW`,
        external: `${rising.manufacturer || 'Unknown'} parts showing rising constraint signals externally`,
        external_short: 'Rising constraint signals',
        action: `Monitor ${rising.part_family_prefix || 'these'}* parts closely. ${allocatedPct}% of VQs showing 40+w lead times. May escalate to full allocation in 2-4 weeks. Early customer communication recommended if lead times extend further.`
      });
    }
  }

  // Fallback actions if we don't have enough
  while (actions.length < 3) {
    actions.push({
      title: 'Continue Standard Operations',
      internal: 'No critical constraints detected in this category',
      internal_short: 'No critical constraints',
      external: 'Market conditions stable',
      external_short: 'Stable conditions',
      action: 'Focus on conversion optimization and margin improvement. Monitor constraint indicators for emerging signals.'
    });
  }

  return actions;
}

/**
 * Generate part family table HTML (FULL DATA - no limit)
 */
function generatePartFamilyTable(parts, limitRows = false) {
  if (!parts || parts.length === 0) {
    return '<p style="color: #666; font-style: italic;">No multi-customer shortage signals detected.</p>';
  }

  const displayParts = limitRows ? parts.slice(0, 5) : parts;

  return `
    <table>
      <thead>
        <tr>
          <th>Part Family</th>
          <th>Manufacturer</th>
          <th>Type</th>
          <th style="text-align: right;">Customers</th>
          <th style="text-align: right;">RFQ Lines</th>
          <th style="text-align: right;">VQ Lines</th>
          <th style="text-align: right;">CQ Lines</th>
          <th style="text-align: right;">SO Lines</th>
          <th style="text-align: right;">Booked GP</th>
          <th style="text-align: right;">GM%</th>
        </tr>
      </thead>
      <tbody>
        ${displayParts.map((part, i) => `
        <tr style="background: ${i === 0 ? '#f0fdf4' : '#f5f5f5'};">
          <td><strong>${i === 0 ? '🏆 ' : ''}${part.mpn}*</strong></td>
          <td>${part.manufacturer}</td>
          <td style="font-size: 10px;">${part.part_type || 'Other'}</td>
          <td style="text-align: right;">${part.total_customers} (${part.oem_customers} OEM)</td>
          <td style="text-align: right;">${part.rfq_lines || 0}</td>
          <td style="text-align: right;">${part.vq_lines || 0}${part.no_quote_count > 0 ? `<span style="color: #dc2626;">(-${part.no_quote_count})</span>` : ''}</td>
          <td style="text-align: right;">${part.cq_lines || 0}</td>
          <td style="text-align: right;">${part.so_lines || 0}</td>
          <td style="text-align: right; font-weight: 600;">
            ${formatCurrency(part.booked_gp || 0)}
          </td>
          <td style="text-align: right; color: ${(part.booked_gm_pct || 0) > 0 && (part.booked_gm_pct || 0) < 0.18 ? '#dc2626' : ''};">
            ${((part.booked_gm_pct || 0) * 100).toFixed(1)}%
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    ${limitRows && parts.length > 5 ? `<p style="font-size: 10px; color: #666; font-style: italic;">Showing top 5 of ${parts.length} part families. Expand section to see all.</p>` : ''}
    ${!limitRows ? `<p style="font-size: 10px; color: #666; font-style: italic; margin-top: 8px;">Showing all ${parts.length} part families with 2+ OEM customers in shortage RFQs (30-day window).</p>` : ''}
    <p style="font-size: 10px; color: #666; font-style: italic; margin-top: 12px; padding: 8px; background: #f0f9ff; border-left: 3px solid #3b82f6; border-radius: 4px;">
      <strong>📝 VQ Lines Note:</strong> VQ Lines shows total quotes received from suppliers. Numbers in <span style="color: #dc2626; font-weight: 600;">red (-X)</span> indicate "No Quote" responses from suppliers unable to provide pricing. For example, "165<span style="color: #dc2626;">(-2)</span>" means 165 quotes received, but 2 were "No Quote" responses.
    </p>
    <p style="font-size: 10px; color: #64748b; margin-top: 12px; padding: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; line-height: 1.5;">
      <strong>Booked GP Filter:</strong> Shortage RFQs only (30-day rolling). Does not include Stock, PPV, EOL, or other RFQ types. Totals will not match Power BI.
    </p>`;
}

/**
 * Generate manufacturer table HTML (FULL DATA - no limit)
 */
function generateManufacturerTable(manufacturers, limitRows = false) {
  if (!manufacturers || manufacturers.length === 0) {
    return '<p style="color: #666; font-style: italic;">No trending shortage manufacturers detected.</p>';
  }

  const displayMfrs = limitRows ? manufacturers.slice(0, 10) : manufacturers;

  return `
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th style="text-align: right;">Customers</th>
          <th style="text-align: right;">RFQ Lines</th>
          <th style="text-align: right;">VQ Lines</th>
          <th style="text-align: right;">CQ Lines</th>
          <th style="text-align: right;">SO Lines</th>
          <th style="text-align: right;">CQ Sold %</th>
          <th style="text-align: right;">Booked GP</th>
        </tr>
      </thead>
      <tbody>
        ${displayMfrs.map((mfr, i) => `
        <tr style="background: ${i === 0 ? '#f0fdf4' : '#f5f5f5'};">
          <td><strong>${i === 0 ? '🏆 ' : ''}${mfr.manufacturer}</strong></td>
          <td style="text-align: right;">${mfr.total_customers} (${mfr.oem_customers} OEM)</td>
          <td style="text-align: right;">${mfr.rfq_lines || 0}</td>
          <td style="text-align: right;">${mfr.vq_lines || 0}</td>
          <td style="text-align: right;">${mfr.cq_lines || 0}</td>
          <td style="text-align: right;">${mfr.sold || 0}</td>
          <td style="text-align: right; color: ${(mfr.cq_sold_pct || 0) > 0 && (mfr.cq_sold_pct || 0) < 0.15 ? '#dc2626' : ''};">
            ${((mfr.cq_sold_pct || 0) * 100).toFixed(1)}%
          </td>
          <td style="text-align: right; font-weight: 600;">
            ${formatCurrency(mfr.booked_gp || 0)}
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    ${limitRows && manufacturers.length > 10 ? `<p style="font-size: 10px; color: #666; font-style: italic;">Showing top 10 of ${manufacturers.length} manufacturers. Expand section to see all.</p>` : ''}
    ${!limitRows ? `<p style="font-size: 10px; color: #666; font-style: italic; margin-top: 8px;">Showing all ${manufacturers.length} manufacturers from shortage RFQs (30-day window).</p>` : ''}
    <p style="font-size: 10px; color: #64748b; margin-top: 12px; padding: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; line-height: 1.5;">
      <strong>Booked GP Filter:</strong> Shortage RFQs only (30-day rolling). Does not include Stock, PPV, EOL, or other RFQ types. Totals will not match Power BI.
    </p>`;
}

/**
 * Generate lead time table HTML (FULL DATA - no limit)
 */
function generateLeadTimeTable(leadTimes, limitRows = false) {
  if (!leadTimes || leadTimes.length === 0) {
    return '<p style="color: #666; font-style: italic;">No franchise lead time data available.</p>';
  }

  const displayLTs = limitRows ? leadTimes.slice(0, 20) : leadTimes;

  return `
    <table>
      <thead>
        <tr>
          <th>Part Family</th>
          <th>Manufacturer</th>
          <th style="text-align: right;">Current LT</th>
          <th style="text-align: right;">Baseline</th>
          <th style="text-align: right;">Change</th>
          <th style="text-align: center;">Status</th>
          <th style="text-align: right;">Sample</th>
        </tr>
      </thead>
      <tbody>
        ${displayLTs.map(lt => {
          const statusColor =
            lt.status === 'Allocated' ? '#dc2626' :
            lt.status === 'Constrained' ? '#ea580c' :
            lt.status === 'Recovery' ? '#3b82f6' :
            '#10b981';
          const statusDot = `<span style="display: inline-block; width: 10px; height: 10px; background: ${statusColor}; border-radius: 50%; margin-right: 4px; vertical-align: middle;"></span>`;

          const changePct = parseFloat(lt.lt_change_pct) || 0;
          const currentLT = parseFloat(lt.current_avg_lt) || 0;
          const baselineLT = parseFloat(lt.baseline_avg_lt) || 0;

          return `
        <tr style="background: #f5f5f5;">
          <td><strong>${lt.part_family || 'N/A'}*</strong></td>
          <td>${lt.manufacturer || 'Unknown'}</td>
          <td style="text-align: right; font-weight: 600; color: ${changePct >= 0 ? '#dc2626' : '#3b82f6'};">
            ${currentLT.toFixed(1)}w
          </td>
          <td style="text-align: right;">${baselineLT.toFixed(1)}w</td>
          <td style="text-align: right; color: ${changePct >= 0 ? '#dc2626' : '#3b82f6'};">
            ${changePct >= 0 ? '+' : ''}${changePct.toFixed(0)}%
          </td>
          <td style="text-align: center;">
            ${statusDot}<span style="color: ${statusColor}; font-weight: 600; font-size: 10px;">${(lt.status || 'Unknown').toUpperCase()}</span>
          </td>
          <td style="text-align: right; font-size: 10px; color: #666;">${lt.vq_count || 0} VQs</td>
        </tr>
        `;
        }).join('')}
      </tbody>
    </table>
    ${limitRows && leadTimes.length > 20 ? `<p style="font-size: 10px; color: #666; font-style: italic;">Showing top 20 of ${leadTimes.length} part families. Expand section to see all.</p>` : ''}
    ${!limitRows ? `<p style="font-size: 10px; color: #666; font-style: italic; margin-top: 8px;">Showing all ${leadTimes.length} part families with franchise lead time data.</p>` : ''}`;
}

/**
 * Generate external market table HTML
 */
function generateExternalMarketTable(externalData) {
  return `
    <table>
      <thead>
        <tr>
          <th style="width: 15%;">Category</th>
          <th style="width: 12%; text-align: center;">External Status</th>
          <th style="width: 30%;">Key Signals</th>
          <th style="width: 12%; text-align: center;">Industry LT</th>
          <th style="width: 15%; text-align: center;">Alignment</th>
          <th style="width: 16%;">OT Internal Signal</th>
        </tr>
      </thead>
      <tbody>
        ${externalData.map(item => {
          const statusDot = `<span style="display: inline-block; width: 10px; height: 10px; background: ${item.statusColor}; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>`;
          return `
        <tr style="background: #f5f5f5;">
          <td><strong>${item.category}</strong></td>
          <td style="text-align: center; font-weight: 600;">
            ${statusDot}<span style="color: ${item.statusColor};">${item.status.toUpperCase()}</span>
          </td>
          <td style="font-size: 11px;">${item.keySignals}</td>
          <td style="text-align: center; font-weight: 600;">${item.industryLeadTime}</td>
          <td style="text-align: center; font-weight: 700; ${
            item.alignment === 'MATCHES' ? 'color: #10b981;' :
            item.alignment === 'BETTER SUPPLY' ? 'color: #3b82f6;' :
            'color: #ea580c;'
          }">
            ${item.alignmentIcon} ${item.alignment}
          </td>
          <td style="font-size: 11px; color: #666;">${item.otSignal}</td>
        </tr>
        `;
        }).join('')}
      </tbody>
    </table>`;
}

/**
 * Generate regional performance table HTML
 */
function generateRegionalTable(current, kla) {
  // Calculate regional data
  const regions = ['USA', 'MEX', 'APAC', 'Other'].map(region => {
    let bookingsGP, billingsGP, bookingsGM, billingsGM;

    if (region === 'APAC') {
      bookingsGP = current.total.apac.bookings.gp;
      billingsGP = current.total.apac.billings.gp;
      bookingsGM = current.total.apac.bookings.gm;
      billingsGM = current.total.apac.billings.gm;
    } else {
      const b = current.total.bookings.byTeam[region] || { gp: 0, gm: 0 };
      const bil = current.total.billings.byTeam[region] || { gp: 0, gm: 0 };
      bookingsGP = b.gp;
      billingsGP = bil.gp;
      bookingsGM = b.gm;
      billingsGM = bil.gm;
    }

    if (bookingsGP === 0 && billingsGP === 0) return null;

    return {
      region,
      bookingsGP,
      billingsGP,
      bookingsGM,
      billingsGM,
      bbRatio: billingsGP > 0 ? (bookingsGP / billingsGP) : 0
    };
  }).filter(d => d);

  const totalBookings = current.total.bookings.total.gp;
  const totalBillings = current.total.billings.total.gp;
  const totalBBRatio = totalBillings > 0 ? (totalBookings / totalBillings) : 0;
  const totalBookingsGM = current.total.bookings.total.gm;
  const totalBillingsGM = current.total.billings.total.gm;

  return `
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th style="text-align: right;">Bookings GP</th>
          <th style="text-align: right;">Billings GP</th>
          <th style="text-align: right;">B/B Ratio</th>
          <th style="text-align: right;">Bookings GM</th>
          <th style="text-align: right;">Billings GM</th>
        </tr>
      </thead>
      <tbody>
        ${regions.map(d => {
          const rowStyle = d.region === 'APAC' && (kla.bookings.gp > 0 || kla.billings.gp > 0) ? 'background: #fef3c7;' : 'background: #f5f5f5;';
          return `
        <tr style="${rowStyle}">
          <td><strong>${d.region}${d.region === 'APAC' ? ' *' : ''}</strong></td>
          <td style="text-align: right;">${formatCurrency(d.bookingsGP, true)}</td>
          <td style="text-align: right;">${formatCurrency(d.billingsGP, true)}</td>
          <td style="text-align: right;"><strong style="${d.bbRatio < 1.0 ? 'color: #dc2626;' : ''}">${d.bbRatio.toFixed(2)}</strong></td>
          <td style="text-align: right; ${d.bookingsGM < 0.18 ? 'color: #dc2626; font-weight: 600;' : ''}">${formatPercent(d.bookingsGM)}</td>
          <td style="text-align: right; ${d.billingsGM < 0.18 ? 'color: #dc2626; font-weight: 600;' : ''}">${formatPercent(d.billingsGM)}</td>
        </tr>`;
        }).join('')}
        <tr style="background: #f3f4f6; font-weight: 600; border-top: 2px solid #cbd5e1;">
          <td><strong>TOTAL</strong></td>
          <td style="text-align: right;">${formatCurrency(totalBookings, true)}</td>
          <td style="text-align: right;">${formatCurrency(totalBillings, true)}</td>
          <td style="text-align: right;"><strong style="${totalBBRatio < 1.0 ? 'color: #dc2626;' : ''}">${totalBBRatio.toFixed(2)}</strong></td>
          <td style="text-align: right;">${formatPercent(totalBookingsGM)}</td>
          <td style="text-align: right;">${formatPercent(totalBillingsGM)}</td>
        </tr>
      </tbody>
    </table>

    ${(kla.bookings.gp > 0 || kla.billings.gp > 0) ? `
    <div style="margin-top: 12px; padding: 10px; background: #fef3c7; border-left: 3px solid #f59e0b; border-radius: 4px; font-size: 11px; color: #92400e;">
      <strong>* APAC includes KLA business:</strong> ${formatCurrency(kla.bookings.gp, true)} bookings / ${formatCurrency(kla.billings.gp, true)} billings
    </div>
    ` : ''}`;
}

/**
 * Generate methodology content HTML
 */
function generateMethodologyContent() {
  return `
    <div style="font-size: 11px; color: #475569; line-height: 1.6;">
      <h4 style="font-size: 12px; font-weight: 600; margin: 0 0 8px 0; color: #1e293b;">Section 1: External Market Snapshot</h4>
      <p style="margin: 0 0 12px 0;">
        <strong>Data Source:</strong> Industry market reports (Sourceability, Avnet, J2 Sourcing, Deloitte)<br>
        <strong>What it shows:</strong> External semiconductor market conditions (Allocated/Constrained/Recovery/Normal) by category<br>
        <strong>Purpose:</strong> Validate whether our internal signals match market-wide trends or if we have competitive advantages<br>
        <strong>Update Frequency:</strong> Manual review of industry reports (weekly or bi-weekly)
      </p>

      <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">Section 2: Constraint Indicators (30-Day Rolling)</h4>
      <p style="margin: 0 0 8px 0;">
        <strong>Data Source:</strong> Orange Tsunami (OT) database — RFQ, VQ, CQ activity<br>
        <strong>Purpose:</strong> Early warning signs for supply constraints and allocation risk (2-4 week lead time before manufacturer announcements)
      </p>

      <div style="margin-left: 16px; margin-bottom: 12px;">
        <h5 style="font-size: 11px; font-weight: 600; margin: 0 0 4px 0; color: #dc2626;">Hot Part Families (Shortage Signals)</h5>
        <p style="margin: 0 0 8px 0; font-size: 10px;">
          <strong>What it shows:</strong> Full conversion funnel (RFQ → VQ → CQ → SO) for part families requested by 2+ OEM customers<br>
          <strong>Filters:</strong> Shortage RFQs only; excludes Tier 1 EMS (Sanmina, Jabil, etc.); sorted by Booked GP<br>
          <strong>Time Window:</strong> RFQs from last 30 days; funnel conversions all-time
        </p>

        <h5 style="font-size: 11px; font-weight: 600; margin: 0 0 4px 0; color: #1e40af;">Franchise Lead Time Analysis</h5>
        <p style="margin: 0 0 8px 0; font-size: 10px;">
          <strong>What it shows:</strong> Factory lead times from franchise distributors (Arrow, Avnet, Mouser, Digi-Key, etc.)<br>
          <strong>Comparison:</strong> Current 30-day average vs 90-day baseline<br>
          <strong>Why it matters:</strong> Franchise lead times = earliest signal of manufacturer constraints
        </p>

        <h5 style="font-size: 11px; font-weight: 600; margin: 0 0 4px 0; color: #7c3aed;">Trending Manufacturers</h5>
        <p style="margin: 0; font-size: 10px;">
          <strong>What it shows:</strong> Top manufacturers by Booked GP from Shortage RFQs (same data as Part Families, aggregated by manufacturer)<br>
          <strong>Why separate view:</strong> Helps identify which companies are driving shortage-related revenue
        </p>
      </div>

      <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">Section 3: Performance Snapshot (Infor Weekly Summary)</h4>
      <p style="margin: 0;">
        <strong>Data Source:</strong> Infor ERP (Post-Sales) via Power BI export<br>
        <strong>What it shows:</strong> Completed week bookings vs billings performance, all metrics shown as Gross Profit (GP)<br>
        <strong>Metrics:</strong> B/B Ratio = Bookings GP / Billings GP (>1.0 = building backlog, <1.0 = consuming backlog)<br>
        <strong>Regional Breakdown:</strong> USA (Jeff Wallace team), MEX (Joel Marquez team), APAC (Laurel, Silvia, Lavanya, Edyna teams)<br>
        <strong>KLA Business:</strong> Shown separately due to large shipment variability and credit/return impact
      </p>
    </div>`;
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log(`\n=== Generating Market Pulse Option A (Dashboard) — Week ${WEEK_NUM} ===\n`);

    // Collect all data using functions from original script
    const snapshot = collectPerformanceSnapshot();
    const constraintIndicators = collectConstraintIndicators();
    const temperatureGauge = calculateTemperatureGauge(constraintIndicators);
    const externalMarketData = getExternalMarketData();

    // Build HTML
    const html = buildOptionAHTML(
      snapshot,
      snapshot.bookingsData,
      snapshot.billingsData,
      constraintIndicators,
      temperatureGauge,
      externalMarketData
    );

    // Write output files
    const outputDir = path.join(__dirname, '../output/market-pulse');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `market-pulse-option-a-week${WEEK_NUM}-${timestamp}.html`);

    fs.writeFileSync(htmlPath, html);
    console.log(`✅ HTML report: ${htmlPath}`);

    // Summary (CHANGED: Show Total including KLA, not Ex-KLA)
    console.log(`\n=== Week ${WEEK_NUM} Summary (Total incl. KLA) ===`);
    console.log(`Bookings GP: ${formatCurrency(snapshot.current.total.bookings.total.gp)} (${formatPercent(snapshot.current.total.bookings.total.gm)} GM)`);
    console.log(`Billings GP: ${formatCurrency(snapshot.current.total.billings.total.gp)} (${formatPercent(snapshot.current.total.billings.total.gm)} GM)`);
    const bbRatio = snapshot.current.total.billings.total.gp > 0 ?
      (snapshot.current.total.bookings.total.gp / snapshot.current.total.billings.total.gp) : 0;
    console.log(`B/B Ratio: ${bbRatio.toFixed(2)}x`);
    console.log(`\nMarket State: ${temperatureGauge.temperature} (${temperatureGauge.totalSignals} signals)`);
    console.log(`  - Allocated: ${temperatureGauge.allocatedCount}`);
    console.log(`  - Constrained: ${temperatureGauge.constrainedCount}`);
    console.log(`  - Shortage: ${temperatureGauge.shortageSignalCount}`);
    console.log('');

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
