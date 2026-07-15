#!/usr/bin/env node

/**
 * Email USA Daily Brief
 *
 * Generates the USA Daily Brief and emails it as an HTML attachment
 * Recipients: Jeff Wallace, Melissa Bojar
 * Scheduled to run weekdays at 6am via cron
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
  'jeff.wallace@astutegroup.com',
  'melissa.bojar@astutegroup.com'
];

const ALERT_RECIPIENT = 'melissa.bojar@astutegroup.com';

async function sendAlert(subject, body) {
  await notifier.sendEmail(ALERT_RECIPIENT, subject, body);
}

async function main() {
  try {
    console.log('============================================================');
    console.log('USA DAILY BRIEF - EMAIL DISTRIBUTION');
    console.log('============================================================\n');

    // Step 0A: Run health checks (database connectivity, sample queries)
    console.log('🏥 Running system health checks...');
    const healthCheck = runHealthChecks();
    if (!healthCheck.healthy) {
      console.error('❌ HEALTH CHECK FAILED - System not ready');
      console.error('Aborting USA Daily Brief send to prevent bad data\n');

      await sendAlert(
        '🚨 ALERT: USA Daily Brief Health Check Failed - NOT SENT',
        `USA Daily Brief automated send was blocked due to system health issues.

HEALTH CHECK FAILURES:
${healthCheck.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

LIKELY CAUSES:
- Database connection issues (network outage, database server down)
- Database query timeouts
- Stale/missing data in database

ACTION REQUIRED:
1. Check database connectivity: psql -c "SELECT 1;"
2. Check recent orders: psql -c "SELECT COUNT(*) FROM adempiere.c_order WHERE created::date >= CURRENT_DATE - INTERVAL '7 days';"
3. If database is down/unreachable, wait for connectivity to restore
4. If database is up but returning no data, investigate data pipeline
5. Do NOT manually run email scripts until health checks pass

Recipients who did NOT receive today's brief:
- Jeff Wallace
- Melissa Bojar

The brief will NOT be sent until system health is restored.

---
Run health checks manually: node ~/workspace/astute-workinstructions/Sales\\ Pulse\\ Daily/scripts/health-checks.js
`
      );

      process.exit(1);
    }
    console.log('✅ Health checks passed\n');

    // Step 0B: Validate regional filtering fixes are in place
    console.log('🔍 Running regional filtering validation...');
    const validationPath = path.join(__dirname, 'validate-regional-fixes.js');
    try {
      execSync(`node "${validationPath}"`, { encoding: 'utf8', stdio: 'pipe' });
      console.log('✅ Validation passed - regional fixes confirmed\n');
    } catch (validationError) {
      console.error('❌ VALIDATION FAILED - Regional fixes NOT in place');
      console.error('Aborting USA Daily Brief send to prevent incorrect data\n');

      // Send alert email to Melissa
      await notifier.sendEmail(
        'melissa.bojar@astutegroup.com',
        '🚨 ALERT: USA Daily Brief Validation Failed - NOT SENT',
        `USA Daily Brief automated send was blocked due to validation failure.

The regional filtering validation script detected that fixes are NOT in place.
This prevents sending reports with incorrect region labels.

ACTION REQUIRED:
1. Run validation manually: node ~/workspace/astute-workinstructions/Sales\\ Pulse\\ Daily/scripts/validate-regional-fixes.js
2. Review failed checks
3. Contact Claude to re-apply fixes if needed
4. Do NOT manually run email scripts until validation passes

Recipients who did NOT receive today's brief:
- Jeff Wallace
- Melissa Bojar

The brief will NOT be sent until validation passes.

---
Validation output:
${validationError.stdout || validationError.message}
`
      );

      process.exit(1);
    }

    // Step 1: Generate the report
    console.log('📊 Generating USA Daily Brief...');
    const scriptPath = path.join(__dirname, 'sales-pulse-usa-daily.js');
    execSync(`node "${scriptPath}"`, { encoding: 'utf8', stdio: 'inherit' });

    // Step 2: Get the generated HTML and JSON files
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const htmlPath = path.join(__dirname, '../output/usa-briefs', `usa-daily-brief-${today}.html`);
    const jsonPath = path.join(__dirname, '../output/usa-briefs', `usa-daily-brief-${today}.json`);

    if (!fs.existsSync(htmlPath)) {
      throw new Error(`HTML file not found at ${htmlPath}`);
    }

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`JSON file not found at ${jsonPath}`);
    }

    // Step 2A: Validate report data quality
    console.log('\n🔍 Validating report data quality...');
    const reportData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const dataErrors = validateReportData(reportData, 'USA Daily Brief');

    if (dataErrors.length > 0) {
      console.error('❌ DATA VALIDATION FAILED - Report data looks suspicious');
      console.error('Aborting USA Daily Brief send to prevent incomplete information\n');

      await sendAlert(
        '🚨 ALERT: USA Daily Brief Data Validation Failed - NOT SENT',
        `USA Daily Brief automated send was blocked due to suspicious/incomplete data.

DATA VALIDATION FAILURES:
${dataErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

LIKELY CAUSES:
- Database connection was slow/unstable during report generation
- Queries returned partial results due to timeout
- Database is missing recent data (replication lag, sync issues)

WHAT TO CHECK:
1. Verify database has recent orders: psql -c "SELECT COUNT(*) FROM adempiere.c_order WHERE created::date = CURRENT_DATE - INTERVAL '1 day';"
2. Check if there was ACTUALLY zero activity yesterday (unlikely but possible)
3. Review the generated JSON file manually: ~/workspace/astute-workinstructions/Sales\\ Pulse\\ Daily/output/usa-briefs/usa-daily-brief-${today}.json

Recipients who did NOT receive today's brief:
- Jeff Wallace
- Melissa Bojar

RECOMMENDED ACTION:
If you confirm there was actually no activity yesterday, you can manually send the report.
Otherwise, wait for database stability and re-run: node ~/workspace/astute-workinstructions/Sales\\ Pulse\\ Daily/scripts/email-usa-daily-brief.js
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

    const subject = `USA Daily Brief - Sales Pulse (${yesterdayFormatted})`;

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

  <p>Your USA Daily Brief for <strong>${yesterdayFormatted}</strong> is attached. This report provides a quick review of USA sales team performance from yesterday.</p>

  <div class="info-box">
    <p style="margin-top: 0;"><strong>📎 How to View:</strong></p>
    <p>Open the attached HTML file in your web browser for the full interactive report with collapsible sections and detailed tables.</p>
  </div>

  <p><strong>Report Sections:</strong></p>
  <ul class="section-list">
    <li><strong>Section 1: Yesterday's Top Wins</strong> — Top 15 orders booked (5 visible + 10 collapsible), new customers won, strategic account activity, and customer reactivations</li>
    <li><strong>Section 2: Needs Attention</strong> — Top 10 late shipments, top 5 scheduled to ship this month (backlog view), inactive sales reps, and low-margin orders requiring review</li>
    <li><strong>Section 3: Yesterday's Activity by Sales Rep</strong> — Individual USA sales representative performance breakdown</li>
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
          filename: `usa-daily-brief-${today}.html`,
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
