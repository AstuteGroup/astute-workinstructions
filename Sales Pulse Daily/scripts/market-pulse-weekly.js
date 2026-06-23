#!/usr/bin/env node
/**
 * Market Pulse Weekly - Standalone Market Intelligence Report
 *
 * 30-day rolling window market analysis sent weekly
 *
 * Sections:
 * 1. Temperature Gauge - Overall market status with constraint signals
 * 2. Constraint Indicators - Early warning signals (multi-customer parts, conversion drop, velocity spike)
 * 3. Trending Manufacturers - Top manufacturers by activity with booked sales
 * 4. Trending Parts - Top parts by RFQ count
 * 5. Manufacturer Exposure - Pipeline concentration risk
 * 6. Regional Demand Divergence - APAC concentration signals
 * 7. Response Time Trends - Supply chain stress indicators
 * 8. New Entrants - Emerging hotspots
 *
 * Changes from mockup (per Josh's feedback 2026-06-04):
 * - REMOVED: Margin Expansion Leaders section
 * - REMOVED: Avg Quote Age column from Trending Manufacturers
 * - ADDED: Booked Sales (30d) column to Trending Manufacturers
 * - MODIFIED: Velocity Spike - always show top 3 (no >50% threshold)
 * - MODIFIED: Multi-Customer Parts - emphasize distinct customer count
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
 * Get 30-day rolling window dates
 */
function get30DayWindow() {
  const today = new Date();
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - 30);

  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0]
  };
}

/**
 * Get prior 30-day window (for comparison)
 */
function getPrior30DayWindow() {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() - 30);
  const start = new Date(end);
  start.setDate(start.getDate() - 30);

  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0]
  };
}

/**
 * Section 1: Temperature Gauge
 * Overall market status with constraint signal counts
 */
async function collectTemperatureGauge() {
  console.log('Collecting Temperature Gauge metrics...');

  const window = get30DayWindow();
  const priorWindow = getPrior30DayWindow();

  // TODO: Implement queries for:
  // - Count of MFRs with conversion drop (>10pts)
  // - Count of parts with 5+ customers
  // - Top 3 MFRs by velocity increase (no threshold)
  // - Count of MFRs with APAC >70%
  // - Count of MFRs with response time increase >20%

  // Placeholder data
  return {
    status: 'HEATING UP',
    statusIndicator: '🟡',
    activeSignals: 4,
    description: 'Market transitioning from Normal → Constrained. Memory manufacturers showing early allocation patterns.',
    signals: {
      conversion_drop: 2,
      multi_customer_parts: 3,
      velocity_spike: 0,
      apac_concentration: 2,
      response_time_increase: 1
    },
    keyWatchItems: 'Micron DDR4 (8 customers), Samsung memory (APAC 78% concentration), Nexperia discrete (response time +45%).'
  };
}

/**
 * Section 2: Constraint Indicators
 * Early warning signals for allocation
 */
async function collectConstraintIndicators() {
  console.log('Collecting Constraint Indicators...');

  const window = get30DayWindow();
  const priorWindow = getPrior30DayWindow();

  // TODO: Implement queries for:
  // - Multi-Customer Parts (5+ distinct customers)
  // - Conversion Drop-Off (>10pts decline)
  // - Velocity Spike (top 3 MFRs, no threshold)

  // Placeholder data
  return {
    multiCustomerParts: [],
    conversionDropOff: [],
    velocitySpike: []
  };
}

/**
 * Section 3: Trending Manufacturers
 * Top manufacturers by activity (rank by Sold per Josh feedback)
 */
async function collectTrendingManufacturers() {
  console.log('Collecting Trending Manufacturers...');

  const window = get30DayWindow();
  const priorWindow = getPrior30DayWindow();

  // TODO: Implement query for top 10 manufacturers
  // Columns: Manufacturer, Customers, RFQ Count, Quoted, Sold, Win %, Booked Sales (30d), WoW Velocity, Signals
  // NOTE: Removed Avg Quote Age per Josh feedback
  // NOTE: Consider ranking by Sold instead of RFQ count

  // Placeholder data
  return {
    manufacturers: []
  };
}

/**
 * Section 4: Trending Parts
 * Top parts by RFQ count
 */
async function collectTrendingParts() {
  console.log('Collecting Trending Parts...');

  const window = get30DayWindow();

  // TODO: Implement query for top 10 parts
  // Columns: MPN, Manufacturer, Customers, RFQ Count, Quoted, Sold, Win %, First Seen, Scarcity Signal

  // Placeholder data
  return {
    parts: []
  };
}

/**
 * Section 5: Manufacturer Exposure
 * Pipeline concentration risk
 */
