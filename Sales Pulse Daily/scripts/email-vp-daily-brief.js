#!/usr/bin/env node

/**
 * Email VP Daily Brief V2
 *
 * Generates the VP Daily Brief and emails it to Josh Pucci and Melissa Bojar
 * Scheduled to run weekdays at 8am via cron
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load notifier from shared utilities
const { createNotifier } = require(path.resolve(__dirname, '../../astute-workinstructions/shared/notifier'));

const notifier = createNotifier({
  fromEmail: 'salesanalytics@orangetsunami.com',
  fromName: 'Sales Analytics',
});

// Recipients
const RECIPIENTS = [
  'josh.pucci@astutegroup.com',
  'melissa.bojar@astutegroup.com'
];

async function main() {
  try {
    console.log('============================================================');
    console.log('VP DAILY BRIEF - EMAIL DISTRIBUTION');
    console.log('============================================================\n');

    // Step 1: Generate the report
    console.log('📊 Generating VP Daily Brief...');
    const scriptPath = path.join(__dirname, 'sales-pulse-vp-daily-v2.js');
    execSync(`node "${scriptPath}"`, { encoding: 'utf8', stdio: 'inherit' });

    // Step 2: Get the generated HTML file
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const htmlPath = path.join(__dirname, '../output', `vp-daily-brief-v2-${today}.html`);

    if (!fs.existsSync(htmlPath)) {
      throw new Error(`HTML file not found at ${htmlPath}`);
    }

    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Step 3: Prepare email
    // Calculate previous business day (Friday if Monday, else yesterday)
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

    // Step 4: Send to each recipient
    console.log('\n📧 Sending emails...');
    for (const recipient of RECIPIENTS) {
      console.log(`  Sending to ${recipient}...`);
      const success = await notifier.sendEmail(
        recipient,
        subject,
        htmlContent,
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
