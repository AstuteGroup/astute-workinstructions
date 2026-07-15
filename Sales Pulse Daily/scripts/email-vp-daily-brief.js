#!/usr/bin/env node

/**
 * Email VP Daily Brief V2
 *
 * Generates the VP Daily Brief and emails it as an HTML attachment
 * Recipients: Josh Pucci, Melissa Bojar, Aran Coker
 * Scheduled to run weekdays at 8am via cron
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load notifier from shared utilities
const { createNotifier } = require(path.resolve(__dirname, '../../shared/notifier'));
const { runHealthChecks, validateReportData } = require(path.join(__dirname, 'health-checks.js'));

const notifier = createNotifier({
  fromEmail: 'salesanalytics@orangetsunami.com',
  fromName: 'Sales Analytics',
});

// Recipients
const RECIPIENTS = [
  'josh.pucci@astutegroup.com',
  'melissa.bojar@astutegroup.com',
  'aran.coker@astutegroup.com'
];

const ALERT_RECIPIENT = 'melissa.bojar@astutegroup.com';

async function sendAlert(subject, body) {
  await notifier.sendEmail(ALERT_RECIPIENT, subject, body);
}

async function main() {
  try {
    console.log('============================================================');
    console.log('VP DAILY BRIEF - EMAIL DISTRIBUTION');
    console.log('============================================================\n');

    // Step 0: Run health checks
    console.log('🏥 Running system health checks...');
    const healthCheck = runHealthChecks();
    if (!healthCheck.healthy) {
      console.error('❌ HEALTH CHECK FAILED - System not ready');
      console.error('Aborting VP Daily Brief send to prevent bad data\n');

      await sendAlert(
        '🚨 ALERT: VP Daily Brief Health Check Failed - NOT SENT',
        `VP Daily Brief automated send was blocked due to system health issues.

HEALTH CHECK FAILURES:
${healthCheck.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Recipients who did NOT receive today's brief:
- Josh Pucci
- Melissa Bojar
- Aran Coker

Run health checks manually: node ~/workspace/astute-workinstructions/Sales\\ Pulse\\ Daily/scripts/health-checks.js
`
      );

      process.exit(1);
    }
    console.log('✅ Health checks passed\n');

    // Step 1: Generate the report
    console.log('📊 Generating VP Daily Brief...');
    const scriptPath = path.join(__dirname, 'sales-pulse-vp-daily-v2.js');
    execSync(`node "${scriptPath}"`, { encoding: 'utf8', stdio: 'inherit' });

    // Step 2: Get the generated files and validate data
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const htmlPath = path.join(__dirname, '../output/vp-briefs', `vp-daily-brief-v2-${today}.html`);
    const jsonPath = path.join(__dirname, '../output/vp-briefs', `vp-daily-brief-v2-${today}.json`);

    if (!fs.existsSync(htmlPath)) {
      throw new Error(`HTML file not found at ${htmlPath}`);
    }

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`JSON file not found at ${jsonPath}`);
    }

    // Step 2A: Validate report data quality
    console.log('\n🔍 Validating report data quality...');
    const reportData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const dataErrors = validateReportData(reportData, 'VP Daily Brief');

    if (dataErrors.length > 0) {
      console.error('❌ DATA VALIDATION FAILED - Report data looks suspicious');
      console.error('Aborting VP Daily Brief send\n');

      await sendAlert(
        '🚨 ALERT: VP Daily Brief Data Validation Failed - NOT SENT',
        `VP Daily Brief automated send was blocked due to suspicious/incomplete data.

DATA VALIDATION FAILURES:
${dataErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Recipients who did NOT receive today's brief:
- Josh Pucci
- Melissa Bojar
- Aran Coker

Review JSON: ~/workspace/astute-workinstructions/Sales\\ Pulse\\ Daily/output/vp-briefs/vp-daily-brief-v2-${today}.json
`
      );

      process.exit(1);
    }
    console.log('✅ Data validation passed\n');

    // Step 3: Calculate previous business day (Friday if Monday, else yesterday)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const businessDay = new Date(now);
    if (dayOfWeek === 1) {
      // Monday: go back 3 days to Friday
      businessDay.setDate(businessDay.getDate() - 3);
    } else {
      // Otherwise: go back 1 day
      businessDay.setDate(businessDay.getDate() - 1);
    }

    const yesterdayFormatted = businessDay.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const subject = `VP Daily Brief - Sales Pulse (${yesterdayFormatted})`;

    // Step 4: Create simple email body with instructions
    const emailBodyHTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: #333;
    max-width: 600px;
    margin: 0 auto;
    padding: 20px;
  }
  .info-box {
    background: #f8fafc;
    border-left: 4px solid #3b82f6;
    padding: 16px;
    margin: 20px 0;
    border-radius: 4px;
  }
  .section-list {
    margin: 12px 0;
    padding-left: 24px;
  }
  .section-list li {
    margin: 8px 0;
  }
  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 2px solid #e5e7eb;
    font-size: 13px;
    color: #6b7280;
  }
</style>
</head>
<body>
  <p>Good morning,</p>

  <p>Your VP Daily Brief for <strong>${yesterdayFormatted}</strong> is attached. This report provides a quick 60-second review of Astute Inc.'s sales performance from yesterday.</p>

  <div class="info-box">
    <p style="margin-top: 0;"><strong>📎 How to View:</strong></p>
    <p>Open the attached HTML file in your web browser for the full interactive report with collapsible sections and detailed tables.</p>
  </div>

  <p><strong>Report Sections:</strong></p>
  <ul class="section-list">
    <li><strong>Section 1: Yesterday's Top Wins</strong> — Top orders booked, new customers won, strategic account activity, and customer reactivations</li>
    <li><strong>Section 2: Needs Attention</strong> — High-value late shipments, upcoming scheduled shipments, inactive sales reps, and low-margin orders requiring review</li>
    <li><strong>Section 3: Yesterday's Activity by Region</strong> — Regional performance breakdown across USA, MEX, APAC-Laurel, APAC-Silvia, and Other</li>
  </ul>

  <div class="footer">
    <p>Questions or feedback? Contact Melissa Bojar at melissa.bojar@astutegroup.com</p>
  </div>
</body>
</html>
    `;

    // Step 5: Send to each recipient with HTML attachment
    console.log('\n📧 Sending emails...');
    for (const recipient of RECIPIENTS) {
      console.log(`  Sending to ${recipient}...`);
      const success = await notifier.sendWithAttachment(
        recipient,
        subject,
        emailBodyHTML,
        [{
          filename: `vp-daily-brief-${today}.html`,
          path: htmlPath
        }],
        { html: true }
      );

      if (success) {
        console.log(`  ✓ Sent successfully to ${recipient}`);
      } else {
        console.log(`  ✗ Failed to send to ${recipient}`);
      }
    }

    console.log('\n============================================================');
    console.log('✅ EMAIL DISTRIBUTION COMPLETE');
    console.log('============================================================');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
