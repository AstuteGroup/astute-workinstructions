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

// Trigger phrases from Jake (case-insensitive)
const JAKE_TRIGGER_PHRASES = [
  'inventory uploaded',
  'inventory confirmed',
  'inventory ready',
  'inv uploaded',
  'inv confirmed'
];

// Trigger phrases from NetComponents confirming upload (case-insensitive)
const NC_TRIGGER_PHRASES = [
  'upload completed',
  'upload successful',
  'data received',
  'file received',
  'upload has been completed',
  'successfully uploaded',
  'successfully received'
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

function matchesJakeTrigger(subject) {
  const lower = (subject || '').toLowerCase();
  return JAKE_TRIGGER_PHRASES.some(phrase => lower.includes(phrase));
}

function matchesNCTrigger(subject) {
  const lower = (subject || '').toLowerCase();
  return NC_TRIGGER_PHRASES.some(phrase => lower.includes(phrase));
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

  const fetcher = createFetcher('stockrfq');

  try {
    // Check INBOX for recent emails (last 100)
    const envelopes = await fetcher.listEnvelopes('INBOX', 100);
    console.log(`Found ${envelopes.length} emails to check`);

    // Process emails - accept triggers from Jake OR NetComponents upload confirmations
    // RULE: NEVER reply directly to NetComponents or external senders - only notify Jake
    for (const env of envelopes) {
      const subject = env.subject || '';
      // New API: env.from is {name, addr} object
      const fromAddr = (env.from && env.from.addr ? env.from.addr : '').toLowerCase();
      const fromDisplay = env.from ? `${env.from.name || ''} <${env.from.addr || ''}>` : '';
      const cc = ''; // CC not available in new envelope format

      const isFromJake = fromAddr.includes('jake.harris') || fromAddr.includes(JAKE_EMAIL.toLowerCase());
      const isFromNC = fromAddr.includes('netcomponents');
      const jakeInCC = false; // CC not available in current envelope format - always notify on NC emails

      // Case 1: NetComponents confirms upload completed - process it, notify Jake only
      if (isFromNC && matchesNCTrigger(subject)) {
        console.log('');
        console.log('*** NC UPLOAD CONFIRMATION RECEIVED ***');
        console.log(`From: ${fromDisplay}`);
        console.log(`Subject: ${subject}`);
        console.log('');

        // Set the gate
        setInventoryGate();

        // Move email to processed folder
        try {
          await fetcher.moveMessage(env.id, PROCESSED_FOLDER);
          console.log(`Email moved to ${PROCESSED_FOLDER}`);
        } catch (e) {
          console.warn(`Could not move email: ${e.message}`);
        }

        // Notify Jake ONLY - never reply to NC
        try {
          const notifier = createNotifier({
            fromEmail: INBOX,
            fromName: 'Active Sourcing',
            smtpPass: process.env.WORKMAIL_PASS
          });
          await notifier.sendEmail(
            JAKE_EMAIL,
            'Active Sourcing Gate Opened (NC confirmed upload)',
            `NetComponents confirmed the inventory upload.\n\nFrom: ${fromDisplay}\nSubject: ${subject}\nDate: ${env.date}\n\nActive Sourcing will proceed on the next scheduled run (Mon/Thu 8:30 AM CT).`
          );
          console.log('Notified Jake (no reply sent to NC)');
        } catch (e) {
          console.warn(`Could not notify Jake: ${e.message}`);
        }

        writeState({
          lastCheck: new Date().toISOString(),
          lastConfirmation: { date: new Date().toISOString(), subject, from: fromDisplay, source: 'netcomponents' }
        });

        return { found: true, email: env, source: 'netcomponents' };
      }

      // Case 2: Other NC email (questions, issues) - notify Jake, never reply
      if (isFromNC && !matchesNCTrigger(subject)) {
        console.log(`  NC email detected (not a confirmation): ${subject}`);
        try {
          const notifier = createNotifier({
            fromEmail: INBOX,
            fromName: 'Inventory Gate Poller',
            smtpPass: process.env.WORKMAIL_PASS
          });
          await notifier.sendEmail(
            JAKE_EMAIL,
            `FYI: NetComponents email needs attention`,
            `An email from NetComponents arrived that may need your attention:\n\nFrom: ${fromDisplay}\nSubject: ${subject}\nDate: ${env.date}\n\nNo reply has been sent to them.\n\nPlease check stockrfq@ inbox.`
          );
          console.log(`  Notified Jake about NC email`);
        } catch (e) {
          console.warn(`  Could not notify Jake: ${e.message}`);
        }
        continue;
      }

      // Case 3: Not from Jake and not NC - skip silently
      if (!isFromJake) {
        continue;
      }

      // Case 4: From Jake - check if it matches trigger
      if (matchesJakeTrigger(subject)) {
          console.log('');
          console.log('*** CONFIRMATION FOUND ***');
          console.log(`From: ${fromDisplay}`);
          console.log(`Subject: ${subject}`);
          console.log(`Date: ${env.date}`);
          console.log('');

          // Set the gate
          setInventoryGate();

          // Move email to processed folder
          try {
            await fetcher.moveMessage(env.id, PROCESSED_FOLDER);
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
              from: fromDisplay
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

          return { found: true, email: env };
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

    return { found: false };

  } catch (err) {
    console.error(`Error checking inbox: ${err.message}`);
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
  console.log('Jake trigger phrases (in subject):');
  JAKE_TRIGGER_PHRASES.forEach(p => console.log(`  - "${p}"`));
  console.log('');
  console.log('NetComponents confirmation phrases:');
  NC_TRIGGER_PHRASES.forEach(p => console.log(`  - "${p}"`));
  console.log('');
  console.log('RULE: Never reply to NetComponents - only notify Jake.');
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
