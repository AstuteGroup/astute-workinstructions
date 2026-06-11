#!/usr/bin/env node
/**
 * NC Response Monitor — Alerts Jake when datamaster@netcomponents.com replies
 * to stockrfq@ without CC'ing him.
 *
 * Checks the stockrfq inbox for emails from datamaster@netcomponents.com,
 * forwards them to Jake, and marks them processed.
 *
 * Schedule: Every 4 hours (low-frequency check for rare event)
 *
 * Usage:
 *   node nc-response-monitor.js           # Live run
 *   node nc-response-monitor.js --dry-run # Preview without sending
 */

'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createNotifier } = require('../shared/notifier');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  inbox: 'stockRFQ@orangetsunami.com',
  watchFor: 'datamaster@netcomponents.com',
  alertTo: process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com',
  imapHost: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
  imapPort: 993,
  sentinelFile: path.join(process.env.HOME, 'workspace/.nc-response-monitor-seen.json'),
  // Once we detect ANY response from NC, stop running (mission complete)
  stopSentinel: path.join(process.env.HOME, 'workspace/.nc-response-monitor-done'),
};

// =============================================================================
// HELPERS
// =============================================================================

function loadSeenUIDs() {
  try {
    if (fs.existsSync(CONFIG.sentinelFile)) {
      return new Set(JSON.parse(fs.readFileSync(CONFIG.sentinelFile, 'utf8')));
    }
  } catch (e) {
    console.warn(`Warning: Could not load seen UIDs: ${e.message}`);
  }
  return new Set();
}

