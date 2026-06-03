#!/usr/bin/env node
/**
 * Inventory Gate Poller
 *
 * Polls stockrfq@ inbox for Jake's confirmation that inventory has been uploaded.
 * When found, sets the gate file so Active Sourcing can proceed.
 *
 * Trigger phrases (in subject, case-insensitive):
 *   - "inventory uploaded"
 *   - "inventory confirmed"
 *   - "inventory ready"
 *
 * Schedule: Hourly on Mon/Thu, starting 1 hour after inventory upload email
 *
 * Usage:
 *   node inventory-gate-poller.js           # Check once
 *   node inventory-gate-poller.js --status  # Show current state
 */

const path = require('path');
const fs = require('fs');

// Load environment
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createFetcher } = require('../../shared/email-fetcher');
const { setInventoryGate, INVENTORY_GATE_FILE } = require('./active-sourcing-runner');
const { createNotifier } = require('../../shared/notifier');

// Configuration
const INBOX = 'stockrfq@orangetsunami.com';
const PROCESSED_FOLDER = 'Processed/Inventory Gate';
const JAKE_EMAIL = 'jake.harris@astutegroup.com';

// Trigger phrases (case-insensitive)
const TRIGGER_PHRASES = [
  'inventory uploaded',
  'inventory confirmed',
  'inventory ready',
  'inv uploaded',
  'inv confirmed'
];

// State file to track last check and avoid duplicate processing
const STATE_FILE = path.join(process.env.HOME, 'workspace/.inventory-gate-poller-state.json');

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { lastCheck: null, lastConfirmation: null };
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function matchesTrigger(subject) {
  const lower = (subject || '').toLowerCase();
  return TRIGGER_PHRASES.some(phrase => lower.includes(phrase));
}

