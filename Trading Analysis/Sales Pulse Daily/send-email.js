#!/usr/bin/env node
/**
 * Sales Pulse Daily Email Sender
 *
 * Sends the comprehensive Sales Pulse report via email
 * Usage: node send-email.js [--to email@example.com] [--test]
 */

const fs = require('fs');
const path = require('path');
const { createNotifier } = require('../../shared/notifier');

// Get today's date in YYYY-MM-DD format
function getToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse command line arguments
const args = process.argv.slice(2);
const testMode = args.includes('--test');
const toIndex = args.indexOf('--to');
const recipientOverride = toIndex >= 0 && args[toIndex + 1] ? args[toIndex + 1] : null;

// Email configuration
const FROM_EMAIL = 'salesanalytics@orangetsunami.com';
const FROM_NAME = 'Sales Pulse Daily';

// Default recipients (can be overridden with --to)
const DEFAULT_RECIPIENTS = [
  'melissa.bojar@astutegroup.com',
  'jeff.wallace@astutegroup.com'
];

// Test recipient (when --test flag is used)
const TEST_RECIPIENT = 'melissa.bojar@astutegroup.com';

async function sendSalesPulseEmail() {
  try {
    // Determine recipient(s)
    const recipients = recipientOverride
      ? [recipientOverride]
      : (testMode ? [TEST_RECIPIENT] : DEFAULT_RECIPIENTS);

    console.log(`Sending Sales Pulse email to: ${recipients.join(', ')}`);
    if (testMode) {
      console.log('⚠️  TEST MODE - Only sending to test recipient');
    }

    // Load today's HTML report
    const today = getToday();
    const htmlPath = path.join(__dirname, 'output', `sales-pulse-comprehensive-${today}.html`);

    if (!fs.existsSync(htmlPath)) {
      console.error(`❌ Error: Report file not found: ${htmlPath}`);
      console.error('Run sales-pulse-comprehensive.js first to generate the report.');
      process.exit(1);
    }

    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    // Create notifier
    const notifier = createNotifier({
      fromEmail: FROM_EMAIL,
      fromName: FROM_NAME
    });

    // Format date for subject line
    const dateObj = new Date();
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
    const monthName = dateObj.toLocaleDateString('en-US', { month: 'long' });
    const dayNum = dateObj.getDate();
    const year = dateObj.getFullYear();

    const subject = `📊 Sales Pulse — ${dayName}, ${monthName} ${dayNum}, ${year}`;

    // Send to each recipient
    const results = [];
    for (const recipient of recipients) {
      const success = await notifier.sendEmail(
        recipient,
        subject,
        htmlContent,
        { html: true }
      );
      results.push({ recipient, success });

      if (success) {
        console.log(`✅ Sent to ${recipient}`);
      } else {
        console.log(`❌ Failed to send to ${recipient}`);
      }
    }

    // Summary
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    console.log(`\n📧 Email sending complete:`);
    console.log(`   ✅ Successful: ${successCount}`);
    if (failCount > 0) {
      console.log(`   ❌ Failed: ${failCount}`);
    }

    if (successCount === 0) {
      console.error('\n❌ All email sends failed. Check SMTP configuration in ~/.env');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run
sendSalesPulseEmail();