function saveSeenUIDs(uids) {
  try {
    // Keep only last 500 UIDs to prevent unbounded growth
    const arr = [...uids].slice(-500);
    fs.writeFileSync(CONFIG.sentinelFile, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.warn(`Warning: Could not save seen UIDs: ${e.message}`);
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const forceRun = process.argv.includes('--force');

  // Check if we already completed (found a response previously)
  if (fs.existsSync(CONFIG.stopSentinel) && !forceRun) {
    const data = JSON.parse(fs.readFileSync(CONFIG.stopSentinel, 'utf8'));
    console.log('NC Response Monitor: Already completed.');
    console.log(`  Response detected: ${data.detectedAt}`);
    console.log(`  Subject: ${data.subject}`);
    console.log('\nTo re-enable: rm ~/.nc-response-monitor-done');
    return { success: true, completed: true };
  }

  console.log('='.repeat(60));
  console.log('NC Response Monitor');
  console.log('='.repeat(60));
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Watching for: ${CONFIG.watchFor}`);
  console.log(`Alert to: ${CONFIG.alertTo}`);
  console.log('-'.repeat(60));

  const seenUIDs = loadSeenUIDs();
  const newlySeen = [];
  const toForward = [];

  // Connect to IMAP
  const client = new ImapFlow({
    host: CONFIG.imapHost,
    port: CONFIG.imapPort,
    secure: true,
    auth: {
      user: CONFIG.inbox,
      pass: process.env.WORKMAIL_PASS,
    },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Scan recent messages (last 7 days worth, roughly)
    // We'll check all and filter by seen UIDs
    for await (const msg of client.fetch('1:*', { envelope: true, source: true })) {
      const from = msg.envelope.from && msg.envelope.from[0];
      const fromAddr = from ? (from.address || '').toLowerCase() : '';

      if (fromAddr.includes('datamaster') && fromAddr.includes('netcomponent')) {
        const uid = msg.uid;

        if (seenUIDs.has(uid)) {
          continue; // Already processed
        }

        console.log(`\nFound NC response: UID ${uid}`);
        console.log(`  From: ${from.name || ''} <${fromAddr}>`);
        console.log(`  Subject: ${msg.envelope.subject}`);
        console.log(`  Date: ${msg.envelope.date}`);

        // Check if Jake was CC'd
        const ccAddrs = (msg.envelope.cc || []).map(c => (c.address || '').toLowerCase());
        const toAddrs = (msg.envelope.to || []).map(t => (t.address || '').toLowerCase());
        const jakeEmail = CONFIG.alertTo.toLowerCase();

        const jakeIncluded = ccAddrs.includes(jakeEmail) || toAddrs.includes(jakeEmail);

        if (jakeIncluded) {
          console.log(`  → Jake was CC'd/TO'd — no alert needed`);
        } else {
          console.log(`  → Jake NOT included — will forward alert`);

          // Parse full message for forwarding
          const parsed = await simpleParser(msg.source);
          toForward.push({
            uid,
            subject: msg.envelope.subject,
            date: msg.envelope.date,
            from: `${from.name || ''} <${fromAddr}>`,
            textBody: parsed.text || '(no text body)',
            htmlBody: parsed.html || null,
          });
        }

        newlySeen.push(uid);
      }
    }

    await client.logout();
  } catch (e) {
    console.error(`IMAP error: ${e.message}`);
    throw e;
  }

  // Send alerts
  if (toForward.length > 0) {
    console.log(`\nForwarding ${toForward.length} message(s) to ${CONFIG.alertTo}...`);

    if (!dryRun) {
      const notifier = createNotifier({
        fromEmail: CONFIG.inbox,
        fromName: 'NC Response Monitor',
        smtpPass: process.env.WORKMAIL_PASS,
      });

      for (const msg of toForward) {
        const subject = `[FWD] NetComponents Response: ${msg.subject}`;
        const html = `
<div style="font-family: Arial, sans-serif; font-size: 13px; max-width: 700px;">
  <div style="background: #fffbcc; border: 1px solid #e6d98c; padding: 12px; margin-bottom: 16px; border-radius: 4px;">
    <strong>⚠️ NetComponents replied to stockRFQ@ without CC'ing you</strong><br>
    <span style="font-size: 12px; color: #666;">This is an automated forward from the NC Response Monitor.</span>
  </div>

  <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 16px;">
    <strong>From:</strong> ${msg.from}<br>
    <strong>Date:</strong> ${msg.date}<br>
    <strong>Subject:</strong> ${msg.subject}
  </div>

  <div style="border-left: 3px solid #ccc; padding-left: 12px;">
    ${msg.htmlBody || `<pre style="white-space: pre-wrap;">${msg.textBody}</pre>`}
  </div>
</div>`;

        try {
          await notifier.send(CONFIG.alertTo, subject, html);
          console.log(`  ✓ Forwarded UID ${msg.uid}`);
        } catch (e) {
          console.error(`  ✗ Failed to forward UID ${msg.uid}: ${e.message}`);
        }
      }
    } else {
      console.log('  [dry-run] Skipping actual send');
    }
  } else {
    console.log('\nNo new NC responses requiring forwarding.');
  }

  // Update seen UIDs
  if (newlySeen.length > 0 && !dryRun) {
    for (const uid of newlySeen) {
      seenUIDs.add(uid);
    }
    saveSeenUIDs(seenUIDs);
    console.log(`\nMarked ${newlySeen.length} UID(s) as seen.`);

    // Mission complete — stop future runs
    const firstMsg = toForward[0] || { subject: '(Jake was CC\'d)', date: new Date().toISOString() };
    fs.writeFileSync(CONFIG.stopSentinel, JSON.stringify({
      detectedAt: new Date().toISOString(),
      subject: firstMsg.subject,
      forwarded: toForward.length,
    }, null, 2));
    console.log('\n✓ Response detected — monitor will stop on future runs.');
    console.log('  To re-enable later: rm ~/workspace/.nc-response-monitor-done');
  }

  console.log('\n' + '='.repeat(60));
  console.log('NC Response Monitor Complete');
  console.log('='.repeat(60));

  return { success: true, forwarded: toForward.length, checked: newlySeen.length };
}

// =============================================================================
// ENTRY
// =============================================================================

if (require.main === module) {
  main()
    .then(r => process.exit(r.success ? 0 : 1))
    .catch(e => {
      console.error('Fatal error:', e);
      process.exit(1);
    });
}

module.exports = { main };
