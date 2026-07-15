#!/usr/bin/env node
/**
 * Market Pulse Weekly - Week 29 Report (July 13, 2026)
 *
 * Generates Market Pulse report in dashboard format with:
 * - Tier 1: Executive Brief (Performance WoW, Market Shifts, Top 3 Actions)
 * - Tier 2: Supporting Intelligence (Constraint Signals, External Market Validation, Data Sources)
 *
 * Usage:
 *   node market-pulse-week29.js
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Week to analyze
const WEEK_NUM = 29;

// Import helper functions from week25 script
const week25Path = path.join(__dirname, 'market-pulse-week25.js');
const week25Script = fs.readFileSync(week25Path, 'utf8');

// Extract all helper functions (everything before main())
const functionsCode = week25Script.substring(0, week25Script.indexOf('async function main()'));
eval(functionsCode);

// Import external market research data for Week 29
const { getExternalMarketDataWeek29 } = require(path.join(__dirname, '../../../market-pulse-week29-research.js'));

/**
 * Build Week 29 HTML report
 */
function buildWeek29HTML(snapshot, constraintIndicators, temperatureGauge, externalMarketData) {
  const { currentWeek, current, prior, kla } = snapshot;

  // Calculate key metrics
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

  /* Executive Brief Columns */
  .executive-brief {
    grid-column: 1 / -1;
    min-height: auto;
  }
  .exec-cols {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 24px;
  }
  .exec-col-title {
    font-size: 13px;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 2px solid #cbd5e1;
  }
  .metric-box {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    padding: 6px;
    background: white;
    border-radius: 4px;
  }
  .metric-label {
    color: #475569;
    font-weight: 600;
    font-size: 11px;
  }
  .metric-value-group {
    text-align: right;
  }
  .metric-primary {
    font-weight: 700;
    font-size: 12px;
    color: #1e293b;
  }
  .metric-secondary {
    font-weight: 600;
    font-size: 10px;
  }
  .shift-item {
    margin-bottom: 10px;
    padding: 8px;
    background: white;
    border-radius: 4px;
  }
  .shift-title {
    font-weight: 700;
    font-size: 11px;
    margin-bottom: 3px;
  }
  .shift-detail {
    color: #64748b;
    font-size: 10px;
    line-height: 1.4;
  }
  .action-box {
    margin-bottom: 12px;
    padding: 8px;
    background: #fefce8;
    border-left: 3px solid #eab308;
    border-radius: 4px;
  }
  .action-title {
    font-weight: 700;
    color: #854d0e;
    margin-bottom: 4px;
    font-size: 10px;
  }
  .action-detail {
    color: #78716c;
    font-size: 9px;
    margin-bottom: 2px;
  }
  .action-expand-link {
    color: #3b82f6;
    cursor: pointer;
    font-size: 9px;
    font-weight: 600;
    margin-top: 4px;
  }
  .action-detail-content {
    display: none;
    margin-top: 8px;
    padding: 8px;
    background: #fffbeb;
    border-radius: 4px;
    font-size: 9px;
    line-height: 1.6;
    color: #78350f;
  }
  .action-detail-content.show {
    display: block;
  }
  .kla-note {
    margin-top: 12px;
    padding: 8px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    font-size: 10px;
    color: #64748b;
    line-height: 1.5;
  }
  .alert-box {
    padding: 8px;
    border-radius: 4px;
    font-size: 10px;
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
    .exec-cols {
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

  <!-- TIER 1: EXECUTIVE BRIEF -->
  <div class="tier1">
    <div class="insight-card executive-brief">
      <h2>📊 WEEK ${currentWeek} EXECUTIVE BRIEF</h2>
      <div class="exec-cols">

        <!-- Column 1: Performance WoW -->
        <div>
          <div class="exec-col-title">📈 PERFORMANCE vs LAST WEEK</div>
          ${generatePerformanceColumn(bookingsGP, bookingsGM, billingsGP, billingsGM, bbRatio, bookingsWoW, billingsWoW, prior, kla)}
        </div>

        <!-- Column 2: Market Shifts WoW -->
        <div>
          <div class="exec-col-title">🌍 MARKET SHIFTS WoW</div>
          ${generateMarketShiftsColumn(externalMarketData)}
        </div>

        <!-- Column 3: Top Actions -->
        <div>
          <div class="exec-col-title">🎯 TOP 3 ACTIONS THIS WEEK</div>
          ${generateActionsColumn(actions)}
        </div>

      </div>
    </div>
  </div>

  <!-- TIER 2: SUPPORTING INTELLIGENCE -->
  <div class="tier2-title">📊 SUPPORTING INTELLIGENCE</div>
  <div style="font-size: 11px; color: #64748b; margin-bottom: 20px; font-style: italic;">
    Click any section below to expand detailed data tables and analysis
  </div>

  <!-- Section 1: Constraint Signals -->
  ${generateConstraintSignalsSection(constraintIndicators)}

  <!-- Section 2: External Market Validation -->
  ${generateExternalMarketSection(externalMarketData)}

  <!-- Section 3: External Data Sources -->
  ${generateExternalSourcesSection(currentWeek)}

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
 * Generate Performance Column HTML
 */
function generatePerformanceColumn(bookingsGP, bookingsGM, billingsGP, billingsGM, bbRatio, bookingsWoW, billingsWoW, prior, kla) {
  const marginChange = (bookingsGM - prior.total.bookings.total.gm) * 100;
  const marginChangePct = prior.total.bookings.total.gm > 0 ?
    ((bookingsGM - prior.total.bookings.total.gm) / prior.total.bookings.total.gm * 100) : 0;

  return `
    <div style="font-size: 11px; line-height: 2.0;">
      <!-- Bookings GP -->
      <div class="metric-box">
        <span class="metric-label">Bookings GP:</span>
        <div class="metric-value-group">
          <div class="metric-primary">${formatCurrency(bookingsGP, true)}</div>
          <div class="metric-secondary" style="color: ${bookingsWoW >= 0 ? '#10b981' : '#dc2626'};">
            ${bookingsWoW >= 0 ? '↑' : '↓'} ${Math.abs(bookingsWoW).toFixed(0)}% WoW
          </div>
        </div>
      </div>
      <!-- Bookings GM -->
      <div class="metric-box">
        <span class="metric-label">Bookings GM:</span>
        <div class="metric-value-group">
          <div class="metric-primary">${formatPercent(bookingsGM)}</div>
          <div class="metric-secondary" style="color: ${marginChange >= 0 ? '#10b981' : '#dc2626'};">
            ${marginChange >= 0 ? '↑' : '↓'} ${Math.abs(marginChange).toFixed(1)} pts (${Math.abs(marginChangePct).toFixed(0)}%)
          </div>
        </div>
      </div>
      <!-- Billings GP -->
      <div class="metric-box">
        <span class="metric-label">Billings GP:</span>
        <div class="metric-value-group">
          <div class="metric-primary">${formatCurrency(billingsGP, true)}</div>
          <div class="metric-secondary" style="color: ${billingsWoW >= 0 ? '#10b981' : '#dc2626'};">
            ${billingsWoW >= 0 ? '↑' : '↓'} ${Math.abs(billingsWoW).toFixed(0)}% WoW
          </div>
        </div>
      </div>
      <!-- Billings GM -->
      <div class="metric-box">
        <span class="metric-label">Billings GM:</span>
        <div class="metric-value-group">
          <div class="metric-primary">${formatPercent(billingsGM)}</div>
          <div class="metric-secondary" style="color: ${(billingsGM - prior.total.billings.total.gm) >= 0 ? '#10b981' : '#dc2626'};">
            ${(billingsGM - prior.total.billings.total.gm) >= 0 ? '↑' : '↓'} ${Math.abs((billingsGM - prior.total.billings.total.gm) * 100).toFixed(1)} pts
          </div>
        </div>
      </div>
      <!-- B/B Ratio -->
      <div class="metric-box">
        <span class="metric-label">B/B Ratio:</span>
        <div class="metric-value-group">
          <div class="metric-primary" style="color: ${bbRatio >= 1.0 ? '#10b981' : '#dc2626'};">${bbRatio.toFixed(2)}x</div>
          <div style="font-size: 9px; color: #64748b;">${bbRatio >= 1.0 ? 'Building backlog' : 'Consuming backlog'}</div>
        </div>
      </div>
      <!-- Alert box -->
      <div class="alert-box" style="background: ${Math.abs(marginChange) > 10 ? '#fef3c7' : '#f0fdf4'}; border-left: 3px solid ${Math.abs(marginChange) > 10 ? '#f59e0b' : '#10b981'}; margin-top: 8px;">
        ${Math.abs(marginChange) > 10 ?
          `🔴 <strong>CRITICAL:</strong> Bookings margin ${marginChange < 0 ? 'dropped' : 'surged'} ${Math.abs(marginChange).toFixed(1)} points` :
          `🟢 <strong>STABLE:</strong> Margins within normal range`
        }
      </div>
      <!-- KLA Note -->
      <div class="kla-note">
        <strong>Note on KLA Business:</strong> Metrics include KLA Research consignment business. Week ${WEEK_NUM} KLA impact: Bookings ${formatCurrency(kla.bookings.gp, true)} (${kla.bookings.gp > 0 && bookingsGP > 0 ? Math.round((kla.bookings.gp / bookingsGP) * 100) : 0}% of total), Billings ${formatCurrency(kla.billings.gp, true)} (${kla.billings.gp > 0 && billingsGP > 0 ? Math.round((kla.billings.gp / billingsGP) * 100) : 0}% of total).
      </div>
    </div>
  `;
}

/**
 * Generate Market Shifts Column HTML
 */
function generateMarketShiftsColumn(externalMarketData) {
  // Identify Week 29 specific shifts
  const shifts = [];

  externalMarketData.forEach(cat => {
    if (cat.category.includes('Memory') && cat.keySignals.includes('CRITICAL ESCALATION')) {
      shifts.push({
        icon: '🆙',
        label: 'CRITICAL ESCALATION',
        color: '#dc2626',
        category: 'Memory (DRAM/HBM)',
        detail: 'HBM at 23% of DRAM capacity, prices +10-20%/month'
      });
    }
    if (cat.category.includes('MLCC') && cat.status === 'Allocated') {
      shifts.push({
        icon: '🆕',
        label: 'NEW CONSTRAINT',
        color: '#dc2626',
        category: 'MLCCs (Passives)',
        detail: '20-26w lead times, structural shortage confirmed'
      });
    }
    if (cat.category.includes('MCU') && cat.keySignals.includes('CRITICAL')) {
      shifts.push({
        icon: '⚠️',
        label: 'PRODUCTION LOSS',
        color: '#ea580c',
        category: 'MCUs (Renesas)',
        detail: '2 weeks production lost, 30-55w lead times'
      });
    }
    if (cat.category.includes('Power') && cat.status === 'Allocated') {
      shifts.push({
        icon: '🆙',
        label: 'UPGRADED',
        color: '#ea580c',
        category: 'Power Management ICs',
        detail: 'uPI Semi 2026 shortage warning, 35-40w LT'
      });
    }
  });

  return `
    <div style="font-size: 11px; line-height: 1.8;">
      ${shifts.slice(0, 5).map(shift => `
        <div class="shift-item" style="border-left: 3px solid ${shift.color};">
          <div class="shift-title" style="color: ${shift.color};">
            ${shift.icon} ${shift.category} → ${shift.label}
          </div>
          <div class="shift-detail">
            ${shift.detail}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Generate Actions Column HTML
 */
function generateActionsColumn(actions) {
  return `
    <div style="font-size: 10px; line-height: 1.6;">
      ${actions.slice(0, 3).map((action, i) => `
        <div class="action-box">
          <div class="action-title">
            ${i + 1}. ${action.title}
          </div>
          <div class="action-detail">
            <strong>Internal:</strong> ${action.internal.substring(0, 60)}${action.internal.length > 60 ? '...' : ''}
          </div>
          <div class="action-detail">
            <strong>External:</strong> ${action.external.substring(0, 60)}${action.external.length > 60 ? '...' : ''}
          </div>
          <div id="exec-action-${i}-detail-link" class="action-expand-link" onclick="toggleActionDetail('exec-action-${i}-detail')">
            [+ View full action details]
          </div>
          <div id="exec-action-${i}-detail" class="action-detail-content">
            <strong>ACTION:</strong> ${action.action}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Generate top 3 actions
 */
function generateTopActions(constraintIndicators, temperatureGauge, externalMarketData) {
  const actions = [];

  // Action 1: Memory escalation (Week 29 specific)
  const memoryData = externalMarketData.find(item => item.category.includes('Memory'));
  if (memoryData && memoryData.keySignals.includes('CRITICAL ESCALATION')) {
    actions.push({
      title: 'Memory Shortage Critical Escalation',
      internal: 'MT* parts showing multi-OEM demand in shortage RFQs; allocation risk highest in 2 years',
      external: 'HBM consuming 23% of DRAM capacity (was ~10% last month); +10-20% price increases per month through end of 2026',
      action: 'URGENT: Lock in memory supply NOW for Q4 2026 commitments. Intel CEO confirms no relief until 2028. Prioritize long-term customer relationships; short-term spot buys will see 50-100% price premium. Micron $9.3B fab (groundbreaking July 8) won\'t produce until Q3 2028.'
    });
  }

  // Action 2: MLCC new structural shortage
  const mlccData = externalMarketData.find(item => item.category.includes('MLCC'));
  if (mlccData && mlccData.status === 'Allocated') {
    actions.push({
      title: 'MLCCs Upgraded to Structural Shortage',
      internal: 'GRM* family showing multi-customer demand; high-capacitance (10µF+) parts most constrained',
      external: 'Shortage status upgraded from "potential risk" to "structural shortage" (June 2026); lead times 20-26w, AI-grade capacitors +50-60% YoY',
      action: 'NEW CONSTRAINT: MLCCs now allocation-grade shortage. AI servers require 40K-440K MLCCs each (NVIDIA GB200: 6,500, Rubin H2 2026: 12,000). Murata/Samsung/Taiyo Yuden at 90-95% utilization. Secure allocation positions for high-cap parts (10µF+, X7R/X5R) immediately.'
    });
  }

  // Action 3: Renesas production disruption
  const mcuData = externalMarketData.find(item => item.category.includes('MCU'));
  if (mcuData && mcuData.keySignals.includes('CRITICAL')) {
    actions.push({
      title: 'Renesas Factory Production Loss',
      internal: 'STM* and Renesas automotive parts under allocation; extended lead times across multiple families',
      external: 'Early July voltage drop at Renesas factory = 2 weeks production lost; STM32 lead times 30-55w, Renesas automotive 20-45w',
      action: 'IMMEDIATE: Check customer commitments for Renesas parts (especially RH850 automotive family). 2-week production gap creates spot shortage on top of existing 20-45w lead times. Proactive communication to customers: expect delivery delays and potential upsells to alternate MCUs (STM32, NXP) if available.'
    });
  }

  // Fallback if we don't have 3 actions
  while (actions.length < 3) {
    actions.push({
      title: 'Monitor Market Conditions',
      internal: 'No critical constraints detected in this category',
      external: 'Market conditions within expected range',
      action: 'Continue standard operations. Focus on conversion optimization and margin improvement. Monitor constraint indicators for emerging signals.'
    });
  }

  return actions;
}

/**
 * Generate Constraint Signals Section
 */
function generateConstraintSignalsSection(constraintIndicators) {
  return `
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
        • <strong>By Part Family:</strong> Which specific part families have 2+ OEM customers requesting in shortage RFQs<br>
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

        <!-- Tab 1: By Part Family -->
        <div id="constraint-tabs-content-families" class="tab-content active">
          <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">
            🔥 Hot Part Families — Shortage Signals (2+ OEM Customers)
          </h4>
          ${generatePartFamilyTable(constraintIndicators.multiCustomerParts, false)}
        </div>

        <!-- Tab 2: By Manufacturer -->
        <div id="constraint-tabs-content-manufacturers" class="tab-content">
          <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">
            📊 Trending Shortage Manufacturers — All Results by Booked GP
          </h4>
          ${generateManufacturerTable(constraintIndicators.trendingMfrs, false)}
        </div>

        <!-- Tab 3: By Lead Time -->
        <div id="constraint-tabs-content-leadtimes" class="tab-content">
          <h4 style="font-size: 12px; font-weight: 600; margin: 16px 0 8px 0; color: #1e293b;">
            📊 Franchise Lead Time Analysis — Market Temperature by Part Type
          </h4>
          ${generateLeadTimeTable(constraintIndicators.franchiseLeadTimes, false)}
        </div>
      </div>
    </div>
  </div>
  `;
}

/**
 * Generate External Market Section
 */
function generateExternalMarketSection(externalMarketData) {
  return `
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
        <strong>Data Source:</strong> Industry market reports (FindChips, 773 GROUP, J2 Sourcing, TrendForce, etc.)<br>
        <strong>Last Updated:</strong> July 13, 2026<br>
        <strong>Purpose:</strong> Validate whether our internal signals match market-wide trends
      </p>
      ${generateExternalMarketTable(externalMarketData)}

      <div style="margin-top: 16px; padding: 12px; background: white; border-left: 4px solid #3b82f6; border-radius: 4px;">
        <p style="font-size: 11px; color: #1e40af; margin: 0; line-height: 1.6;">
          <strong>💡 Sales Action Guide:</strong><br>
          • ✅ <strong>MATCHES</strong> → Confirmed market-wide shortage; premium pricing justified<br>
          • ⚠️ <strong>BETTER SUPPLY</strong> → Competitive advantage! Market aggressively<br>
          • ⚠️ <strong>WATCH</strong> → Monitor for pricing pressure
        </p>
      </div>
    </div>
  </div>
  `;
}

/**
 * Generate External Sources Section (Week 29 specific)
 */
function generateExternalSourcesSection(currentWeek) {
  return `
  <div class="expandable-section">
    <div class="expandable-header" onclick="toggleSection('external-sources')">
      <div>
        <div class="expandable-title">🔗 External Data Sources — Market Intelligence Links</div>
        <div class="expandable-subtitle">
          Direct links to industry sources used for Week ${currentWeek} external market validation
        </div>
      </div>
      <div class="expandable-toggle" id="external-sources-toggle">+</div>
    </div>
    <div id="external-sources" class="expandable-content">
      <p style="font-size: 11px; color: #666; margin-bottom: 16px; line-height: 1.6;">
        <strong>Purpose:</strong> These articles and reports informed the Week ${currentWeek} external market intelligence.<br>
        <strong>Research Date:</strong> July 13, 2026<br>
        <strong>Key Market Events This Week:</strong> Micron $9.3B fab groundbreaking (Jul 8), Renesas voltage drop production loss, Intel CEO "no relief until 2028" statement
      </p>

      <!-- CRITICAL MARKET EVENTS (Week 29) -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🚨 CRITICAL MARKET EVENTS — WEEK 29 (July 8-13, 2026)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <strong>Jul 8:</strong> Micron breaks ground on $9.3B fab in Singapore (production starts Q3 2028) — 3-year wait for relief
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Early Jul:</strong> Renesas MCU factory voltage drop due to lightning — 2 weeks production lost, automotive MCUs most affected
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jul 10:</strong> Intel CEO Lip-Bu Tan: "No relief until 2028" for memory shortage — confirms multi-year structural shortage
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jul 12:</strong> HBM 2026 capacity SOLD OUT under multi-year contracts — entire year allocation locked
          </div>
          <div style="margin-bottom: 4px;">
            • <strong>Jun 2026:</strong> MLCC shortage shifts from "potential risk" to "structural shortage" (industry buyer data)
          </div>
          <div>
            • <strong>Jul 1:</strong> Multiple manufacturer price increases effective (Infineon, TI, Molex, TE Connectivity)
          </div>
        </div>
      </div>

      <!-- Memory Sources -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🔴 MEMORY (DRAM/NAND/HBM) — ALLOCATED / CRITICAL ESCALATION
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://www.tomshardware.com/pc-components/ram/hbm-is-eating-your-ram" target="_blank" style="color: #3b82f6;">Tom's Hardware (Jul 2, 2026): "HBM Is Eating Your RAM"</a> — HBM uses 3-4x wafer capacity vs DDR5
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://tech-insider.org/memory-chip-shortage-2026-ai-consumer-electronics/" target="_blank" style="color: #3b82f6;">Tech Insider (Jul 2, 2026): "Memory Chip Shortage 2026"</a> — DRAM +80-90% Q1, +70% expected Q2
          </div>
          <div>
            • <a href="https://sourceability.com/post/the-memory-shortage-is-set-to-grow-through-2026" target="_blank" style="color: #3b82f6;">Sourceability (Jul 2, 2026)</a> — DRAM revenues projected to triple to $418.6B
          </div>
        </div>
      </div>

      <!-- MLCC Sources -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🆕 MLCCs (PASSIVES) — NEW CONSTRAINT (ALLOCATED)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://www.astutegroup.com/news/general/mlcc-shortages-deepen-as-ai-demand-extends-lead-times/" target="_blank" style="color: #3b82f6;">Astute Group (Jul 2, 2026): "MLCC Shortages Deepen"</a> — NVIDIA GB200: 6,500 MLCCs, Rubin: 12,000
          </div>
          <div style="margin-bottom: 4px;">
            • <a href="https://www.773grp.com/blogs/news/the-2026-passive-components-crunch-mlcc-capacitor-lead-times" target="_blank" style="color: #3b82f6;">773 GROUP (Jul 2, 2026)</a> — Lead times 26-40w (was 8-12w)
          </div>
          <div>
            • <a href="https://www.eenewseurope.com/en/ai-drives-mlcc-shortage/" target="_blank" style="color: #3b82f6;">EE News Europe (Jul 2, 2026)</a> — AI-grade MLCCs +50-60% by May 2026
          </div>
        </div>
      </div>

      <!-- MCU Sources -->
      <div style="background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #991b1b; margin-bottom: 8px;">
          🔴 MCUs (STM32, RENESAS) — CONSTRAINED (30-55w Lead Times)
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div style="margin-bottom: 4px;">
            • <a href="https://www.773grp.com/blogs/news/mcu-market-2026-microcontroller-lead-times-shortage" target="_blank" style="color: #3b82f6;">773 GROUP (Jul 2, 2026): "MCU Market 2026"</a> — STM32 lead time research
          </div>
          <div>
            • <a href="https://blog.findchips.com/mcu-mpu-shortage-watch-q2-2026/" target="_blank" style="color: #3b82f6;">FindChips (Jul 2, 2026): "MCU & MPU Shortage Watch Q2 2026"</a> — 30-31w lead times
          </div>
        </div>
      </div>

      <!-- Power ICs Sources -->
      <div style="background: #fff7ed; border-left: 3px solid #ea580c; padding: 12px; margin-bottom: 12px; border-radius: 4px;">
        <div style="font-weight: 700; font-size: 12px; color: #9a3412; margin-bottom: 8px;">
          🟠 POWER ICs — CONSTRAINED / UPGRADED TO ALLOCATED
        </div>
        <div style="font-size: 10px; color: #666; line-height: 1.8;">
          <div>
            • <a href="https://www.microchipusa.com/manufacturer-articles/electronic-component-shortage-2026-vishay-onsemi--infineon-risks" target="_blank" style="color: #3b82f6;">Microchip USA (Jul 2, 2026)</a> — Allocation programs active, uPI Semi 2026 shortage warning
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
            • <a href="https://www.ti.com/ordering-resources/faqs/inventory-product-availability.html" target="_blank" style="color: #3b82f6;">Texas Instruments</a> — TI inventory at 222 days (Q2 2026)
          </div>
        </div>
      </div>

    </div>
  </div>
  `;
}

/**
 * Generate part family table HTML
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
          <th style="text-align: right;">Customers</th>
          <th style="text-align: right;">RFQ Lines</th>
          <th style="text-align: right;">VQ Lines</th>
          <th style="text-align: right;">CQ Lines</th>
          <th style="text-align: right;">SO Lines</th>
          <th style="text-align: right;">Booked GP</th>
        </tr>
      </thead>
      <tbody>
        ${displayParts.map((part, i) => `
        <tr style="background: ${i === 0 ? '#f0fdf4' : '#f5f5f5'};">
          <td><strong>${i === 0 ? '🏆 ' : ''}${part.mpn}*</strong></td>
          <td>${part.manufacturer}</td>
          <td style="text-align: right;">${part.total_customers} (${part.oem_customers} OEM)</td>
          <td style="text-align: right;">${part.rfq_lines || 0}</td>
          <td style="text-align: right;">${part.vq_lines || 0}${part.no_quote_count > 0 ? `<span style="color: #dc2626;">(-${part.no_quote_count})</span>` : ''}</td>
          <td style="text-align: right;">${part.cq_lines || 0}</td>
          <td style="text-align: right;">${part.so_lines || 0}</td>
          <td style="text-align: right; font-weight: 600;">
            ${formatCurrency(part.booked_gp || 0)}
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    ${!limitRows ? `<p style="font-size: 10px; color: #666; font-style: italic; margin-top: 8px;">Showing all ${parts.length} part families with 2+ OEM customers in shortage RFQs (30-day window).</p>` : ''}
  `;
}

/**
 * Generate manufacturer table HTML
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
          <td style="text-align: right; font-weight: 600;">
            ${formatCurrency(mfr.booked_gp || 0)}
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    ${!limitRows ? `<p style="font-size: 10px; color: #666; font-style: italic; margin-top: 8px;">Showing all ${manufacturers.length} manufacturers from shortage RFQs (30-day window).</p>` : ''}
  `;
}

/**
 * Generate lead time table HTML
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
    ${!limitRows ? `<p style="font-size: 10px; color: #666; font-style: italic; margin-top: 8px;">Showing all ${leadTimes.length} part families with franchise lead time data.</p>` : ''}
  `;
}

/**
 * Generate external market table HTML
 */
function generateExternalMarketTable(externalData) {
  return `
    <table>
      <thead>
        <tr>
          <th style="width: 20%;">Category</th>
          <th style="width: 12%; text-align: center;">Status</th>
          <th style="width: 35%;">Key Signals (Week 29)</th>
          <th style="width: 12%; text-align: center;">Industry LT</th>
          <th style="width: 12%; text-align: center;">Alignment</th>
          <th style="width: 9%;">OT Signal</th>
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
          <td style="font-size: 10px;">${item.keySignals.substring(0, 150)}${item.keySignals.length > 150 ? '...' : ''}</td>
          <td style="text-align: center; font-weight: 600;">${item.industryLeadTime}</td>
          <td style="text-align: center; font-weight: 700; ${
            item.alignment === 'MATCHES' ? 'color: #10b981;' :
            item.alignment === 'BETTER SUPPLY' ? 'color: #3b82f6;' :
            'color: #ea580c;'
          }">
            ${item.alignmentIcon} ${item.alignment}
          </td>
          <td style="font-size: 10px; color: #666;">${item.otSignal.substring(0, 50)}${item.otSignal.length > 50 ? '...' : ''}</td>
        </tr>
        `;
        }).join('')}
      </tbody>
    </table>
  `;
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log(`\n=== Generating Market Pulse Week ${WEEK_NUM} Report ===\n`);

    // Collect all data using functions from week25 script
    const snapshot = collectPerformanceSnapshot();
    const constraintIndicators = collectConstraintIndicators();
    const temperatureGauge = calculateTemperatureGauge(constraintIndicators);
    const externalMarketData = getExternalMarketDataWeek29();

    // Build HTML
    const html = buildWeek29HTML(
      snapshot,
      constraintIndicators,
      temperatureGauge,
      externalMarketData
    );

    // Write output file
    const outputDir = path.join(__dirname, '../output/market-pulse');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `market-pulse-week${WEEK_NUM}-${timestamp}.html`);

    fs.writeFileSync(htmlPath, html);
    console.log(`✅ HTML report: ${htmlPath}`);

    // Summary
    console.log(`\n=== Week ${WEEK_NUM} Summary ===`);
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
