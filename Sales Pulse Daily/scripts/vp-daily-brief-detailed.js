#!/usr/bin/env node

/**
 * VP Daily Brief V2 - DETAILED VERSION (On-Demand)
 *
 * This version includes part details (MPNs, manufacturers, quantities) which
 * requires slower queries (30-60 seconds). Run manually when full details needed.
 *
 * Usage:
 *   node vp-daily-brief-detailed.js                    # Generate files only
 *   node vp-daily-brief-detailed.js --email josh@...   # Generate and email
 *   node vp-daily-brief-detailed.js --date 2026-06-17  # Specific date
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const emailTo = args.find(arg => arg.startsWith('--email'))?.split('=')[1];
const targetDate = args.find(arg => arg.startsWith('--date'))?.split('=')[1];

console.log('============================================================');
console.log('VP DAILY BRIEF - DETAILED VERSION (On-Demand)');
console.log('============================================================\n');
console.log('⚠️  This version includes part details and may take 30-60 seconds.\n');

if (targetDate) {
  console.log(`📅 Target date: ${targetDate}\n`);
}

// Use the same script but with a special flag to include parts
process.env.INCLUDE_PART_DETAILS = 'true';
if (targetDate) {
  process.env.TARGET_DATE = targetDate;
}

try {
  // Run the main script
  const scriptPath = path.join(__dirname, 'sales-pulse-vp-daily-v2.js');
  execSync(`node "${scriptPath}"`, { encoding: 'utf8', stdio: 'inherit' });

  console.log('\n✅ Detailed report generated successfully!\n');

  // If email requested, send it
  if (emailTo) {
    console.log(`📧 Emailing to ${emailTo}...\n`);
    const { createNotifier } = require(path.resolve(__dirname, '../../astute-workinstructions/shared/notifier'));

    const notifier = createNotifier({
      fromEmail: 'salesanalytics@orangetsunami.com',
      fromName: 'Sales Analytics',
    });

    const today = targetDate || new Date().toISOString().split('T')[0];
    const htmlPath = path.join(__dirname, '../output', `vp-daily-brief-v2-${today}.html`);

    if (!fs.existsSync(htmlPath)) {
      throw new Error(`HTML file not found: ${htmlPath}`);
    }

    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayFormatted = yesterday.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const subject = `VP Daily Brief - DETAILED (${yesterdayFormatted})`;

    (async () => {
      const success = await notifier.sendEmail(emailTo, subject, htmlContent, { html: true });
      if (success) {
        console.log(`✅ Email sent to ${emailTo}\n`);
      } else {
        console.log(`❌ Failed to send email to ${emailTo}\n`);
      }
    })();
  }

} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
} finally {
  delete process.env.INCLUDE_PART_DETAILS;
  delete process.env.TARGET_DATE;
}