async function collectManufacturerExposure() {
  console.log('Collecting Manufacturer Exposure...');

  // TODO: Implement query for manufacturer pipeline exposure
  // Columns: Manufacturer, Open RFQ Value, Open CQ Value, Total Exposure, % of Pipeline, Largest Customer, Risk Level

  // Placeholder data
  return {
    exposures: []
  };
}

/**
 * Section 6: Regional Demand Divergence
 * APAC concentration signals
 */
async function collectRegionalDemand() {
  console.log('Collecting Regional Demand Divergence...');

  const window = get30DayWindow();

  // TODO: Implement query for regional demand by manufacturer
  // Columns: Manufacturer, Total RFQs, APAC %, USA %, MEX %, Other %, Signal

  // Placeholder data
  return {
    regionalData: []
  };
}

/**
 * Section 7: Response Time Trends
 * Supply chain stress indicators
 */
async function collectResponseTimeTrends() {
  console.log('Collecting Response Time Trends...');

  const window = get30DayWindow();
  const priorWindow = getPrior30DayWindow();

  // TODO: Implement query for response time by manufacturer
  // Columns: Manufacturer, Current Avg Response Time, vs Prior 30d, Change %, Sample Size, Signal

  // Placeholder data
  return {
    responseTimes: []
  };
}

/**
 * Section 8: New Entrants
 * Emerging hotspots
 */
async function collectNewEntrants() {
  console.log('Collecting New Entrants...');

  const window = get30DayWindow();

  // TODO: Implement query for new trending parts/manufacturers
  // Parts/MFRs that weren't in top 20 last period but are trending now

  // Placeholder data
  return {
    entrants: []
  };
}

/**
 * Build HTML email
 */