async function checkForConfirmation() {
  console.log('Inventory Gate Poller');
  console.log('='.repeat(50));
  console.log(`Checking ${INBOX} for inventory confirmation...`);
  console.log('');

  // Check if gate is already open
  if (fs.existsSync(INVENTORY_GATE_FILE)) {
    const ts = fs.readFileSync(INVENTORY_GATE_FILE, 'utf8').trim();
    console.log(`Gate already OPEN (set at ${ts})`);
    console.log('No action needed.');
    return { found: false, alreadyOpen: true };
  }

  const fetcher = createFetcher({
    user: INBOX,
    password: process.env.WORKMAIL_PASS,
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10)
  });

  try {
    await fetcher.connect();

    // Check INBOX for recent emails (last 3 days)
    const envelopes = await fetcher.listEnvelopes('INBOX', 3);
    console.log(`Found ${envelopes.length} emails in last 3 days`);

    // Look for confirmation from Jake ONLY
    // If someone else (NetComponents, vendors) replies - notify Jake, never reply to them
    for (const env of envelopes) {
      const subject = env.subject || '';
      const from = (env.from || '').toLowerCase();
      const cc = (env.cc || '').toLowerCase();

      // STRICT: Only accept gate triggers from Jake
      const isFromJake = from.includes('jake.harris') || from.includes(JAKE_EMAIL.toLowerCase());
      const jakeInCC = cc.includes('jake.harris') || cc.includes(JAKE_EMAIL.toLowerCase());

      if (!isFromJake) {
        // Not from Jake - check if it's related to inventory/NC and Jake isn't CC'd
        const isInventoryRelated = (subject.toLowerCase().includes('inventory') ||
                                    subject.toLowerCase().includes('data upload') ||
                                    subject.toLowerCase().includes('netcomponents') ||
                                    from.includes('netcomponents'));

        if (isInventoryRelated && !jakeInCC) {
          // Someone replied about inventory and Jake isn't CC'd - notify him
          console.log(`  External reply detected (Jake not in CC): ${env.from}`);
          try {
            const notifier = createNotifier({
              fromEmail: INBOX,
              fromName: 'Inventory Gate Poller',
              smtpPass: process.env.WORKMAIL_PASS
            });
            await notifier.sendEmail(
              JAKE_EMAIL,
              `FYI: Reply to inventory email from ${env.from}`,
              `An email arrived in stockrfq@ that may need your attention:\n\nFrom: ${env.from}\nSubject: ${subject}\nDate: ${env.date}\n\nYou were not CC'd on this email. No reply has been sent.\n\nPlease check stockrfq@ inbox if action is needed.`
            );
            console.log(`  Notified Jake about external reply`);
          } catch (e) {
            console.warn(`  Could not notify Jake: ${e.message}`);
          }
        }
        // Never reply to non-Jake senders, skip to next email
        continue;
      }

      // From Jake - check if it matches trigger
      if (matchesTrigger(subject)) {
          console.log('');
          console.log('*** CONFIRMATION FOUND ***');
          console.log(`From: ${env.from}`);
          console.log(`Subject: ${subject}`);
          console.log(`Date: ${env.date}`);
          console.log('');

          // Set the gate
          setInventoryGate();

          // Move email to processed folder
          try {
            await fetcher.moveEmail(env.id, PROCESSED_FOLDER, 'INBOX');
            console.log(`Email moved to ${PROCESSED_FOLDER}`);
          } catch (e) {
            console.warn(`Could not move email: ${e.message}`);
          }

          // Update state
          writeState({
            lastCheck: new Date().toISOString(),
            lastConfirmation: {
              date: new Date().toISOString(),
              subject: subject,
              from: env.from
            }
          });

          // Send acknowledgment
          try {
            const notifier = createNotifier({
              fromEmail: INBOX,
              fromName: 'Active Sourcing',
              smtpPass: process.env.WORKMAIL_PASS
            });
            await notifier.sendEmail(
              JAKE_EMAIL,
              'Active Sourcing Gate Opened',
              `Inventory confirmation received.\n\nActive Sourcing will proceed on the next scheduled run (Mon/Thu 8:30 AM CT).\n\nOriginal confirmation:\nSubject: ${subject}\nReceived: ${env.date}`
            );
            console.log('Acknowledgment sent to Jake');
          } catch (e) {
            console.warn(`Could not send acknowledgment: ${e.message}`);
          }

          await fetcher.disconnect();
          return { found: true, email: env };
        }
      }
    }

    console.log('');
    console.log('No confirmation found yet.');
    console.log('Will check again on next poll.');

    // Update state
    writeState({
      ...readState(),
      lastCheck: new Date().toISOString()
    });

    await fetcher.disconnect();
    return { found: false };

  } catch (err) {
    console.error(`Error checking inbox: ${err.message}`);
    try { await fetcher.disconnect(); } catch (e) { /* ignore */ }
    return { found: false, error: err.message };
  }
}

function showStatus() {
  console.log('Inventory Gate Poller — Status');
  console.log('='.repeat(50));

  // Gate status
  if (fs.existsSync(INVENTORY_GATE_FILE)) {
    const ts = fs.readFileSync(INVENTORY_GATE_FILE, 'utf8').trim();
    console.log(`Gate: OPEN (set at ${ts})`);
  } else {
    console.log('Gate: CLOSED');
  }
  console.log('');

  // Poller state
  const state = readState();
  console.log(`Last check: ${state.lastCheck || 'never'}`);
  if (state.lastConfirmation) {
    console.log(`Last confirmation: ${state.lastConfirmation.date}`);
    console.log(`  Subject: ${state.lastConfirmation.subject}`);
    console.log(`  From: ${state.lastConfirmation.from}`);
  }
  console.log('');

  // Trigger phrases
  console.log('Trigger phrases (in subject):');
  TRIGGER_PHRASES.forEach(p => console.log(`  - "${p}"`));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    showStatus();
  } else if (args.includes('--help')) {
    console.log('Usage: node inventory-gate-poller.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --status   Show current gate and poller status');
    console.log('  --help     Show this help');
    console.log('');
    console.log('Polls stockrfq@ for inventory confirmation email from Jake.');
    console.log('When found, sets the gate file so Active Sourcing can proceed.');
  } else {
    await checkForConfirmation();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { checkForConfirmation };