function buildEmail(tempGauge, constraints, trendingMfrs, trendingParts, exposure, regional, responseTimes, newEntrants) {
  const today = new Date();
  const window = get30DayWindow();
  const windowStart = new Date(window.start);
  const windowEnd = new Date(window.end);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Market Pulse — 30-Day Rolling View</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
    max-width: 1100px;
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
    margin-bottom: 20px;
  }
  .section {
    margin-bottom: 28px;
    padding-bottom: 28px;
    border-bottom: 2px solid #e0e0e0;
  }
  .section:last-child {
    border-bottom: none;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
    color: #1a1a1a;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-subtitle {
    font-size: 11px;
    color: #666;
    margin-bottom: 12px;
    font-style: italic;
  }

  /* Temperature Gauge */
  .temp-gauge {
    background: linear-gradient(135deg, #fef3c7 0%, #fef9e7 100%);
    border: 2px solid #f59e0b;
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 24px;
  }
  .temp-gauge h2 {
    margin: 0 0 12px 0;
    font-size: 16px;
    font-weight: 700;
    color: #92400e;
  }
  .gauge-status {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .gauge-indicator {
    font-size: 48px;
    line-height: 1;
  }
  .gauge-text {
    flex: 1;
  }
  .gauge-title {
    font-size: 18px;
    font-weight: 700;
    color: #1a1a1a;
    margin-bottom: 4px;
  }
  .gauge-detail {
    font-size: 12px;
    color: #666;
  }
  .signal-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 12px;
  }
  .signal-card {
    background: white;
    padding: 12px;
    border-radius: 6px;
    border-left: 3px solid #94a3b8;
  }
  .signal-card.active {
    border-left-color: #dc2626;
    background: #fef2f2;
  }
  .signal-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #64748b;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .signal-value {
    font-size: 18px;
    font-weight: 700;
    color: #1e293b;
  }
  .signal-card.active .signal-value {
    color: #dc2626;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-top: 8px;
  }
  th {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    padding: 8px;
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    color: #475569;
  }
  td {
    border: 1px solid #e2e8f0;
    padding: 8px;
  }
  tr:hover {
    background: #fafafa;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-yellow { background: #fef3c7; color: #92400e; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-gray { background: #f1f5f9; color: #475569; }

  /* Trend indicators */
  .trend-up { color: #dc2626; font-weight: 600; }
  .trend-down { color: #16a34a; font-weight: 600; }
  .trend-neutral { color: #64748b; }

  /* Alert boxes */
  .alert-box {
    background: #f8fafc;
    border-left: 4px solid #3b82f6;
    padding: 12px;
    margin-top: 12px;
    border-radius: 4px;
    font-size: 12px;
  }
  .alert-box.warning {
    background: #fffbeb;
    border-left-color: #f59e0b;
  }
  .alert-box.critical {
    background: #fef2f2;
    border-left-color: #dc2626;
  }
  .alert-box strong {
    color: #1e40af;
  }
  .alert-box.warning strong {
    color: #92400e;
  }
  .alert-box.critical strong {
    color: #991b1b;
  }

  /* Constraint indicators */
  .constraint-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin-top: 12px;
  }
  .constraint-item {
    background: white;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 16px;
  }
  .constraint-header {
    font-weight: 700;
    font-size: 13px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 2px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .constraint-count {
    background: #dc2626;
    color: white;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
  }
  .constraint-count.inactive {
    background: #64748b;
  }
  .constraint-list {
    font-size: 12px;
  }
  .constraint-list-item {
    padding: 6px 0;
    border-bottom: 1px solid #f1f5f9;
  }
  .constraint-list-item:last-child {
    border-bottom: none;
  }

  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #e0e0e0;
    font-size: 11px;
    color: #666;
  }
</style>
</head>
<body>

<div class="container">
  <h1>📈 Market Pulse — 30-Day Rolling View</h1>
  <div class="subtitle">
    As of ${formatDate(today)} | Rolling window: ${formatDate(windowStart)} - ${formatDate(windowEnd)} (30 calendar days)
  </div>

  <!-- TEMPERATURE GAUGE -->
  <div class="temp-gauge">
    <h2>🌡️ Market Temperature — Overall Status</h2>

    <div class="gauge-status">
      <div class="gauge-indicator">${tempGauge.statusIndicator}</div>
      <div class="gauge-text">
        <div class="gauge-title">${tempGauge.status} — ${tempGauge.activeSignals} Constraint Signals Detected</div>
        <div class="gauge-detail">
          ${tempGauge.description}
        </div>
      </div>
    </div>

    <div class="signal-grid">
      <div class="signal-card${tempGauge.signals.conversion_drop > 0 ? ' active' : ''}">
        <div class="signal-label">MFRs with Conversion Drop</div>
        <div class="signal-value">${tempGauge.signals.conversion_drop}${tempGauge.signals.conversion_drop > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.velocity_spike > 0 ? ' active' : ''}">
        <div class="signal-label">MFRs with Velocity Spike</div>
        <div class="signal-value">${tempGauge.signals.velocity_spike}${tempGauge.signals.velocity_spike > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.multi_customer_parts > 0 ? ' active' : ''}">
        <div class="signal-label">Parts with 5+ Customers</div>
        <div class="signal-value">${tempGauge.signals.multi_customer_parts}${tempGauge.signals.multi_customer_parts > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.apac_concentration > 0 ? ' active' : ''}">
        <div class="signal-label">MFRs with APAC >70%</div>
        <div class="signal-value">${tempGauge.signals.apac_concentration}${tempGauge.signals.apac_concentration > 0 ? ' 🔥' : ''}</div>
      </div>
      <div class="signal-card${tempGauge.signals.response_time_increase > 0 ? ' active' : ''}">
        <div class="signal-label">MFRs with Response Time ↑</div>
        <div class="signal-value">${tempGauge.signals.response_time_increase}${tempGauge.signals.response_time_increase > 0 ? ' 🔥' : ''}</div>
      </div>
    </div>

    <div class="alert-box warning" style="margin-top: 16px;">
      <strong>Key Watch Items:</strong> ${tempGauge.keyWatchItems}
    </div>
  </div>

  <!-- PLACEHOLDER SECTIONS -->
  <div class="section">
    <div class="section-title">🔥 Constraint Indicators</div>
    <p style="color: #999; font-style: italic;">Section under development - queries in progress</p>
  </div>

  <div class="section">
    <div class="section-title">🏭 Trending Manufacturers</div>
    <p style="color: #999; font-style: italic;">Section under development - queries in progress</p>
  </div>

  <div class="section">
    <div class="section-title">🔧 Trending Parts</div>
    <p style="color: #999; font-style: italic;">Section under development - queries in progress</p>
  </div>

  <div class="footer">
    <p><strong>Data Sources:</strong> OT RFQ/VQ/CQ pipeline (30-day rolling window)</p>
    <p style="margin-top: 12px; font-style: italic;">
      Generated with Claude Code • Market Pulse Weekly
    </p>
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
  console.log('Market Pulse Weekly - Building report...');

  try {
    const tempGauge = await collectTemperatureGauge();
    const constraints = await collectConstraintIndicators();
    const trendingMfrs = await collectTrendingManufacturers();
    const trendingParts = await collectTrendingParts();
    const exposure = await collectManufacturerExposure();
    const regional = await collectRegionalDemand();
    const responseTimes = await collectResponseTimeTrends();
    const newEntrants = await collectNewEntrants();

    const html = buildEmail(tempGauge, constraints, trendingMfrs, trendingParts, exposure, regional, responseTimes, newEntrants);

    const outputDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `market-pulse-weekly-${timestamp}.html`);
    const jsonPath = path.join(outputDir, `market-pulse-weekly-${timestamp}.json`);

    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
      tempGauge,
      constraints,
      trendingMfrs,
      trendingParts,
      exposure,
      regional,
      responseTimes,
      newEntrants
    }, null, 2));

    console.log(`✅ Market Pulse Weekly generated`);
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
